import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { assertSafeGitRef, resolveSafeGitFileTarget } from './git-url-safety';
import { buildGitEnv, cleanupSshKey, execGit, type GitEnv } from './git';
import type { GitCredentialData } from './db';

const MAX_GIT_FILE_SIZE = 10 * 1024 * 1024;

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
	const normalized = normalizeGitFilePath(path);
	const absolute = resolve(repoPath, ...normalized.split('/'));
	const rel = relative(resolve(repoPath), absolute).split(sep).join('/');
	if (!rel || rel.startsWith('../') || isAbsolute(rel)) throw new Error(`Git file path escapes the repository: ${path}`);
	return rel;
}

function normalizeGitFilePath(value: unknown): string {
	if (typeof value !== 'string' || value.length === 0 || value.includes('\0')) {
		throw new Error('Git file path must be a non-empty relative path');
	}
	if (value.startsWith('/') || /^[A-Za-z]:[\\/]/.test(value) || value.includes('\\')) {
		throw new Error('Git file path must use a relative POSIX path');
	}
	const segments = value.split('/');
	if (segments.some((segment) => segment === '' || segment === '.' || segment === '..')) {
		throw new Error('Git file path cannot contain empty, ".", or ".." segments');
	}
	return segments.join('/');
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
	return result.stdout.replace(/\n$/, '');
}

// Local-only workspace files are untracked. Older workspaces also appended their
// exclusions to the tracked .gitignore; tolerate that one dirty file, but never
// overwrite or commit it as part of a compose-file push.
async function assertSafeCheckout(repoPath: string, env: GitEnv): Promise<void> {
	const status = await gitStatus(repoPath, env);
	if (status.split('\n').some((line) => line && !line.startsWith('?? ') && line !== ' M .gitignore')) {
		throw new Error('Git checkout has other changes; resolve them before pushing');
	}
	if (status.split('\n').includes(' M .gitignore')) {
		const committed = await execGit(['show', 'HEAD:.gitignore'], repoPath, env);
		const current = readFileSync(join(repoPath, '.gitignore'), 'utf8');
		const prefix = committed.stdout + (committed.stdout && !committed.stdout.endsWith('\n') ? '\n' : '');
		const additions = current.startsWith(prefix) ? current.slice(prefix.length).trimEnd().split('\n') : [];
		if (committed.code !== 0 || !additions.length || additions.some((line) => !/^\/[^\s]+$/.test(line))) {
			throw new Error('Git checkout has other changes; resolve them before pushing');
		}
	}
}

async function rollback(
	repoPath: string,
	env: GitEnv,
	oldHead: string,
	untrackedSnapshots: Map<string, Buffer | null>,
	localIgnore: Buffer | null
): Promise<void> {
	await execGit(['reset', '--hard', oldHead], repoPath, env);
	if (localIgnore) writeFileSync(join(repoPath, '.gitignore'), localIgnore);
	for (const [path, content] of untrackedSnapshots) {
		const target = resolve(repoPath, ...path.split('/'));
		if (content === null) {
			await execGit(['clean', '-f', '--', path], repoPath, env);
		} else {
			writeFileSync(target, content);
		}
	}
	await assertSafeCheckout(repoPath, env);
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
		let localIgnore: Buffer | null = null;
		try {
			await assertSafeCheckout(options.repoPath, env);
			if ((await gitStatus(options.repoPath, env)).split('\n').includes(' M .gitignore')) {
				localIgnore = readFileSync(join(options.repoPath, '.gitignore'));
			}
			const fetch = await execGit(['fetch', 'origin', options.branch], options.repoPath, env);
			if (fetch.code !== 0) throw new Error(`Git fetch failed: ${fetch.stderr}`);
			// Compare against the fetched branch *before* moving the checkout. A remote
			// edit to the same file must not be silently overwritten by this draft.
			for (const change of options.changes) {
				const path = repoRelativePath(options.repoPath, change.path);
				const remote = await execGit(['show', `origin/${options.branch}:${path}`], options.repoPath, env);
				if (remote.code === 0 && contentRevision(remote.stdout) !== change.expectedRevision) {
					throw Object.assign(new Error(`Git file changed on the remote; reload ${change.path} and retry`), { status: 409 });
				}
				if (remote.code !== 0 && (await classifyPath(options.repoPath, path, env)).tracked) {
					throw Object.assign(new Error(`Git file was removed on the remote; reload ${change.path} and retry`), { status: 409 });
				}
			}
			const checkout = await execGit(['checkout', '-B', options.branch, `origin/${options.branch}`], options.repoPath, env);
			if (checkout.code !== 0) throw new Error(`Git checkout failed: ${checkout.stderr}`);
			const head = await execGit(['rev-parse', 'HEAD'], options.repoPath, env);
			if (head.code !== 0) throw new Error(`Unable to resolve Git HEAD: ${head.stderr}`);
			oldHead = head.stdout.trim();

			const classifications: GitFileClassification[] = [];
			const changedPaths = new Set<string>();
			for (const change of options.changes) {
				const path = repoRelativePath(options.repoPath, change.path);
				if (Buffer.byteLength(change.content, 'utf8') > MAX_GIT_FILE_SIZE || change.content.includes('\0')) throw new Error(`Invalid text content for Git file: ${change.path}`);
				const target = resolveSafeGitFileTarget(options.repoPath, path);
				const classification = await classifyPath(options.repoPath, path, env);
				// Newly-created untracked draft files have no repository revision yet.
				// Existing and tracked files still require the optimistic-concurrency hash.
				if (!change.expectedRevision && (classification.tracked || existsSync(target))) throw new Error(`Git file revision is required: ${change.path}`);
				if ((existsSync(target) && contentRevision(readFileSync(target)) !== change.expectedRevision) || (!existsSync(target) && classification.tracked)) {
					throw new Error(`Git file changed since it was loaded: ${change.path}`);
				}
				if (!existsSync(target) || contentRevision(readFileSync(target)) !== contentRevision(change.content)) changedPaths.add(path);
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
			const pathsToCommit = classifications.filter((entry) => changedPaths.has(entry.path) && (entry.tracked ? shouldMutateTracked : shouldMutateUntracked)).map((entry) => entry.path);
			for (const change of options.changes) {
				const path = repoRelativePath(options.repoPath, change.path);
				const classification = classifications.find((entry) => entry.path === path)!;
				if (!changedPaths.has(path)) continue;
				if (classification.tracked || options.untrackedDecision !== 'add') continue;
				const target = resolveSafeGitFileTarget(options.repoPath, path);
				untrackedSnapshots.set(path, existsSync(target) ? readFileSync(target) : null);
			}
			for (const change of options.changes) {
				const path = repoRelativePath(options.repoPath, change.path);
				const classification = classifications.find((entry) => entry.path === path)!;
				if (!changedPaths.has(path)) continue;
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
			if (newHead.code !== 0) throw new Error('Unable to resolve Git HEAD after push');
			await assertSafeCheckout(options.repoPath, env);
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
				try { await rollback(options.repoPath, env, oldHead, untrackedSnapshots, localIgnore); } catch (rollbackError) { throw new Error(`${error instanceof Error ? error.message : String(error)}; rollback failed: ${rollbackError instanceof Error ? rollbackError.message : String(rollbackError)}`); }
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
