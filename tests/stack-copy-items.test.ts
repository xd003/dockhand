import { expect, test } from 'bun:test';
import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { copyStackItems } from '../src/lib/server/stack-copy-items';

test('copies files and directories before the Git overlay without moving the originals', () => {
	const root = mkdtempSync(join(tmpdir(), 'dockhand-copy-'));
	try {
		const source = join(root, 'source');
		const destination = join(root, 'managed');
		mkdirSync(join(source, 'assets'), { recursive: true });
		writeFileSync(join(source, 'assets', 'data.txt'), 'original');
		writeFileSync(join(source, 'config.txt'), 'original');
		copyStackItems([join(source, 'assets'), join(source, 'config.txt')], destination);
		expect(readFileSync(join(destination, 'assets', 'data.txt'), 'utf8')).toBe('original');
		expect(existsSync(join(source, 'assets', 'data.txt'))).toBe(true);
		writeFileSync(join(destination, 'config.txt'), 'Git overlay');
		expect(readFileSync(join(destination, 'config.txt'), 'utf8')).toBe('Git overlay');
		symlinkSync(join(source, 'config.txt'), join(source, 'assets', 'link'));
		expect(() => copyStackItems([join(source, 'assets')], destination)).toThrow('symbolic link');
	} finally { rmSync(root, { recursive: true, force: true }); }
});
