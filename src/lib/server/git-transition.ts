/**
 * Git Repository Mode Transition Job.
 *
 * Mode change is treated as a migration job, not a boolean flip. The persisted
 * state machine (git_mode_transition) is:
 *
 *   idle → draining → provisioning → cutting_over → idle
 *
 * The terminal success state is `idle` — the outcome lives in the effective
 * git_repository_mode, so the `state !== 'idle'` 409 lock can never wedge (N1).
 * On failure the job rolls back (restores forceRedeploy + any promoted repo
 * fields) and returns to `idle` without cutting over (N4).
 *
 * Both directions share draining → cutting_over; provisioning is a no-op for
 * enter-stack (N6). Env-forced boots run/resume the job before any cleanup or
 * scheduler start (N3).
 */

import { join } from 'node:path';
import { readdir, rm, access } from 'node:fs/promises';
import { db, gitStacks, gitRepositories, eq } from './db/drizzle.js';
import {
	getGitModeTransition,
	updateGitModeTransition,
	getGitRepositories,
	getEnvironments,
	getSetting,
	setSetting,
	deleteSetting,
	updateGitStack,
	type GitModeTransitionState
} from './db';
import { getDesiredGitMode, getGitMode, setEffectiveGitMode, ConflictError, type GitMode } from './git-mode';
import { refreshAllSchedules } from './scheduler';
import { getGitReposDir } from './git';
import { CentralizedGitEngine, getActiveGitCoalesceCount } from './git-centralized';
import { promoteStackSettingsToRepository, restoreBackfillSnapshot, type BackfillSnapshot, type ForceRedeploySnapshot } from './git-backfill';
import { runWithConcurrency } from './run-with-concurrency';

// Default drain window. A coalesce deploy slot is held for the whole
// deployStack (incl. docker builds), so a busy host can exceed any short
// timeout — expose an env override (DOCKHAND_GIT_TRANSITION_DRAIN_TIMEOUT_MS).
const DRAIN_TIMEOUT_MS = Number(process.env.DOCKHAND_GIT_TRANSITION_DRAIN_TIMEOUT_MS ?? 120_000);
const DRAIN_POLL_MS = 500;
const PROVISION_CONCURRENCY = 4;

/**
 * Persistent baseline of the original forceRedeploy values that the enter-
 * centralized backfill overwrites. Survives the transition (unlike the
 * in-flight snapshot) so a later toggle back to stack can restore them (F8/F13).
 */
const FORCE_REDEPLOY_BASELINE_KEY = 'git_mode_force_redeploy_baseline';

/** In-memory mutex: only one transition job may run at a time. */
let transitionRunning = false;
/** Serializes transition initiation so a second concurrent toggle can't clobber
 * the first one's state/snapshot writes (narrow double-click race). */
let transitionStarting = false;

async function setState(state: GitModeTransitionState): Promise<void> {
	await updateGitModeTransition({ state });
}

/**
 * Start a mode transition in the background. Throws ConflictError when a
 * transition is already active or the desired mode equals the effective mode.
 */
export async function startGitModeTransition(mode: GitMode): Promise<void> {
	if (transitionStarting || transitionRunning) {
		throw new ConflictError('A git repository mode transition is already in progress');
	}
	transitionStarting = true;
	try {
		const active = await getGitModeTransition();
		if (active && active.state !== 'idle') {
			throw new ConflictError('A git repository mode transition is already in progress');
		}
		if ((await getGitMode()) === mode) return;

		await updateGitModeTransition({
			mode,
			state: 'draining',
			jobId: `git-mode-${Date.now()}`,
			startedAt: new Date().toISOString(),
			finishedAt: null,
			snapshot: null,
			error: null
		});

		void runTransitionCore(mode).catch((err) => {
			console.error('[GitTransition] background transition failed:', err instanceof Error ? err.message : String(err));
		});
	} finally {
		transitionStarting = false;
	}
}

/**
 * Resolve any pending/desired transition at boot: resume an interrupted
 * transition, or run one when the desired mode differs from the effective mode
 * (covers DOCKHAND_GIT_CENTRALIZED_MODE=true on never-provisioned installs).
 */
export async function ensureGitModeTransitionResolved(): Promise<void> {
	const row = await getGitModeTransition();
	if (row && (row.state === 'provisioning' || row.state === 'cutting_over' || row.state === 'draining')) {
		console.log('[GitTransition] Resuming interrupted transition...');
		await runTransitionCore(await getDesiredGitMode());
		return;
	}
	if (row && row.state === 'failed') {
		// A previous attempt failed — roll back any snapshot then settle to idle
		// so a retry (or a fresh run below) can start cleanly.
		if (row.snapshot) {
			try {
				await restoreBackfillSnapshot(JSON.parse(row.snapshot));
			} catch (err) {
				console.error('[GitTransition] Failed to restore snapshot at boot:', err);
			}
		}
		await deleteSetting(FORCE_REDEPLOY_BASELINE_KEY);
		await updateGitModeTransition({ state: 'idle', finishedAt: new Date().toISOString(), snapshot: null });
	}
	const desired = await getDesiredGitMode();
	if ((await getGitMode()) !== desired) {
		await runTransitionCore(desired);
	}
}

