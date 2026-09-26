import { getEnvironment } from './db';
import { dockerFetch, listContainers } from './docker';
import { getEdgeAgentCapabilities } from './hawser';

import { isAbsolute, join, relative } from 'node:path';

/** Resolve the Docker project identity before asking Hawser to verify enrollment in place. */
export async function hawserComposeProjectLabels(environmentId: number, projectName: string, selectedPath: string): Promise<HawserBinding> {
	const containers = await listContainers(true, environmentId);
	const labels = containers.find((container) => container.labels['com.docker.compose.project'] === projectName)?.labels;
	const root = labels?.['com.docker.compose.project.working_dir'];
	const configFiles = labels?.['com.docker.compose.project.config_files']?.split(',').map((path) => path.trim()).filter(Boolean);
	if (!root || !configFiles?.length || !isAbsolute(root)) throw new Error(`Compose project "${projectName}" has no accessible working_dir/config_files labels; mount its source directory in Hawser`);
	const files = configFiles.map((path) => relative(root, isAbsolute(path) ? path : join(root, path)).split('\\').join('/'));
	if (files.some((path) => !path || path === '..' || path.startsWith('../') || isAbsolute(path))) throw new Error('Compose labels contain a file outside the project directory');
	if (!configFiles.some((path) => (isAbsolute(path) ? path : join(root, path)) === selectedPath)) throw new Error('Selected file does not belong to the Compose project');
	return { root, composeFileNames: files };
}
export type { HawserApplyResult, HawserBinding, HawserFile, HawserFileChange, HawserFileDeletion, HawserFileEntry, HawserStackFileClient } from './hawser-stack-file-types';
import type { HawserApplyResult, HawserBinding, HawserFile, HawserFileChange, HawserFileDeletion, HawserFileEntry, HawserStackFileClient } from './hawser-stack-file-types';

type Request = {
	action: 'bind' | 'enroll' | 'binding' | 'relocate' | 'unbind' | 'list' | 'stat' | 'read' | 'write' | 'mkdir' | 'move' | 'delete' | 'apply';
	projectName: string;
	path?: string;
	targetPath?: string;
	root?: string;
	existingOnly?: boolean;
	removeEmptyRoot?: boolean;
	composeFileNames?: string[];
	contentBase64?: string;
	revision?: string;
	files?: HawserFileChange[];
	deletions?: HawserFileDeletion[];
};
type Reply = Partial<HawserBinding & HawserFileEntry & HawserApplyResult> & {
	rootRemoved?: boolean;
	entry?: HawserFileEntry;
	entries?: HawserFileEntry[];
	contentBase64?: string;
	error?: string;
};

/** Hawser file operations are bound to one Compose project; never accept a Dockhand filesystem root. */
export async function hawserStackFiles(environmentId: number, projectName: string): Promise<HawserStackFileClient> {
	if (!Number.isSafeInteger(environmentId) || environmentId <= 0) throw new Error('A numeric Hawser environment ID is required');
	if (!/^[a-z0-9][a-z0-9_-]*$/.test(projectName)) throw new Error('Invalid Compose project name');
	const environment = await getEnvironment(environmentId);
	if (environment?.connectionType !== 'hawser-edge' && environment?.connectionType !== 'hawser-standard') {
		throw new Error('Stack files require a Hawser environment');
	}
	let capabilities: string[];
	if (environment.connectionType === 'hawser-edge') {
		capabilities = getEdgeAgentCapabilities(environmentId);
		if (capabilities.length === 0) throw new Error('Hawser Edge is disconnected; stack files are unavailable');
	} else {
		const response = await dockerFetch('/_hawser/info', { method: 'GET' }, environmentId);
		if (!response.ok) throw new Error(`Hawser agent info unavailable (${response.status}); stack files are unavailable`);
		const info = await response.json() as { capabilities?: string[] };
		capabilities = info.capabilities ?? [];
	}
	if (!capabilities.includes('stack-files-v1')) throw new Error('Hawser agent must be upgraded to support stack-files-v1');

	async function request(input: Omit<Request, 'projectName'>): Promise<Reply> {
		const response = await dockerFetch('/_hawser/stack-files', {
			method: 'POST', headers: { 'Content-Type': 'application/json' },
			body: JSON.stringify({ ...input, projectName })
		}, environmentId);
		const result = await response.json() as Reply;
		if (!response.ok) throw Object.assign(new Error(result.error || `Hawser stack files failed (${response.status})`), { status: response.status });
		return result;
	}
	return {
		async bind(composeFileNames?: string[], existingOnly?: boolean): Promise<HawserBinding> {
			const reply = await request({ action: 'bind', composeFileNames, existingOnly });
			return { root: reply.root!, composeFileNames: reply.composeFileNames ?? [] };
		},
		async enroll(root: string, composeFileNames: string[]): Promise<HawserBinding> {
			const reply = await request({ action: 'enroll', root, composeFileNames });
			return { root: reply.root!, composeFileNames: reply.composeFileNames ?? [] };
		},
		async binding(): Promise<HawserBinding> {
			const reply = await request({ action: 'binding' });
			return { root: reply.root!, composeFileNames: reply.composeFileNames ?? [], managed: reply.managed === true };
		},
		async unbind(removeEmptyRoot = false): Promise<{ rootRemoved: boolean }> {
			const reply = await request({ action: 'unbind', removeEmptyRoot });
			return { rootRemoved: reply.rootRemoved === true };
		},
		async relocate(root: string): Promise<HawserBinding> {
			const reply = await request({ action: 'relocate', root });
			return { root: reply.root!, composeFileNames: reply.composeFileNames ?? [] };
		},
		async list(path = ''): Promise<HawserFileEntry[]> { return (await request({ action: 'list', path })).entries ?? []; },
		async stat(path: string): Promise<HawserFileEntry> { return (await request({ action: 'stat', path })).entry!; },
		async read(path: string): Promise<HawserFile> {
			const reply = await request({ action: 'read', path });
			return { content: Buffer.from(reply.contentBase64!, 'base64'), revision: reply.revision!, size: reply.size! };
		},
		async write(path: string, content: Uint8Array, revision?: string): Promise<HawserFileEntry> {
			return (await request({ action: 'write', path, contentBase64: Buffer.from(content).toString('base64'), revision })).entry!;
		},
		async mkdir(path: string): Promise<HawserFileEntry> { return (await request({ action: 'mkdir', path })).entry!; },
		async move(path: string, targetPath: string, revision?: string): Promise<HawserFileEntry> {
			return (await request({ action: 'move', path, targetPath, revision })).entry!;
		},
		async delete(path: string, revision?: string): Promise<void> { await request({ action: 'delete', path, revision }); },
		async apply(files: HawserFileChange[], deletions: HawserFileDeletion[] = []): Promise<HawserApplyResult> {
			const reply = await request({ action: 'apply', files, deletions });
			return { deletedFiles: reply.deletedFiles ?? [], skippedFiles: reply.skippedFiles ?? [] };
		}
	};
}
