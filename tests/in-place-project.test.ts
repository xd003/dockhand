import { afterEach, expect, test } from 'bun:test';
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { publishGitFilesInPlace, resolveExistingComposeFile } from '../src/lib/server/in-place-project';

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });

function fixture() {
	const root = mkdtempSync(join(tmpdir(), 'dockhand-in-place-'));
	roots.push(root);
	const checkout = join(root, 'checkout');
	const project = join(root, 'project');
	mkdirSync(join(checkout, 'config'), { recursive: true });
	mkdirSync(join(project, 'data'), { recursive: true });
	writeFileSync(join(checkout, 'compose.yaml'), 'from git');
	writeFileSync(join(checkout, 'config', 'app.conf'), 'tracked config');
	writeFileSync(join(checkout, 'untracked.txt'), 'not published');
	writeFileSync(join(project, 'compose.yaml'), 'old compose');
	writeFileSync(join(project, 'data', 'db.sqlite'), 'bind data');
	writeFileSync(join(project, 'notes.txt'), 'host-only file');
	return { root, checkout, project };
}

test('publishes only listed tracked files, replacing same paths and keeping everything else', () => {
	const { checkout, project } = fixture();
	chmodSync(join(checkout, 'compose.yaml'), 0o755);
	expect(publishGitFilesInPlace(checkout, project, ['compose.yaml', 'config/app.conf'])).toEqual(['compose.yaml', 'config/app.conf']);
	expect(readFileSync(join(project, 'compose.yaml'), 'utf8')).toBe('from git');
	expect(statSync(join(project, 'compose.yaml')).mode & 0o777).toBe(0o755);
	expect(readFileSync(join(project, 'config', 'app.conf'), 'utf8')).toBe('tracked config');
	expect(readFileSync(join(project, 'data', 'db.sqlite'), 'utf8')).toBe('bind data');
	expect(readFileSync(join(project, 'notes.txt'), 'utf8')).toBe('host-only file');
	expect(() => statSync(join(project, 'untracked.txt'))).toThrow();
});

test('refuses to publish through a symlink in the project directory, writing nothing', () => {
	const { root, checkout, project } = fixture();
	const outside = join(root, 'outside');
	mkdirSync(outside);
	symlinkSync(outside, join(project, 'config'));
	expect(() => publishGitFilesInPlace(checkout, project, ['compose.yaml', 'config/app.conf'])).toThrow('not a plain directory');
	expect(readFileSync(join(project, 'compose.yaml'), 'utf8')).toBe('old compose');
	expect(() => statSync(join(outside, 'app.conf'))).toThrow();
});

test('rejects traversal and symlinked checkout entries', () => {
	const { root, checkout, project } = fixture();
	expect(() => publishGitFilesInPlace(checkout, project, ['../escape.yaml'])).toThrow('Unsafe Git publish path');
	writeFileSync(join(root, 'secret'), 'secret');
	symlinkSync(join(root, 'secret'), join(checkout, 'link.yaml'));
	expect(() => publishGitFilesInPlace(checkout, project, ['link.yaml'])).toThrow('not a regular checkout file');
});

test('existing Compose selection must be an absolute YAML file Dockhand can read', () => {
	const { project } = fixture();
	expect(resolveExistingComposeFile(join(project, 'compose.yaml'))).toEqual({ ok: true, composePath: join(project, 'compose.yaml'), projectDir: project });
	expect(resolveExistingComposeFile('compose.yaml').ok).toBe(false);
	expect(resolveExistingComposeFile(join(project, 'notes.txt')).ok).toBe(false);
	expect(resolveExistingComposeFile(join(project, 'missing.yaml')).ok).toBe(false);
	expect(resolveExistingComposeFile(`${project}/../project/compose.yaml`).ok).toBe(false);
});
