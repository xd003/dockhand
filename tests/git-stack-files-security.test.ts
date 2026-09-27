import { afterEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, mkdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { resolveSafeGitFileTarget } from '../src/lib/server/git-url-safety';

let root = '';

afterEach(() => {
	if (root) rmSync(root, { recursive: true, force: true });
	root = '';
});

describe('Git stack file containment', () => {
	test('rejects symlink targets and symlinked parents outside the checkout', () => {
		root = mkdtempSync(join(tmpdir(), 'dockhand-git-files-'));
		const repo = join(root, 'repo');
		const outside = join(root, 'outside');
		mkdirSync(repo);
		mkdirSync(outside);
		writeFileSync(join(outside, 'secret'), 'secret');
		symlinkSync(join(outside, 'secret'), join(repo, 'file'));
		symlinkSync(outside, join(repo, 'dir'));

		expect(() => resolveSafeGitFileTarget(repo, 'file')).toThrow('symbolic link');
		expect(() => resolveSafeGitFileTarget(repo, 'dir/config')).toThrow('escapes the repository');
	});
});