async function runTransitionCore(desired: GitMode): Promise<void> {
	if (transitionRunning) {
		console.warn('[GitTransition] A transition is already running — skipping duplicate');
		return;
	}
	transitionRunning = true;
	let snapshot: BackfillSnapshot | null = null;
	// Pre-transition effective mode — restored on rollback so a failure after
	// the cutover flip (setEffectiveGitMode / refreshAllSchedules) can never
	// leave the app in the new mode with the old mode's data undone (N4).
	const originalMode = await getGitMode();
	try {
		// ---- DRAINING (both directions) ----
		await setState('draining');
		await waitForGitOpsToDrain();

		// ---- PROVISIONING (enter-centralized only) ----
		if (desired === 'centralized') {
			await setState('provisioning');
			snapshot = await promoteStackSettingsToRepository();
			await updateGitModeTransition({ snapshot: JSON.stringify(snapshot) });
			// Persist the original forceRedeploy values so a future toggle back to
			// stack can restore them (F8/F13). Survives this transition's end.
			await setSetting(FORCE_REDEPLOY_BASELINE_KEY, snapshot.forceRedeploy);

			const repos = await getGitRepositories();
			const results = await runWithConcurrency(
				PROVISION_CONCURRENCY,
				repos.map((repo) => async () => {
					console.log(`[GitTransition] Provisioning shared clone for "${repo.name}"...`);
					return CentralizedGitEngine.syncRepositoryExclusive!(repo.id);
				})
			);
			for (let i = 0; i < results.length; i++) {
				if (!results[i].success) {
					throw new Error(`Failed to clone repository "${repos[i].name}": ${results[i].error}`);
				}
			}
		}

		// ---- CUTTING OVER (both directions) ----
		await setState('cutting_over');
		// Run the side effects that touch the previous mode's data FIRST, while the
		// effective mode is still the old one (N4). If either throws we roll back
		// and retry cleanly; the irreversible flip (setEffectiveGitMode) stays the
		// last step so failure can never leave the mode cut over without its data.
		if (desired === 'centralized') {
			// Delete only DB-known stack-mode clone trees; never shared/.
			await cleanupStackCloneTrees();
		} else {
			// Enter-stack: shared clones stay (inert); restore forceRedeploy that
			// a previous enter-centralized backfill set (F8/F13).
			await restoreForceRedeployBaseline();
		}
		await setEffectiveGitMode(desired);
		// Rebuild cron jobs for the new mode; the opposite family is dropped
		// because refreshAllSchedules clears activeJobs and re-registers.
		await refreshAllSchedules();

		await updateGitModeTransition({ state: 'idle', finishedAt: new Date().toISOString(), error: null, snapshot: null });
		console.log(`[GitTransition] Mode transition to "${desired}" complete`);
	} catch (err) {
		const message = err instanceof Error ? err.message : String(err);
		console.error(`[GitTransition] Transition to "${desired}" failed: ${message}`);
		// ---- ROLLBACK (N4): never cut over on failure ----
		try {
			if (desired === 'centralized') {
				const row = await getGitModeTransition();
				if (row?.snapshot) {
					await restoreBackfillSnapshot(JSON.parse(row.snapshot));
				}
				await deleteSetting(FORCE_REDEPLOY_BASELINE_KEY);
			} else if (snapshot) {
				await restoreBackfillSnapshot(snapshot);
			}
			// If the cutover already flipped the effective mode (failure happened in
			// setEffectiveGitMode/refreshAllSchedules), flip it back and rebuild the
			// schedule family so the app matches the restored data.
			if ((await getGitMode()) !== originalMode) {
				await setEffectiveGitMode(originalMode);
				await refreshAllSchedules();
			}
		} catch (rollbackErr) {
			console.error('[GitTransition] Rollback failed:', rollbackErr instanceof Error ? rollbackErr.message : String(rollbackErr));
		}
		// End at `idle` (with the error recorded) so the 409 lock is released —
		// a persistent `failed` state would otherwise block git operations until
		// the next restart. The error is surfaced to the UI via the settings GET.
		await updateGitModeTransition({ state: 'idle', finishedAt: new Date().toISOString(), error: message, snapshot: null });
		throw err;
	} finally {
		transitionRunning = false;
	}
}

/**
 * Wait until no git operation is in flight. New mutations are blocked by the
 * 409 transition guard; in-flight work is detected via:
 *  - git_stacks.syncStatus = 'syncing' (both modes)
 *  - git_repositories.syncStatus = 'syncing' (centralized shared-clone syncs)
 *  - in-memory coalesce slots (stack deploys + repo fan-outs)
 * Bounded wait — abort the transition if a stack never finishes.
 */
