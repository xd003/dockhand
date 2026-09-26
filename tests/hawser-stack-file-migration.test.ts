import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { chmodSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { describe, it } from 'node:test';
import { ensureHawserStackFilesReady, migrateHawserStackFiles } from '../src/lib/server/hawser-stack-file-migration-core';
import type { HawserMigrationServices } from '../src/lib/server/hawser-stack-file-migration-core';
import type { HawserStackFileClient } from '../src/lib/server/hawser-stack-file-types';

const hash = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex');

type TestSource = {
	sourceType: 'internal' | 'git';
	gitStack?: { composePath: string };
	fileLocation: 'dockhand' | 'hawser';
	composePath: string | null;
	composePaths: string | null;
	envPath: string | null;
};

async function fixture(run: (ctx: {
	root: string;
	oldRoot: string;
	remoteRoot: string;
	files: Map<string, Uint8Array>;
	source: TestSource;
	services: HawserMigrationServices;
	calls: { writes: number; updates: number; bound: string[][] };
}) => Promise<void>): Promise<void> {
	const root = mkdtempSync(join(tmpdir(), 'hawser-migration-'));
	const previous = process.env.DATA_DIR;
	process.env.DATA_DIR = root;
	const oldRoot = join(root, 'stacks', 'production', 'demo');
	const remoteRoot = join(root, 'agent-stacks', 'demo');
	mkdirSync(oldRoot, { recursive: true });
	const files = new Map<string, Uint8Array>([['compose.yaml', Buffer.from('services:\n  web:\n    image: current\n')]]);
	const source: TestSource = {
		sourceType: 'internal', fileLocation: 'dockhand', composePath: join(oldRoot, 'compose.yaml'), composePaths: JSON.stringify([join(oldRoot, 'compose.yaml')]), envPath: null
	};
	const calls = { writes: 0, updates: 0, bound: [] as string[][] };
	const client = {
		async bind(paths: string[], existingOnly?: boolean) {
			assert.equal(existingOnly, true, 'migration must not create a missing remote root');
			calls.bound.push(paths);
			return { root: remoteRoot, composeFileNames: paths };
		},
		async enroll(_root: string, paths: string[]) {
			calls.bound.push(paths);
			return { root: remoteRoot, composeFileNames: paths };
		},
		async binding() { return { root: remoteRoot, composeFileNames: ['compose.yaml'] }; },
		async relocate() { calls.writes++; throw new Error('Migration must not relocate Hawser files'); },
		async unbind() { calls.writes++; throw new Error('Migration must not unbind Hawser files'); },
		async list(path = '') {
			return [...files].filter(([name]) => dirname(name) === (path || '.')).map(([name, bytes]) => ({ path: name, type: 'file' as const, revision: hash(bytes), size: bytes.byteLength }));
		},
		async stat(path: string) {
			const bytes = files.get(path);
			if (!bytes) throw new Error(`Remote file missing: ${path}`);
			return { path, type: 'file' as const, revision: hash(bytes), size: bytes.byteLength };
		},
		async read(path: string) {
			const bytes = files.get(path);
			if (!bytes) throw new Error(`Remote file missing: ${path}`);
			return { content: bytes, revision: hash(bytes), size: bytes.byteLength };
		},
		async write() { calls.writes++; throw new Error('Migration must not change Hawser files'); },
		async mkdir() { calls.writes++; throw new Error('Migration must not change Hawser files'); },
		async move() { calls.writes++; throw new Error('Migration must not change Hawser files'); },
		async delete() { calls.writes++; throw new Error('Migration must not change Hawser files'); },
		async apply() { calls.writes++; throw new Error('Migration must not change Hawser files'); }
	} as HawserStackFileClient;
	const services: HawserMigrationServices = {
		environment: async () => ({ connectionType: 'hawser-standard', name: 'production' }),
		source: async () => source,
		update: async (_name, _envId, changes) => {
			calls.updates++;
			if (changes.fileLocation) source.fileLocation = changes.fileLocation;
			if (changes.composePath !== undefined) source.composePath = changes.composePath;
			if (changes.composePaths !== undefined) source.composePaths = JSON.stringify(changes.composePaths);
			if (changes.envPath !== undefined) source.envPath = changes.envPath;
			return true;
		},
		client: async () => client,
		labels: async () => null,
		stacksDir: async () => dirname(remoteRoot)
	};
	try { await run({ root, oldRoot, remoteRoot, files, source, services, calls }); }
	finally {
		if (previous === undefined) delete process.env.DATA_DIR;
		else process.env.DATA_DIR = previous;
		// A read-only archive intentionally persists in production; restore write
		// permission only on this fixture's directories before removing it.
		function makeWritable(path: string): void {
			if (!existsSync(path) || !lstatSync(path).isDirectory()) return;
			chmodSync(path, 0o700);
			for (const name of readdirSync(path)) makeWritable(join(path, name));
		}
		makeWritable(root);
		rmSync(root, { recursive: true, force: true });
	}
}

describe('Hawser stack-file migration', () => {
	it('keeps Hawser divergence, archives old secrets privately and is idempotent', async () => fixture(async ({ root, oldRoot, remoteRoot, source, services, calls, files }) => {
		writeFileSync(join(oldRoot, 'compose.yaml'), 'services:\n  web:\n    image: stale\n');
		writeFileSync(join(oldRoot, '.env'), 'TOKEN=old-secret\n');
		files.set('.env', Buffer.from('TOKEN=remote-secret\n'));
		source.envPath = join(oldRoot, '.env');
		await migrateHawserStackFiles(1, 'demo', services);
		assert.equal(source.fileLocation, 'hawser');
		assert.equal(source.composePath, join(remoteRoot, 'compose.yaml'));
		assert.equal(source.envPath, join(remoteRoot, '.env'));
		assert.equal(existsSync(oldRoot), false);
		assert.equal(calls.writes, 0);
		const archiveParent = join(root, 'hawser-migration-archives', '1', 'demo');
		assert.equal(lstatSync(archiveParent).mode & 0o777, 0o700);
		const archived = join(archiveParent, readdirSync(archiveParent)[0], 'source');
		assert.equal(readFileSync(join(archived, '.env'), 'utf8'), 'TOKEN=old-secret\n');
		assert.equal(lstatSync(join(archived, '.env')).mode & 0o222, 0);
		assert.equal(Buffer.from(files.get('compose.yaml')!).toString(), 'services:\n  web:\n    image: current\n');
		await migrateHawserStackFiles(1, 'demo', services);
		assert.equal(readdirSync(archiveParent).length, 1);
		assert.equal(calls.updates, 1);
	}));

	it('blocks missing Compose and env files without changing the source or staging', async () => fixture(async ({ oldRoot, remoteRoot, source, files, services, calls }) => {
		writeFileSync(join(oldRoot, 'compose.yaml'), 'old');
		writeFileSync(join(oldRoot, 'second.yaml'), 'old override');
		source.composePaths = JSON.stringify([join(oldRoot, 'compose.yaml'), join(oldRoot, 'second.yaml')]);
		source.envPath = join(oldRoot, '.env');
		files.delete('compose.yaml');
		await assert.rejects(migrateHawserStackFiles(1, 'demo', services), error => {
			assert.match(String(error), new RegExp(`${remoteRoot}/compose.yaml`));
			assert.match(String(error), new RegExp(`${remoteRoot}/second.yaml`));
			assert.match(String(error), new RegExp(`${remoteRoot}/.env`));
			return true;
		});
		assert.equal(source.fileLocation, 'dockhand');
		assert.equal(readFileSync(join(oldRoot, 'compose.yaml'), 'utf8'), 'old');
		assert.equal(calls.updates, 0);
	}));

	it('restores renamed staging when the marker write fails and retries safely', async () => fixture(async ({ root, oldRoot, source, services, calls }) => {
		writeFileSync(join(oldRoot, 'compose.yaml'), 'old');
		const original = services.update;
		services.update = async () => { throw new Error('DB unavailable'); };
		await assert.rejects(migrateHawserStackFiles(1, 'demo', services), /DB unavailable/);
		assert.equal(source.fileLocation, 'dockhand');
		assert.equal(readFileSync(join(oldRoot, 'compose.yaml'), 'utf8'), 'old');
		services.update = original;
		await migrateHawserStackFiles(1, 'demo', services);
		assert.equal(source.fileLocation, 'hawser');
		assert.equal(existsSync(oldRoot), false);
		assert.equal(readdirSync(join(root, 'hawser-migration-archives', '1', 'demo')).length, 1);
		assert.equal(calls.updates, 1);
	}));

	it('replays an interrupted rename before remote validation without losing the original', async () => fixture(async ({ root, oldRoot, remoteRoot, files, services, source }) => {
		writeFileSync(join(oldRoot, 'compose.yaml'), 'old');
		const parent = join(root, 'hawser-migration-archives', '1', 'demo', 'interrupted');
		mkdirSync(parent, { recursive: true, mode: 0o700 });
		const identity = `${lstatSync(oldRoot).dev}:${lstatSync(oldRoot).ino}`;
		const archive = join(parent, 'source');
		writeFileSync(join(parent, 'journal.json'), JSON.stringify({ version: 1, phase: 'prepared', oldPath: oldRoot, archivePath: archive, method: 'rename', oldIdentity: identity, remoteRoot, composePaths: [join(remoteRoot, 'compose.yaml')], envPath: null, differences: ['compose.yaml'] }));
		renameSync(oldRoot, archive);
		files.clear();
		await assert.rejects(migrateHawserStackFiles(1, 'demo', services), /missing or unreadable remote file/);
		assert.equal(source.fileLocation, 'dockhand');
		assert.equal(readFileSync(join(oldRoot, 'compose.yaml'), 'utf8'), 'old');
		assert.equal(existsSync(archive), false);
	}));
	it('leaves user-selected Dockhand directories untouched during in-place enrollment', async () => fixture(async ({ root, oldRoot, remoteRoot, source, services, calls }) => {
		const custom = join(root, 'user-project');
		mkdirSync(custom);
		writeFileSync(join(custom, 'compose.yaml'), 'user-owned');
		source.composePath = join(custom, 'compose.yaml');
		source.composePaths = JSON.stringify([source.composePath]);
		services.labels = async () => ({ root: remoteRoot, files: [join(remoteRoot, 'compose.yaml')] });
		services.stacksDir = async () => join(root, 'different-managed-root');
		await migrateHawserStackFiles(1, 'demo', services);
		assert.equal(readFileSync(join(custom, 'compose.yaml'), 'utf8'), 'user-owned');
		assert.equal(existsSync(oldRoot), true);
		assert.equal(source.composePath, join(remoteRoot, 'compose.yaml'));
		assert.deepEqual(calls.bound, [['compose.yaml']]);
	}));

	it('keeps pending stacks intact when the connected agent lacks file support', async () => fixture(async ({ oldRoot, source, services, calls }) => {
		writeFileSync(join(oldRoot, 'compose.yaml'), 'old');
		services.client = async () => { throw new Error('Hawser agent must be upgraded to support stack-files-v1'); };
		await assert.rejects(migrateHawserStackFiles(1, 'demo', services), /upgraded/);
		assert.equal(source.fileLocation, 'dockhand');
		assert.equal(readFileSync(join(oldRoot, 'compose.yaml'), 'utf8'), 'old');
		assert.equal(calls.updates, 0);
	}));
	it('finishes interrupted cross-device cleanup only when remaining files match the durable archive', async () => fixture(async ({ root, oldRoot, remoteRoot, source, services }) => {
		writeFileSync(join(oldRoot, 'compose.yaml'), 'original');
		const identity = `${lstatSync(oldRoot).dev}:${lstatSync(oldRoot).ino}`;
		const parent = join(root, 'hawser-migration-archives', '1', 'demo', 'copy-interrupted');
		const archive = join(parent, 'source');
		mkdirSync(archive, { recursive: true, mode: 0o700 });
		writeFileSync(join(archive, 'compose.yaml'), 'original');
		writeFileSync(join(archive, '.env'), 'SAVED=old\\n');
		writeFileSync(join(parent, 'journal.json'), JSON.stringify({ version: 1, phase: 'committed', oldPath: oldRoot, archivePath: archive, method: 'copy', oldIdentity: identity, remoteRoot, composePaths: [join(remoteRoot, 'compose.yaml')], envPath: null, differences: ['compose.yaml'] }));
		source.fileLocation = 'hawser';
		source.composePath = join(remoteRoot, 'compose.yaml');
		await migrateHawserStackFiles(1, 'demo', services);
		assert.equal(existsSync(oldRoot), false);
		assert.equal(readFileSync(join(archive, '.env'), 'utf8'), 'SAVED=old\\n');
		assert.equal(JSON.parse(readFileSync(join(parent, 'journal.json'), 'utf8')).phase, 'complete');
	}));
	it('discovers existing remote Compose without a configured path and archives the known managed leaf', async () => fixture(async ({ root, oldRoot, source, services, calls }) => {
		writeFileSync(join(oldRoot, 'compose.yaml'), 'old');
		source.composePath = null;
		source.composePaths = null;
		await migrateHawserStackFiles(1, 'demo', services);
		assert.equal(source.fileLocation, 'hawser');
		assert.equal(existsSync(oldRoot), false);
		assert.deepEqual(calls.bound, [['compose.yaml'], ['compose.yaml']]);
		assert.equal(readdirSync(join(root, 'hawser-migration-archives', '1', 'demo')).length, 1);
	}));
	it('shares one cutover among concurrent requests for the same project', async () => fixture(async ({ oldRoot, source, services, calls }) => {
		writeFileSync(join(oldRoot, 'compose.yaml'), 'old');
		const first = ensureHawserStackFilesReady('demo', 1, services);
		const second = ensureHawserStackFilesReady('demo', 1, services);
		assert.strictEqual(first, second);
		await Promise.all([first, second]);
		assert.equal(source.fileLocation, 'hawser');
		assert.equal(calls.updates, 1);
		assert.equal(existsSync(oldRoot), false);
	}));
	it('recognizes a managed staging leaf after the environment was renamed', async () => fixture(async ({ oldRoot, source, services }) => {
		writeFileSync(join(oldRoot, 'compose.yaml'), 'old');
		services.environment = async () => ({ connectionType: 'hawser-standard', name: 'renamed-environment' });
		await migrateHawserStackFiles(1, 'demo', services);
		assert.equal(source.fileLocation, 'hawser');
		assert.equal(existsSync(oldRoot), false);
	}));
	it('preserves a labeled Compose subdirectory for in-place adoption', async () => fixture(async ({ remoteRoot, source, services, files, calls }) => {
		const nested = join(remoteRoot, 'config', 'compose.yaml');
		files.delete('compose.yaml');
		files.set('config/compose.yaml', Buffer.from('services: {}\\n'));
		source.composePath = nested;
		source.composePaths = JSON.stringify([nested]);
		services.labels = async () => ({ root: remoteRoot, files: [nested] });
		services.stacksDir = async () => dirname(dirname(remoteRoot));
		await migrateHawserStackFiles(1, 'demo', services);
		assert.equal(source.composePath, nested);
		assert.deepEqual(calls.bound, [['config/compose.yaml']]);
	}));
	it('maps repository-relative Git Compose paths into the existing remote root in order', async () => fixture(async ({ oldRoot, source, files, services, calls }) => {
		writeFileSync(join(oldRoot, 'compose.yaml'), 'old');
		writeFileSync(join(oldRoot, 'override.yaml'), 'old override');
		files.set('override.yaml', Buffer.from('services: {}\\n'));
		source.sourceType = 'git';
		source.gitStack = { composePath: 'apps/demo/compose.yaml' };
		source.composePaths = JSON.stringify(['apps/demo/compose.yaml', 'apps/demo/override.yaml']);
		await migrateHawserStackFiles(1, 'demo', services);
		assert.equal(source.fileLocation, 'hawser');
		assert.deepEqual(calls.bound, [['compose.yaml', 'override.yaml']]);
	}));
});
