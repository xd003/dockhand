// Infisical per-stack scope: one provider (credentials + optional defaults) serves
// many stacks, each picking project / environment / path via its bulk selector.
//
// Bun's built-in undici binds its native fetch (patching globalThis.fetch does not
// reach it) and has no MockAgent, so `request` is stubbed via mock.module. The mock
// is process-global, so it spreads EVERY real undici export and only diverts
// `request` while a test here has installed a handler; every other suite keeps the
// real behaviour.
import { describe, test, expect, mock, afterEach } from 'bun:test';
import * as realUndici from 'undici';
import { infisicalProvider } from '../src/lib/server/secretproviders/infisical';
import { mergeProviderConfigForWrite } from '../src/lib/server/secretproviders/shared';
import { parseInfisicalSelector, formatInfisicalSelector } from '../src/lib/utils/infisical-selector';

type Reply = { status: number; body: unknown };
let routes: Record<string, Reply> | null = null;
let seen: URL[] = [];

mock.module('undici', () => ({
	...realUndici,
	request: async (url: string, opts?: Parameters<typeof realUndici.request>[1]) => {
		if (!routes) return realUndici.request(url, opts);
		const parsed = new URL(url);
		seen.push(parsed);
		const reply = routes[parsed.pathname];
		if (!reply) throw new Error(`unexpected request ${parsed.pathname}`);
		const text = JSON.stringify(reply.body);
		return { statusCode: reply.status, body: { text: async () => text, json: async () => JSON.parse(text) } };
	}
}));

const HOST = 'https://infisical.example.com';
const base = { host: HOST, token: 'static-token' };
const SECRETS: Record<string, Reply> = {
	'/api/v3/secrets/raw': { status: 200, body: { secrets: [{ secretKey: 'DB_PASS', secretValue: 'x' }] } }
};

afterEach(() => {
	routes = null;
	seen = [];
});

describe('infisical selector', () => {
	test('round-trips project / environment / path', () => {
		for (const s of ['p1', 'p1/prod', 'p1/prod/db/creds', 'p1//db', '/db']) {
			expect(formatInfisicalSelector(parseInfisicalSelector(s))).toBe(s);
		}
	});

	test('a leading slash is a path-only override (legacy selector)', () => {
		expect(parseInfisicalSelector('/app')).toEqual({ path: '/app' });
	});

	test('an environment without a project cannot be expressed', () => {
		expect(formatInfisicalSelector({ environment: 'prod' })).toBe('');
	});
});

describe('resolveBulk scope precedence', () => {
	test('the stack selector overrides every provider default', async () => {
		routes = SECRETS;
		const out = await infisicalProvider.resolveBulk(
			{ ...base, projectId: 'default-proj', environment: 'dev', path: '/def' },
			'stack-proj/prod/db'
		);
		expect(out).toEqual({ DB_PASS: 'x' });
		const q = seen[0].searchParams;
		expect([q.get('workspaceId'), q.get('environment'), q.get('secretPath')]).toEqual(['stack-proj', 'prod', '/db']);
	});

	test('parts the selector leaves out fall back to the provider defaults', async () => {
		routes = SECRETS;
		await infisicalProvider.resolveBulk({ ...base, projectId: 'default-proj', environment: 'dev', path: '/def' }, 'stack-proj');
		const q = seen[0].searchParams;
		expect([q.get('workspaceId'), q.get('environment'), q.get('secretPath')]).toEqual(['stack-proj', 'dev', '/def']);
	});

	test('a legacy path selector keeps the default project', async () => {
		routes = SECRETS;
		await infisicalProvider.resolveBulk({ ...base, projectId: 'default-proj', environment: 'dev' }, '/app');
		const q = seen[0].searchParams;
		expect([q.get('workspaceId'), q.get('secretPath')]).toEqual(['default-proj', '/app']);
	});

	test('no project on the stack nor the provider fails before any request', async () => {
		routes = SECRETS;
		await expect(infisicalProvider.resolveBulk({ ...base, environment: 'dev' }, '')).rejects.toThrow(/No project selected/);
		expect(seen).toHaveLength(0);
	});
});

describe('listProjects', () => {
	test('returns secret-manager projects with environments, sorted by name', async () => {
		routes = {
			'/api/v1/projects': {
				status: 200,
				body: {
					projects: [
						{ id: 'b', name: 'Zeta', type: 'secret-manager', environments: [{ slug: 'prod', name: 'Production' }] },
						{ id: 'k', name: 'Keys', type: 'kms', environments: [] },
						{ id: 'a', name: 'Alpha', type: 'secret-manager', environments: [{ slug: 'dev', name: 'Development' }] }
					]
				}
			}
		};
		expect(await infisicalProvider.listProjects!(base)).toEqual([
			{ id: 'a', name: 'Alpha', environments: [{ slug: 'dev', name: 'Development' }] },
			{ id: 'b', name: 'Zeta', environments: [{ slug: 'prod', name: 'Production' }] }
		]);
	});

	test('falls back to the legacy /api/v1/workspace route on an older self-hosted server', async () => {
		routes = {
			'/api/v1/projects': { status: 404, body: { message: 'Not found' } },
			'/api/v1/workspace': {
				status: 200,
				body: { workspaces: [{ id: 'w1', name: 'Legacy', environments: [{ slug: 'prod', name: 'Production' }] }] }
			}
		};
		expect(await infisicalProvider.listProjects!(base)).toEqual([
			{ id: 'w1', name: 'Legacy', environments: [{ slug: 'prod', name: 'Production' }] }
		]);
	});
});

describe('testConnection without a default project', () => {
	test('verifies the credentials by listing projects', async () => {
		routes = { '/api/v1/projects': { status: 200, body: { projects: [] } } };
		expect(await infisicalProvider.testConnection(base)).toEqual({ ok: true });
	});

	test('surfaces a rejected credential', async () => {
		routes = { '/api/v1/projects': { status: 401, body: { message: 'Token missing' } } };
		const result = await infisicalProvider.testConnection(base);
		expect(result.ok).toBe(false);
		expect(result.error).toContain('HTTP 401');
	});
});

describe('validateConfig (save-time auth check)', () => {
	const validate = (c: Record<string, unknown>) => infisicalProvider.validateConfig!(c as never);

	test('rejects a config with neither a token nor a Universal Auth pair', () => {
		expect(validate({ host: HOST })).toMatch(/access token or a Universal Auth/);
	});

	test('rejects half a Universal Auth pair', () => {
		expect(validate({ host: HOST, clientId: 'id' })).toMatch(/Client secret is required/);
		expect(validate({ host: HOST, clientSecret: 's' })).toMatch(/Client ID is required/);
	});

	test('accepts a token or a complete pair', () => {
		expect(validate(base)).toBeNull();
		expect(validate({ host: HOST, clientId: 'id', clientSecret: 's' })).toBeNull();
	});

	test('an edit leaving the secret blank keeps the stored one; clearing clientId drops the pair', () => {
		const stored = { host: HOST, clientId: 'id', clientSecret: 's' };
		expect(validate(mergeProviderConfigForWrite({ host: HOST, clientId: 'id', clientSecret: '' }, stored))).toBeNull();
		expect(validate(mergeProviderConfigForWrite({ host: HOST, clientId: '', clientSecret: '', token: '' }, stored))).toMatch(/access token or a Universal Auth/);
	});
});
