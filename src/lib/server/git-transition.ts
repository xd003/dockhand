/**
 * Legacy whole-fleet git-mode transition — RETIRED.
 *
 * The old idle → draining → provisioning → cutting_over → idle state machine
 * (git_mode_transition) migrated EVERY stack when the global mode changed.
 * Per-stack migration (git-stack-migrate.ts) replaces it: the global setting is
 * a DEFAULT for new stacks only, and existing stacks migrate individually.
 *
 * Nothing starts the fleet transition anymore (Settings writes the default
 * only; boot never resumes it). This module only settles a stale in-flight row
 * so the retired machine can never wedge the app.
 */

import { getGitModeTransition, updateGitModeTransition } from './db';

/**
 * The fleet transition is retired: an install that upgraded mid-flight could
 * still carry a non-idle git_mode_transition row. Settle it to idle so the
 * inert machine can never block live git or show a phantom "transitioning"
 * state. Existing stacks are untouched — this only marks the old job done.
 */
export async function settleLegacyGitModeTransition(): Promise<void> {
	try {
		const row = await getGitModeTransition();
		if (row && row.state !== 'idle') {
			console.warn(`[GitTransition] Settling superseded fleet transition (state="${row.state}") to idle — per-stack migration replaces it`);
			await updateGitModeTransition({
				state: 'idle',
				finishedAt: new Date().toISOString(),
				error: 'Superseded by per-stack git migration'
			});
		}
	} catch (err) {
		console.error('[GitTransition] Failed to settle legacy transition:', err instanceof Error ? err.message : String(err));
	}
}
