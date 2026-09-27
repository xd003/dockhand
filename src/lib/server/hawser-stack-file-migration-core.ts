/**
 * Pure orchestration for the one-time Hawser stack-file ownership cutover.
 * All database, Docker and agent I/O arrives through HawserMigrationServices,
 * so this module never imports the DB layer (tests load it directly).
 */
import { createHash, randomUUID } from 'node:crypto';
import {
	chmodSync, closeSync, cpSync, existsSync, fsyncSync, lstatSync, mkdirSync, openSync,
	readFileSync, readdirSync, readlinkSync, readSync, realpathSync, renameSync, rmSync, statSync, writeFileSync
} from 'node:fs';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { parseComposePathsColumn } from './compose-files';
import type { HawserBinding, HawserStackFileClient } from './hawser-stack-file-types';

interface Journal {
	version: 1;
	phase: 'prepared' | 'archived' | 'committed' | 'complete';
	oldPath: string;
	archivePath: string;
	method: 'rename' | 'copy';
	oldIdentity: string;
	remoteRoot: string;
	composePaths: string[];
	envPath: string | null;
	differences: string[];
}
/** Small I/O boundary so migration's journal and remote-wins behavior can be exercised without Docker. */
export interface HawserMigrationServices {
	environment(id: number): Promise<{ name: string; connectionType?: string | null } | undefined>;
	source(name: string, environmentId: number): Promise<{ fileLocation: 'dockhand' | 'hawser'; composePath: string | null; composePaths: string | null; envPath: string | null; sourceType: string; gitStack?: { composePath: string } | null } | null>;
	update(stackName: string, environmentId: number, updates: { fileLocation: 'hawser'; composePath: string; composePaths: string[]; envPath: string | null }): Promise<boolean>;
	client(environmentId: number, name: string): Promise<HawserStackFileClient>;
	labels(environmentId: number, name: string): Promise<{ root: string; files: string[] } | null>;
	stacksDir(environmentId: number, edge: boolean): Promise<string>;
}

const inFlight = new Map<string, Promise<void>>();

/** Operator-facing outcome of one completed cutover (null when nothing needed migrating). */
export interface HawserMigrationResult {
	/** Private read-only archive of the old Dockhand staging copy, or null when none existed. */
	archivePath: string | null;
	/** Paths whose bytes differed between the archived staging copy and Hawser (Hawser won). */
	differences: string[];
}
const composeDefaults = ['compose.yaml', 'compose.yml', 'docker-compose.yml', 'docker-compose.yaml'];
const dataDir = () => resolve(process.env.DATA_DIR || './data');
const archiveRoot = () => join(dataDir(), 'hawser-migration-archives');
const stagingRoot = () => join(dataDir(), 'stacks');
const within = (root: string, path: string) => path === root || path.startsWith(root + sep);
const identity = (path: string) => { const s = lstatSync(path); return `${s.dev}:${s.ino}`; };

function syncDirectory(path: string): void {
	const fd = openSync(path, 'r');
	try { fsyncSync(fd); } finally { closeSync(fd); }
}

function privateDirectory(path: string): void {
	const parent = dirname(path);
	if (path !== parent && within(dataDir(), parent) && parent !== dataDir()) privateDirectory(parent);
	if (!existsSync(path)) mkdirSync(path, { mode: 0o700 });
	if (!lstatSync(path).isDirectory()) throw new Error(`Migration archive parent is not a directory: ${path}`);
	chmodSync(path, 0o700);
	syncDirectory(parent);
}

function saveJournal(path: string, journal: Journal): void {
	const temp = join(dirname(path), `.journal-${randomUUID()}`);
	const fd = openSync(temp, 'wx', 0o600);
	try {
		writeFileSync(fd, JSON.stringify(journal));
		fsyncSync(fd);
	} finally { closeSync(fd); }
	renameSync(temp, path);
	syncDirectory(dirname(path));
}

function loadJournal(path: string): Journal {
	const journal = JSON.parse(readFileSync(path, 'utf8')) as Journal;
	if (journal.version !== 1 || !within(archiveRoot(), journal.archivePath) ||
		!within(stagingRoot(), journal.oldPath) || !['prepared', 'archived', 'committed', 'complete'].includes(journal.phase)) {
		throw new Error(`Invalid Hawser migration journal: ${path}`);
	}
	return journal;
}

