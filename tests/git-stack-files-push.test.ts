import { afterEach, expect, mock, test } from 'bun:test';
import { createHash } from 'node:crypto';
import { execFileSync, spawn } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

let failPush = false;
mock.module('../src/lib/server/git', () => ({
	buildGitEnv: async () => process.env,
	cleanupSshKey: () => {},
	execGit: (args: string[], cwd: string) => new Promise<{ code: number; stdout: string; stderr: string }>((resolve) => {
		if (failPush && args[0] === 'push') return resolve({ code: 1, stdout: '', stderr: 'rejected' });
		const child = spawn('git', args, { cwd });
		let stdout = ''; let stderr = '';
		child.stdout.on('data', (chunk) => stdout += chunk);
		child.stderr.on('data', (chunk) => stderr += chunk);
		child.on('close', (code) => resolve({ code: code ?? 1, stdout, stderr }));
	})
}));
const { mutateGitStackFiles } = await import('../src/lib/server/git-stack-files');

let root = '';
afterEach(() => { if (root) rmSync(root, { recursive: true, force: true }); root = ''; failPush = false; });

function git(cwd: string, ...args: string[]): string {
	return execFileSync('git', args, { cwd, encoding: 'utf8' }).trim();
}

test('push fetches unrelated remote changes without losing local-only files or .gitignore', async () => {
	root = mkdtempSync(join(tmpdir(), 'dockhand-push-'));
	git(root, 'init', '--bare', 'remote.git');
	git(root, 'clone', 'remote.git', 'checkout');
	const checkout = join(root, 'checkout');
	git(checkout, 'config', 'user.email', 'test@example.com');
	git(checkout, 'config', 'user.name', 'Test');
	writeFileSync(join(checkout, 'compose.yaml'), 'old\n');
	writeFileSync(join(checkout, '.gitignore'), '\n');
	writeFileSync(join(checkout, 'other.txt'), 'old\n');
	git(checkout, 'add', '.');
	git(checkout, 'commit', '-m', 'initial');
	git(checkout, 'branch', '-M', 'main');
	git(checkout, 'push', '-u', 'origin', 'main');
	git(root, 'clone', '--branch', 'main', 'remote.git', 'remote-edit');
	const remoteEdit = join(root, 'remote-edit');
	git(remoteEdit, 'config', 'user.email', 'test@example.com');
	git(remoteEdit, 'config', 'user.name', 'Test');
	writeFileSync(join(remoteEdit, 'other.txt'), 'upstream\n');
	git(remoteEdit, 'add', '.');
	git(remoteEdit, 'commit', '-m', 'upstream');
	git(remoteEdit, 'push');
	writeFileSync(join(checkout, '.gitignore'), '\n/local.txt\n');
	writeFileSync(join(checkout, 'local.txt'), 'local\n');
	const revision = createHash('sha256').update('old\n').digest('hex');
	const options = { repositoryId: 1, repoPath: checkout, branch: 'main', credential: null,
		changes: [{ path: 'compose.yaml', content: 'new\n', expectedRevision: revision }],
		trackedDecision: 'commit' as const, untrackedDecision: 'add' as const, commitMessage: 'Update compose' };
	const result = await mutateGitStackFiles(options);
	expect(result.committed).toBe(true);
	expect(git(remoteEdit, 'fetch', 'origin', 'main')).toBe('');
	expect(git(remoteEdit, 'show', 'origin/main:other.txt')).toBe('upstream');
	expect(git(remoteEdit, 'show', 'origin/main:compose.yaml')).toBe('new');
	expect(readFileSync(join(checkout, '.gitignore'), 'utf8')).toBe('\n/local.txt\n');
	expect(readFileSync(join(checkout, 'local.txt'), 'utf8')).toBe('local\n');
	failPush = true;
	await expect(mutateGitStackFiles({ ...options, changes: [{ ...options.changes[0],
		expectedRevision: createHash('sha256').update('new\n').digest('hex'), content: 'failed push\n' }] }))
		.rejects.toThrow('Git push failed');
	failPush = false;
	expect(readFileSync(join(checkout, 'compose.yaml'), 'utf8')).toBe('new\n');
	expect(readFileSync(join(checkout, '.gitignore'), 'utf8')).toBe('\n/local.txt\n');

	git(remoteEdit, 'pull', '--ff-only');
	writeFileSync(join(remoteEdit, 'compose.yaml'), 'remote version\n');
	git(remoteEdit, 'add', '.');
	git(remoteEdit, 'commit', '-m', 'remote compose');
	git(remoteEdit, 'push');
	await expect(mutateGitStackFiles({ ...options, changes: [{ ...options.changes[0], content: 'overwrite\n' }] }))
		.rejects.toThrow('Git file changed on the remote');
	expect(git(checkout, 'show', 'HEAD:compose.yaml')).toBe('new');
});
