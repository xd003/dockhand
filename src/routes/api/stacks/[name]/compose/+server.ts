import { json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { dirname } from 'node:path';
import { getStackComposeFile, deployStack, saveStackComposeFile, remapHawserStagingDisplayPaths } from '$lib/server/stacks';
import { updateStackSource, getStackSource } from '$lib/server/db';
import { authorize } from '$lib/server/authorize';
import { createJobResponse } from '$lib/server/sse';
import { parseComposePathsColumn } from '$lib/server/compose-files';

async function remapDisplayPath(
	name: string,
	envId: number | undefined,
	path: string | null | undefined
): Promise<string | null | undefined> {
	if (!path) return path;
	const remapped = await remapHawserStagingDisplayPaths(name, envId, {
		composePath: path,
		composePaths: []
	});
	return remapped.composePath ?? path;
}

// GET /api/stacks/[name]/compose - Get compose file content
export const GET: RequestHandler = async ({ params, url, cookies }) => {
	const auth = await authorize(cookies);
	if (auth.authEnabled && !(await auth.can('stacks', 'view'))) {
		return json({ error: 'Permission denied' }, { status: 403 });
	}

	const { name } = params;
	const envId = url.searchParams.get('env');
	const envIdNum = envId ? parseInt(envId) : undefined;

	try {
		const result = await getStackComposeFile(name, envIdNum);
		const source = await getStackSource(name, envIdNum);

		if (!result.success) {
			// Return info about what's needed - unified response for all missing compose files
			return json({
				error: result.error,
				needsFileLocation: result.needsFileLocation || false,
				composePath: await remapDisplayPath(name, envIdNum, result.composePath),
				envPath: await remapDisplayPath(name, envIdNum, result.envPath)
			}, { status: 404 });
		}

		const composePathsList = result.composePaths ?? parseComposePathsColumn(source?.composePaths);
		const displayPaths = await remapHawserStagingDisplayPaths(name, envIdNum, {
			composePath: result.composePath ?? null,
			composePaths: Array.isArray(composePathsList) ? composePathsList : []
		});
		let displayStackDir = result.stackDir;
		if (displayPaths.composePath) {
			displayStackDir = dirname(displayPaths.composePath);
		}

		return json({
			content: result.content,
			composeContents: result.composeContents ?? null,
			stackDir: displayStackDir,
			composePath: displayPaths.composePath,
			composePaths: displayPaths.composePaths.length > 0 ? displayPaths.composePaths : null,
			envPath: await remapDisplayPath(name, envIdNum, result.envPath),
			suggestedEnvPath: await remapDisplayPath(name, envIdNum, result.suggestedEnvPath)
		});
	} catch (error: any) {
		console.error(`Error getting compose file for stack ${name}:`, error);
		return json({ error: error.message || 'Failed to get compose file' }, { status: 500 });
	}
};

// PUT /api/stacks/[name]/compose - Update compose file content
export const PUT: RequestHandler = async ({ params, request, url, cookies }) => {
	const auth = await authorize(cookies);

	const { name } = params;
	const envId = url.searchParams.get('env');
	const envIdNum = envId ? parseInt(envId) : undefined;

	// Permission check with environment context
	if (auth.authEnabled && !(await auth.can('stacks', 'edit', envIdNum))) {
		return json({ error: 'Permission denied' }, { status: 403 });
	}

	try {
		const body = await request.json();
		const { content, composeContents, restart = false, composePath, composePaths, envPath, moveFromDir, oldComposePath, oldEnvPath } = body;

		if (!content || typeof content !== 'string') {
			return json({ error: 'Compose file content is required' }, { status: 400 });
		}

		// Build options object for custom paths, move operation, and file renames
		const pathOptions = (composePath || composePaths || envPath !== undefined || moveFromDir || oldComposePath || oldEnvPath || composeContents)
			? { composePath, composePaths, composeContents, envPath, moveFromDir, oldComposePath, oldEnvPath }
			: undefined;

		if (restart) {
			// Deploy with docker compose up -d --force-recreate
			// Force recreate ensures env var changes are applied
			// Save paths first if provided
			if (pathOptions) {
				const saveResult = await saveStackComposeFile(name, content, false, envIdNum, pathOptions);
				if (!saveResult.success) {
					return json({ error: saveResult.error }, { status: 500 });
				}
			}
			// Update DB with multi-file paths if provided
			if (composePaths !== undefined) {
				await updateStackSource(name, envIdNum ?? null, {
					composePaths: composePaths ?? undefined
				});
			}
			// Get authoritative paths from DB/filesystem for deploy
			const composeInfo = await getStackComposeFile(name, envIdNum);
			const deploySource = await getStackSource(name, envIdNum);
			const deployComposePaths = parseComposePathsColumn(deploySource?.composePaths);

			// Deploy via SSE to keep connection alive during long operations
			return createJobResponse(async (send) => {
				try {
					const result = await deployStack({
						name,
						compose: content,
						envId: envIdNum,
						forceRecreate: true,
						composePath: composeInfo.composePath || undefined,
						composePaths: deployComposePaths,
						envPath: composeInfo.envPath || undefined
					});

					if (!result.success) {
						send('result', { success: false, error: result.error });
						return;
					}
					send('result', { success: true });
				} catch (error: any) {
					console.error(`Error deploying stack ${name}:`, error);
					send('result', { success: false, error: error.message || 'Failed to deploy stack' });
				}
			}, request);
		}

		// Just save the file without restarting (update operation, not create)
		const result = await saveStackComposeFile(name, content, false, envIdNum, pathOptions);

		if (!result.success) {
			return json({ error: result.error }, { status: 500 });
		}

		// Preserve multi-file paths after save (mirrors restart path)
		if (composePaths !== undefined) {
			await updateStackSource(name, envIdNum ?? null, {
				composePaths: composePaths ?? undefined
			});
		}

		return json({ success: true });
	} catch (error: any) {
		console.error(`Error updating compose file for stack ${name}:`, error);
		return json({ error: error.message || 'Failed to update compose file' }, { status: 500 });
	}
};