const hashBuffer = Buffer.allocUnsafe(64 * 1024);
function fileHash(path: string): string {
	const digest = createHash('sha256');
	const fd = openSync(path, 'r');
	try {
		let count: number;
		while ((count = readSync(fd, hashBuffer, 0, hashBuffer.length, null)) > 0) {
			digest.update(hashBuffer.subarray(0, count));
		}
	} finally { closeSync(fd); }
	return digest.digest('hex');
}

function walk(path: string, base = path, files = new Map<string, string>()): Map<string, string> {
	for (const entry of readdirSync(path, { withFileTypes: true })) {
		const child = join(path, entry.name);
		const name = relative(base, child);
		if (entry.isDirectory()) walk(child, base, files);
		else if (entry.isFile()) files.set(name, fileHash(child));
		else if (entry.isSymbolicLink()) files.set(name, `link:${readlinkSync(child)}`);
		else throw new Error(`Cannot safely archive special file: ${child}`);
	}
	return files;
}

function compareTrees(original: string, archive: string): boolean {
	const left = walk(original), right = walk(archive);
	return left.size === right.size && [...left].every(([path, hash]) => right.get(path) === hash);
}
function matchesArchivedSubset(original: string, archive: string): boolean {
	const archived = walk(archive);
	return [...walk(original)].every(([path, hash]) => archived.get(path) === hash);
}


function syncTree(path: string): void {
	for (const entry of readdirSync(path, { withFileTypes: true })) {
		const child = join(path, entry.name);
		if (entry.isDirectory()) syncTree(child);
		else if (entry.isFile()) {
			const fd = openSync(child, 'r');
			try { fsyncSync(fd); } finally { closeSync(fd); }
		}
	}
	syncDirectory(path);
}

function durableCopy(source: string, destination: string): void {
	cpSync(source, destination, { recursive: true, preserveTimestamps: true, dereference: false, errorOnExist: true, force: false });
	if (!compareTrees(source, destination)) throw new Error('Migration archive byte verification failed');
	syncTree(destination);
}

function readonlyTree(path: string): void {
	for (const entry of readdirSync(path, { withFileTypes: true })) {
		const child = join(path, entry.name);
		if (entry.isDirectory()) readonlyTree(child);
		else if (entry.isFile()) chmodSync(child, lstatSync(child).mode & ~0o222);
	}
	chmodSync(path, lstatSync(path).mode & ~0o222);
}

function managedStaging(path: string | null, environmentId: number, environmentName: string, stackName: string): string | null {
	const root = stagingRoot();
	const candidates = [environmentName, String(environmentId), ''].map(parent => join(root, parent, stackName));
	const expected = path && isAbsolute(path) ? resolve(path) : null;
	// An environment can be renamed after the old staging directory was created.
	// The source path itself still identifies its owned <environment>/<stack> leaf.
	if (expected && within(root, expected)) {
		const segments = relative(root, expected).split(sep);
		if (segments.length >= 3 && segments[1] === stackName) {
			candidates.push(join(root, segments[0], stackName));
		}
	}
	const matches = expected
		? [...new Set(candidates.filter(leaf => within(leaf, expected)))]
		: candidates.filter(leaf => !!lstatSync(leaf, { throwIfNoEntry: false }));
	if (matches.length > 1) throw new Error(`Ambiguous Dockhand staging directories for ${stackName}: ${matches.join(', ')}`);
	const leaf = matches[0];
	const entry = leaf ? lstatSync(leaf, { throwIfNoEntry: false }) : undefined;
	if (entry && (!entry.isDirectory() || realpathSync(leaf) !== leaf)) {
		throw new Error(`Managed staging directory is a symlink or inaccessible: ${leaf}`);
	}
	return leaf ?? null;
}

