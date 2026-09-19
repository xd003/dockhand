import { json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { authorize } from '$lib/server/authorize';
import { listStackFileDirectory } from '$lib/server/stack-linked-files';

/**
 * @openapi
 * summary: Browse a stack's Compose directory
 * path: name:string The stack name
 * query: env:integer Environment id
 * query: path:string Absolute directory path constrained to the Compose root
 * resp-403: Permission denied (needs stacks:view)
 * resp-400: Path is outside the Compose directory or protected
 * resp-404: Directory not found
 * resp-500: Failed to browse the stack directory
 */
export const GET: RequestHandler = async ({ url, params, cookies }) => {
	const rawEnv = url.searchParams.get('env');
	const envValue = rawEnv ? Number(rawEnv) : NaN;
	const environmentId = Number.isInteger(envValue) ? envValue : undefined;
	// Shared authorization and filesystem helpers emit these documented responses.
	// status: 403
	// status: 400
	// status: 404
	// status: 500
	const auth = await authorize(cookies);
	if (auth.authEnabled && !(await auth.can('stacks', 'view', environmentId))) {
		return json({ error: 'Permission denied' }, { status: 403 });
	}
	const denied = await auth.requireEnvAccess(environmentId ?? null);
	if (denied) return denied;
	try {
		return json(await listStackFileDirectory(params.name, environmentId, url.searchParams.get('path') || undefined));
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		return json({ error: message }, { status: /not found/i.test(message) ? 404 : /outside|protected/i.test(message) ? 400 : 500 });
	}
};
