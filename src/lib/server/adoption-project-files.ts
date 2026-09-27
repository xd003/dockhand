/**
 * Files of an existing Compose project directory that is being converted to Git in place.
 * The Git stack workspace shows them next to the checkout files, and the edits made there
 * are applied to the directory right before Compose runs, with rollback on failure.
 */
import { lstat, mkdir, readFile, rename, rm, rmdir, writeFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { dirname } from 'node:path';
import type { HawserStackFileClient } from './hawser-stack-file-types';
import { isBinaryWorkspaceContent, listWorkspace, MAX_STACK_WORKSPACE_TEXT_SIZE, normalizeWorkspacePath, resolveWorkspacePath, STACK_WORKSPACE_HIDDEN, workspaceRevision } from './stack-workspace';

export interface ProjectEntry { path: string; name: string; type: 'file' | 'directory'; size: number }
export interface ProjectFile { content: Buffer; revision: string }

/** Relative-path file access confined to one project directory (Dockhand's filesystem or a Hawser root). */
export interface ProjectFileStore {
	list(path: string): Promise<ProjectEntry[]>;
	stat(path: string): Promise<'file' | 'directory' | null>;
	read(path: string): Promise<ProjectFile | null>;
	/** `expectedRevision`: string = must match, null = must not exist, undefined = overwrite. */
	write(path: string, content: Buffer, expectedRevision?: string | null): Promise<void>;
	mkdir(path: string): Promise<void>;
	move(path: string, destination: string): Promise<void>;
	/** Remove a file or an empty directory. */
	remove(path: string): Promise<void>;
	removeTree(path: string): Promise<void>;
}

function conflict(message: string): Error {
	return Object.assign(new Error(message), { status: 409 });
}

function isMissing(error: unknown): boolean {
	return !!error && typeof error === 'object' && (('code' in error && error.code === 'ENOENT') || ('status' in error && error.status === 404));
}

export function localProjectFiles(root: string): ProjectFileStore {
	async function stat(path: string): Promise<'file' | 'directory' | null> {
		try {
			const stats = await lstat(await resolveWorkspacePath(root, path));
			return stats.isDirectory() ? 'directory' : 'file';
		} catch (error) {
			if (isMissing(error)) return null;
			throw error;
		}
	}
	async function read(path: string): Promise<ProjectFile | null> {
		let target: string;
		try { target = await resolveWorkspacePath(root, path); } catch (error) { if (isMissing(error)) return null; throw error; }
		const stats = await lstat(target);
		if (!stats.isFile()) throw new Error(`Not a regular file: ${path}`);
		if (stats.size > MAX_STACK_WORKSPACE_TEXT_SIZE) throw new Error(`File exceeds the 10 MiB workspace limit: ${path}`);
		const content = await readFile(target);
		return { content, revision: workspaceRevision(content) };
	}
	return {
		async list(path) {
			return (await listWorkspace(root, path)).map(({ path, name, type, size }) => ({ path, name, type, size }));
		},
		stat,
		read,
		async write(path, content, expectedRevision) {
			const current = await read(path);
			if (expectedRevision === null && current) throw conflict(`File was created since the workspace was loaded: ${path}`);
			if (typeof expectedRevision === 'string' && current?.revision !== expectedRevision) throw conflict(`File changed since it was loaded: ${path}`);
			const target = await resolveWorkspacePath(root, path, { existing: false });
			await mkdir(dirname(target), { recursive: true, mode: 0o755 });
			const mode = current ? (await lstat(target)).mode & 0o7777 : 0o640;
			const temporary = `${target}.dockhand-${randomUUID()}.tmp`;
			try {
				await writeFile(temporary, content, { mode });
				await rename(temporary, target);
			} finally {
				await rm(temporary, { force: true });
			}
		},
		async mkdir(path) {
			await mkdir(await resolveWorkspacePath(root, path, { existing: false }), { recursive: true, mode: 0o755 });
		},
		async move(path, destination) {
			const source = await resolveWorkspacePath(root, path);
			const target = await resolveWorkspacePath(root, destination, { existing: false });
			if (await stat(destination)) throw conflict(`Destination already exists: ${destination}`);
			await mkdir(dirname(target), { recursive: true, mode: 0o755 });
			await rename(source, target);
		},
		async remove(path) {
			const target = await resolveWorkspacePath(root, path);
			if ((await lstat(target)).isDirectory()) await rmdir(target);
			else await rm(target);
		},
		async removeTree(path) {
			await rm(await resolveWorkspacePath(root, path), { recursive: true });
		}
	};
}

/** Scoped recursive delete: Hawser removes one revision-checked file or empty directory per call. */
export async function removeHawserTree(remote: HawserStackFileClient, path: string): Promise<void> {
	const entry = await remote.stat(path);
	if (entry.type === 'directory') {
		for (const child of await remote.list(path)) await removeHawserTree(remote, child.path);
		await remote.delete(path);
	} else await remote.delete(path, entry.revision);
}

export function hawserProjectFiles(remote: HawserStackFileClient): ProjectFileStore {
	async function entry(path: string) {
		try { return await remote.stat(path); } catch (error) { if (isMissing(error)) return null; throw error; }
	}
	async function read(path: string): Promise<ProjectFile | null> {
		try {
			const file = await remote.read(path);
			return { content: Buffer.from(file.content), revision: file.revision };
		} catch (error) {
			if (isMissing(error)) return null;
			throw error;
		}
	}
	return {
		async list(path) {
			return (await remote.list(path))
				.map((item) => ({ path: item.path, name: item.path.split('/').at(-1)!, type: item.type, size: item.size ?? 0 }))
				.filter((item) => !STACK_WORKSPACE_HIDDEN.has(item.name))
				.sort((a, b) => Number(a.type === 'file') - Number(b.type === 'file') || a.name.localeCompare(b.name));
		},
		async stat(path) {
			return (await entry(path))?.type ?? null;
		},
		read,
		async write(path, content, expectedRevision) {
			// Hawser compares revisions itself; an absent revision requires the file not to exist.
			const revision = expectedRevision === undefined ? (await read(path))?.revision : expectedRevision ?? undefined;
			try {
				await remote.write(path, content, revision);
			} catch (error) {
				if (error && typeof error === 'object' && 'status' in error && error.status === 409) throw conflict(`File changed since it was loaded: ${path}`);
				throw error;
			}
		},
		async mkdir(path) {
			if (!(await entry(path))) await remote.mkdir(path);
		},
		async move(path, destination) {
			const item = await remote.stat(path);
			await remote.move(path, destination, item.type === 'file' ? item.revision : undefined);
		},
		async remove(path) {
			const item = await remote.stat(path);
			await remote.delete(path, item.type === 'file' ? item.revision : undefined);
		},
		async removeTree(path) {
			await removeHawserTree(remote, path);
		}
	};
}

export async function readProjectFile(store: ProjectFileStore, path: string): Promise<{ binary: boolean; content?: string; contentBase64?: string; revision: string; size: number }> {
	const file = await store.read(normalizeWorkspacePath(path));
	if (!file) throw Object.assign(new Error(`File not found: ${path}`), { status: 404 });
	const size = file.content.byteLength;
	return isBinaryWorkspaceContent(file.content)
		? { binary: true, contentBase64: file.content.toString('base64'), revision: file.revision, size }
		: { binary: false, content: new TextDecoder().decode(file.content), revision: file.revision, size };
}

export interface ProjectFileWrite { path: string; content: Buffer; expectedRevision?: string | null }
export interface ProjectFileDeletion { path: string; expectedRevision?: string }
export interface ProjectFileChanges { writes: ProjectFileWrite[]; deletions: ProjectFileDeletion[]; folders: string[] }

/** Validate the client's local-file changes; throws on malformed input. */
export function parseProjectFileChanges(value: unknown): ProjectFileChanges | null {
	if (value == null) return null;
	if (typeof value !== 'object' || Array.isArray(value)) throw new Error('localChanges must be an object');
	const input = value as { writes?: unknown; deletions?: unknown; folders?: unknown };
	const list = (field: unknown, name: string): unknown[] => {
		if (field == null) return [];
		if (!Array.isArray(field)) throw new Error(`localChanges.${name} must be an array`);
		return field;
	};
	const revision = (item: Record<string, unknown>, allowNull: boolean): string | null | undefined => {
		const expected = item.expectedRevision;
		if (expected === undefined || (allowNull && expected === null) || (typeof expected === 'string' && /^[0-9a-f]{64}$/.test(expected))) return expected as string | null | undefined;
		throw new Error(`Invalid file revision: ${String(item.path)}`);
	};
	const writes = list(input.writes, 'writes').map((raw) => {
		if (!raw || typeof raw !== 'object') throw new Error('Invalid local file write');
		const item = raw as Record<string, unknown>;
		const path = normalizeWorkspacePath(item.path);
		let content: Buffer;
		if (typeof item.content === 'string') {
			if (item.content.includes('\0')) throw new Error(`Invalid text content: ${path}`);
			content = Buffer.from(item.content, 'utf8');
		} else if (typeof item.contentBase64 === 'string') content = Buffer.from(item.contentBase64, 'base64');
		else throw new Error(`Local file content is required: ${path}`);
		if (content.byteLength > MAX_STACK_WORKSPACE_TEXT_SIZE) throw new Error(`File exceeds the 10 MiB workspace limit: ${path}`);
		return { path, content, expectedRevision: revision(item, true) };
	});
	const deletions = list(input.deletions, 'deletions').map((raw) => {
		if (!raw || typeof raw !== 'object') throw new Error('Invalid local file deletion');
		const item = raw as Record<string, unknown>;
		return { path: normalizeWorkspacePath(item.path), expectedRevision: revision(item, false) ?? undefined };
	});
	const folders = list(input.folders, 'folders').map((path) => normalizeWorkspacePath(path));
	return writes.length || deletions.length || folders.length ? { writes, deletions, folders } : null;
}

export interface AppliedProjectFileChanges {
	/** Drop the backups of deleted items; call once Compose succeeded. */
	commit(): Promise<void>;
	/** Restore every touched path to its previous state. */
	rollback(): Promise<void>;
}

/**
 * Apply deletions (moved into a trash directory so they can be restored), folders, then
 * writes. Every change is revision-checked against what the workspace loaded.
 */
export async function applyProjectFileChanges(store: ProjectFileStore, changes: ProjectFileChanges): Promise<AppliedProjectFileChanges> {
	const trash = `.dockhand-trash-${randomUUID()}`;
	const undo: Array<() => Promise<void>> = [];
	let trashCreated = false;
	const rollback = async () => {
		const errors: string[] = [];
		for (const step of undo.reverse()) {
			try { await step(); } catch (error) { errors.push(error instanceof Error ? error.message : String(error)); }
		}
		undo.length = 0;
		if (errors.length) throw new Error(`Could not restore project files: ${errors.join('; ')}`);
	};
	try {
		const deletions = changes.deletions.filter((deletion) => !changes.deletions.some((other) => deletion.path.startsWith(`${other.path}/`)));
		if (deletions.length) {
			await store.mkdir(trash);
			trashCreated = true;
			undo.push(() => store.removeTree(trash));
		}
		for (const deletion of deletions) {
			const type = await store.stat(deletion.path);
			if (!type) continue;
			if (type === 'file' && deletion.expectedRevision && (await store.read(deletion.path))?.revision !== deletion.expectedRevision) {
				throw conflict(`File changed since it was loaded: ${deletion.path}`);
			}
			await store.move(deletion.path, `${trash}/${deletion.path}`);
			undo.push(() => store.move(`${trash}/${deletion.path}`, deletion.path));
		}
		// Record every directory this apply creates, including a written file's parents.
		const ensureFolder = async (folder: string) => {
			const missing: string[] = [];
			for (let current = folder; current; current = current.includes('/') ? current.slice(0, current.lastIndexOf('/')) : '') {
				const type = await store.stat(current);
				if (type === 'directory') break;
				if (type) throw conflict(`Not a directory: ${current}`);
				missing.unshift(current);
			}
			if (!missing.length) return;
			await store.mkdir(folder);
			for (const created of missing) undo.push(() => store.remove(created));
		};
		for (const folder of changes.folders) await ensureFolder(folder);
		for (const write of changes.writes) {
			if (write.path.includes('/')) await ensureFolder(write.path.slice(0, write.path.lastIndexOf('/')));
			const previous = await store.read(write.path);
			await store.write(write.path, write.content, write.expectedRevision);
			undo.push(previous
				? () => store.write(write.path, previous.content)
				: () => store.remove(write.path));
		}
	} catch (error) {
		try { await rollback(); } catch (rollbackError) {
			throw new Error(`${error instanceof Error ? error.message : String(error)}; ${rollbackError instanceof Error ? rollbackError.message : String(rollbackError)}`);
		}
		throw error;
	}
	return {
		async commit() {
			undo.length = 0;
			if (trashCreated) await store.removeTree(trash);
		},
		rollback
	};
}
