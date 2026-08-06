import { json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { statSync, readdirSync, existsSync, realpathSync } from 'node:fs';
import { join, resolve, isAbsolute, relative } from 'node:path';
import { getGitRepository } from '$lib/server/db';
import { syncRepositoryExclusive, getRepoPath } from '$lib/server/git';
import { getGitMode } from '$lib/server/git-mode';
import { authorize } from '$lib/server/authorize';
import { isPathUnderRoot } from '$lib/server/path-utils';

interface FileEntry {
	name: string;
	/** Path relative to the repository root ('' = root). Never absolute. */
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
 * The `path` query parameter is optional (relative to the repo root, or an
 * absolute path previously returned by this endpoint) — defaults to the
 * repository root. All paths are validated to stay within the clone root
 * (no directory traversal, no symlink escape, no .git internals).
 *
 * All paths in the response are RELATIVE to the repository root, so the
 * host filesystem layout (DATA_DIR etc.) is never exposed.
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

	// Browse operates on the shared clone — a centralized-mode concept. Stack
	// mode uses the host-filesystem browser instead.
	if (await getGitMode() !== 'centralized') {
		return json({ error: 'Repository browsing is not available in stack mode' }, { status: 404 });
	}

	const repoRoot = getRepoPath(repo.name);

	// Always sync (clone or pull) before listing so the browser shows up-to-date content.
	// syncRepositoryExclusive joins any in-flight syncs (e.g. from just adding the repository).
	console.log(`[BrowseAPI] Syncing repository ${id} before browse`);
	const syncResult = await syncRepositoryExclusive(id);
	if (!syncResult.success) {
		return json({ error: `Failed to sync repository: ${syncResult.error}` }, { status: 500 });
	}

	// Resolve the requested path (default to repo root). Relative paths are
	// joined with the repo root; absolute paths are accepted so navigation
	// works with previously returned entry paths, but they are re-validated
	// against the (realpath'd) root below before anything is listed.
	const requestedPath = url.searchParams.get('path') || '';
	let targetPath: string;

	if (!requestedPath || requestedPath === '/') {
		targetPath = repoRoot;
	} else if (isAbsolute(requestedPath)) {
		targetPath = requestedPath;
	} else {
		targetPath = join(repoRoot, requestedPath);
	}

	// Resolve to eliminate any `..` components, then guard against traversal.
	// Use realpath so a symlink inside the clone cannot escape to a sibling repo
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
	if (!isPathUnderRoot(realTarget, realRoot)) {
		return json({ error: 'Access denied: path is outside repository root' }, { status: 403 });
	}

	// Never expose git internals, even when requested directly (the listing
	// below hides .git, but a crafted request could still target it).
	const gitDir = join(realRoot, '.git');
	if (isPathUnderRoot(realTarget, gitDir)) {
		return json({ error: 'Access denied: .git is not browsable' }, { status: 403 });
	}

	const stat = statSync(realTarget);
	if (!stat.isDirectory()) {
		return json({ error: 'Not a directory' }, { status: 400 });
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
					path: relative(realRoot, fullPath),
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

		return json({
			path: relative(realRoot, realTarget),
			parent: realTarget === realRoot ? null : relative(realRoot, resolve(realTarget, '..')),
			entries
		});
	} catch (error) {
		console.error('[BrowseAPI] Error listing directory:', error);
		return json({ error: 'Failed to list directory' }, { status: 500 });
	}
};
