import { chmodSync, closeSync, existsSync, fsyncSync, lstatSync, mkdirSync, mkdtempSync, openSync, readdirSync, readFileSync, realpathSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { createHash } from 'node:crypto';
import { getStackComposeFile, getStackDir, withStackLock } from './stacks';
import { getStackLinkedFiles, getStackSource, updateStackSource } from './db';
import { getRepoPath } from './git';
import { getStackRepoPath } from './git-stack';
import { isProtectedPath } from './fs-guard';
import {
	MAX_LINKED_FILE_SIZE,
	defaultLinkedFilePostChange,
	linkedFileLanguage,
	normalizeLinkedFile,
	normalizeLinkedFiles,
	normalizeLinkedPath,
	type LinkedStackFile
} from '../stack-linked-files';

export interface StackFileEntry {
	path: string;
	name: string;
	kind: 'compose' | 'linked';
	content?: string;
	language: string;
	ownership: 'local' | 'git';
	tracked?: boolean;
	ignored?: boolean;
	postChange: LinkedStackFile['postChange'];
	size: number;
	mtime: number;
	revision?: string;
	error?: string;
}

export interface StackFileWorkspace {
	root: string;
	localRoot: string;
	entries: StackFileEntry[];
	composeServices: string[];
	linkedFiles: LinkedStackFile[];
	git: boolean;
}

export interface StackFileDirectoryEntry {
	name: string;
	path: string;
	type: 'file' | 'directory' | 'symlink';
	size: number;
	mtime: string;
	mode: string;
}

interface WorkspaceRoots {
	localRoot: string;
	gitRoot: string | null;
	composePaths: string[];
	envPath: string | null;
	composePath: string;
	linkedFiles: LinkedStackFile[];
	git: boolean;
}

export interface DraftLinkedFilesInput {
	linkedFiles?: unknown;
	linkedFileContents?: unknown;
	createdFolders?: unknown;
}

function revision(content: string): string {
	return createHash('sha256').update(content, 'utf8').digest('hex');
}

function isInside(child: string, root: string): boolean {
	return child === root || child.startsWith(root + sep);
}

function realPathForExistingOrParent(path: string): string {
	let current = resolve(path);
	const missing: string[] = [];
	while (!existsSync(current)) {
		const parent = dirname(current);
		if (parent === current) return resolve(path);
		missing.push(basename(current));
		current = parent;
	}
	const real = realpathSync(current);
	return missing.length > 0 ? join(real, ...missing.reverse()) : real;
}

function assertContained(path: string, root: string, label: string): string {
	const lexical = resolve(path);
	const rootReal = realPathForExistingOrParent(root);
	const targetReal = realPathForExistingOrParent(lexical);
	if (!isInside(lexical, resolve(root)) || !isInside(targetReal, rootReal)) {
		throw new Error(`${label} must remain inside the stack Compose directory`);
	}
	if (isProtectedPath(targetReal)) throw new Error(`${label} is protected`);
	return lexical;
}

function assertRegularText(path: string): { content: string; size: number; mtime: number } {
	const stat = statSync(path);
	if (!stat.isFile()) throw new Error(`Linked path is not a regular file: ${path}`);
	if (stat.size > MAX_LINKED_FILE_SIZE) throw new Error(`Linked file exceeds the ${MAX_LINKED_FILE_SIZE} byte limit`);
	const bytes = readFileSync(path);
	let content: string;
	try {
		content = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
	} catch {
		throw new Error('Linked files must contain valid UTF-8 text');
	}
	if (content.includes('\0')) throw new Error('Linked files must contain text, not binary data');
	return { content, size: stat.size, mtime: stat.mtimeMs };
}

function relativePath(root: string, path: string): string {
	const result = relative(root, path).split(sep).join('/');
	return normalizeLinkedPath(result);
}

function resolveRootPath(root: string, path: string, label: string): string {
	const normalized = normalizeLinkedPath(path);
	return assertContained(join(root, ...normalized.split('/')), root, label);
}

function draftContents(value: unknown): Record<string, string> {
	if (value === undefined || value === null) return {};
	if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('linkedFileContents must be an object');
	const contents: Record<string, string> = {};
	for (const [path, content] of Object.entries(value)) {
		contents[normalizeLinkedPath(path)] = typeof content === 'string' ? content : (() => { throw new Error(`Invalid text content for linked file: ${path}`); })();
	}
	return contents;
}

/** Validate a create-flow draft before the Compose writer mutates the workspace. */
export function validateDraftLinkedFiles(
	root: string,
	input: DraftLinkedFilesInput,
	options: { reservedPaths?: Iterable<string>; forceLocalOwnership?: boolean } = {}
): { linkedFiles: LinkedStackFile[]; linkedFileContents: Record<string, string>; createdFolders: string[] } {
	const linkedFiles = normalizeLinkedFiles(input.linkedFiles ?? [], options);
	const linkedFileContents = draftContents(input.linkedFileContents);
	const createdFolders = Array.isArray(input.createdFolders) ? input.createdFolders.map(normalizeLinkedPath) : input.createdFolders === undefined || input.createdFolders === null ? [] : (() => { throw new Error('createdFolders must be an array'); })();
	const filePaths = new Set(linkedFiles.map((file) => file.path));
	const reserved = new Set((options.reservedPaths ?? []).map(normalizeLinkedPath));
	const folded = new Set<string>();
	for (const path of [...createdFolders, ...linkedFiles.map((file) => file.path)]) {
		const key = path.toLocaleLowerCase();
		if (folded.has(key)) throw new Error(`Case-colliding draft path: ${path}`);
		folded.add(key);
		if (reserved.has(path)) throw new Error(`Draft path duplicates a configured Compose or environment file: ${path}`);
	}
	for (const path of Object.keys(linkedFileContents)) {
		if (!filePaths.has(path)) throw new Error(`Content supplied for an unlinked file: ${path}`);
		const content = linkedFileContents[path];
		if (Buffer.byteLength(content, 'utf8') > MAX_LINKED_FILE_SIZE || content.includes('\0')) throw new Error(`Invalid text content for linked file: ${path}`);
	}
	for (const folder of createdFolders) {
		const target = resolveRootPath(root, folder, 'Folder path');
		if (existsSync(target) && !lstatSync(target).isDirectory()) throw new Error(`Folder path is occupied by a file: ${folder}`);
	}
	for (const file of linkedFiles) {
		const target = resolveRootPath(root, file.path, 'Linked file path');
		if (existsSync(target)) {
			assertRegularText(target);
		} else if (linkedFileContents[file.path] === undefined) {
			throw new Error(`Linked file does not exist and has no staged content: ${file.path}`);
		}
	}
	return { linkedFiles, linkedFileContents, createdFolders };
}

/** Publish a validated initial-deployment draft under an already resolved Compose root. */
export function publishDraftLinkedFiles(
	root: string,
	input: DraftLinkedFilesInput,
	options: { reservedPaths?: Iterable<string>; forceLocalOwnership?: boolean } = {}
): { linkedFiles: LinkedStackFile[]; createdFolders: string[] } {
	const draft = validateDraftLinkedFiles(root, input, options);
	const createdDirectories: string[] = [];
	try {
		for (const folder of draft.createdFolders) {
			const target = resolveRootPath(root, folder, 'Folder path');
			if (!existsSync(target)) {
				mkdirSync(target, { recursive: true });
				createdDirectories.push(target);
			}
		}
		const writes = draft.linkedFiles
			.filter((file) => draft.linkedFileContents[file.path] !== undefined)
			.map((file) => ({ root, path: file.path, content: draft.linkedFileContents[file.path] }));
		publishAtomically(writes);
		return { linkedFiles: draft.linkedFiles, createdFolders: draft.createdFolders };
	} catch (error) {
		for (const directory of createdDirectories.reverse()) {
			try { rmSync(directory, { recursive: true, force: true }); } catch { /* best effort */ }
		}
		throw error;
	}
}

async function resolveWorkspaceRoots(stackName: string, envId?: number | null): Promise<WorkspaceRoots> {
	const source = await getStackSource(stackName, envId);
	if (!source) throw new Error(`Stack not found: ${stackName}`);
	const compose = await getStackComposeFile(stackName, envId);
	if (!compose.success || !compose.stackDir || !compose.composePath) {
		throw new Error(compose.error || `Compose file not found for stack "${stackName}"`);
	}
	const git = source.sourceType === 'git';
	let gitRoot: string | null = null;
	let repoPath: string | null = null;
	if (git && source.gitStack) {
		repoPath = source.gitStack.engine === 'centralized'
			? getRepoPath(source.gitStack.repository.name)
			: await getStackRepoPath(source.gitStack.id, source.gitStack.stackName, source.gitStack.environmentId);
		gitRoot = resolve(compose.stackDir);
		// getStackComposeFile already resolves the selected primary file inside the
		// operational checkout; linked paths are relative to that file's directory.
		if (!isInside(gitRoot, resolve(repoPath))) throw new Error('Git Compose directory is outside the repository checkout');
	}
	const localStackRoot = git ? await getStackDir(stackName, envId) : compose.stackDir;
	const localRoot = git && repoPath ? join(localStackRoot, relative(repoPath, gitRoot!)) : localStackRoot;
	const composePaths = (compose.composePaths?.length ? compose.composePaths : [compose.composePath]).map((path) => resolve(path));
	const envPath = compose.envPath ? resolve(compose.envPath) : null;
	const linkedFiles = getStackLinkedFiles(source).map((file) => git ? file : { ...file, ownership: 'local' as const });
	return { localRoot: resolve(localRoot), gitRoot, composePaths, envPath, composePath: resolve(compose.composePath), linkedFiles, git };
}

function parseComposeServices(content: string): string[] {
	// Compose validation remains authoritative elsewhere. This intentionally only
	// reads top-level service keys for policy validation and never executes YAML.
	const services: string[] = [];
	let inServices = false;
	for (const line of content.split(/\r?\n/)) {
		if (/^services:\s*$/.test(line)) {
			inServices = true;
			continue;
		}
		if (inServices && /^\S/.test(line)) break;
		const match = inServices ? line.match(/^  ([A-Za-z0-9_.-]+):\s*(?:#.*)?$/) : null;
		if (match) services.push(match[1]);
	}
	return services;
}

function readEntry(root: string, path: string, file: LinkedStackFile, kind: 'compose' | 'linked'): StackFileEntry {
	try {
		const absolute = resolveRootPath(root, path, 'Linked file path');
		const data = assertRegularText(absolute);
		return {
			path,
			name: basename(path),
			kind,
			content: data.content,
			language: linkedFileLanguage(path),
			ownership: file.ownership,
			postChange: file.postChange,
			size: data.size,
			mtime: data.mtime,
			revision: revision(data.content)
		};
	} catch (error) {
		return {
			path,
			name: basename(path),
			kind,
			language: linkedFileLanguage(path),
			ownership: file.ownership,
			postChange: file.postChange,
			size: 0,
			mtime: 0,
			error: error instanceof Error ? error.message : String(error)
		};
	}
}

async function readStackFileWorkspace(stackName: string, envId?: number | null): Promise<StackFileWorkspace> {
	const roots = await resolveWorkspaceRoots(stackName, envId);
	const root = roots.git ? roots.gitRoot! : roots.localRoot;
	const composeEntries = roots.composePaths.map((absolute) => {
		const path = relativePath(root, absolute);
		return readEntry(root, path, { path, ownership: roots.git ? 'git' : 'local', postChange: defaultLinkedFilePostChange() }, 'compose');
	});
	const linkedEntries = roots.linkedFiles.map((file) => readEntry(file.ownership === 'git' && roots.gitRoot ? roots.gitRoot : roots.localRoot, file.path, file, 'linked'));
	const primary = composeEntries.find((entry) => entry.path === relativePath(root, roots.composePath));
	return {
		root,
		localRoot: roots.localRoot,
		entries: [...composeEntries, ...linkedEntries],
		composeServices: primary?.content ? parseComposeServices(primary.content) : [],
		linkedFiles: roots.linkedFiles,
		git: roots.git
	};
}

export async function getStackFileWorkspace(stackName: string, envId?: number | null): Promise<StackFileWorkspace> {
	return withStackLock(stackName, () => readStackFileWorkspace(stackName, envId));
}

/** Read the workspace when the caller already holds the stack lock. */
export async function getStackFileWorkspaceUnlocked(stackName: string, envId?: number | null): Promise<StackFileWorkspace> {
	return readStackFileWorkspace(stackName, envId);
}

export async function listStackFileDirectory(
	stackName: string,
	envId: number | null | undefined,
	requestedPath?: string
): Promise<{ path: string; rootPath: string; parent: string | null; entries: StackFileDirectoryEntry[] }> {
	return withStackLock(stackName, async () => {
		const roots = await resolveWorkspaceRoots(stackName, envId);
		const rootPath = roots.git ? roots.gitRoot! : roots.localRoot;
		const directory = requestedPath ? assertContained(requestedPath, rootPath, 'Directory') : rootPath;
		if (!existsSync(directory) || !lstatSync(directory).isDirectory()) throw new Error('Directory not found');
		const entries = readdirSync(directory, { withFileTypes: true })
			.filter((entry) => !isProtectedPath(join(directory, entry.name)))
			.map((entry) => {
				const absolute = join(directory, entry.name);
				const stat = lstatSync(absolute);
				return {
					name: entry.name,
					path: absolute,
					type: entry.isSymbolicLink() ? 'symlink' as const : entry.isDirectory() ? 'directory' as const : 'file' as const,
					size: stat.size,
					mtime: stat.mtime.toISOString(),
					mode: (stat.mode & 0o777).toString(8)
				};
			});
		return { path: directory, rootPath, parent: directory === rootPath ? null : dirname(directory), entries };
	});
}

function reservedPaths(roots: WorkspaceRoots): Set<string> {
	const paths = new Set<string>();
	const root = roots.git ? roots.gitRoot! : roots.localRoot;
	for (const path of roots.composePaths) {
		if (isInside(path, root)) paths.add(relativePath(root, path));
	}
	if (roots.envPath && isInside(roots.envPath, root)) paths.add(relativePath(root, roots.envPath));
	return paths;
}

function atomicWrite(root: string, path: string, content: string, expectedRevision?: string): void {
	const target = resolveRootPath(root, path, 'Linked file path');
	if (existsSync(target)) {
		const current = assertRegularText(target);
		if (expectedRevision && revision(current.content) !== expectedRevision) throw new Error(`Linked file changed since it was loaded: ${path}`);
	} else if (expectedRevision) {
		throw new Error(`Linked file changed since it was loaded: ${path}`);
	}

	const parent = dirname(target);
	assertContained(parent, root, 'Linked file parent');
	mkdirSync(parent, { recursive: true });
	const tempDir = mkdtempSync(join(parent, '.dockhand-linked-'));
	const temp = join(tempDir, basename(target));
	let mode = 0o640;
	try {
		if (existsSync(target)) mode = statSync(target).mode & 0o777;
		const fd = openSync(temp, 'w', mode);
		try {
			writeFileSync(fd, content, 'utf8');
			fsyncSync(fd);
		} finally {
			closeSync(fd);
		}
		chmodSync(temp, mode);
		renameSync(temp, target);
	} finally {
		try { rmSync(tempDir, { recursive: true, force: true }); } catch { /* best effort */ }
	}
}

function publishAtomically(items: Array<{ root: string; path: string; content: string; expectedRevision?: string }>): void {
	const backups = new Map<string, { content: Buffer | null; mode: number }>();
	try {
		for (const item of items) {
			const target = resolveRootPath(item.root, item.path, 'Linked file path');
			backups.set(target, existsSync(target) ? { content: readFileSync(target), mode: statSync(target).mode & 0o777 } : { content: null, mode: 0o640 });
			atomicWrite(item.root, item.path, item.content, item.expectedRevision);
		}
	} catch (error) {
		for (const [target, backup] of backups) {
			if (backup.content === null) rmSync(target, { force: true });
			else {
				writeFileSync(target, backup.content);
				chmodSync(target, backup.mode);
			}
		}
		throw error;
	}
}

export async function saveLinkedFileContents(
	stackName: string,
	envId: number | null | undefined,
	changes: Array<{ path: string; content: string; expectedRevision?: string }>
): Promise<void> {
	await withStackLock(stackName, async () => {
		const roots = await resolveWorkspaceRoots(stackName, envId);
		const files = normalizeLinkedFiles(roots.linkedFiles, { reservedPaths: reservedPaths(roots), forceLocalOwnership: !roots.git });
		const byPath = new Map(files.map((file) => [file.path, file]));
		const staged: Array<{ root: string; path: string; content: string; expectedRevision?: string }> = [];
		for (const change of changes) {
			const path = normalizeLinkedPath(change.path);
			const file = byPath.get(path);
			if (!file) throw new Error(`File is not linked: ${path}`);
			if (typeof change.content !== 'string' || Buffer.byteLength(change.content, 'utf8') > MAX_LINKED_FILE_SIZE || change.content.includes('\0')) {
				throw new Error(`Invalid text content for linked file: ${path}`);
			}
			staged.push({ root: file.ownership === 'git' && roots.gitRoot ? roots.gitRoot : roots.localRoot, path, content: change.content, expectedRevision: change.expectedRevision });
		}
		// Validate all paths and revisions before publishing any replacement.
		for (const item of staged) {
			const target = resolveRootPath(item.root, item.path, 'Linked file path');
			if (existsSync(target)) {
				const current = assertRegularText(target);
				if (item.expectedRevision && revision(current.content) !== item.expectedRevision) throw new Error(`Linked file changed since it was loaded: ${item.path}`);
			}
		}
		publishAtomically(staged);
	});
}

/** Publish successful Git edits into the deployed local stack copy after push. */
export async function publishLinkedFilesToLocal(
	stackName: string,
	envId: number | null | undefined,
	changes: Array<{ path: string; content: string }>
): Promise<void> {
	await withStackLock(stackName, async () => {
		const roots = await resolveWorkspaceRoots(stackName, envId);
		const staged = changes.map((change) => {
			const path = normalizeLinkedPath(change.path);
			if (Buffer.byteLength(change.content, 'utf8') > MAX_LINKED_FILE_SIZE || change.content.includes('\0')) throw new Error(`Invalid text content for linked file: ${path}`);
			return { root: roots.localRoot, path, content: change.content };
		});
		publishAtomically(staged);
	});
}

export async function linkStackFile(stackName: string, envId: number | null | undefined, path: string, postChange = defaultLinkedFilePostChange(), ownership?: 'local' | 'git'): Promise<LinkedStackFile> {
	return withStackLock(stackName, async () => {
		const roots = await resolveWorkspaceRoots(stackName, envId);
		const normalizedPath = normalizeLinkedPath(path);
		const root = roots.gitRoot ?? roots.localRoot;
		const target = resolveRootPath(root, normalizedPath, 'Linked file path');
		const data = assertRegularText(target);
		const linked = normalizeLinkedFile({ path: normalizedPath, ownership: ownership ?? (roots.git ? 'git' : 'local'), postChange });
		const next = normalizeLinkedFiles([...roots.linkedFiles, linked], { reservedPaths: reservedPaths(roots), forceLocalOwnership: !roots.git });
		const localTarget = resolveRootPath(roots.localRoot, normalizedPath, 'Linked file path');
		const previous = existsSync(localTarget) ? readFileSync(localTarget) : null;
		try {
			if (roots.git && linked.ownership === 'local') atomicWrite(roots.localRoot, normalizedPath, data.content);
			await updateStackSource(stackName, envId ?? null, { linkedFiles: next });
			if (roots.git && linked.ownership === 'local') rmSync(target, { force: true });
		} catch (error) {
			if (roots.git && linked.ownership === 'local') {
				if (previous === null) rmSync(localTarget, { force: true });
				else writeFileSync(localTarget, previous);
			}
			throw error;
		}
		return linked;
	});
}

export async function createLinkedFile(stackName: string, envId: number | null | undefined, path: string, content = '', postChange = defaultLinkedFilePostChange()): Promise<LinkedStackFile> {
	return withStackLock(stackName, async () => {
		const roots = await resolveWorkspaceRoots(stackName, envId);
		const normalizedPath = normalizeLinkedPath(path);
		const linked = normalizeLinkedFile({ path: normalizedPath, ownership: roots.git ? 'local' : 'local', postChange });
		const next = normalizeLinkedFiles([...roots.linkedFiles, linked], { reservedPaths: reservedPaths(roots), forceLocalOwnership: !roots.git });
		const target = resolveRootPath(roots.localRoot, normalizedPath, 'Linked file path');
		if (existsSync(target)) throw new Error(`File already exists: ${normalizedPath}`);
		if (Buffer.byteLength(content, 'utf8') > MAX_LINKED_FILE_SIZE || content.includes('\0')) throw new Error('Invalid text content for linked file');
		atomicWrite(roots.localRoot, normalizedPath, content);
		try {
			await updateStackSource(stackName, envId ?? null, { linkedFiles: next });
		} catch (error) {
			rmSync(target, { force: true });
			throw error;
		}
		return next.find((file) => file.path === normalizedPath)!;
	});
}

export async function createStackFolder(stackName: string, envId: number | null | undefined, path: string): Promise<string> {
	return withStackLock(stackName, async () => {
		const roots = await resolveWorkspaceRoots(stackName, envId);
		const normalized = normalizeLinkedPath(path);
		const target = resolveRootPath(roots.localRoot, normalized, 'Folder path');
		if (existsSync(target) && !lstatSync(target).isDirectory()) throw new Error(`Folder path is occupied by a file: ${normalized}`);
		mkdirSync(target, { recursive: true });
		assertContained(target, roots.localRoot, 'Folder path');
		return normalized;
	});
}

export async function unlinkStackFile(stackName: string, envId: number | null | undefined, path: string): Promise<LinkedStackFile> {
	return withStackLock(stackName, async () => {
		const roots = await resolveWorkspaceRoots(stackName, envId);
		const normalized = normalizeLinkedPath(path);
		const file = roots.linkedFiles.find((entry) => entry.path === normalized);
		if (!file) throw new Error(`File is not linked: ${normalized}`);
		await updateStackSource(stackName, envId ?? null, { linkedFiles: roots.linkedFiles.filter((entry) => entry.path !== normalized) });
		return file;
	});
}
