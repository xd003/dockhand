/**
 * Unit tests for file hashing and deletion planning
 * used by git sync.
 */

// @ts-expect-error -- bun:test is a runtime built-in with no types installed
import { test, expect, describe } from 'bun:test';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { computeDeletions, hashContent, hashDirFiles, trackedGitFiles } from '../src/lib/server/git-deletions';

const hashAll = (files: Record<string, string>) =>
	Object.fromEntries(Object.entries(files).map(([path, content]) => [path, hashContent(content)]));

test('Hawser Git publication excludes untracked host-only files under the selected Compose context', () => {
	const repo = mkdtempSync(join(tmpdir(), 'dockhand-git-files-'));
	try {
		const context = join(repo, 'apps', 'web');
		mkdirSync(context, { recursive: true });
		execFileSync('git', ['init', '-q'], { cwd: repo });
		writeFileSync(join(context, 'compose.yaml'), 'services: {}\n');
		writeFileSync(join(context, 'config.txt'), 'tracked\n');
		execFileSync('git', ['add', '--', 'apps/web/compose.yaml', 'apps/web/config.txt'], { cwd: repo });
		writeFileSync(join(context, 'data.bin'), Buffer.from([0, 255, 1]));
		writeFileSync(join(context, 'config-local.txt'), 'host only\n');

		expect(hashDirFiles(context, trackedGitFiles(context))).toEqual({
			'compose.yaml': hashContent('services: {}\n'),
			'config.txt': hashContent('tracked\n')
		});
	} finally {
		rmSync(repo, { recursive: true, force: true });
	}
});

describe('computeDeletions with a shipped-file manifest', () => {
	test('files absent from the new payload are deletion candidates; still-present files are not', () => {
		const prev = hashAll({
			'compose.yaml': 'services: {}\n',
			'config.yaml': 'keep: false\n',
			'scripts/run.sh': '#!/bin/sh\n'
		});
		const next = hashAll({
			'compose.yaml': 'services: {}\n',
			'.env': 'A=1\n'
		});
		const plan = computeDeletions(prev, next);
		expect(plan.toDelete.map((f) => f.path).sort()).toEqual(['config.yaml', 'scripts/run.sh']);
		expect(plan.toDelete.find((f) => f.path === 'config.yaml')?.hash).toBe(prev['config.yaml']);
		expect(plan.toDelete.some((f) => f.path === 'compose.yaml')).toBe(false);
	});

	test('compose and .env are load-bearing and never queued for deletion', () => {
		const prev = hashAll({
			'compose.yaml': 'old\n',
			'.env': 'OLD=1\n',
			'extra.conf': 'x\n'
		});
		const next = hashAll({ 'other.yaml': 'y\n' });
		const plan = computeDeletions(prev, next);
		expect(plan.toDelete.map((f) => f.path)).toEqual(['extra.conf']);
		expect(plan.skipped.map((s) => s.path).sort()).toEqual(['.env', 'compose.yaml']);
		expect(plan.skipped.every((s) => s.reason === 'load-bearing')).toBe(true);
	});
});
