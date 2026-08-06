/**
 * Single source of truth for resolving git schedule targets.
 *
 * Stack mode schedules are per-stack (git_stack_sync); centralized mode
 * schedules are per-repository (git_repository_sync). The deprecated
 * git_stack_sync type maps to the stack's repository only in centralized mode.
 * All schedule routes must resolve through this function (F12) — no ad-hoc
 * repo remapping.
 */

import { getGitStack, getGitRepository, type GitStackWithRepo, type GitRepositoryData } from './db';
import type { GitMode } from './git-mode';

export type GitScheduleTarget =
	| { kind: 'stack'; id: number; entity: GitStackWithRepo }
	| { kind: 'repository'; id: number; entity: GitRepositoryData };

export type GitScheduleType = 'git_stack_sync' | 'git_repository_sync';

/**
 * Resolve the effective target for a git schedule id. Returns null when the
 * entity is missing or (centralized git_stack_sync) has no linked repository.
 */
export async function resolveGitScheduleTarget(
	mode: GitMode,
	type: string,
	id: number
): Promise<GitScheduleTarget | null> {
	if (type === 'git_stack_sync') {
		const stack = await getGitStack(id);
		if (!stack) return null;
		if (mode === 'stack') {
			return { kind: 'stack', id, entity: stack };
		}
		// Centralized: git_stack_sync is a deprecated alias — target the repository.
		if (!stack.repositoryId) return null;
		const repo = await getGitRepository(stack.repositoryId);
		if (!repo) return null;
		return { kind: 'repository', id: repo.id, entity: repo };
	}
	if (type === 'git_repository_sync') {
		const repo = await getGitRepository(id);
		if (!repo) return null;
		return { kind: 'repository', id, entity: repo };
	}
	return null;
}

/** True when the schedule type is one of the git families. */
export function isGitScheduleType(type: string): type is GitScheduleType {
	return type === 'git_stack_sync' || type === 'git_repository_sync';
}
