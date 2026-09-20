import {
	accessSync,
	cpSync,
	constants as fsConstants,
	existsSync,
	lstatSync,
	mkdirSync,
	mkdtempSync,
	rmSync,
	rmdirSync,
	readFileSync,
	renameSync,
	unlinkSync,
	writeFileSync
} from 'node:fs';
import { basename, dirname, isAbsolute, join, relative, resolve, sep as pathSep } from 'node:path';

/** True when childPath is rootPath or one of its descendants. */
export function isPathUnderRoot(childPath: string, rootPath: string): boolean {
	const child = resolve(childPath);
	const root = resolve(rootPath);
	return child === root || child.startsWith(root + pathSep);
}

/** Remap a path from one stack dir root to its mirror under another root. Paths outside fromDir pass through. */
export function remapPathBetweenDirs(fromDir: string, toDir: string, path: string): string {
	const resolvedPath = resolve(path);
	return isPathUnderRoot(resolvedPath, fromDir)
		? join(resolve(toDir), relative(resolve(fromDir), resolvedPath))
		: path;
}

export function remapPathsBetweenDirs(fromDir: string, toDir: string, paths: string[]): string[] {
	return paths.map((path) => remapPathBetweenDirs(fromDir, toDir, path));
}

/** Resolve repo-relative Git stack paths inside the copied deployment directory. */
export function resolveGitStackPaths(rawPaths: string[], contextDir: string, stackDir: string | null): string[] {
	return rawPaths.map((path) => {
		if (isAbsolute(path) || !stackDir) return path;
		let deployedPath = path;
		if (contextDir) {
			if (path.startsWith(contextDir + '/')) deployedPath = path.slice(contextDir.length + 1);
			else if (path === contextDir) deployedPath = basename(path);
		}
		return join(stackDir, deployedPath);
	});
}

export function resolveStackDirForLayout(
	defaultRoot: string,
	localRoot: string,
	stackName: string,
	environmentName: string | undefined,
	flatLocal: boolean
): string {
	return join(flatLocal ? localRoot : defaultRoot, ...(!flatLocal && environmentName ? [environmentName] : []), stackName);
}

/** Resolve Docker Compose label paths without trusting paths supplied by the browser. */
export function resolveComposePathHints(
	workingDir: string | null,
	configFiles: string[] | null
): string[] {
	if (!configFiles?.length) return [];
	return configFiles.flatMap((path) => {
		if (!path) return [];
		if (isAbsolute(path)) return [resolve(path)];
		return workingDir ? [resolve(workingDir, path)] : [];
	});
}

export function findStackNameCollision<T extends { stackName: string; environmentId: number | null }>(
	sources: T[],
	stackName: string,
	environmentId?: number | null
): T | undefined {
	return sources.find(
		(source) => source.stackName === stackName && source.environmentId !== environmentId && source.environmentId != null
	);
}

/** Move a file atomically when possible, with a copy+delete fallback across filesystems. */
export function moveStackFilePathCrossDevice(
	sourcePath: string,
	destPath: string,
	label: string,
	rename: typeof renameSync = renameSync
): void {
	try {
		rename(sourcePath, destPath);
		console.log(`[Stack] Moved ${label}: ${sourcePath} -> ${destPath}`);
	} catch (renameError: any) {
		if (renameError.code !== 'EXDEV') {
			console.warn(`[Stack] Failed to move ${label}: ${renameError.message}`);
			return;
		}

		try {
			writeFileSync(destPath, readFileSync(sourcePath));
			unlinkSync(sourcePath);
			console.log(`[Stack] Copied ${label} (cross-fs): ${sourcePath} -> ${destPath}`);
		} catch (error: any) {
			console.warn(`[Stack] Failed to copy ${label}: ${error.message}`);
		}
	}
}

export interface StackDirectoryRelocation {
	sourceDir: string;
	destinationDir: string;
	commit(): void;
	rollback(): void;
}

/**
 * Stage a complete stack directory without touching the source until commit.
 * The destination is owned by the returned transaction, so rollback cannot
 * remove a directory that existed before this operation.
 */
