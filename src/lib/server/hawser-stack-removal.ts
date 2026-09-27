/**
 * Stack removal on a Hawser-owned directory.
 *
 * Hawser is the only filesystem authority, so Dockhand can no longer list "every file it
 * ever wrote" from a local staging mirror. Removal therefore deletes only files whose
 * ownership is provable, each with a revision check, and never walks the directory:
 *   - the bound ordered Compose files and the Compose-adjacent `.env` / `.env.dockhand`
 *     plus the configured env file (Dockhand-managed configuration);
 *   - for Git stacks, published files recorded in the sync manifest whose remote bytes
 *     still match the recorded hash (hash-guarded, same policy as Git deletion sync).
 * Everything else (relative bind data, host-only files) stays. An in-place adopted root
 * is the user's own directory: nothing in it is deleted. Pure apart from the client.
 */
import { posix } from 'node:path';
import type { HawserStackFileClient } from './hawser-stack-file-types';

export interface HawserRemovalInput {
	composeFileNames: string[];
	/** Configured env file relative to the bound root, when it lies inside it. */
	envFileName?: string | null;
	/** Git sync manifest { relativePath: sha256 } of files published on the last sync. */
	gitManifest?: Record<string, string>;
}

export interface HawserRemovalPlan {
	/** Paths Dockhand owns outright (configuration it wrote). */
	owned: string[];
	/** Git-published paths, deleted only when their remote revision matches. */
	guarded: Record<string, string>;
}

const safe = (path: string) => !!path && !path.startsWith('/') && !path.split('/').includes('..') && !path.includes('\0');

export function planHawserStackRemoval(input: HawserRemovalInput): HawserRemovalPlan {
	const owned = new Set<string>();
	for (const name of input.composeFileNames) if (safe(name)) owned.add(name);
	const primaryDir = input.composeFileNames[0] ? posix.dirname(input.composeFileNames[0]) : '.';
	for (const sibling of ['.env', '.env.dockhand']) {
		owned.add(primaryDir === '.' ? sibling : posix.join(primaryDir, sibling));
	}
	if (input.envFileName && safe(input.envFileName)) owned.add(input.envFileName);
	const guarded: Record<string, string> = {};
	for (const [path, hash] of Object.entries(input.gitManifest ?? {})) {
		if (safe(path) && !owned.has(path) && /^[a-f0-9]{64}$/.test(hash)) guarded[path] = hash;
	}
	return { owned: [...owned].sort(), guarded };
}

const status = (error: unknown) => (error && typeof error === 'object' && 'status' in error ? Number(error.status) : 0);

/** Apply a removal plan; returns human-readable notes for anything intentionally kept. */
export async function removeHawserStackFiles(
	client: HawserStackFileClient,
	plan: HawserRemovalPlan
): Promise<{ deleted: string[]; kept: string[] }> {
	const deleted: string[] = [];
	const kept: string[] = [];
	const remove = async (path: string, expected?: string) => {
		let entry;
		try { entry = await client.stat(path); }
		catch (error) {
			if (status(error) === 404) return;
			kept.push(`${path} (${error instanceof Error ? error.message : String(error)})`);
			return;
		}
		if (entry.type !== 'file') { kept.push(`${path} (not a regular file)`); return; }
		if (expected && entry.revision !== expected) { kept.push(`${path} (modified on the host since the last Git sync)`); return; }
		try {
			await client.delete(path, entry.revision);
			deleted.push(path);
		} catch (error) {
			kept.push(`${path} (${error instanceof Error ? error.message : String(error)})`);
		}
	};
	for (const path of plan.owned) await remove(path);
	for (const [path, hash] of Object.entries(plan.guarded)) await remove(path, hash);
	// Remove directories that became empty, deepest first. A non-empty directory
	// (host data) makes Hawser refuse, which is exactly the intent.
	const directories = new Set<string>();
	for (const path of deleted) {
		for (let dir = posix.dirname(path); dir !== '.'; dir = posix.dirname(dir)) directories.add(dir);
	}
	for (const dir of [...directories].sort((a, b) => b.split('/').length - a.split('/').length)) {
		try { await client.delete(dir); } catch { /* not empty or already gone */ }
	}
	return { deleted: deleted.sort(), kept };
}
