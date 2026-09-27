/**
 * Helpers for stacks adopted in place: an existing, user-selected Compose project directory
 * keeps its location, and Dockhand deploys (and for Git, publishes tracked files) there
 * instead of creating a managed deployment copy. Pure filesystem logic (no DB/Docker).
 */
import { copyFileSync, existsSync, lstatSync, mkdirSync, realpathSync, statSync } from 'node:fs';
import { basename, dirname, isAbsolute, join, relative, resolve } from 'node:path';
import { isProtectedPath } from './fs-guard';
import { isAllowedStackFilename } from './stack-filename';
import { isPathUnderRoot } from './stack-path-utils';

/** Validate a Dockhand-accessible Compose file selected for in-place adoption. */
export function resolveExistingComposeFile(input: unknown): { ok: true; composePath: string; projectDir: string } | { ok: false; error: string } {
	if (typeof input !== 'string' || !input.trim()) return { ok: false, error: 'Select the existing Compose file' };
	const composePath = input.trim();
	if (!isAbsolute(composePath) || composePath.split(/[\\/]/).includes('..')) {
		return { ok: false, error: 'The existing Compose file must be an absolute path without ".." segments' };
	}
	if (!/\.ya?ml$/i.test(composePath) || !isAllowedStackFilename(basename(composePath))) {
		return { ok: false, error: 'Select a .yml or .yaml Compose file' };
	}
	if (isProtectedPath(composePath)) return { ok: false, error: 'The selected Compose file is in a protected location' };
	let stats;
	try { stats = statSync(composePath); }
	catch { return { ok: false, error: `Compose file not found on Dockhand's filesystem: ${composePath}` }; }
	if (!stats.isFile()) return { ok: false, error: `Not a regular file: ${composePath}` };
	return { ok: true, composePath: resolve(composePath), projectDir: dirname(resolve(composePath)) };
}

/**
 * Copy Git-tracked checkout files into an existing project directory. Only the listed
 * paths are written; unrelated files and bind-mount data stay untouched. Symlinks on
 * either side are rejected so a publish can never escape either directory.
 */
export function publishGitFilesInPlace(checkoutDir: string, projectDir: string, paths: Iterable<string>): string[] {
	const checkoutRoot = realpathSync(checkoutDir);
	const projectRoot = realpathSync(projectDir);
	if (!lstatSync(projectRoot).isDirectory()) throw new Error(`Project directory is not a directory: ${projectDir}`);
	const planned: Array<{ source: string; target: string; path: string }> = [];
	for (const path of paths) {
		if (!path || isAbsolute(path) || path.includes('\0') || path.split(/[\\/]/).some((part) => !part || part === '.' || part === '..')) {
			throw new Error(`Unsafe Git publish path: ${path}`);
		}
		const source = join(checkoutRoot, path);
		if (!lstatSync(source).isFile() || !isPathUnderRoot(realpathSync(source), checkoutRoot)) {
			throw new Error(`Git publish path is not a regular checkout file: ${path}`);
		}
		const target = join(projectRoot, path);
		for (let current = dirname(target); current !== projectRoot; current = dirname(current)) {
			if (!existsSync(current)) continue;
			const entry = lstatSync(current);
			if (entry.isSymbolicLink() || !entry.isDirectory()) throw new Error(`Cannot publish ${path}: ${relative(projectRoot, current)} is not a plain directory`);
		}
		let existing;
		try { existing = lstatSync(target); } catch { existing = null; }
		if (existing && (existing.isSymbolicLink() || !existing.isFile())) throw new Error(`Cannot publish ${path}: the existing path is not a regular file`);
		planned.push({ source, target, path });
	}
	for (const { source, target } of planned) {
		mkdirSync(dirname(target), { recursive: true });
		copyFileSync(source, target);
	}
	return planned.map(({ path }) => path);
}

function lstatExists(path: string): boolean {
	try { lstatSync(path); return true; } catch { return false; }
}
