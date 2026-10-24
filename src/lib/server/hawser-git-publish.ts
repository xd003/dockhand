/** Builds the Hawser apply payload for a Git stack's tracked checkout files (no DB imports; unit-testable). */
import { lstatSync, readFileSync, realpathSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { gitIndexFileModes } from './git-deletions';
import type { HawserFileChange } from './hawser-stack-file-types';
import { isPathUnderRoot } from './stack-path-utils';

/**
 * One change per path, carrying the file's Git index mode so executable scripts stay
 * executable on the agent. Paths Git does not track as a regular file (an untracked
 * selected env file) carry no mode, so the agent keeps its legacy behaviour for them.
 */
export async function buildGitPublishChanges(
	checkoutDir: string,
	paths: Iterable<string>,
	limits: { maxFileSize: number; maxTotalSize: number },
	revisionOf: (path: string) => Promise<string | undefined>
): Promise<HawserFileChange[]> {
	const checkoutRoot = realpathSync(checkoutDir);
	const modes = gitIndexFileModes(checkoutRoot);
	const changes: HawserFileChange[] = [];
	let totalBytes = 0;
	for (const path of paths) {
		const target = join(checkoutRoot, path);
		if (!isPathUnderRoot(realpathSync(target), checkoutRoot) || !lstatSync(target).isFile()) throw new Error(`Git publish path is not a regular checkout file: ${path}`);
		const size = statSync(target).size;
		if (size > limits.maxFileSize || (totalBytes += size) > limits.maxTotalSize) throw new Error(`Git publish file exceeds transport limits: ${path}`);
		const revision = await revisionOf(path);
		changes.push({ path, contentBase64: readFileSync(target).toString('base64'), revision, mode: modes.get(path) });
	}
	return changes;
}
