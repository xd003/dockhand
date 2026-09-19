import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { assertSafeGitRef, resolveSafeGitFileTarget } from './git-url-safety';
import { buildGitEnv, cleanupSshKey, execGit, type GitEnv } from './git';
import type { GitCredentialData } from './db';
import { normalizeLinkedPath, MAX_LINKED_FILE_SIZE } from '../stack-linked-files';

export type GitTrackedDecision = 'commit' | 'internal';
export type GitUntrackedDecision = 'add' | 'local';

export interface GitFileClassification {
	path: string;
	tracked: boolean;
	ignored: boolean;
}

export interface GitFileChange {
	path: string;
	content: string;
	expectedRevision?: string;
	created?: boolean;
}

export interface GitFileMutationOptions {
	repositoryId: number;
	repoPath: string;
	branch: string;
	credential: GitCredentialData | null;
	changes: GitFileChange[];
	trackedDecision: GitTrackedDecision;
	untrackedDecision: GitUntrackedDecision;
	commitMessage?: string;
	expectedClassifications?: GitFileClassification[];
	afterPush?: (result: GitFileMutationResult) => Promise<void>;
}

export interface GitFileMutationResult {
	committed: boolean;
	commit?: string;
	reconciliationError?: string;
	classifications: GitFileClassification[];
	trackedPaths: string[];
	localPaths: string[];
	addedPaths: string[];
}

const repositoryLocks = new Map<number, Promise<void>>();

export async function withGitRepositoryMutationLock<T>(repositoryId: number, fn: () => Promise<T>): Promise<T> {
	const previous = repositoryLocks.get(repositoryId);
	let release!: () => void;
	const current = new Promise<void>((resolve) => { release = resolve; });
	repositoryLocks.set(repositoryId, current);
	if (previous) await previous;
	try {
		return await fn();
	} finally {
		release();
		if (repositoryLocks.get(repositoryId) === current) repositoryLocks.delete(repositoryId);
	}
}

function repoRelativePath(repoPath: string, path: string): string {
	const normalized = normalizeLinkedPath(path);
	const absolute = resolve(repoPath, ...normalized.split('/'));
	const rel = relative(resolve(repoPath), absolute).split(sep).join('/');
	if (!rel || rel.startsWith('../') || isAbsolute(rel)) throw new Error(`Git file path escapes the repository: ${path}`);
	return rel;
}

function contentRevision(content: Buffer | string): string {
	return createHash('sha256').update(content).digest('hex');
}

async function classifyPath(repoPath: string, path: string, env: GitEnv): Promise<GitFileClassification> {
	const trackedResult = await execGit(['ls-files', '--error-unmatch', '--', path], repoPath, env);
	const tracked = trackedResult.code === 0;
	const ignoredResult = tracked ? { code: 1 } : await execGit(['check-ignore', '--quiet', '--', path], repoPath, env);
	return { path, tracked, ignored: !tracked && ignoredResult.code === 0 };
}

async function gitStatus(repoPath: string, env: GitEnv): Promise<string> {
	const result = await execGit(['status', '--porcelain', '--untracked-files=all'], repoPath, env);
	if (result.code !== 0) throw new Error(`Unable to inspect Git checkout: ${result.stderr}`);
	return result.stdout.trim();
}

async function rollback(
	repoPath: string,
	env: GitEnv,
	oldHead: string,
	untrackedSnapshots: Map<string, Buffer | null>
): Promise<void> {
	await execGit(['reset', '--hard', oldHead], repoPath, env);
	for (const [path, content] of untrackedSnapshots) {
		const target = resolve(repoPath, ...path.split('/'));
		if (content === null) {
			await execGit(['clean', '-f', '--', path], repoPath, env);
		} else {
			writeFileSync(target, content);
		}
	}
	if (await gitStatus(repoPath, env)) throw new Error('Git checkout could not be restored to a clean state');
}

