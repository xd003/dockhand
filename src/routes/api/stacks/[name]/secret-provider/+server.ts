import { json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { authorize } from '$lib/server/authorize';
import { parseEnvParam } from '$lib/server/env-param';
import { getStackSource, secretProviderExists, updateStackSource } from '$lib/server/db';

/**
 * @openapi
 * summary: Bind or unbind a stack's secret provider
 * description: Sets the secret provider whose secrets are resolved into the stack at its next deploy, for internal and Git stacks alike. `null` unbinds. Only the binding changes; the stack's files, variables and containers are untouched until it is redeployed.
 * path: name:string! Stack name
 * query: env:integer Environment id the stack belongs to
 * body: {secretProviderId:integer!}
 * body-example: {"secretProviderId":3}
 * resp-200: {success:boolean!, secretProviderId:integer}
 * resp-400: secretProviderId is not a number/null, or the provider no longer exists
 * resp-403: Permission denied (needs stacks:edit; binding a secret provider also needs secrets:view)
 * resp-404: Stack is not managed by Dockhand
 */
export const PUT: RequestHandler = async ({ params, url, request, cookies }) => {
	const auth = await authorize(cookies);
	const envId = parseEnvParam(url.searchParams.get('env'));
	if (auth.authEnabled && !(await auth.can('stacks', 'edit', envId ?? undefined))) {
		return json({ error: 'Permission denied' }, { status: 403 });
	}
	const envAccessDenied = await auth.requireEnvAccess(envId);
	if (envAccessDenied) return envAccessDenied;

	const body = await request.json().catch(() => null);
	const secretProviderId = body?.secretProviderId;
	if (!body || !('secretProviderId' in body) || (secretProviderId !== null && typeof secretProviderId !== 'number')) {
		return json({ error: 'secretProviderId must be a number or null' }, { status: 400 });
	}

	// Binding a secret provider resolves its secrets into the container at deploy;
	// require the secrets permission so a stacks-only user can't exfiltrate a
	// provider's secrets by binding it and reading the container env.
	if (typeof secretProviderId === 'number' && auth.authEnabled && !(await auth.can('secrets', 'view', envId ?? undefined))) {
		return json({ error: 'Permission denied: binding a secret provider requires the secrets permission' }, { status: 403 });
	}

	// A stale provider id (provider deleted/recreated while the editor held the old
	// list) would otherwise hit a raw foreign-key error on save (#1522).
	if (typeof secretProviderId === 'number' && !(await secretProviderExists(secretProviderId))) {
		return json({ error: 'The selected secret provider no longer exists. Reopen the stack and pick a current provider.' }, { status: 400 });
	}

	const source = await getStackSource(params.name, envId);
	if (!source || source.sourceType === 'external') {
		return json({ error: 'Stack is not managed by Dockhand' }, { status: 404 });
	}

	await updateStackSource(params.name, envId, { secretProviderId });
	return json({ success: true, secretProviderId });
};
