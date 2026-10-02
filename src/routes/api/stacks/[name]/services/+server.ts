import { json } from '@sveltejs/kit';
import { getStackServices } from '$lib/server/stacks';
import { authorize } from '$lib/server/authorize';
import type { RequestHandler } from './$types';

/**
 * @openapi
 * summary: List the services a stack's compose file(s) declare, including ones without containers
 * description: Lets a stack that was saved but never deployed (or only partly started) show and start individual services. A never-deployed Git stack is read from its repository checkout (cloned on first use, without a stack sync).
 * path: name:string! Stack name (from GET /api/stacks)
 * query: env:integer Environment id (from GET /api/environments)
 * resp-200: {services:array<object>!, error:string}
 * resp-200-desc: services is [{name, image?, profiles}] in declaration order; error explains an empty list (e.g. compose file not found).
 * resp-403: Permission denied (needs stacks:view), or access denied to this environment
 */
export const GET: RequestHandler = async ({ params, url, cookies }) => {
	const auth = await authorize(cookies);
	const envId = url.searchParams.get('env');
	const envIdNum = envId ? parseInt(envId) : undefined;

	if (auth.authEnabled && !(await auth.can('stacks', 'view', envIdNum))) {
		return json({ error: 'Permission denied' }, { status: 403 });
	}
	const envAccessDenied = await auth.requireEnvAccess(envIdNum ?? null);
	if (envAccessDenied) return envAccessDenied;

	try {
		return json(await getStackServices(params.name, envIdNum));
	} catch (error) {
		console.error(`Error listing services for stack ${params.name}:`, error);
		return json({ services: [], error: 'Failed to read stack services' });
	}
};
