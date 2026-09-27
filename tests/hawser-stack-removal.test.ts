import { describe, expect, test } from 'bun:test';
import { createHash } from 'node:crypto';
import { posix } from 'node:path';
import { planHawserStackRemoval, removeHawserStackFiles } from '../src/lib/server/hawser-stack-removal';
import type { HawserStackFileClient } from '../src/lib/server/hawser-stack-file-types';

const sha = (text: string) => createHash('sha256').update(text).digest('hex');

/** In-memory Hawser root with the agent's delete rules: revision-checked files, empty dirs only. */
function fakeRoot(initial: Record<string, string>) {
	const files = new Map(Object.entries(initial));
	const dirs = new Set<string>();
	for (const path of files.keys()) for (let d = posix.dirname(path); d !== '.'; d = posix.dirname(d)) dirs.add(d);
	const client = {
		async stat(path: string) {
			if (files.has(path)) return { path, type: 'file' as const, revision: sha(files.get(path)!), size: files.get(path)!.length };
			if (dirs.has(path)) return { path, type: 'directory' as const };
			throw Object.assign(new Error(`missing ${path}`), { status: 404 });
		},
		async delete(path: string, revision?: string) {
			if (files.has(path)) {
				if (revision !== sha(files.get(path)!)) throw Object.assign(new Error('stale'), { status: 409 });
				files.delete(path);
				return;
			}
			if (!dirs.has(path)) throw Object.assign(new Error('missing'), { status: 404 });
			if ([...files.keys(), ...dirs].some((other) => other.startsWith(`${path}/`))) throw Object.assign(new Error('not empty'), { status: 500 });
			dirs.delete(path);
		}
	} as unknown as HawserStackFileClient;
	return { files, dirs, client };
}

describe('Hawser stack removal', () => {
	test('deletes Dockhand configuration but never relative bind data or host-only files', async () => {
		const root = fakeRoot({
			'app/compose.yaml': 'services: {}\n',
			'app/override.yaml': 'services: {}\n',
			'app/.env': 'A=1\n',
			'app/.env.dockhand': 'B=2\n',
			'app/data/db.sqlite': 'volume bytes',
			'notes.txt': 'host only'
		});
		const plan = planHawserStackRemoval({ composeFileNames: ['app/compose.yaml', 'app/override.yaml'] });
		const result = await removeHawserStackFiles(root.client, plan);
		expect(result.deleted).toEqual(['app/.env', 'app/.env.dockhand', 'app/compose.yaml', 'app/override.yaml']);
		expect([...root.files.keys()].sort()).toEqual(['app/data/db.sqlite', 'notes.txt']);
		// `app` still holds bind data, so the agent refuses to remove it.
		expect(root.dirs.has('app')).toBe(true);
	});

	test('Git-published files are hash guarded: host edits survive removal', async () => {
		const root = fakeRoot({
			'compose.yaml': 'services: {}\n',
			'config/app.conf': 'edited on the host',
			'config/unchanged.conf': 'from git'
		});
		const plan = planHawserStackRemoval({
			composeFileNames: ['compose.yaml'],
			gitManifest: { 'config/app.conf': sha('from git'), 'config/unchanged.conf': sha('from git'), '../escape': sha('x') }
		});
		expect(Object.keys(plan.guarded).sort()).toEqual(['config/app.conf', 'config/unchanged.conf']);
		const result = await removeHawserStackFiles(root.client, plan);
		expect(result.deleted).toEqual(['compose.yaml', 'config/unchanged.conf']);
		expect(root.files.get('config/app.conf')).toBe('edited on the host');
		expect(result.kept.some((note) => note.startsWith('config/app.conf'))).toBe(true);
	});

	test('empties removed directories deepest first once nothing else remains', async () => {
		const root = fakeRoot({ 'svc/nested/compose.yaml': 'services: {}\n' });
		await removeHawserStackFiles(root.client, planHawserStackRemoval({ composeFileNames: ['svc/nested/compose.yaml'] }));
		expect(root.files.size).toBe(0);
		expect(root.dirs.size).toBe(0);
	});
});
