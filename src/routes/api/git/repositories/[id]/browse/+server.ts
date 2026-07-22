import { json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { statSync, readdirSync, existsSync } from 'node:fs';
import { join, resolve, isAbsolute } from 'node:path';
import { getGitRepository } from '$lib/server/db';
import { syncRepositoryExclusive, getRepoClonePath } from '$lib/server/git';
import { authorize } from '$lib/server/authorize';

interface FileEntry {
	name: string;
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
 * All paths are validated to stay within the clone root (no directory traversal).
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

	// Resolve the requested path (default to repo root)
	const requestedPath = url.searchParams.get('path') || '';
	let targetPath: string;

	if (!requestedPath || requestedPath === '/') {
		targetPath = repoRoot;
	} else if (isAbsolute(requestedPath)) {
		// Caller passed an absolute path (after receiving repoRoot from a prior response)
		targetPath = requestedPath;
	} else {
		// Relative path — join with repo root
		targetPath = join(repoRoot, requestedPath);
	}

	// Resolve to eliminate any `..` components, then guard against traversal
	const resolvedTarget = resolve(targetPath);
	if (!resolvedTarget.startsWith(repoRoot)) {
		return json({ error: 'Access denied: path is outside repository root' }, { status: 403 });
	}

	if (!existsSync(resolvedTarget)) {
		return json({ error: `Path not found: ${resolvedTarget}` }, { status: 404 });
	}

	const stat = statSync(resolvedTarget);
	if (!stat.isDirectory()) {
		return json({ error: `Not a directory: ${resolvedTarget}` }, { status: 400 });
	}

	try {
		const entries: FileEntry[] = [];
		const dirEntries = readdirSync(resolvedTarget, { withFileTypes: true });

		for (const entry of dirEntries) {
			// Hide the .git directory from the browser
			if (entry.name === '.git') continue;

			try {
				const fullPath = join(resolvedTarget, entry.name);
				const entryStat = statSync(fullPath);

				entries.push({
					name: entry.name,
					path: fullPath,
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
			path: resolvedTarget,
			// Expose the root so the client can compute relative paths
			repoRoot,
			parent: resolvedTarget === repoRoot ? null : resolve(resolvedTarget, '..'),
			entries
		});
	} catch (error) {
		console.error('[BrowseAPI] Error listing directory:', error);
		const message = error instanceof Error ? error.message : 'Unknown error';
		return json({ error: `Failed to list directory: ${message}` }, { status: 500 });
	}
};