export function prepareStackDirectoryRelocation(
	sourceDir: string,
	destinationDir: string
): StackDirectoryRelocation {
	const source = resolve(sourceDir);
	const destination = resolve(destinationDir);
	const sameIdentity = (path: string, expected: NonNullable<ReturnType<typeof lstatSync>>): boolean => {
		try {
			const actual = lstatSync(path);
			return actual.dev === expected.dev && actual.ino === expected.ino;
		} catch {
			return false;
		}
	};

	if (source !== destination && (isPathUnderRoot(source, destination) || isPathUnderRoot(destination, source))) {
		throw new Error('Stack source and destination directories must not overlap');
	}
	if (!existsSync(source) || !lstatSync(source).isDirectory()) {
		throw new Error(`Stack source directory is not accessible: ${source}`);
	}
	try {
		accessSync(source, fsConstants.R_OK | fsConstants.X_OK);
		accessSync(dirname(source), fsConstants.W_OK | fsConstants.X_OK);
	} catch {
		throw new Error(`Stack source directory is not readable or removable: ${source}`);
	}
	const sourceIdentity = lstatSync(source);
	if (!sourceIdentity) throw new Error(`Stack source directory is not accessible: ${source}`);

	if (source === destination) {
		const snapshotRoot = mkdtempSync(join(dirname(source), '.dockhand-adoption-'));
		const snapshot = join(snapshotRoot, 'stack');
		try {
			cpSync(source, snapshot, {
				recursive: true,
				force: false,
				errorOnExist: true,
				dereference: false,
				verbatimSymlinks: true
			});
		} catch (error) {
			rmSync(snapshotRoot, { recursive: true, force: true });
			throw new Error(`Failed to snapshot stack directory: ${error instanceof Error ? error.message : String(error)}`);
		}
		const destinationIdentity = lstatSync(destination);
		if (!destinationIdentity) throw new Error(`Stack source directory is not accessible: ${destination}`);

		let committed = false;
		let rolledBack = false;
		return {
			sourceDir: source,
			destinationDir: destination,
			commit() {
				if (committed) return;
				if (rolledBack) throw new Error('Cannot commit a rolled-back stack directory relocation');
				if (!sameIdentity(destination, destinationIdentity)) throw new Error('Stack directory changed before commit');
				rmSync(snapshotRoot, { recursive: true, force: false });
				committed = true;
			},
			rollback() {
				if (committed || rolledBack) return;
				if (!sameIdentity(destination, destinationIdentity)) throw new Error('Stack directory changed before rollback');
				rmSync(destination, { recursive: true, force: false });
				renameSync(snapshot, destination);
				rmSync(snapshotRoot, { recursive: true, force: false });
				rolledBack = true;
			}
		};
	}
	if (existsSync(destination)) {
		throw new Error(`Stack destination already exists: ${destination}`);
	}

	const createdParents: string[] = [];
	let parent = dirname(destination);
	while (!existsSync(parent)) {
		createdParents.push(parent);
		const next = dirname(parent);
		if (next === parent) break;
		parent = next;
	}
	try {
		accessSync(parent, fsConstants.W_OK | fsConstants.X_OK);
	} catch {
		throw new Error(`Stack destination parent is not writable: ${parent}`);
	}

	try {
		mkdirSync(dirname(destination), { recursive: true });
		cpSync(source, destination, {
			recursive: true,
			force: false,
			errorOnExist: true,
			dereference: false,
			verbatimSymlinks: true
		});
	} catch (error) {
		try { rmSync(destination, { recursive: true, force: true }); } catch { /* preserve the original copy error */ }
		for (const createdParent of createdParents) {
			try { rmdirSync(createdParent); } catch { break; }
		}
		throw new Error(`Failed to stage stack directory: ${error instanceof Error ? error.message : String(error)}`);
	}
	const destinationIdentity = lstatSync(destination);
	if (!destinationIdentity) throw new Error(`Stack destination is not accessible: ${destination}`);

	let committed = false;
	let rolledBack = false;
	return {
		sourceDir: source,
		destinationDir: destination,
		commit() {
			if (committed) return;
			if (rolledBack) throw new Error('Cannot commit a rolled-back stack directory relocation');
			if (!sameIdentity(source, sourceIdentity)) throw new Error('Stack source changed before commit');
			if (!sameIdentity(destination, destinationIdentity)) throw new Error('Stack directory changed before commit');
			rmSync(source, { recursive: true, force: false });
			committed = true;
		},
		rollback() {
			if (committed || rolledBack) return;
			if (existsSync(destination) && !sameIdentity(destination, destinationIdentity)) throw new Error('Stack directory changed before rollback');
			if (existsSync(destination)) rmSync(destination, { recursive: true, force: false });
			for (const createdParent of createdParents) {
				try { rmdirSync(createdParent); } catch { break; }
			}
			rolledBack = true;
		}
	};
}
