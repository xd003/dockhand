import { json } from '@sveltejs/kit';
import { getStacksBasePathForEnv } from '$lib/server/stacks';
import { authorize } from '$lib/server/authorize';
import type { RequestHandler } from './$types';

/**
 * GET /api/stacks/base-path
 *
 * @openapi
 * summary: Return the directory new stacks are created under (Dockhand's stacks directory, or the Hawser agent's STACKS_DIR on Hawser environments)
 * query: env:integer Environment ID used to select the local or environment-scoped stacks root
 * resp-200: {basePath:string!}
 * resp-200-example: {"basePath":"/data/stacks"}
 * resp-403: Permission denied (needs stacks:create) or environment access denied
 * resp-503: Hawser agent is offline or did not report its STACKS_DIR
 *
 * Returns the Dockhand stacks root for the requested environment context.
 * Query params:
 * - env: Environment ID (optional) — when set, returns STACKS_DIR for local envs
 *   with STACKS_DIR configured, otherwise $DATA_DIR/stacks (staging / legacy).
 */
export const GET: RequestHandler = async ({ url, cookies }) => {
	const envParam = url.searchParams.get('env');
	const envIdNum = envParam ? parseInt(envParam) : undefined;
	const auth = await authorize(cookies);
	if (auth.authEnabled && !(await auth.can('stacks', 'create', envIdNum))) return json({ error: 'Permission denied' }, { status: 403 });
	const denied = await auth.requireEnvAccess(envIdNum ?? null);
	if (denied) return denied;
	try {
		const basePath = await getStacksBasePathForEnv(envIdNum !== undefined && !Number.isNaN(envIdNum) ? envIdNum : undefined);
		return json({ basePath });
	} catch (error) {
		return json({ error: error instanceof Error ? error.message : 'Hawser stack directory is unavailable' }, { status: 503 });
	}
};
