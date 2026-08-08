/**
 * Idempotent promotion of stack-level scheduled-sync / webhook settings to the
 * repository, mirroring the original 0010 migration semantics (now moved out of
 * the DB migration into a runtime step — see the implementation plan, Phase 8).
 *
 * Only runs inside the enter-centralized transition. It snapshots the original
 * values it mutates so a failed transition can restore them exactly (N4/F8).
 */

import { getGitRepositories, getGitStacks, updateGitRepository, updateGitStack } from './db';
import type { GitRepositoryData, GitStackWithRepo } from './db';
import { scheduleFrequencyRank, pickScheduleWinner } from './git-schedule-ranking';

export interface ForceRedeploySnapshot {
	[stackId: number]: boolean;
}

export interface RepoSettingSnapshot {
	autoUpdate?: boolean;
	autoUpdateSchedule?: string | null;
	autoUpdateCron?: string | null;
	webhookEnabled?: boolean;
	webhookSecret?: string | null;
}

export interface BackfillSnapshot {
	/** Original forceRedeploy per stack, before any backfill set it. */
	forceRedeploy: ForceRedeploySnapshot;
	/** Original repo-level settings, before any promotion wrote them. */
	repoSettings: Record<number, RepoSettingSnapshot>;
}

/**
 * Promote stack-level schedule + webhook settings to the repository and backfill
 * force_redeploy for webhook-enabled stacks. Returns the snapshot of everything
 * it touched, for rollback on a failed transition.
 */
export async function promoteStackSettingsToRepository(): Promise<BackfillSnapshot> {
	const repos = await getGitRepositories();
	const stacks = await getGitStacks();

	const snapshot: BackfillSnapshot = { forceRedeploy: {}, repoSettings: {} };

	// Group stacks by repository.
	const stacksByRepo = new Map<number, GitStackWithRepo[]>();
	for (const stack of stacks) {
		if (stack.repositoryId == null) continue;
		const list = stacksByRepo.get(stack.repositoryId) ?? [];
		list.push(stack);
		stacksByRepo.set(stack.repositoryId, list);
	}

	for (const repo of repos) {
		const repoStacks = stacksByRepo.get(repo.id) ?? [];
		if (repoStacks.length === 0) continue;

		// Backfill force_redeploy on webhook-enabled stacks (record original).
		for (const stack of repoStacks) {
			if (stack.webhookEnabled && !stack.forceRedeploy) {
				if (!(stack.id in snapshot.forceRedeploy)) {
					snapshot.forceRedeploy[stack.id] = stack.forceRedeploy;
				}
				await updateGitStack(stack.id, { forceRedeploy: true });
			}
		}

		// Schedule promotion: only when the repo has no schedule of its own.
		if (!repo.autoUpdate) {
			const autoStacks = repoStacks.filter((s) => s.autoUpdate);
			if (autoStacks.length > 0) {
				// Most-frequent schedule wins; lowest stack id breaks ties.
				const winner = pickScheduleWinner(autoStacks)!;
				snapshot.repoSettings[repo.id] = {
					autoUpdate: repo.autoUpdate,
					autoUpdateSchedule: repo.autoUpdateSchedule,
					autoUpdateCron: repo.autoUpdateCron
				};
				await updateGitRepository(repo.id, {
					autoUpdate: true,
					autoUpdateSchedule: (winner.autoUpdateSchedule as 'custom' | 'daily' | 'weekly') ?? 'daily',
					autoUpdateCron: winner.autoUpdateCron ?? '0 3 * * *'
				});
			}
		}

		// Webhook promotion: only when the repo has no webhook of its own.
		if (!repo.webhookEnabled) {
			const webhookStacks = repoStacks.filter((s) => s.webhookEnabled && s.webhookSecret != null);
			if (webhookStacks.length > 0) {
				// Lowest stack id wins for the secret.
				const winner = [...webhookStacks].sort((a, b) => a.id - b.id)[0];
				snapshot.repoSettings[repo.id] = {
					...snapshot.repoSettings[repo.id],
					webhookEnabled: repo.webhookEnabled,
					webhookSecret: repo.webhookSecret
				};
				await updateGitRepository(repo.id, {
					webhookEnabled: true,
					webhookSecret: winner.webhookSecret
				});
			}
		}
	}

	return snapshot;
}

/**
 * Restore a backfill snapshot exactly (rollback path). Restores forceRedeploy
 * per stack and clears/preserves the promoted repo-level fields.
 */
export async function restoreBackfillSnapshot(snapshot: BackfillSnapshot | null): Promise<void> {
	if (!snapshot) return;

	for (const [stackIdStr, original] of Object.entries(snapshot.forceRedeploy)) {
		const stackId = Number(stackIdStr);
		await updateGitStack(stackId, { forceRedeploy: original });
	}

	for (const [repoIdStr, original] of Object.entries(snapshot.repoSettings)) {
		const repoId = Number(repoIdStr);
		await updateGitRepository(repoId, {
			autoUpdate: original.autoUpdate ?? false,
			autoUpdateSchedule: (original.autoUpdateSchedule as 'custom' | 'daily' | 'weekly' | null) ?? null,
			autoUpdateCron: original.autoUpdateCron ?? null,
			webhookEnabled: original.webhookEnabled ?? false,
			webhookSecret: original.webhookSecret ?? null
		});
	}
}
