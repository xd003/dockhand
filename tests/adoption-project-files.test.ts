import { afterEach, expect, test } from 'bun:test';
import { mkdtemp, mkdir, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { applyProjectFileChanges, localProjectFiles, parseProjectFileChanges } from '../src/lib/server/adoption-project-files';
import { workspaceRevision } from '../src/lib/server/stack-workspace';

let roots: string[] = [];

afterEach(async () => {
	await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function project() {
	const root = await mkdtemp(join(tmpdir(), 'dockhand-adoption-'));
	roots.push(root);
	await mkdir(join(root, 'config'), { recursive: true });
	await mkdir(join(root, 'data', 'db'), { recursive: true });
	await writeFile(join(root, 'config', 'app.env'), 'MODE=old\n');
	await writeFile(join(root, 'data', 'db', 'state'), 'volume data');
	await writeFile(join(root, 'notes.txt'), 'keep');
	return root;
}

test('project-file changes apply edits, creations and deletions, and roll every path back', async () => {
	const root = await project();
	const changes = parseProjectFileChanges({
		writes: [
			{ path: 'config/app.env', content: 'MODE=new\n', expectedRevision: workspaceRevision('MODE=old\n') },
			{ path: 'secrets/token', content: 'abc', expectedRevision: null }
		],
		deletions: [{ path: 'data' }, { path: 'data/db/state' }, { path: 'notes.txt', expectedRevision: workspaceRevision('keep') }],
		folders: ['logs']
	})!;

	const applied = await applyProjectFileChanges(localProjectFiles(root), changes);
	expect(await readFile(join(root, 'config', 'app.env'), 'utf8')).toBe('MODE=new\n');
	expect(await readFile(join(root, 'secrets', 'token'), 'utf8')).toBe('abc');
	expect((await stat(join(root, 'logs'))).isDirectory()).toBe(true);
	expect((await readdir(root)).filter((name) => !name.startsWith('.dockhand-trash-')).sort()).toEqual(['config', 'logs', 'secrets']);

	await applied.rollback();
	expect(await readFile(join(root, 'config', 'app.env'), 'utf8')).toBe('MODE=old\n');
	expect(await readFile(join(root, 'data', 'db', 'state'), 'utf8')).toBe('volume data');
	expect(await readFile(join(root, 'notes.txt'), 'utf8')).toBe('keep');
	expect((await readdir(root)).sort()).toEqual(['config', 'data', 'notes.txt']);
});

test('committing project-file changes removes the deleted items for good', async () => {
	const root = await project();
	const applied = await applyProjectFileChanges(localProjectFiles(root), parseProjectFileChanges({ deletions: [{ path: 'data' }] })!);
	await applied.commit();
	expect((await readdir(root)).sort()).toEqual(['config', 'notes.txt']);
});

test('a file changed since it was loaded aborts the apply and restores earlier changes', async () => {
	const root = await project();
	const changes = parseProjectFileChanges({
		writes: [
			{ path: 'fresh.conf', content: 'new', expectedRevision: null },
			{ path: 'config/app.env', content: 'MODE=new\n', expectedRevision: workspaceRevision('MODE=stale\n') }
		],
		deletions: [{ path: 'notes.txt' }]
	})!;

	await expect(applyProjectFileChanges(localProjectFiles(root), changes)).rejects.toThrow('changed since it was loaded');
	expect(await readFile(join(root, 'config', 'app.env'), 'utf8')).toBe('MODE=old\n');
	expect(await readFile(join(root, 'notes.txt'), 'utf8')).toBe('keep');
	expect((await readdir(root)).sort()).toEqual(['config', 'data', 'notes.txt']);
});

test('project-file changes cannot leave the project directory', () => {
	expect(() => parseProjectFileChanges({ writes: [{ path: '../outside', content: 'x' }] })).toThrow();
	expect(() => parseProjectFileChanges({ deletions: [{ path: '/etc/passwd' }] })).toThrow();
	expect(() => parseProjectFileChanges({ folders: ['.git/hooks'] })).toThrow();
});
