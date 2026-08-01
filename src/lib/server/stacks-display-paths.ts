import { join, relative, resolve, sep as pathSep } from 'node:path';

function isPathUnderRoot(childPath: string, rootPath: string): boolean {
	const resolvedChild = resolve(childPath);
	const resolvedRoot = resolve(rootPath);
	return resolvedChild === resolvedRoot || resolvedChild.startsWith(resolvedRoot + pathSep);
}

/**
 * Remap absolute paths from Dockhand's Hawser staging dir to the remote host stack dir.
 */
export function remapPathsFromStagingToRemote(
	stagingStackDir: string,
	remoteStackDir: string,
	paths: string[]
): string[] {
	const stagingResolved = resolve(stagingStackDir);
	const remoteResolved = resolve(remoteStackDir);
	return paths.map((p) => {
		const resolved = resolve(p);
		if (isPathUnderRoot(resolved, stagingResolved)) {
			return join(remoteResolved, relative(stagingResolved, resolved));
		}
		return p;
	});
}
