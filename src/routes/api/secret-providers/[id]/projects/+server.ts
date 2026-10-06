import { json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { getSecretProviderById } from '$lib/server/db';
import { authorize } from '$lib/server/authorize';
import { getProvider } from '$lib/server/secretproviders';
import { parseProviderError } from '$lib/server/secretproviders/shared';

/**
 * Projects (with their environments) the stored provider's credentials can read,
 * plus the provider's configured default scope. Powers the stack editor's
 * project / environment pick lists, so one provider (one set of credentials)
 * serves many stacks that each pick their own project. Names and ids only - no
 * secret values.
 *
 * @openapi
 * summary: List the projects and environments a stored provider's credentials can read
 * path: id:integer The secret provider id
 * resp-200: {ok:boolean!, projects:array<object>, defaults:object, error:string}
 * resp-200-desc: ok=true returns the projects (id, name, environments[{slug,name}]) and the provider's default projectId/environment/path; ok=false folds a provider error in (still 200) so an unreachable provider never breaks the editor
 * resp-400: Invalid ID, unknown provider type, or the provider cannot list projects
 * resp-403: Permission denied (needs secrets:view)
 * resp-404: Secret provider not found
 */
export const GET: RequestHandler = async ({ params, cookies }) => {
	const auth = await authorize(cookies);
	if (auth.authEnabled && !(await auth.can('secrets', 'view'))) {
		return json({ error: 'Permission denied' }, { status: 403 });
	}

	const id = Number.parseInt(params.id);
	if (Number.isNaN(id)) {
		return json({ error: 'Invalid secret provider ID' }, { status: 400 });
	}

	const row = await getSecretProviderById(id);
	if (!row) {
		return json({ error: 'Secret provider not found' }, { status: 404 });
	}
	const provider = getProvider(row.type);
	if (!provider) {
		return json({ error: `Unknown secret provider type: ${row.type}` }, { status: 400 });
	}
	if (!provider.listProjects) {
		return json({ error: `${provider.label} cannot list projects` }, { status: 400 });
	}

	const config = row.config as unknown as Record<string, unknown>;
	const str = (key: string) => (typeof config[key] === 'string' ? (config[key] as string).trim() : '');
	const defaults = { projectId: str('projectId'), environment: str('environment'), path: str('path') };

	try {
		const projects = await provider.listProjects(row.config);
		return json({ ok: true, projects, defaults });
	} catch (e) {
		const raw = e instanceof Error ? e.message : String(e);
		return json({ ok: false, error: parseProviderError(raw) ?? raw.slice(0, 200), defaults });
	}
};
