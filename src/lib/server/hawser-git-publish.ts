/** Builds the Hawser apply payload for a Git stack's tracked checkout files (no DB imports; unit-testable). */
import { lstatSync, readFileSync, realpathSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { gitIndexFileModes } from './git-deletions';
import type { HawserFileChange } from './hawser-stack-file-types';
import { isPathUnderRoot } from './stack-path-utils';

/**
 * The per-file limit a Git publish to Hawser must respect: the smaller of Dockhand's
 * GIT_PUBLISH_MAX_FILE_SIZE_MB and the agent's reported MAX_STACK_FILE_SIZE_MB, so an
 * oversized file is refused before any batch is written. Agents that report no limit
 * leave Dockhand's.
 */
export function gitPublishFileLimit(dockhandMaxFileSize: number, agentMaxFileSize?: number): { maxFileSize: number; fileSizeSetting: string } {
	return agentMaxFileSize !== undefined && agentMaxFileSize < dockhandMaxFileSize
		? { maxFileSize: agentMaxFileSize, fileSizeSetting: 'MAX_STACK_FILE_SIZE_MB on the Hawser agent' }
		: { maxFileSize: dockhandMaxFileSize, fileSizeSetting: 'GIT_PUBLISH_MAX_FILE_SIZE_MB on Dockhand' };
}

/**
 * One change per path, carrying the file's Git index mode so executable scripts stay
 * executable on the agent. Paths Git does not track as a regular file (an untracked
 * selected env file) carry no mode, so the agent keeps its legacy behaviour for them.
 */
export async function buildGitPublishChanges(
	checkoutDir: string,
	paths: Iterable<string>,
	/** `fileSizeSetting` names the setting behind maxFileSize in the error. */
	limits: { maxFileSize: number; maxTotalSize: number; fileSizeSetting?: string },
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
		if (size > limits.maxFileSize) {
			const mib = (bytes: number) => `${(bytes / 1024 / 1024).toFixed(1).replace(/\.0$/, '')} MiB`;
			throw new Error(`Git publish file ${path} is ${mib(size)}, over the ${mib(limits.maxFileSize)} per-file limit${limits.fileSizeSetting ? ` (${limits.fileSizeSetting})` : ''}`);
		}
		if ((totalBytes += size) > limits.maxTotalSize) throw new Error(`Git publish exceeds the ${limits.maxTotalSize / 1024 / 1024} MiB total transport limit at ${path}`);
		const revision = await revisionOf(path);
		changes.push({ path, contentBase64: readFileSync(target).toString('base64'), revision, mode: modes.get(path) });
	}
	return changes;
}
