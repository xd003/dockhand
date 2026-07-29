import { json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { getStackSources } from '$lib/server/db';
import { authorize } from '$lib/server/authorize';
import { resolveStackSourceDisplayPaths } from '$lib/server/stacks';

export const GET: RequestHandler = async ({ url, cookies }) => {
	const auth = await authorize(cookies);

	const envId = url.searchParams.get('env');
	const envIdNum = envId ? parseInt(envId) : undefined;

	// Permission check with environment context
	if (auth.authEnabled && !await auth.can('stacks', 'view', envIdNum)) {
		return json({ error: 'Permission denied' }, { status: 403 });
	}

	try {
		const sources = await getStackSources(envIdNum);

		// Convert to a map for easier lookup in the frontend.
		// Resolve compose paths to absolute on-disk paths (git stacks store repo-relative paths).
		const sourceMap: Record<string, { sourceType: string; composePath?: string | null; composePaths?: string | null; repository?: any }> = {};
		for (const source of sources) {
			const resolved = resolveStackSourceDisplayPaths(source);
			sourceMap[source.stackName] = {
				sourceType: source.sourceType,
				composePath: resolved.composePath,
				composePaths: resolved.composePaths.length > 0 ? JSON.stringify(resolved.composePaths) : null,
				repository: source.repository
			};
		}

		return json(sourceMap);
	} catch (error) {
		console.error('Failed to get stack sources:', error);
		return json({ error: 'Failed to get stack sources' }, { status: 500 });
	}
};
