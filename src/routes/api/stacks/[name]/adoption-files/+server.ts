import { json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { authorize } from '$lib/server/authorize';
import { openAdoptionProjectFiles } from '$lib/server/git-stack-adoption';
import { readProjectFile } from '$lib/server/adoption-project-files';
import { normalizeWorkspacePath } from '$lib/server/stack-workspace';

/**
 * GET /api/stacks/[name]/adoption-files
 *
 * @openapi
 * summary: Browse the files of an untracked stack's project directory while converting it to Git in place, so the Git stack workspace can show and edit files that are not in the repository
 * path: name:string! Stack name (from GET /api/stacks)
 * query: env:integer Environment ID the stack belongs to (from GET /api/environments)
 * query: existingComposePath:string! The project's current Compose file, as selected for the conversion
 * query: path:string Directory or file relative to the project directory (default: the project root)
 * query: content:string "1" returns one file's content instead of a directory listing
 * resp-200: A directory listing ({entries} with path, name, type and size), or with content=1 one file (binary, content or contentBase64, revision, size)
 * resp-400: Invalid path or Compose file selection
 * resp-403: Permission denied (requires stacks:edit) or environment access denied
 * resp-404: The stack or file does not exist
 * resp-409: The stack is not external, or the selected Compose file does not belong to it
 */
export const GET: RequestHandler = async ({ params, url, cookies }) => {
	const rawEnvId = url.searchParams.get('env');
	const envId = rawEnvId ? Number(rawEnvId) : null;
	if (envId !== null && (!Number.isInteger(envId) || envId <= 0)) return json({ error: 'Invalid environment' }, { status: 400 });
	const auth = await authorize(cookies);
	if (auth.authEnabled && !(await auth.can('stacks', 'edit', envId ?? undefined))) return json({ error: 'Permission denied' }, { status: 403 });
	const denied = await auth.requireEnvAccess(envId);
	if (denied) return denied;
	try {
		const store = await openAdoptionProjectFiles(params.name, envId, url.searchParams.get('existingComposePath'));
		const path = normalizeWorkspacePath(url.searchParams.get('path') ?? '', true);
		if (url.searchParams.get('content') === '1') return json(await readProjectFile(store, path));
		return json({ entries: await store.list(path) });
	} catch (error) {
		const message = error instanceof Error ? error.message : 'Failed to read project files';
		const status = typeof error === 'object' && error && 'status' in error ? error.status : undefined;
		if (status === 404) return json({ error: message }, { status: 404 });
		if (status === 409) return json({ error: message }, { status: 409 });
		return json({ error: message }, { status: 400 });
	}
};
