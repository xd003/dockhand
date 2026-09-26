import { json, redirect } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { authorize } from '$lib/server/authorize';
import { getEnvironment } from '$lib/server/db';
import { dockerFetch } from '$lib/server/docker';
import { isHawserConnection } from '$lib/server/stacks';
import { getStackSource } from '$lib/server/db';
import { hawserStackFiles, hawserComposeProjectLabels } from '$lib/server/hawser-stack-files';
import { ensureHawserStackFilesReady } from '$lib/server/hawser-stack-file-migration';
import { hawserRelativeFilePath } from '$lib/server/stacks';

export const GET: RequestHandler = async ({ url, cookies }) => {
	const rawEnvId = url.searchParams.get('env');
	const envId = rawEnvId ? Number(rawEnvId) : null;
	const auth = await authorize(cookies);
	if (envId !== null && (!Number.isInteger(envId) || envId <= 0)) return json({ error: 'Invalid environment' }, { status: 400 });
	if (auth.authEnabled && !(await auth.can('stacks', 'edit', envId ?? undefined)) && !(await auth.can('stacks', 'create', envId ?? undefined))) return json({ error: 'Permission denied' }, { status: 403 });
	const denied = await auth.requireEnvAccess(envId);
	if (denied) return denied;
	const env = envId === null ? null : await getEnvironment(envId);
	if (envId !== null && !env) return json({ error: 'Environment not found' }, { status: 404 });
	if (!isHawserConnection(env)) redirect(307, `/api/system/files?path=${encodeURIComponent(url.searchParams.get('path') || '/')}`);
	try {
		if (url.searchParams.get('content') === '1') {
			const projectName = url.searchParams.get('projectName');
			const path = url.searchParams.get('path');
			if (!projectName || !path || !envId) return json({ error: 'Project name, environment, and path are required' }, { status: 400 });
			const source = await getStackSource(projectName, envId);
			if (!source && auth.authEnabled && !(await auth.can('stacks', 'create', envId))) return json({ error: 'Permission denied' }, { status: 403 });
			if (source) await ensureHawserStackFilesReady(projectName, envId);
			const files = await hawserStackFiles(envId, projectName);
			let root: string;
			if (source) {
				root = (await files.binding()).root;
			} else {
				try { root = (await files.binding()).root; }
				catch (error) {
					if (!(error && typeof error === 'object' && 'status' in error && error.status === 404)) throw error;
					if (!/\.ya?ml$/i.test(path)) throw new Error('Select the project Compose file before opening sibling files');
					const labels = await hawserComposeProjectLabels(envId, projectName, path);
					root = (await files.enroll(labels.root, labels.composeFileNames)).root;
				}
			}
			const read = await files.read(hawserRelativeFilePath(root, path));
			if (read.size > 10 * 1024 * 1024) return json({ error: 'File too large (max 10 MiB)' }, { status: 400 });
			return json({ path, content: new TextDecoder('utf-8', { fatal: true }).decode(read.content), size: read.size, revision: read.revision });
		}
		const result = await dockerFetch(`/_hawser/host-files?path=${encodeURIComponent(url.searchParams.get('path') || '/')}`, { method: 'GET' }, envId!);
		if (!result.ok) return json({ error: 'Hawser cannot browse this directory' }, { status: result.status });
		return json(await result.json());
	} catch (error) {
		const status = error && typeof error === 'object' && 'status' in error && typeof error.status === 'number' ? error.status : 502;
		return json({ error: error instanceof Error ? error.message : 'Hawser is unavailable' }, { status });
	}
};