/** Mutate one clean checkout, producing at most one commit and never force-pushing. */
export async function mutateGitStackFiles(options: GitFileMutationOptions): Promise<GitFileMutationResult> {
	return withGitRepositoryMutationLock(options.repositoryId, async () => {
		assertSafeGitRef(options.branch);
		if (!options.changes.length) return { committed: false, classifications: [], trackedPaths: [], localPaths: [], addedPaths: [] };
		const message = options.commitMessage?.trim();
		if ((options.trackedDecision === 'commit' || options.untrackedDecision === 'add') && !message) {
			throw new Error('A non-blank Git commit message is required');
		}

		const env = await buildGitEnv(options.credential);
		let oldHead = '';
		let pushed = false;
		const untrackedSnapshots = new Map<string, Buffer | null>();
		try {
			if (await gitStatus(options.repoPath, env)) throw new Error('Git checkout is not clean; synchronize it before editing files');
			const fetch = await execGit(['fetch', 'origin', options.branch], options.repoPath, env);
			if (fetch.code !== 0) throw new Error(`Git fetch failed: ${fetch.stderr}`);
			const checkout = await execGit(['checkout', '-B', options.branch, `origin/${options.branch}`], options.repoPath, env);
			if (checkout.code !== 0) throw new Error(`Git checkout failed: ${checkout.stderr}`);
			const head = await execGit(['rev-parse', 'HEAD'], options.repoPath, env);
			if (head.code !== 0) throw new Error(`Unable to resolve Git HEAD: ${head.stderr}`);
			oldHead = head.stdout.trim();

			const classifications: GitFileClassification[] = [];
			for (const change of options.changes) {
				const path = repoRelativePath(options.repoPath, change.path);
				if (Buffer.byteLength(change.content, 'utf8') > MAX_LINKED_FILE_SIZE || change.content.includes('\0')) throw new Error(`Invalid text content for Git file: ${change.path}`);
				const target = resolveSafeGitFileTarget(options.repoPath, path);
				if (!change.expectedRevision) throw new Error(`Git file revision is required: ${change.path}`);
				const classification = await classifyPath(options.repoPath, path, env);
				if ((existsSync(target) && contentRevision(readFileSync(target)) !== change.expectedRevision) || (!existsSync(target) && classification.tracked)) {
					throw new Error(`Git file changed since it was loaded: ${change.path}`);
				}
				classifications.push(classification);
			}
			if (options.expectedClassifications) {
				for (const expected of options.expectedClassifications) {
					const actual = classifications.find((entry) => entry.path === repoRelativePath(options.repoPath, expected.path));
					if (!actual || actual.tracked !== expected.tracked || actual.ignored !== expected.ignored) throw new Error('Git tracking state changed; reload and retry');
				}
			}

			const trackedPaths = classifications.filter((entry) => entry.tracked).map((entry) => entry.path);
			const untrackedPaths = classifications.filter((entry) => !entry.tracked);
			if (untrackedPaths.some((entry) => entry.ignored) && options.untrackedDecision === 'add') {
				throw new Error(`Ignored Git files cannot be added: ${untrackedPaths.filter((entry) => entry.ignored).map((entry) => entry.path).join(', ')}`);
			}
			const shouldMutateTracked = options.trackedDecision === 'commit';
			const shouldMutateUntracked = options.untrackedDecision === 'add';
			const pathsToCommit = classifications.filter((entry) => entry.tracked ? shouldMutateTracked : shouldMutateUntracked).map((entry) => entry.path);
			for (const change of options.changes) {
				const path = repoRelativePath(options.repoPath, change.path);
				const classification = classifications.find((entry) => entry.path === path)!;
				if (classification.tracked || options.untrackedDecision !== 'add') continue;
				const target = resolveSafeGitFileTarget(options.repoPath, path);
				untrackedSnapshots.set(path, existsSync(target) ? readFileSync(target) : null);
			}
			for (const change of options.changes) {
				const path = repoRelativePath(options.repoPath, change.path);
				const classification = classifications.find((entry) => entry.path === path)!;
				if (!classification.tracked && options.untrackedDecision === 'local') continue;
				const target = resolveSafeGitFileTarget(options.repoPath, path);
				mkdirSync(dirname(target), { recursive: true });
				writeFileSync(target, change.content, { encoding: 'utf8', mode: 0o640 });
			}

			if (pathsToCommit.length === 0) {
				const result = { committed: false, classifications, trackedPaths, localPaths: untrackedPaths.map((entry) => entry.path), addedPaths: [] };
				await options.afterPush?.(result);
				return result;
			}
			const add = await execGit(['add', '--', ...pathsToCommit], options.repoPath, env);
			if (add.code !== 0) throw new Error(`Git stage failed: ${add.stderr}`);
			const commit = await execGit(['-c', 'user.name=Dockhand', '-c', 'user.email=dockhand@localhost', 'commit', '-m', message!], options.repoPath, env);
			if (commit.code !== 0) throw new Error(`Git commit failed: ${commit.stderr}`);
			const pushResult = await execGit(['push', 'origin', `HEAD:${options.branch}`], options.repoPath, env);
			if (pushResult.code !== 0) throw Object.assign(new Error(`Git push failed: ${pushResult.stderr}`), { code: pushResult.stderr.includes('non-fast-forward') ? 409 : 500 });
			pushed = true;
			const newHead = await execGit(['rev-parse', 'HEAD'], options.repoPath, env);
			if (newHead.code !== 0 || await gitStatus(options.repoPath, env)) throw new Error('Git checkout is not clean after push');
			const result: GitFileMutationResult = {
				committed: true,
				commit: newHead.stdout.trim(),
				classifications,
				trackedPaths,
				localPaths: untrackedPaths.filter((entry) => options.untrackedDecision === 'local').map((entry) => entry.path),
				addedPaths: untrackedPaths.filter((entry) => options.untrackedDecision === 'add').map((entry) => entry.path)
			};
			try {
				await options.afterPush?.(result);
			} catch (error) {
				result.reconciliationError = error instanceof Error ? error.message : String(error);
			}
			return result;
		} catch (error) {
			if (oldHead && !pushed) {
				try { await rollback(options.repoPath, env, oldHead, untrackedSnapshots); } catch (rollbackError) { throw new Error(`${error instanceof Error ? error.message : String(error)}; rollback failed: ${rollbackError instanceof Error ? rollbackError.message : String(rollbackError)}`); }
			}
			throw error;
		} finally {
			cleanupSshKey(options.credential, env);
		}
	});
}

export async function classifyGitFiles(repoPath: string, paths: string[], credential: GitCredentialData | null): Promise<GitFileClassification[]> {
	const env = await buildGitEnv(credential);
	try {
		return Promise.all(paths.map((path) => classifyPath(repoPath, repoRelativePath(repoPath, path), env)));
	} finally {
		cleanupSshKey(credential, env);
	}
}
