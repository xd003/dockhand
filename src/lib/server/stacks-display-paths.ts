import { join, relative, resolve } from 'node:path';
import { isPathUnderRoot } from './path-utils';

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
