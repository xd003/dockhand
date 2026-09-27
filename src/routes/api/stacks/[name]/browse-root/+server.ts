import { json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { existsSync } from 'node:fs';
import { authorize } from '$lib/server/authorize';
import { getEnvironment } from '$lib/server/db';
import { dockerFetch } from '$lib/server/docker';
import { getCachedContainerMounts, hostPathInContainerMount } from '$lib/server/host-path';
import { getStackPathHints, getStacksBasePathForEnv, isHawserConnection } from '$lib/server/stacks';
import { isPathUnderRoot } from '$lib/server/stack-path-utils';

/**
 * GET /api/stacks/[name]/browse-root
 *
 * @openapi
 * summary: Return where to browse for an untracked stack's Compose file - the host-attached directory holding stack projects (the Hawser agent's STACKS_DIR, or the Dockhand mount exposing the project) and the project's working directory inside it when visible
 * path: name:string! Stack name (from GET /api/stacks)
 * query: env:integer Environment ID the stack belongs to (from GET /api/environments)
 * resp-200: {root:string!, path:string!}
 * resp-200-example: {"root":"/opt/stacks","path":"/opt/stacks/web"}
 * resp-403: Permission denied (requires stacks:edit) or environment access denied
 * resp-503: The environment is unreachable, or the Hawser agent did not report its STACKS_DIR
 */
export const GET: RequestHandler = async ({ params, url, cookies }) => {
	const rawEnvId = url.searchParams.get('env');
	const envId = rawEnvId ? Number(rawEnvId) : null;
	const auth = await authorize(cookies);
	if (auth.authEnabled && !(await auth.can('stacks', 'edit', envId ?? undefined))) return json({ error: 'Permission denied' }, { status: 403 });
	const denied = await auth.requireEnvAccess(envId);
	if (denied) return denied;

	try {
		const env = envId === null ? null : await getEnvironment(envId);
		const { workingDir } = await getStackPathHints(params.name, envId);
		const base = await getStacksBasePathForEnv(envId);
		if (isHawserConnection(env)) {
			if (!workingDir) return json({ root: base, path: base });
			if (isPathUnderRoot(workingDir, base)) return json({ root: base, path: workingDir });
			// A project mounted into the agent outside STACKS_DIR (at its host path) is its own root.
			const listing = await dockerFetch(`/_hawser/host-files?path=${encodeURIComponent(workingDir)}`, { method: 'GET' }, envId!);
			return json(listing.ok ? { root: workingDir, path: workingDir } : { root: base, path: base });
		}
		const mounts = getCachedContainerMounts();
		// Bare metal: Dockhand's filesystem is the Docker host's.
		if (mounts.length === 0) return json({ root: '/', path: workingDir && existsSync(workingDir) ? workingDir : base });
		// Socket labels are this host's paths; a direct remote host is only reachable through an identical mount.
		const visible = workingDir && hostPathInContainerMount(
			workingDir,
			env?.connectionType === 'direct' ? mounts.map((m) => ({ source: m.destination, destination: m.destination })) : mounts
		);
		if (visible && existsSync(visible.path)) return json({ root: visible.mount, path: visible.path });
		return json({ root: base, path: base });
	} catch (error) {
		return json({ error: error instanceof Error ? error.message : 'Stack files are unavailable' }, { status: 503 });
	}
};
