import { json } from '@sveltejs/kit';
import { join } from 'path';
import { getStackDir } from '$lib/server/stacks';
import { getEnvironment } from '$lib/server/db';
import { authorize } from '$lib/server/authorize';
import { isHawserConnection } from '$lib/server/stacks';
import type { RequestHandler } from './$types';

/**
 * Get the default path for a new stack — used by the UI to show where files will be created.
 * With location set the path is {location}/{envName}/{stackName}/, otherwise Dockhand's
 * default $DATA_DIR/stacks/{envName}/{stackName}/.
 *
 * @openapi
 * summary: Compute the default compose/env file paths for a new stack, either under a custom base location or under the default stacks directory (the Hawser agent's STACKS_DIR on Hawser environments, where a custom location is rejected)
 * query: name:string! Stack name
 * query: env:integer Environment ID (scopes the path under the environment name) (from GET /api/environments)
 * query: location:string Custom base location path
 * resp-200: {stackDir:string!, composePath:string!, envPath:string!, source:string!}
 * resp-200-example: {"stackDir":"/data/stacks/prod/web","composePath":"/data/stacks/prod/web/compose.yaml","envPath":"/data/stacks/prod/web/.env","source":"default"}
 * resp-400: Stack name is required, or a custom location was given for a Hawser environment
 * resp-403: Permission denied (needs stacks:create) or environment access denied
 * resp-503: Hawser agent is offline or did not report its STACKS_DIR
 */
export const GET: RequestHandler = async ({ url, cookies }) => {
	const stackName = url.searchParams.get('name');
	const envId = url.searchParams.get('env');
	const location = url.searchParams.get('location');
	const envIdNum = envId ? parseInt(envId) : undefined;
	const auth = await authorize(cookies);
	if (auth.authEnabled && !(await auth.can('stacks', 'create', envIdNum))) return json({ error: 'Permission denied' }, { status: 403 });
	const denied = await auth.requireEnvAccess(envIdNum ?? null);
	if (denied) return denied;
	const environment = envIdNum ? await getEnvironment(envIdNum) : null;
	if (isHawserConnection(environment) && location) return json({ error: 'Hawser creates stacks under the agent STACKS_DIR; custom Dockhand base paths are not available' }, { status: 400 });

	if (!stackName) {
		return json({ error: 'Stack name is required' }, { status: 400 });
	}

	let stackDir: string;
	try {
		if (location) {
			if (envIdNum) {
				const env = await getEnvironment(envIdNum);
				stackDir = env ? join(location, env.name, stackName) : join(location, stackName);
			} else stackDir = join(location, stackName);
		} else stackDir = await getStackDir(stackName, envIdNum);
	} catch (error) {
		return json({ error: error instanceof Error ? error.message : 'Hawser stack directory is unavailable' }, { status: 503 });
	}

	return json({
		stackDir,
		composePath: `${stackDir}/compose.yaml`,
		envPath: `${stackDir}/.env`,
		source: 'default'
	});
};
