import { afterEach, describe, expect, it } from 'bun:test';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
	findStackNameCollision,
	moveStackFilePathCrossDevice,
	prepareStackDirectoryRelocation,
	resolveComposePathHints,
	resolveGitStackPaths,
	resolveStackDirForLayout
} from '../src/lib/server/stack-path-utils';

const tempDirs: string[] = [];

afterEach(() => {
	for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe('moveStackFilePathCrossDevice', () => {
	it('copies and deletes the source when rename fails with EXDEV', () => {
		const dir = mkdtempSync(join(tmpdir(), 'dockhand-stack-move-'));
		tempDirs.push(dir);
		const source = join(dir, 'old.env');
		const destination = join(dir, 'new.env');
		writeFileSync(source, 'TOKEN=secret\n');

		moveStackFilePathCrossDevice(source, destination, 'env file', () => {
			throw Object.assign(new Error('cross-device link'), { code: 'EXDEV' });
		});

		expect(readFileSync(destination, 'utf8')).toBe('TOKEN=secret\n');
		expect(existsSync(source)).toBe(false);
	});
});

describe('resolveStackDirForLayout', () => {
	it('uses flat STACKS_DIR for local stacks and environment scope otherwise', () => {
		expect(resolveStackDirForLayout('/data/stacks', '/srv/stacks', 'app', 'local', true)).toBe('/srv/stacks/app');
		expect(resolveStackDirForLayout('/data/stacks', '/srv/stacks', 'app', 'production', false)).toBe('/data/stacks/production/app');
	});
});

describe('resolveComposePathHints', () => {
	it('resolves relative Docker label paths against the project working directory', () => {
		expect(resolveComposePathHints('/srv/stacks/app', ['compose.yaml', '/opt/override.yaml'])).toEqual([
			'/srv/stacks/app/compose.yaml',
			'/opt/override.yaml'
		]);
	});

	it('rejects relative label paths without an authoritative working directory', () => {
		expect(resolveComposePathHints(null, ['compose.yaml'])).toEqual([]);
	});
});

describe('resolveGitStackPaths', () => {
	it('resolves compose and env files from the repo context into the deployed stack directory', () => {
		expect(resolveGitStackPaths(
			['stacks/linkleaner/compose.yaml', 'stacks/linkleaner/.env'],
			'stacks/linkleaner',
			'/data/stacks/linkleaner'
		)).toEqual([
			'/data/stacks/linkleaner/compose.yaml',
			'/data/stacks/linkleaner/.env'
		]);
	});
});

describe('findStackNameCollision', () => {
	it('finds the same stack name in another local environment', () => {
		const sources = [
			{ stackName: 'app', environmentId: 1 },
			{ stackName: 'worker', environmentId: 2 }
		];

		expect(findStackNameCollision(sources, 'app', 2)).toEqual(sources[0]);
		expect(findStackNameCollision(sources, 'app', 1)).toBeUndefined();
	});
});

describe('prepareStackDirectoryRelocation', () => {
	it('stages a complete directory and rolls it back without touching the source', () => {
		const dir = mkdtempSync(join(tmpdir(), 'dockhand-stack-relocate-'));
		tempDirs.push(dir);
		const source = join(dir, 'external');
		const destination = join(dir, 'managed', 'app');
		mkdirSync(join(source, 'data'), { recursive: true });
		writeFileSync(join(source, 'compose.yaml'), 'services: {}\n');
		writeFileSync(join(source, 'data', 'state.txt'), 'keep\n');

		const relocation = prepareStackDirectoryRelocation(source, destination);

		expect(existsSync(source)).toBe(true);
		expect(readFileSync(join(destination, 'data', 'state.txt'), 'utf8')).toBe('keep\n');
		relocation.rollback();
		expect(existsSync(source)).toBe(true);
		expect(existsSync(destination)).toBe(false);
		relocation.rollback();
	});

	it('removes the original directory only when committed', () => {
		const dir = mkdtempSync(join(tmpdir(), 'dockhand-stack-relocate-'));
		tempDirs.push(dir);
		const source = join(dir, 'external');
		const destination = join(dir, 'managed');
		mkdirSync(source);
		writeFileSync(join(source, 'compose.yaml'), 'services: {}\n');

		const relocation = prepareStackDirectoryRelocation(source, destination);
		relocation.commit();
		relocation.commit();

		expect(existsSync(source)).toBe(false);
		expect(existsSync(join(destination, 'compose.yaml'))).toBe(true);
	});

	it('snapshots an in-place destination and restores it on rollback', () => {
		const dir = mkdtempSync(join(tmpdir(), 'dockhand-stack-relocate-'));
		tempDirs.push(dir);
		const stackDir = join(dir, 'app');
		mkdirSync(stackDir);
		writeFileSync(join(stackDir, 'compose.yaml'), 'original\n');

		const relocation = prepareStackDirectoryRelocation(stackDir, stackDir);
		writeFileSync(join(stackDir, 'compose.yaml'), 'git overlay\n');
		writeFileSync(join(stackDir, 'new.txt'), 'new\n');
		relocation.rollback();

		expect(readFileSync(join(stackDir, 'compose.yaml'), 'utf8')).toBe('original\n');
		expect(existsSync(join(stackDir, 'new.txt'))).toBe(false);
		relocation.rollback();
	});

	it('keeps an in-place overlay when committed', () => {
		const dir = mkdtempSync(join(tmpdir(), 'dockhand-stack-relocate-'));
		tempDirs.push(dir);
		const stackDir = join(dir, 'app');
		mkdirSync(stackDir);
		writeFileSync(join(stackDir, 'compose.yaml'), 'original\n');

		const relocation = prepareStackDirectoryRelocation(stackDir, stackDir);
		writeFileSync(join(stackDir, 'compose.yaml'), 'git overlay\n');
		relocation.commit();

		expect(readFileSync(join(stackDir, 'compose.yaml'), 'utf8')).toBe('git overlay\n');
		relocation.commit();
	});

	it('rejects an existing destination and overlapping paths', () => {
		const dir = mkdtempSync(join(tmpdir(), 'dockhand-stack-relocate-'));
		tempDirs.push(dir);
		const source = join(dir, 'external');
		mkdirSync(source);
		writeFileSync(join(source, 'compose.yaml'), 'services: {}\n');

		expect(() => prepareStackDirectoryRelocation(source, join(dir, 'external', 'nested'))).toThrow();
		const destination = join(dir, 'managed');
		mkdirSync(destination);
		expect(() => prepareStackDirectoryRelocation(source, destination)).toThrow();
	});
});