async function waitForGitOpsToDrain(): Promise<void> {
	const deadline = Date.now() + DRAIN_TIMEOUT_MS;
	for (;;) {
		const [busyStacks, busyRepos, coalesceCount] = await Promise.all([
			db.select({ id: gitStacks.id }).from(gitStacks).where(eq(gitStacks.syncStatus, 'syncing')),
			db.select({ id: gitRepositories.id }).from(gitRepositories).where(eq(gitRepositories.syncStatus, 'syncing')),
			getActiveGitCoalesceCount()
		]);
		if (busyStacks.length === 0 && busyRepos.length === 0 && coalesceCount === 0) return;
		if (Date.now() >= deadline) {
			throw new Error(
				`Git operations still in flight (${busyStacks.length} stack(s), ${busyRepos.length} repo(s), ${coalesceCount} coalesced) — aborting mode transition`
			);
		}
		await new Promise((r) => setTimeout(r, DRAIN_POLL_MS));
	}
}

/**
 * Restore the persistent forceRedeploy baseline (toggle-off) and clear it.
 * Only restores the stacks the backfill touched.
 */
async function restoreForceRedeployBaseline(): Promise<void> {
	const baseline = await getSetting(FORCE_REDEPLOY_BASELINE_KEY);
	await deleteSetting(FORCE_REDEPLOY_BASELINE_KEY);
	if (!baseline) return;

	let parsed: ForceRedeploySnapshot;
	try {
		parsed = typeof baseline === 'string' ? JSON.parse(baseline) : baseline;
	} catch {
		console.warn('[GitTransition] Ignoring unreadable forceRedeploy baseline');
		return;
	}

	for (const [stackIdStr, original] of Object.entries(parsed)) {
		const stackId = Number(stackIdStr);
		await updateGitStack(stackId, { forceRedeploy: original });
	}
	console.log(`[GitTransition] Restored forceRedeploy for ${Object.keys(parsed).length} stack(s)`);
}

/**
 * Remove per-stack clone trees after an enter-centralized cutover,
 * asynchronously (git trees can hold tens of thousands of files — sync
 * rmSync/readdirSync would block the event loop). Only touches:
 *  - git-repos/stack-<id> (per-stack fallback clones)
 *  - git-repos/<envName>/ (env-scoped clones), only for DB-known environment
 *    names (allowlist, never the heuristic sweep) and never a directory with a
 *    top-level .git (F2/F10/F14). git-repos/shared/ is never touched.
 */
export async function cleanupStackCloneTrees(): Promise<void> {
	const root = getGitReposDir();
	let entries: string[];
	try {
		entries = await readdir(root);
	} catch {
		return; // root missing
	}
	const envNames = new Set((await getEnvironments()).map((e) => e.name));

	for (const entry of entries) {
		const dir = join(root, entry);
		if (entry === 'shared') continue; // never touch the active namespace
		if (/^stack-\d+$/.test(entry)) {
			try {
				await rm(dir, { recursive: true, force: true });
				console.log(`[GitTransition] Removed per-stack clone: ${dir}`);
			} catch (err) {
				console.warn(`[GitTransition] Failed to remove per-stack clone ${dir}:`, err);
			}
			continue;
		}
		if (envNames.has(entry)) {
			// Defensive: never remove a directory that holds a top-level .git
			// (a shared clone can never live here under the shared/ layout, but
			// this guard is cheap insurance).
			try {
				await access(join(dir, '.git'));
				continue;
			} catch {
				// no .git — safe to remove
			}
			try {
				await rm(dir, { recursive: true, force: true });
				console.log(`[GitTransition] Removed env-scoped clone dir: ${dir}`);
			} catch (err) {
				console.warn(`[GitTransition] Failed to remove env-scoped clone dir ${dir}:`, err);
			}
			continue;
		}
		// Any other top-level directory with a `.git` is a pre-shared centralized
		// clone (git-repos/<repoName> from before the shared/ namespace). Env
		// dirs never have a top-level .git, so this is precise — and after the
		// cutover the authoritative clones live under shared/, so these are inert.
		try {
			await access(join(dir, '.git'));
			try {
				await rm(dir, { recursive: true, force: true });
				console.log(`[GitTransition] Removed pre-shared clone: ${dir}`);
			} catch (err) {
				console.warn(`[GitTransition] Failed to remove pre-shared clone ${dir}:`, err);
			}
		} catch {
			// no .git — not a clone; leave unknown entries alone
		}
	}
}

/**
 * Boot-time cleanup of the per-stack clone trees for installs already in
 * centralized mode (the transition-driven cleanup above replaces the old
 * one-shot migration). ONLY runs when the effective mode is centralized — in
 * stack mode these trees ARE the active per-stack clones. Never touches
 * git-repos/shared/.
 */
export async function cleanupStackCloneTreesAtBoot(): Promise<void> {
	if ((await getGitMode()) !== 'centralized') {
		console.log('[GitTransition] Git-repos cleanup skipped (stack mode)');
		return;
	}
	await cleanupStackCloneTrees();
}