function relativeFile(path: string, oldRoot: string | null, remoteRoot: string): string {
	const normalized = isAbsolute(path) ? resolve(path) : resolve(remoteRoot, path);
	const oldRelative = oldRoot && within(oldRoot, normalized) ? relative(oldRoot, normalized) : null;
	const name = oldRelative ?? relative(remoteRoot, normalized);
	if (!name || name === '.' || name === '..' || name.startsWith(`..${sep}`) || isAbsolute(name)) {
		throw new Error(`Configured file is outside the Hawser stack directory: ${path}`);
	}
	return name;
}

async function differences(oldRoot: string | null, client: HawserStackFileClient): Promise<string[]> {
	if (!oldRoot || !existsSync(oldRoot)) return [];
	const local = walk(oldRoot);
	const remote = new Map<string, string>();
	async function visit(path = ''): Promise<void> {
		for (const entry of await client.list(path)) {
			if (entry.type === 'directory') await visit(entry.path);
			else remote.set(entry.path, entry.revision ?? 'unknown');
		}
	}
	await visit();
	return [...new Set([...local.keys(), ...remote.keys()])].filter(path => local.get(path) !== remote.get(path)).sort();
}

export function findJournals(environmentId: number, stackName: string): string[] {
	const path = join(archiveRoot(), String(environmentId), stackName);
	if (!existsSync(path)) return [];
	if (!lstatSync(path).isDirectory()) throw new Error(`Invalid migration archive directory: ${path}`);
	return readdirSync(path).map(id => join(path, id, 'journal.json')).filter(existsSync);
}

async function replay(environmentId: number, stackName: string, services: HawserMigrationServices): Promise<void> {
	for (const path of findJournals(environmentId, stackName)) {
		const journal = loadJournal(path);
		const source = await services.source(stackName, environmentId);
		if (source?.fileLocation === 'hawser') {
			if (!existsSync(journal.archivePath)) throw new Error(`Migration archive missing: ${journal.archivePath}`);
			if (journal.method === 'rename' && lstatSync(journal.oldPath, { throwIfNoEntry: false })) {
				throw new Error(`Hawser migration pending cleanup: staging reappeared at ${journal.oldPath}; archive: ${journal.archivePath}`);
			}
			if (journal.method === 'copy' && lstatSync(journal.oldPath, { throwIfNoEntry: false })) {
				if (identity(journal.oldPath) !== journal.oldIdentity || !matchesArchivedSubset(journal.oldPath, journal.archivePath)) {
					throw new Error(`Hawser migration pending cleanup: staging changed at ${journal.oldPath}; archive: ${journal.archivePath}`);
				}
				rmSync(journal.oldPath, { recursive: true });
				syncDirectory(dirname(journal.oldPath));
			}
			readonlyTree(journal.archivePath);
			if (journal.phase !== 'complete') saveJournal(path, { ...journal, phase: 'complete' });
			continue;
		}
		if (journal.method === 'rename' && existsSync(journal.archivePath) && !lstatSync(journal.oldPath, { throwIfNoEntry: false })) {
			if (journal.phase === 'complete') throw new Error(`Cannot restore committed migration without a source marker: ${path}`);
			renameSync(journal.archivePath, journal.oldPath);
			syncDirectory(dirname(journal.oldPath));
		}
		if (!lstatSync(journal.oldPath, { throwIfNoEntry: false }) || identity(journal.oldPath) !== journal.oldIdentity) {
			throw new Error(`Hawser migration pending recovery: source directory changed at ${journal.oldPath}; journal: ${path}`);
		}
		if (existsSync(journal.archivePath)) rmSync(journal.archivePath, { recursive: true });
		rmSync(dirname(path), { recursive: true });
		syncDirectory(dirname(dirname(path)));
	}
}


