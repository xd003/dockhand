import { json } from '@sveltejs/kit';
import { join, dirname } from 'path';
import { getStackDir, remapHawserStagingDisplayPaths, isHawserConnection } from '$lib/server/stacks';
import { getEnvironment } from '$lib/server/db';
import type { RequestHandler } from './$types';

/**
 * Get the default path for a new stack
 * Used by the UI to show where files will be created
 *
 * Query params:
 * - name: Stack name (required)
 * - env: Environment ID (optional)
 * - location: Custom base location path (optional)
 *
 * If location is provided, path will be: {location}/{envName}/{stackName}/
 * Otherwise uses Dockhand's default via getStackDir (flat STACKS_DIR/<stackName>/
 * for local envs when STACKS_DIR is set, else $DATA_DIR/stacks/<envName>/<stackName>/).
 *
 * For Hawser environments, Dockhand stages files under $DATA_DIR/stacks/... but the
 * compose command runs on the remote host under the agent's STACKS_DIR/<stackName>/,
 * so the returned paths are remapped to the remote location (mirroring the display
 * remap used by the stack sources and compose endpoints).
 */
export const GET: RequestHandler = async ({ url }) => {
	const stackName = url.searchParams.get('name');
	const envId = url.searchParams.get('env');
	const location = url.searchParams.get('location');
	const envIdNum = envId ? parseInt(envId) : undefined;

	if (!stackName) {
		return json({ error: 'Stack name is required' }, { status: 400 });
	}

	let stackDir: string;

	if (location) {
		// Custom location: {location}/{envName}/{stackName}/
		if (envIdNum) {
			const env = await getEnvironment(envIdNum);
			if (env) {
				stackDir = join(location, env.name, stackName);
			} else {
				stackDir = join(location, stackName);
			}
		} else {
			stackDir = join(location, stackName);
		}
	} else {
		// Dockhand default location
		stackDir = await getStackDir(stackName, envIdNum);
	}

	let composePath = `${stackDir}/compose.yaml`;
	let envPath = `${stackDir}/.env`;
	let source = 'default';

	// Hawser: show the remote host path where compose actually runs, not the local staging copy.
	if (envIdNum) {
		const env = await getEnvironment(envIdNum);
		if (isHawserConnection(env)) {
			const remapped = await remapHawserStagingDisplayPaths(stackName, envIdNum, {
				composePath,
				composePaths: []
			}, env);
			if (remapped.composePath) {
				const dir = dirname(remapped.composePath);
				stackDir = dir;
				composePath = remapped.composePath;
				envPath = join(dir, '.env');
				source = 'hawser';
			}
		}
	}

	return json({
		stackDir,
		composePath,
		envPath,
		source
	});
};
