import { afterEach, describe, expect, test } from 'bun:test';
import { mkdtemp, mkdir, readFile, readdir, rm, stat, symlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { listWorkspace, normalizeWorkspacePath, resolveWorkspacePath, withInternalStackDirectory, workspaceRevision } from '../src/lib/server/stack-workspace';

let roots: string[] = [];

afterEach(async () => {
	await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

test('converting a deployed Git stack preserves the deployment directory and its local files', async () => {
	const parent = await mkdtemp(join(tmpdir(), 'dockhand-convert-'));
	roots.push(parent);
	const checkout = join(parent, 'checkout');
	const deployed = join(parent, 'deployed');
	await mkdir(join(checkout, '.git'), { recursive: true });
	await mkdir(join(deployed, 'data'), { recursive: true });
	await writeFile(join(checkout, 'run.yaml'), 'from git');
	await writeFile(join(checkout, '.git', 'config'), 'private');
	await writeFile(join(deployed, 'run.yaml'), 'previous deploy');
	await writeFile(join(deployed, 'data', 'state'), 'keep me');
	const originalDirectory = await stat(deployed);

	await expect(withInternalStackDirectory(checkout, deployed, async () => {
		expect(await readFile(join(deployed, 'run.yaml'), 'utf8')).toBe('from git');
		await writeFile(join(deployed, 'run.yaml'), 'edited locally');
		throw new Error('source update failed');
	})).rejects.toThrow('source update failed');
	expect(await readFile(join(deployed, 'data', 'state'), 'utf8')).toBe('keep me');
	expect((await stat(deployed)).ino).toBe(originalDirectory.ino);
	expect((await readdir(parent)).sort()).toEqual(['checkout', 'deployed']);

	await withInternalStackDirectory(checkout, deployed, async () => {
		await writeFile(join(deployed, 'run.yaml'), 'edited locally');
	});
	expect(await readFile(join(deployed, 'run.yaml'), 'utf8')).toBe('edited locally');
	expect(await readFile(join(deployed, 'data', 'state'), 'utf8')).toBe('keep me');
	expect((await readdir(deployed)).sort()).toEqual(['data', 'run.yaml']);
	expect((await readdir(parent)).sort()).toEqual(['checkout', 'deployed']);
});

test('converting a Git stack without a deployment directory cleans up a failed save', async () => {
	const parent = await mkdtemp(join(tmpdir(), 'dockhand-convert-'));
	roots.push(parent);
	const checkout = join(parent, 'checkout');
	const destination = join(parent, 'new-stack');
	await mkdir(checkout);
	await writeFile(join(checkout, 'run.yaml'), 'from git');
	await expect(withInternalStackDirectory(checkout, destination, async () => {
		throw new Error('source update failed');
	})).rejects.toThrow('source update failed');
	expect(await readdir(parent)).toEqual(['checkout']);
	await withInternalStackDirectory(checkout, destination, async () => {});
	expect(await readFile(join(destination, 'run.yaml'), 'utf8')).toBe('from git');
});

describe('stack workspace path boundary', () => {
	test('accepts relative paths and rejects traversal and hidden dependency trees', () => {
		expect(normalizeWorkspacePath('config/app.json')).toBe('config/app.json');
		for (const path of ['../secret', '/etc/passwd', 'a/../../secret', 'node_modules/pkg/index.js', '.git/config', 'build/output.js']) {
			expect(() => normalizeWorkspacePath(path)).toThrow();
		}
	});

	test('does not expose hidden directories or follow symlinks', async () => {
		const root = await mkdtemp(join(tmpdir(), 'dockhand-workspace-'));
		roots.push(root);
		await mkdir(join(root, 'node_modules'));
		await mkdir(join(root, 'config'));
		await writeFile(join(root, 'compose.yaml'), 'services: {}\n');
		await symlink(tmpdir(), join(root, 'outside'));

		expect((await listWorkspace(root)).map((entry) => entry.name)).toEqual(['config', 'compose.yaml']);
		await expect(resolveWorkspacePath(root, 'outside')).rejects.toThrow();
		await expect(resolveWorkspacePath(root, 'outside/new.txt', { existing: false })).rejects.toThrow();
	});

	test('uses stable content revisions for optimistic saves', () => {
		expect(workspaceRevision('same')).toBe(workspaceRevision(Buffer.from('same')));
		expect(workspaceRevision('before')).not.toBe(workspaceRevision('after'));
	});
});
