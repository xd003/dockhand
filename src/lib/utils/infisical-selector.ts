// The per-stack Infisical scope, carried in the stack's DOCKHAND_SECRET_SELECTOR.
// One Infisical provider holds the credentials (host + Machine Identity); each
// stack picks its own project / environment / secret path through the selector:
//
//   <projectId>[/<environment>[/<secret/path>]]   e.g. "3f1c.../prod/db"
//   /<secret/path>                                 path-only override (legacy form)
//
// Project IDs are UUIDs and environment slugs cannot contain "/", so the first two
// segments are unambiguous. Any part left empty falls back to the provider config.
// Shared by the server (bulk pull) and the stack editor (project/env dropdowns).

export interface InfisicalScope {
	projectId?: string;
	environment?: string;
	/** Always starts with "/" when set. */
	path?: string;
}

export function parseInfisicalSelector(selector: string | undefined | null): InfisicalScope {
	const value = (selector ?? '').trim();
	if (!value) return {};
	if (value.startsWith('/')) return { path: value };

	const [projectId, environment, ...rest] = value.split('/');
	const scope: InfisicalScope = {};
	if (projectId) scope.projectId = projectId;
	if (environment) scope.environment = environment;
	const path = rest.join('/');
	if (path) scope.path = `/${path}`;
	return scope;
}

/**
 * Inverse of {@link parseInfisicalSelector}. Returns '' when the scope is empty so
 * the caller can drop the selector var entirely (the provider config then applies).
 */
export function formatInfisicalSelector(scope: InfisicalScope): string {
	const projectId = scope.projectId?.trim() ?? '';
	const environment = scope.environment?.trim() ?? '';
	const path = (scope.path?.trim() ?? '').replace(/^\/+|\/+$/g, '');

	if (!projectId) {
		// No project: only a path override is expressible (environment needs a project).
		return path ? `/${path}` : '';
	}
	if (path) return `${projectId}/${environment}/${path}`;
	if (environment) return `${projectId}/${environment}`;
	return projectId;
}
