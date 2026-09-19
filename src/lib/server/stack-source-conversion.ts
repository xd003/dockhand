import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { basename, dirname, join, relative, resolve, sep } from 'node:path';
import { getStackSource, upsertStackSource, deleteGitStack } from './db';
import { deleteGitStackFiles } from './git';
import { unregisterSchedule } from './scheduler';
import { getStackFileWorkspaceUnlocked } from './stack-linked-files';
import { withGitRepositoryMutationLock } from './git-stack-files';
import { withStackLock } from './stacks';
import type { LinkedStackFile } from '../stack-linked-files';

export async function convertGitStackToInternal(
	stackName: string,
	envId: number | null | undefined,
	changes: Array<{ path: string; content: string }>,
	linkedFiles: LinkedStackFile[]
): Promise<void> {
	const source = await getStackSource(stackName, envId);
	if (!source?.gitStack || source.sourceType !== 'git') throw new Error('Git source is no longer available');
	return withGitRepositoryMutationLock(source.gitStack.repositoryId, () => withStackLock(stackName, () => convertGitStackToInternalUnlocked(stackName, envId, changes, linkedFiles)));
}

async function convertGitStackToInternalUnlocked(
	stackName: string,
	envId: number | null | undefined,
	changes: Array<{ path: string; content: string }>,
	linkedFiles: LinkedStackFile[]
): Promise<void> {
	const source = await getStackSource(stackName, envId);
	if (!source?.gitStack || source.sourceType !== 'git') throw new Error('Git source is no longer available');
	const workspace = await getStackFileWorkspaceUnlocked(stackName, envId);
	const localRoot = resolve(workspace.localRoot);
	const sourceEntries = workspace.entries.filter((entry) => entry.kind === 'compose' || entry.kind === 'linked');
	const contentByPath = new Map(sourceEntries.map((entry) => {
		const localPath = resolve(localRoot, ...entry.path.split('/'));
		return [entry.path, existsSync(localPath) ? readFileSync(localPath, 'utf8') : entry.content] as const;
	}).filter((entry): entry is readonly [string, string] => typeof entry[1] === 'string'));
	for (const change of changes) contentByPath.set(change.path, change.content);

	const composePaths = sourceEntries
		.filter((entry) => entry.kind === 'compose')
		.map((entry) => join(localRoot, ...entry.path.split('/')));
	if (composePaths.length === 0) throw new Error('Git stack has no Compose file to convert');
	let envPath = source.envPath;
	const writes = sourceEntries.flatMap((entry) => {
		const content = contentByPath.get(entry.path);
		if (content === undefined) return [];
		const target = resolve(localRoot, ...entry.path.split('/'));
		if (!target.startsWith(`${localRoot}${sep}`)) throw new Error(`Conversion path escapes the deployed stack directory: ${entry.path}`);
		return [{ target, content: Buffer.from(content), mode: 0o640 }];
	});
	if (source.envPath && existsSync(source.envPath)) {
		const envRelative = relative(workspace.root, source.envPath).split(sep).join('/');
		if (envRelative && !envRelative.startsWith('../') && !envRelative.startsWith('/')) {
			const target = resolve(localRoot, ...envRelative.split('/'));
			if (!target.startsWith(`${localRoot}${sep}`)) throw new Error('Conversion environment path escapes the deployed stack directory');
			if (!existsSync(target)) writes.push({ target, content: readFileSync(source.envPath), mode: 0o640 });
			envPath = target;
		}
	}

	const backups = new Map<string, Buffer | null>();
	let committed = false;
	try {
		for (const write of writes) {
			mkdirSync(dirname(write.target), { recursive: true });
			backups.set(write.target, existsSync(write.target) ? readFileSync(write.target) : null);
			const temp = join(dirname(write.target), `.${basename(write.target)}.dockhand-convert-${process.pid}`);
			writeFileSync(temp, write.content, { mode: write.mode });
			renameSync(temp, write.target);
		}
		await upsertStackSource({
			stackName,
			environmentId: envId ?? null,
			sourceType: 'internal',
			composePath: composePaths[0],
			composePaths,
			envPath: envPath ?? null,
			secretProviderId: source.secretProviderId,
			icon: source.icon,
			linkedFiles: linkedFiles.map((file) => ({ ...file, ownership: 'local' }))
		});
		committed = true;
	} finally {
		if (!committed) {
			for (const [target, content] of backups) {
				if (content === null) rmSync(target, { force: true });
				else writeFileSync(target, content);
			}
		}
	}

	try {
		if (source.gitStack.engine === 'stack') await deleteGitStackFiles(source.gitStack.id, source.gitStack.stackName, source.gitStack.environmentId);
		unregisterSchedule(source.gitStack.id, 'git_stack_sync');
		await deleteGitStack(source.gitStack.id);
	} catch (error) {
		console.warn(`[Stack:${stackName}] Converted to internal, but Git cleanup must be retried:`, error);
	}
}
