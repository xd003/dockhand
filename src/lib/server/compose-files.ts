import { existsSync, readFileSync } from 'node:fs';
import { basename, dirname, join, isAbsolute, relative, resolve } from 'node:path';
import { isPathInside } from './git-url-safety';

export const STANDARD_OVERRIDE_MAP: Record<string, string[]> = {
	'compose.yaml': ['compose.override.yaml', 'compose.override.yml'],
	'compose.yml': ['compose.override.yaml', 'compose.override.yml'],
	'docker-compose.yaml': ['docker-compose.override.yaml', 'docker-compose.override.yml'],
	'docker-compose.yml': ['docker-compose.override.yaml', 'docker-compose.override.yml'],
};

export interface ResolvedComposeFile {
	path: string;
	role: 'primary' | 'additional' | 'override';
	source: 'user' | 'auto';
}

export interface ResolveComposeFilesInput {
	composePaths?: string[] | null;
	composePath?: string | null;
	diskExists?: (path: string) => boolean;
}

export function discoverOverrideCandidates(baseFileName: string): string[] {
	return STANDARD_OVERRIDE_MAP[baseFileName] ?? [];
}

export function discoverOverridesOnDisk(
	dir: string,
	baseFileName: string,
	existsFn: (path: string) => boolean = existsSync
): string | null {
	const candidates = discoverOverrideCandidates(baseFileName);
	for (const name of candidates) {
		const fullPath = join(dir, name);
		if (existsFn(fullPath)) return fullPath;
	}
	return null;
}

export function isStandardOverrideName(name: string): boolean {
	for (const candidates of Object.values(STANDARD_OVERRIDE_MAP)) {
		if (candidates.includes(name)) return true;
	}
	return false;
}

export function parseComposePathsColumn(raw: string | null | undefined): string[] {
	if (!raw) return [];
	try {
		const parsed = JSON.parse(raw);
		if (Array.isArray(parsed) && parsed.every((item) => typeof item === 'string')) {
			return parsed as string[];
		}
	} catch {
		return [];
	}
	return [];
}

export function serializeComposePaths(paths: string[]): string {
	return JSON.stringify(paths);
}

/**
 * Directories whose changes should trigger a stack redeploy.
 *
 * Covers every file the stack reads from the repository: the context dir (the
 * copied subtree), the directory of every configured compose file (multi-file
 * stacks may spread across directories), and the env file's directory. Nested
 * dirs are pruned so one subtree diff covers them (e.g. contextDir `apps`
 * subsumes a compose file at `apps/web/compose.yaml`). Falls back to the repo
 * root so a change anywhere still redeploys.
 */
export function getStackDiffDirs(input: {
	composePath: string;
	composePaths?: string | null;
	contextDir?: string | null;
	envFilePath?: string | null;
}): string[] {
	const dirs = new Set<string>();
	const add = (dir: string | null | undefined) => {
		if (!dir) return;
		const normalized = dir.replace(/[\\/]+$/, '') || '.';
		dirs.add(normalized);
	};

	add(input.contextDir);
	const paths = parseComposePathsColumn(input.composePaths);
	if (paths.length > 0) {
		for (const p of paths) add(dirname(p));
	} else {
		add(dirname(input.composePath));
	}
	add(input.envFilePath ? dirname(input.envFilePath) : null);

	if (dirs.has('.')) return ['.'];
	// Prune dirs nested inside another dir in the set (subtree diff covers them).
	const top = [...dirs].filter(
		(d) => ![...dirs].some((other) => other !== d && d.startsWith(other + '/'))
	);
	return top.length > 0 ? top.sort() : ['.'];
}

/**
 * Rebase repo-relative git compose paths onto the copied stack directory and
 * validate each stays inside it. Mirrors the single composePath containment
 * check in git.ts (repoFilePath): absolute paths are rejected and a relative
 * path whose `..` segments walk above the stack directory is refused. Throws
 * with a descriptive message on the first offending entry.
 *
 * `copiedPrimaryDir` is the on-disk directory of the copied primary compose
 * file; `workingDir` is the stack directory the repo subtree was copied into.
 */
