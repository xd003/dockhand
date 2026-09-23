import { cp, lstat, mkdir, readdir, realpath, rename, rm } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';

export const STACK_WORKSPACE_HIDDEN = new Set(['.git', 'node_modules', 'vendor', 'dist', 'build']);
export const MAX_STACK_WORKSPACE_TEXT_SIZE = 10 * 1024 * 1024;

export function normalizeWorkspacePath(value: unknown, allowRoot = false): string {
	if (typeof value !== 'string' || value.includes('\0') || value.includes('\\') || isAbsolute(value) || /^[A-Za-z]:/.test(value)) {
		throw new Error('Path must be relative to the stack directory');
	}
	const path = value.replace(/^\.\//, '').replace(/\/$/, '');
	if (!path && allowRoot) return '';
	const parts = path.split('/');
	if (!path || parts.some((part) => !part || part === '.' || part === '..') || parts.some((part) => STACK_WORKSPACE_HIDDEN.has(part))) {
		throw new Error('Invalid workspace path');
	}
	return parts.join('/');
}

export async function resolveWorkspacePath(root: string, value: unknown, options: { allowRoot?: boolean; existing?: boolean } = {}): Promise<string> {
	const path = normalizeWorkspacePath(value, options.allowRoot);
	const canonicalRoot = await realpath(root);
	const target = resolve(canonicalRoot, ...path.split('/').filter(Boolean));
	const rel = relative(canonicalRoot, target);
	if (rel.startsWith(`..${sep}`) || rel === '..' || isAbsolute(rel)) throw new Error('Path escapes the stack directory');
	if (options.existing !== false) {
		const canonicalTarget = await realpath(target);
		const canonicalRel = relative(canonicalRoot, canonicalTarget);
		if (canonicalRel.startsWith(`..${sep}`) || canonicalRel === '..' || isAbsolute(canonicalRel)) throw new Error('Path escapes the stack directory');
		if ((await lstat(target)).isSymbolicLink()) throw new Error('Symbolic links are not available in the workspace');
	} else {
		let parent = dirname(target);
		while (parent !== canonicalRoot) {
			try {
				const canonicalParent = await realpath(parent);
				const parentRel = relative(canonicalRoot, canonicalParent);
				if (parentRel.startsWith(`..${sep}`) || parentRel === '..' || isAbsolute(parentRel)) throw new Error('Path escapes the stack directory');
				break;
			} catch (error) {
				if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
				const next = dirname(parent);
				if (next === parent) throw new Error('Path escapes the stack directory');
				parent = next;
			}
		}
	}
	return target;
}

export interface WorkspaceEntry {
	path: string;
	name: string;
	type: 'file' | 'directory';
	size: number;
}

export function workspaceRevision(content: Buffer | string): string {
	return createHash('sha256').update(content).digest('hex');
}

/** Keep an existing deployment directory (and its bind mounts) in place while retaining local files. */
export async function withInternalStackDirectory(root: string, destination: string, save: () => Promise<void>): Promise<void> {
	await mkdir(dirname(destination), { recursive: true });
	const gitDir = join(root, '.git');
	const filter = (path: string) => path !== gitDir && !path.startsWith(`${gitDir}${sep}`);
	let existing = false;
	try {
		const stats = await lstat(destination);
		if (!stats.isDirectory()) throw new Error('Stack directory is not a directory');
		existing = true;
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
	}
	if (existing) {
		await cp(root, destination, { recursive: true, filter });
		await save();
		return;
	}
	const staging = `${destination}.dockhand-${crypto.randomUUID()}.tmp`;
	let installed = false;
	try {
		await cp(root, staging, { recursive: true, filter });
		await rename(staging, destination);
		installed = true;
		await save();
	} catch (error) {
		if (installed) await rename(destination, staging);
		await rm(staging, { recursive: true, force: true });
		throw error;
	}
}

export async function listWorkspace(root: string, path = ''): Promise<WorkspaceEntry[]> {
	const directory = await resolveWorkspacePath(root, path, { allowRoot: true });
	if (!(await lstat(directory)).isDirectory()) throw new Error('Workspace path is not a directory');
	const entries = await readdir(directory, { withFileTypes: true });
	const visible = entries.filter((entry) => !STACK_WORKSPACE_HIDDEN.has(entry.name) && !entry.isSymbolicLink());
	return Promise.all(visible.map(async (entry) => {
		const childPath = path ? `${path}/${entry.name}` : entry.name;
		const stats = await lstat(resolve(directory, entry.name));
		return { path: childPath, name: entry.name, type: entry.isDirectory() ? 'directory' as const : 'file' as const, size: stats.size };
	})).then((items) => items.sort((a, b) => Number(a.type === 'file') - Number(b.type === 'file') || a.name.localeCompare(b.name)));
}

export function isBinaryWorkspaceContent(content: Buffer): boolean {
	if (content.includes(0)) return true;
	try {
		new TextDecoder('utf-8', { fatal: true }).decode(content);
		return false;
	} catch {
		return true;
	}
}
