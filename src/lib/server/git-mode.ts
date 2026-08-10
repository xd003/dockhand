/**
 * Git Repository Mode — source of truth for the stack vs centralized git model.
 *
 * Two distinct concepts:
 *  - **desired** mode: what the user selected in Settings (git_repository_desired_mode)
 *    or what the DOCKHAND_GIT_CENTRALIZED_MODE env var demands. Changing it does NOT
 *    change runtime behaviour — it starts a transition job (git-transition.ts).
 *  - **effective** mode: what engines, scheduler and disk layout actually use
 *    (git_repository_mode). Only the transition job's `cutting_over` step writes it.
 *
 * getGitMode() never short-circuits on the env var: the env var only contributes to
 * the desired mode. Effective stays stack until a transition completes (N3).
 */

import { getSetting, setSetting } from './db';

export type GitMode = 'stack' | 'centralized';

export const EFFECTIVE_MODE_SETTING = 'git_repository_mode';
export const DESIRED_MODE_SETTING = 'git_repository_desired_mode';

// Module-level caches — invalidated by setDesiredGitMode. The effective mode is
// only ever written by the transition job at cutover, so caching it here is safe.
let cachedEffective: GitMode | null = null;
let cachedDesired: GitMode | null = null;

function isGitModeValue(value: unknown): value is GitMode {
	return value === 'stack' || value === 'centralized';
}

/** Effective mode — what the app actually uses. Async-only (F15). */
export async function getGitMode(): Promise<GitMode> {
	if (cachedEffective) return cachedEffective;
	const raw = await getSetting(EFFECTIVE_MODE_SETTING);
	cachedEffective = isGitModeValue(raw) ? raw : 'stack';
	return cachedEffective;
}

/** Desired mode — env var wins over the UI setting. */
export async function getDesiredGitMode(): Promise<GitMode> {
	if (cachedDesired) return cachedDesired;
	if (process.env.DOCKHAND_GIT_CENTRALIZED_MODE === 'true') {
		cachedDesired = 'centralized';
		return cachedDesired;
	}
	const raw = await getSetting(DESIRED_MODE_SETTING);
	cachedDesired = isGitModeValue(raw) ? raw : 'stack';
	return cachedDesired;
}

export function isGitModeEnvForced(): boolean {
	// Presence of the variable locks the mode from the UI regardless of its value.
	// Only an actual `true` (below in getDesiredGitMode) forces centralized; any
	// other value just means "the operator owns this, not the UI".
	const v = process.env.DOCKHAND_GIT_CENTRALIZED_MODE;
	return v !== undefined && v !== '';
}

/** Set the desired mode. Rejected when env-forced or a transition is active. */
export async function setDesiredGitMode(mode: GitMode): Promise<void> {
	if (isGitModeEnvForced()) {
		throw new Error('Git repository mode is managed by the DOCKHAND_GIT_CENTRALIZED_MODE environment variable');
	}
	const { getGitModeTransition } = await import('./db');
	const transition = await getGitModeTransition();
	if (transition && transition.state !== 'idle') {
		throw new ConflictError('A git repository mode transition is already in progress');
	}
	await setSetting(DESIRED_MODE_SETTING, mode);
	cachedDesired = mode;
}

/** Write the effective mode at cutover (transition job only). */
export async function setEffectiveGitMode(mode: GitMode): Promise<void> {
	await setSetting(EFFECTIVE_MODE_SETTING, mode);
	cachedEffective = mode;
}

export async function isCentralizedGit(): Promise<boolean> {
	return (await getGitMode()) === 'centralized';
}

export async function isStackGit(): Promise<boolean> {
	return (await getGitMode()) === 'stack';
}

/** Error used for 409-style conflicts (mid-transition). */
export class ConflictError extends Error {}
