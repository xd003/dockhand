import { json } from '@sveltejs/kit';
import { getStacksBasePathForEnv } from '$lib/server/stacks';
import type { RequestHandler } from './$types';

/**
 * GET /api/stacks/base-path
 *
 * Returns the Dockhand stacks root for the requested environment context.
 * Query params:
 * - env: Environment ID (optional) — when set, returns STACKS_DIR for local envs
 *   with STACKS_DIR configured, otherwise $DATA_DIR/stacks (staging / legacy).
 */
export const GET: RequestHandler = async ({ url }) => {
	const envParam = url.searchParams.get('env');
	const envIdNum = envParam ? parseInt(envParam) : undefined;
	const basePath = await getStacksBasePathForEnv(
		envIdNum !== undefined && !Number.isNaN(envIdNum) ? envIdNum : undefined
	);
	return json({ basePath });
};