/** Perform a single remote-wins cutover; services is an isolated I/O boundary for crash/retry tests. */
export async function migrateHawserStackFiles(
	environmentId: number, stackName: string, services: HawserMigrationServices
): Promise<HawserMigrationResult | null> {
	const environment = await services.environment(environmentId);
	if (environment?.connectionType !== 'hawser-edge' && environment?.connectionType !== 'hawser-standard') return null;
	await replay(environmentId, stackName, services);
	const source = await services.source(stackName, environmentId);
	if (!source) throw new Error(`Stack ${stackName} has no source metadata; select a Compose file location before using Hawser files`);
	if (source.fileLocation === 'hawser') return null;
	const client = await services.client(environmentId, stackName);
	const rawPaths = source.composePaths ? parseComposePathsColumn(source.composePaths) : source.composePath ? [source.composePath] : [];
	const configured = source.sourceType === 'git' && source.gitStack?.composePath
		? rawPaths.map(path => isAbsolute(path) ? path : relative(dirname(source.gitStack!.composePath), path))
		: rawPaths;
	const primary = source.composePath;
	const originalComposePath = primary && isAbsolute(primary) ? primary : configured.find(isAbsolute);
	const managed = managedStaging(originalComposePath ?? null, environmentId, environment.name, stackName);
	const oldRoot = managed ?? (originalComposePath ? dirname(originalComposePath) : null);
	const labels = await services.labels(environmentId, stackName);
	const managedRemoteRoot = join(await services.stacksDir(environmentId, environment.connectionType === 'hawser-edge'), stackName);
	const external = !!labels && resolve(labels.root) !== resolve(managedRemoteRoot);
	let binding: HawserBinding;
	let paths: string[];
	if (external) {
		const expected = configured.length ? configured : labels.files;
		paths = expected.map(file => relativeFile(file, oldRoot && within(labels.root, oldRoot) ? null : oldRoot, labels.root));
		const labeled = labels.files.map(file => relativeFile(file, null, labels.root));
		if (paths.length !== labeled.length || paths.some((file, i) => file !== labeled[i])) {
			throw new Error(`Cannot migrate ${stackName}: configured Compose paths do not match Compose project labels`);
		}
		binding = await client.enroll(labels.root, paths);
	} else if (oldRoot && !managed && !labels) {
		throw new Error(`Cannot migrate ${stackName}: Compose project working_dir/config_files labels are missing; mount the labeled directory in Hawser`);
	} else {
		const expected = configured.length ? configured : (primary ? [primary] : labels?.files ?? []);
		paths = expected.map(file => relativeFile(file, oldRoot && within(managedRemoteRoot, oldRoot) ? null : oldRoot, managedRemoteRoot));
		// An old source without configured paths must discover an existing remote
		// Compose file; binding existingOnly never creates the directory.
		if (!paths.length) {
			const provisional = await client.bind([composeDefaults[0]], true);
			for (const candidate of composeDefaults) {
				try { await client.read(candidate); paths = [candidate]; break; } catch { /* try next name */ }
			}
			if (!paths.length) throw new Error(`Hawser migration pending for ${stackName}: missing remote Compose file (${composeDefaults.map(p => join(provisional.root, p)).join(', ')})`);
		}
		if (labels) {
			const labeled = labels.files.map(file => relativeFile(file, null, labels.root));
			if (paths.length !== labeled.length || paths.some((path, i) => path !== labeled[i])) {
				throw new Error(`Cannot migrate ${stackName}: configured Compose paths do not match Compose project labels`);
			}
		}
		try {
			binding = await client.bind(paths, true);
		} catch (error) {
			if ((error as { status?: number }).status === 404) {
				throw new Error(`Hawser migration pending for ${stackName}: remote directory ${managedRemoteRoot} is missing; expected Compose file(s): ${paths.map(path => join(managedRemoteRoot, path)).join(', ')}`);
			}
			throw error;
		}
	}
	if (!isAbsolute(binding.root) || resolve(binding.root) !== resolve(external ? labels!.root : managedRemoteRoot) || !paths.length) {
		throw new Error(`Hawser did not return the expected bound root for ${stackName}`);
	}
	const remotePaths = paths.map(path => join(binding.root, path));
	const explicitEnv = source.envPath && source.envPath !== ''
		? relativeFile(source.envPath, oldRoot && within(binding.root, oldRoot) ? null : oldRoot, binding.root)
		: null;
	const missing: string[] = [];
	for (let i = 0; i < paths.length; i++) {
		try { await client.read(paths[i]); } catch { missing.push(remotePaths[i]); }
	}
	if (explicitEnv) {
		try { await client.read(explicitEnv); } catch { missing.push(join(binding.root, explicitEnv)); }
	}
	if (missing.length) throw new Error(`Hawser migration pending for ${stackName}: missing or unreadable remote file(s): ${missing.join(', ')}`);
	const changePaths = await differences(managed, client);
	const remoteEnv = explicitEnv ? join(binding.root, explicitEnv) : source.envPath === '' ? '' : null;
	const oldManaged = managed && existsSync(managed) ? managed : null;
	if (!oldManaged) {
		if (!await services.update(stackName, environmentId, { fileLocation: 'hawser', composePath: remotePaths[0], composePaths: remotePaths, envPath: remoteEnv })) {
			throw new Error(`Stack source vanished during Hawser migration: ${stackName}`);
		}
		return { archivePath: null, differences: changePaths };
	}
	if (!lstatSync(oldManaged).isDirectory()) throw new Error(`Staging directory is not a regular directory: ${oldManaged}`);
	const parent = join(archiveRoot(), String(environmentId), stackName);
	privateDirectory(archiveRoot()); privateDirectory(join(archiveRoot(), String(environmentId))); privateDirectory(parent);
	const transaction = join(parent, randomUUID());
	mkdirSync(transaction, { mode: 0o700 });
	syncDirectory(parent);
	const archivePath = join(transaction, 'source');
	const journalPath = join(transaction, 'journal.json');
	const journal: Journal = {
		version: 1, phase: 'prepared', oldPath: oldManaged, archivePath,
		method: statSync(oldManaged).dev === statSync(parent).dev ? 'rename' : 'copy',
		oldIdentity: identity(oldManaged), remoteRoot: binding.root, composePaths: remotePaths,
		envPath: remoteEnv, differences: changePaths
	};
	try {
		saveJournal(journalPath, journal);
	} catch (error) {
		rmSync(transaction, { recursive: true, force: true });
		syncDirectory(parent);
		throw error;
	}
	try {
		if (journal.method === 'rename') {
			syncTree(oldManaged);
			renameSync(oldManaged, archivePath);
			syncDirectory(dirname(oldManaged)); syncDirectory(transaction);
		} else {
			const temp = join(transaction, `.copy-${randomUUID()}`);
			durableCopy(oldManaged, temp);
			renameSync(temp, archivePath);
			syncDirectory(transaction);
		}
		saveJournal(journalPath, { ...journal, phase: 'archived' });
		if (!await services.update(stackName, environmentId, { fileLocation: 'hawser', composePath: remotePaths[0], composePaths: remotePaths, envPath: remoteEnv })) {
			throw new Error(`Stack source vanished during Hawser migration: ${stackName}`);
		}
		saveJournal(journalPath, { ...journal, phase: 'committed' });
	} catch (error) {
		// The DB write may have committed but thrown on a subsequent journal write.
		// Recheck the marker before deciding whether restoration is safe.
		await replay(environmentId, stackName, services);
		throw error;
	}
	try {
		await replay(environmentId, stackName, services);
	} catch (error) {
		throw new Error(`Hawser migration committed but staging cleanup is pending; archive: ${archivePath}; ${error instanceof Error ? error.message : String(error)}`);
	}
	console.info(`[Hawser migration] ${stackName} env=${environmentId}: archive=${archivePath}; differing paths=${changePaths.join(', ') || '(none)'}`);
	return { archivePath, differences: changePaths };
}

/** Shared per-stack barrier for migration, file operations and deployment. */
export function ensureHawserStackFilesReady(
	stackName: string, environmentId: number, services: HawserMigrationServices
): Promise<void> {
	if (!Number.isSafeInteger(environmentId) || environmentId <= 0 || !/^[a-z0-9][a-z0-9_-]*$/.test(stackName)) {
		return Promise.reject(new Error('A valid Hawser environment and Compose project name are required'));
	}
	const key = `${environmentId}:${stackName}`;
	const existing = inFlight.get(key);
	if (existing) return existing;
	const running = migrateHawserStackFiles(environmentId, stackName, services).then(() => undefined).finally(() => {
		if (inFlight.get(key) === running) inFlight.delete(key);
	});
	inFlight.set(key, running);
	return running;
}

