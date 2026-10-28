// @ts-expect-error -- bun:test is a runtime built-in with no types installed
import { test, expect } from 'bun:test';
import { execFileSync } from 'node:child_process';
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildGitPublishChanges, gitPublishFileLimit } from '../src/lib/server/hawser-git-publish';

test('Hawser Git publish payload carries each file’s Git index mode, not the clone’s filesystem mode', async () => {
	const repo = mkdtempSync(join(tmpdir(), 'dockhand-git-modes-'));
	try {
		const context = join(repo, 'apps', 'bot');
		mkdirSync(join(context, 'scripts'), { recursive: true });
		execFileSync('git', ['init', '-q'], { cwd: repo });
		for (const name of ['compose.yaml', 'scripts/start.sh', 'config.txt']) writeFileSync(join(context, name), name);
		execFileSync('git', ['add', '--', 'apps/bot'], { cwd: repo });
		// Index and filesystem disagree in both directions: the index must win.
		execFileSync('git', ['update-index', '--chmod=+x', '--', 'apps/bot/scripts/start.sh'], { cwd: repo });
		chmodSync(join(context, 'scripts/start.sh'), 0o644);
		chmodSync(join(context, 'config.txt'), 0o755);
		writeFileSync(join(context, '.env'), 'A=1\n'); // selected env file, untracked

		const changes = await buildGitPublishChanges(
			context,
			['compose.yaml', 'scripts/start.sh', 'config.txt', '.env'],
			{ maxFileSize: 1024, maxTotalSize: 4096 },
			async (path) => (path === 'compose.yaml' ? 'rev-1' : undefined)
		);

		expect(changes.map(({ path, mode, revision }) => ({ path, mode, revision }))).toEqual([
			{ path: 'compose.yaml', mode: 0o644, revision: 'rev-1' },
			{ path: 'scripts/start.sh', mode: 0o755, revision: undefined },
			{ path: 'config.txt', mode: 0o644, revision: undefined },
			{ path: '.env', mode: undefined, revision: undefined }
		]);
		expect(JSON.parse(JSON.stringify(changes))[1].mode).toBe(493);
		expect('mode' in JSON.parse(JSON.stringify(changes))[3]).toBe(false);
	} finally {
		rmSync(repo, { recursive: true, force: true });
	}
});

test('a Git publish to Hawser uses the smaller of Dockhand\'s and the agent\'s per-file limit, and names it', async () => {
	const MiB = 1024 * 1024;
	expect(gitPublishFileLimit(10 * MiB, undefined)).toEqual({ maxFileSize: 10 * MiB, fileSizeSetting: 'GIT_PUBLISH_MAX_FILE_SIZE_MB on Dockhand' });
	expect(gitPublishFileLimit(10 * MiB, 50 * MiB).maxFileSize).toBe(10 * MiB);
	expect(gitPublishFileLimit(10 * MiB, 10 * MiB).fileSizeSetting).toBe('GIT_PUBLISH_MAX_FILE_SIZE_MB on Dockhand');
	expect(gitPublishFileLimit(50 * MiB, 10 * MiB)).toEqual({ maxFileSize: 10 * MiB, fileSizeSetting: 'MAX_STACK_FILE_SIZE_MB on the Hawser agent' });

	const repo = mkdtempSync(join(tmpdir(), 'dockhand-git-limit-'));
	try {
		execFileSync('git', ['init', '-q'], { cwd: repo });
		writeFileSync(join(repo, 'big.bin'), Buffer.alloc(3 * MiB / 2));
		const limits = { ...gitPublishFileLimit(50 * MiB, MiB), maxTotalSize: 256 * MiB };
		await expect(buildGitPublishChanges(repo, ['big.bin'], limits, async () => undefined))
			.rejects.toThrow('Git publish file big.bin is 1.5 MiB, over the 1 MiB per-file limit (MAX_STACK_FILE_SIZE_MB on the Hawser agent)');
	} finally {
		rmSync(repo, { recursive: true, force: true });
	}
});
