import { json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { statSync, readdirSync, existsSync, realpathSync } from 'node:fs';
import { join, resolve, isAbsolute, relative, sep } from 'node:path';
import { getGitRepository } from '$lib/server/db';
import { syncRepositoryExclusive, getRepoClonePath } from '$lib/server/git';
import { authorize } from '$lib/server/authorize';
import { isPathInside } from '$lib/server/git-url-safety';

interface FileEntry {
	name: string;
	/** Repo-root-relative path (e.g. "services/web"). Never an absolute host path. */
	path: string;
	type: 'file' | 'directory' | 'symlink';
	size: number;
	mtime: string;
	mode: string;
}

/**
 * GET /api/git/repositories/:id/browse?path=
 *
 * Lists the contents of a cloned git repository directory.
 * If the repository is not yet cloned, a blocking clone is triggered first
 * (so the first browse request is the only one that waits for cloning).
 *
 * The `path` query parameter is optional — defaults to the repository root.
 * It MUST be a repo-root-relative path (e.g. "services/web"); absolute paths
 * are rejected with 400. All paths are validated server-side to stay within
 * the clone root (no directory traversal). The response also uses relative
 * paths throughout so no host filesystem layout is disclosed to the client.
 */
export const GET: RequestHandler = async ({ params, url, cookies }) => {
	const auth = await authorize(cookies);
	if (auth.authEnabled && !await auth.can('git', 'view')) {
		return json({ error: 'Permission denied' }, { status: 403 });
	}

	const id = parseInt(params.id);
	if (isNaN(id)) {
		return json({ error: 'Invalid repository ID' }, { status: 400 });
	}

	const repo = await getGitRepository(id);
	if (!repo) {
		return json({ error: 'Repository not found' }, { status: 404 });
	}

	const repoRoot = getRepoClonePath(repo.name);

	// Always sync (clone or pull) before listing so the browser shows up-to-date content.
	// syncRepositoryExclusive joins any in-flight syncs (e.g. from just adding the repository).
	console.log(`[BrowseAPI] Syncing repository ${id} before browse`);
	const syncResult = await syncRepositoryExclusive(id);
	if (!syncResult.success) {
		return json({ error: `Failed to sync repository: ${syncResult.error}` }, { status: 500 });
	}

	// Resolve the requested path (default to repo root).
	// Only relative paths are accepted from the client — absolute paths are rejected
	// so the client cannot influence which host directory is read.
	const requestedPath = url.searchParams.get('path') || '';

	if (requestedPath && isAbsolute(requestedPath)) {
		return json({ error: 'Invalid path: must be a relative path within the repository' }, { status: 400 });
	}

	// Join relative path with repo root (empty string → repo root itself).
	const targetPath = requestedPath ? join(repoRoot, requestedPath) : repoRoot;

	// Resolve to eliminate any `..` components, then guard against traversal.
	// Use realpathSync so a symlink inside the clone cannot escape to a sibling repo
	// or host path; use sep-aware containment so `/repos/myrepo2` is not treated
	// as inside `/repos/myrepo`.
	const resolvedTarget = resolve(targetPath);
	if (!existsSync(resolvedTarget)) {
		return json({ error: 'Path not found' }, { status: 404 });
	}

	let realRoot: string;
	let realTarget: string;
	try {
		realRoot = realpathSync(repoRoot);
		realTarget = realpathSync(resolvedTarget);
	} catch {
		return json({ error: 'Access denied: unable to resolve path' }, { status: 403 });
	}
	if (!isPathInside(realTarget, realRoot)) {
		return json({ error: 'Access denied: path is outside repository root' }, { status: 403 });
	}

	const stat = statSync(realTarget);
	if (!stat.isDirectory()) {
		return json({ error: 'Not a directory' }, { status: 400 });
	}

	// Helper: convert an absolute on-disk path to a repo-root-relative string.
	// Returns '' for the root itself.
	function toRelative(absPath: string): string {
		const rel = relative(realRoot, absPath);
		// relative() on the same path returns ''; normalize to '' (root sentinel).
		return rel === '.' ? '' : rel;
	}

	try {
		const entries: FileEntry[] = [];
		const dirEntries = readdirSync(realTarget, { withFileTypes: true });

		for (const entry of dirEntries) {
			// Hide the .git directory from the browser
			if (entry.name === '.git') continue;

			try {
				const fullPath = join(realTarget, entry.name);
				const entryStat = statSync(fullPath);

				entries.push({
					name: entry.name,
					path: toRelative(fullPath),
					type: entry.isDirectory() ? 'directory' : entry.isSymbolicLink() ? 'symlink' : 'file',
					size: entryStat.size,
					mtime: entryStat.mtime.toISOString(),
					mode: (entryStat.mode & 0o777).toString(8).padStart(3, '0')
				});
			} catch {
				// Skip entries we can't stat
			}
		}

		// Sort: directories first, then alphabetically
		entries.sort((a, b) => {
			if (a.type === 'directory' && b.type !== 'directory') return -1;
			if (a.type !== 'directory' && b.type === 'directory') return 1;
			return a.name.localeCompare(b.name);
		});

		const currentRelPath = toRelative(realTarget);
		const isRoot = currentRelPath === '';

		// Compute parent as a relative path; null at the repo root.
		const parentRelPath = isRoot
			? null
			: toRelative(resolve(realTarget, '..'));

		return json({
			/** Repo-root-relative path of the listed directory. '' means the root. */
			path: currentRelPath,
			/** True when the listed directory is the repository root. */
			isRoot,
			/** Repo-root-relative path of the parent directory, or null at the root. */
			parent: parentRelPath,
			entries
		});
	} catch (error) {
		console.error('[BrowseAPI] Error listing directory:', error);
		const message = error instanceof Error ? error.message : 'Unknown error';
		return json({ error: `Failed to list directory: ${message}` }, { status: 500 });
	}
};