export function rebaseGitComposePaths(
	composePaths: string[],
	copiedPrimaryDir: string,
	workingDir: string
): string[] {
	const sourcePrimaryDir = dirname(composePaths[0]);
	return composePaths.map((path) => {
		if (isAbsolute(path)) {
			throw new Error(`Compose file path must be relative to the repository: ${path}`);
		}
		const rebased = join(copiedPrimaryDir, relative(sourcePrimaryDir, path));
		if (!isPathInside(resolve(workingDir, rebased), workingDir)) {
			throw new Error(`Compose file path escapes the stack directory: ${path}`);
		}
		return rebased;
	});
}

export function resolveEffectiveComposeFiles(input: ResolveComposeFilesInput): ResolvedComposeFile[] {
	const { composePaths, composePath, diskExists } = input;

	const basePaths = composePaths && composePaths.length > 0
		? composePaths
		: composePath
			? [composePath]
			: [];

	if (basePaths.length === 0) return [];

	const existsFn = diskExists ?? ((p: string) => existsSync(p));

	const allFilePaths: ResolvedComposeFile[] = [];

	for (let i = 0; i < basePaths.length; i++) {
		const path = basePaths[i];
		const role = i === 0 ? 'primary' : 'additional';
		const source = 'user';
		allFilePaths.push({ path, role, source });

		const baseName = basename(path);
		const baseDir = dirname(path);
		const candidates = discoverOverrideCandidates(baseName);

		for (const candidate of candidates) {
			const fullPath = join(baseDir, candidate);
			if (existsFn(fullPath)) {
				const alreadyIncluded = allFilePaths.some((f) => f.path === fullPath);
				if (!alreadyIncluded) {
					allFilePaths.push({ path: fullPath, role: 'override', source: 'auto' });
				}
			}
		}
	}

	return allFilePaths;
}

export function composeFilePathList(files: ResolvedComposeFile[]): string[] {
	return files.map((f) => f.path);
}

/** Filenames Docker Compose auto-discovers when no `-f` is passed. */
const STANDARD_COMPOSE_BASENAMES = new Set([
	'compose.yaml',
	'compose.yml',
	'docker-compose.yaml',
	'docker-compose.yml'
]);

/**
 * Whether to pass explicit `-f` flags to `docker compose`.
 *
 * Omit `-f` only for a single standard compose filename so Compose can
 * auto-discover it (and any matching override) from cwd. Any non-standard
 * name (e.g. `immich.yaml`, `docker-compose.prod.yml`) or multi-file set
 * must use `-f`, otherwise Compose reports "no configuration file provided".
 */
export function shouldUseExplicitFFlags(files: ResolvedComposeFile[]): boolean {
	if (files.length === 0) return false;
	if (files.length > 1) return true;
	return !STANDARD_COMPOSE_BASENAMES.has(basename(files[0].path));
}

export function remapPaths(oldDir: string, newDir: string, paths: string[]): string[] {
	const absOld = oldDir.endsWith('/') ? oldDir : oldDir + '/';
	const absNew = newDir.endsWith('/') ? newDir : newDir + '/';
	return paths.map((p) => {
		if (isAbsolute(p) && p.startsWith(absOld)) {
			return absNew + p.slice(absOld.length);
		}
		return p;
	});
}

export function dedupePaths(paths: string[]): string[] {
	const seen = new Set<string>();
	const result: string[] = [];
	for (const p of paths) {
		if (!seen.has(p)) {
			seen.add(p);
			result.push(p);
		}
	}
	return result;
}

export function findComposeOverrideFile(stackDir: string, composeFileName: string): string | null {
	return discoverOverridesOnDisk(stackDir, composeFileName, existsSync);
}
