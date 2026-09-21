import { json, redirect } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { authorize } from '$lib/server/authorize';
import { getEnvironment } from '$lib/server/db';
import { dockerFetch } from '$lib/server/docker';
import { isHawserConnection } from '$lib/server/stacks';

export const GET: RequestHandler = async ({ url, cookies }) => {
	const rawEnvId = url.searchParams.get('env');
	const envId = rawEnvId ? Number(rawEnvId) : null;
	const auth = await authorize(cookies);
	if (envId !== null && (!Number.isInteger(envId) || envId <= 0)) return json({ error: 'Invalid environment' }, { status: 400 });
	if (auth.authEnabled && !await auth.can('stacks', 'edit', envId ?? undefined)) return json({ error: 'Permission denied' }, { status: 403 });
	const env = envId === null ? null : await getEnvironment(envId);
	if (envId !== null && !env) return json({ error: 'Environment not found' }, { status: 404 });
	if (!isHawserConnection(env)) redirect(307, `/api/system/files?path=${encodeURIComponent(url.searchParams.get('path') || '/')}`);
	try {
		const result = await dockerFetch(`/_hawser/host-files?path=${encodeURIComponent(url.searchParams.get('path') || '/')}`, { method: 'GET' }, envId!);
		if (!result.ok) return json({ error: 'Hawser cannot browse this directory' }, { status: result.status });
		return json(await result.json());
	} catch (error) {
		return json({ error: error instanceof Error ? error.message : 'Hawser is unavailable' }, { status: 502 });
	}
};
