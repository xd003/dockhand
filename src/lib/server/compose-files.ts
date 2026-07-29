import { existsSync, readFileSync } from 'node:fs';
import { basename, dirname, join, isAbsolute, relative } from 'node:path';

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

export function shouldUseExplicitFFlags(files: ResolvedComposeFile[]): boolean {
	if (files.length > 1) return true;
	if (files.length === 1 && files[0].source === 'user' && files[0].role === 'additional') return true;
	return false;
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
