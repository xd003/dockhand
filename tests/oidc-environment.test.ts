import { describe, expect, it } from 'bun:test';
import {
	parseOidcEnvironment,
	reconcileOidcEnvironment,
	type OidcEnvironmentDependencies
} from '../src/lib/server/oidc-environment';
import type { AuthSettingsData, OidcConfigData } from '../src/lib/server/db';

const SECRET = 'opaque client secret';
const MANAGEMENT_KEY = 'oidc_environment_management';

function enabledEnv(overrides: Record<string, string | undefined> = {}): NodeJS.ProcessEnv {
	return {
		OIDC_ENABLED: 'true',
		OIDC_ISSUER_URL: 'https://idp.example.com/realms/dockhand',
		OIDC_CLIENT_ID: 'dockhand',
		OIDC_CLIENT_SECRET: SECRET,
		OIDC_REDIRECT_URI: 'https://dockhand.example.com/api/auth/oidc/callback',
		...overrides
	};
}

function provider(id: number, overrides: Partial<OidcConfigData> = {}): OidcConfigData {
	return {
		id,
		name: 'OIDC',
		enabled: true,
		issuerUrl: 'https://idp.example.com/realms/dockhand',
		clientId: 'dockhand',
		clientSecret: SECRET,
		redirectUri: 'https://dockhand.example.com/api/auth/oidc/callback',
		scopes: 'openid profile email',
		usernameClaim: 'preferred_username',
		emailClaim: 'email',
		displayNameClaim: 'name',
		adminClaim: null,
		adminValue: null,
		roleMappingsClaim: 'groups',
		roleMappings: undefined,
		createdAt: '2026-01-01T00:00:00.000Z',
		updatedAt: '2026-01-01T00:00:00.000Z',
		...overrides
	};
}

function authSettings(overrides: Partial<AuthSettingsData> = {}): AuthSettingsData {
	return {
		id: 1,
		authEnabled: false,
		defaultProvider: 'local',
		sessionTimeout: 86400,
		createdAt: '2026-01-01T00:00:00.000Z',
		updatedAt: '2026-01-01T00:00:00.000Z',
		...overrides
	};
}

function fakeDependencies(options: {
	auth?: Partial<AuthSettingsData>;
	providers?: OidcConfigData[];
	metadata?: unknown;
	fail?: 'create' | 'ownership' | 'update' | 'delete' | 'restore';
} = {}) {
	const state = {
		auth: authSettings(options.auth),
		providers: new Map((options.providers ?? []).map(item => [item.id, item])),
		metadata: (options.metadata ?? null) as unknown,
		calls: [] as string[],
		nextId: Math.max(0, ...(options.providers ?? []).map(item => item.id)) + 1
	};

	const dependencies: OidcEnvironmentDependencies = {
		getOidcConfig: async id => {
			state.calls.push(`getProvider:${id}`);
			return state.providers.get(id) ?? null;
		},
		createOidcConfig: async data => {
			state.calls.push('createProvider');
			if (options.fail === 'create') throw new Error(`create failed with ${data.clientSecret}`);
			const created = provider(state.nextId++, data);
			state.providers.set(created.id, created);
			return created;
		},
		updateOidcConfig: async (id, data) => {
			state.calls.push('updateProvider');
			if (options.fail === 'update') throw new Error(`update failed with ${data.clientSecret}`);
			const existing = state.providers.get(id);
			if (!existing) return null;
			const updated = { ...existing, ...data };
			state.providers.set(id, updated);
			return updated;
		},
		deleteOidcConfig: async id => {
			state.calls.push('deleteProvider');
			if (options.fail === 'delete') throw new Error('delete failed');
			state.providers.delete(id);
			return true;
		},
		getAuthSettings: async () => {
			state.calls.push('getAuth');
			return state.auth;
		},
		updateAuthSettings: async data => {
			state.calls.push('updateAuth');
			if (options.fail === 'restore' && data.authEnabled === false) throw new Error('restore failed');
			state.auth = { ...state.auth, ...data };
			return state.auth;
		},
		getSetting: async key => {
			state.calls.push(`getSetting:${key}`);
			return key === MANAGEMENT_KEY ? state.metadata : null;
		},
		setSetting: async (key, value) => {
			state.calls.push(`setSetting:${key}`);
			if (options.fail === 'ownership' && (value as { providerId?: number }).providerId) {
				throw new Error('ownership failed');
			}
			if (key === MANAGEMENT_KEY) state.metadata = value;
		},
		deleteSetting: async key => {
			state.calls.push(`deleteSetting:${key}`);
			if (key === MANAGEMENT_KEY) state.metadata = null;
		}
	};

	return { state, dependencies };
}

describe('parseOidcEnvironment', () => {
	it('treats an unset or false switch as disabled', () => {
		expect(parseOidcEnvironment({})).toEqual({ enabled: false });
		expect(parseOidcEnvironment({ OIDC_ENABLED: 'false', OIDC_CLIENT_SECRET: SECRET })).toEqual({ enabled: false });
	});

	it('requires the exact boolean switch values', () => {
		for (const value of ['', 'TRUE', '1', 'yes']) {
			expect(() => parseOidcEnvironment({ OIDC_ENABLED: value })).toThrow('OIDC_ENABLED');
		}
	});

	it('rejects every missing or whitespace-only required value', () => {
		for (const name of ['OIDC_ISSUER_URL', 'OIDC_CLIENT_ID', 'OIDC_CLIENT_SECRET', 'OIDC_REDIRECT_URI']) {
			const missing = enabledEnv({ [name]: undefined });
			expect(() => parseOidcEnvironment(missing)).toThrow(name);
			expect(() => parseOidcEnvironment(enabledEnv({ [name]: ' \t' }))).toThrow(name);
		}
	});

	it('accepts only absolute HTTP(S) issuer and redirect URLs', () => {
		for (const name of ['OIDC_ISSUER_URL', 'OIDC_REDIRECT_URI']) {
			for (const value of ['not a URL', 'ftp://idp.example.com', '/relative']) {
				expect(() => parseOidcEnvironment(enabledEnv({ [name]: value }))).toThrow(name);
			}
		}
	});

	it('requires the admin claim and value as a pair', () => {
		expect(() => parseOidcEnvironment(enabledEnv({ OIDC_ADMIN_CLAIM: 'groups' }))).toThrow('provided together');
		expect(() => parseOidcEnvironment(enabledEnv({ OIDC_ADMIN_VALUE: 'admin' }))).toThrow('provided together');
	});

	it('applies defaults and preserves the client secret bytes', () => {
		const state = parseOidcEnvironment(enabledEnv({ OIDC_CLIENT_SECRET: '  secret with spaces  ', OIDC_NAME: ' ' }));
		if (!state.enabled) throw new Error('expected enabled state');
		expect(state.provider).toMatchObject({
			name: 'OIDC',
			scopes: 'openid profile email',
			usernameClaim: 'preferred_username',
			emailClaim: 'email',
			displayNameClaim: 'name',
			clientSecret: '  secret with spaces  '
		});
	});

	it('trims explicit ordinary values', () => {
		const state = parseOidcEnvironment(enabledEnv({
			OIDC_NAME: ' Custom ',
			OIDC_SCOPES: 'openid custom',
			OIDC_ADMIN_CLAIM: ' groups ',
			OIDC_ADMIN_VALUE: ' admin '
		}));
		if (!state.enabled) throw new Error('expected enabled state');
		expect(state.provider).toMatchObject({ name: 'Custom', scopes: 'openid custom', adminClaim: 'groups', adminValue: 'admin' });
	});
});

describe('reconcileOidcEnvironment', () => {
	it('snapshots auth before first mutation and creates an encrypted-CRUD provider', async () => {
		const { state, dependencies } = fakeDependencies();
		const result = await reconcileOidcEnvironment(enabledEnv(), dependencies);

		expect(result.status).toBe('created');
		expect(result.providerId).toBe(1);
		expect(state.auth).toMatchObject({ authEnabled: true, defaultProvider: 'oidc' });
		expect(state.metadata).toEqual({ providerId: 1, authEnabled: false, defaultProvider: 'local' });
		expect(JSON.stringify(state.metadata)).not.toContain(SECRET);
		expect(state.calls.slice(0, 3)).toEqual([
		`getSetting:${MANAGEMENT_KEY}`,
		'getAuth',
		`setSetting:${MANAGEMENT_KEY}`
	]);
	});

	it('does not update an unchanged tracked provider on the next startup', async () => {
		const first = fakeDependencies();
		await reconcileOidcEnvironment(enabledEnv(), first.dependencies);
		first.state.calls.length = 0;

		const result = await reconcileOidcEnvironment(enabledEnv(), first.dependencies);

		expect(result.status).toBe('unchanged');
		expect(first.state.calls).not.toContain('updateProvider');
		expect(first.state.calls).not.toContain('createProvider');
	});

	it('updates changed environment fields without touching GUI-created providers', async () => {
		const guiProvider = provider(99, { name: 'GUI', issuerUrl: 'https://gui.example.com' });
		const fake = fakeDependencies({ providers: [guiProvider] });
		await reconcileOidcEnvironment(enabledEnv(), fake.dependencies);
		const managedId = fake.state.metadata && (fake.state.metadata as { providerId: number }).providerId;
		const managed = fake.state.providers.get(managedId as number)!;
		managed.roleMappingsClaim = 'roles';
		managed.roleMappings = [{ claimValue: 'admin', roleId: 7 }];

		const result = await reconcileOidcEnvironment(enabledEnv({ OIDC_CLIENT_ID: 'changed' }), fake.dependencies);

		expect(result.status).toBe('updated');
		expect(fake.state.providers.get(managedId as number)?.clientId).toBe('changed');
		expect(fake.state.providers.get(managedId as number)).toMatchObject({
			roleMappingsClaim: 'roles',
			roleMappings: [{ claimValue: 'admin', roleId: 7 }]
		});
		expect(fake.state.providers.get(99)).toEqual(guiProvider);
	});

	it('clears GUI-edited admin fields when the environment omits them', async () => {
		const fake = fakeDependencies();
		await reconcileOidcEnvironment(enabledEnv(), fake.dependencies);
		const managedId = (fake.state.metadata as { providerId: number }).providerId;
		const managed = fake.state.providers.get(managedId)!;
		managed.adminClaim = 'groups';
		managed.adminValue = 'admin';

		await reconcileOidcEnvironment(enabledEnv(), fake.dependencies);

		expect(fake.state.providers.get(managedId)).toMatchObject({ adminClaim: null, adminValue: null });
	});

	it('recreates a manually deleted tracked provider while retaining the original snapshot', async () => {
		const fake = fakeDependencies({ auth: { authEnabled: true, defaultProvider: 'ldap' } });
		await reconcileOidcEnvironment(enabledEnv(), fake.dependencies);
		const originalMetadata = fake.state.metadata;
		const originalId = (originalMetadata as { providerId: number }).providerId;
		fake.state.providers.delete(originalId);

		const result = await reconcileOidcEnvironment(enabledEnv(), fake.dependencies);

		expect(result.status).toBe('created');
		expect(fake.state.metadata).toEqual({ providerId: 2, authEnabled: true, defaultProvider: 'ldap' });
	});

	it('does nothing when disabled without management metadata', async () => {
		const fake = fakeDependencies({ providers: [provider(7)], auth: { authEnabled: true, defaultProvider: 'oidc' } });
		const result = await reconcileOidcEnvironment({ OIDC_ENABLED: 'false' }, fake.dependencies);

		expect(result).toEqual({ status: 'disabled' });
		expect(fake.state.providers.has(7)).toBe(true);
		expect(fake.state.auth).toMatchObject({ authEnabled: true, defaultProvider: 'oidc' });
		expect(fake.state.calls).not.toContain('deleteProvider');
	});

	it('deletes only the managed provider and restores a disabled/local snapshot', async () => {
		const fake = fakeDependencies();
		await reconcileOidcEnvironment(enabledEnv(), fake.dependencies);

		const result = await reconcileOidcEnvironment({ OIDC_ENABLED: 'false' }, fake.dependencies);

		expect(result.status).toBe('removed');
		expect(fake.state.providers.size).toBe(0);
		expect(fake.state.auth).toMatchObject({ authEnabled: false, defaultProvider: 'local' });
		expect(fake.state.metadata).toBeNull();
	});

	it('restores an initially enabled non-local snapshot and tolerates a missing provider', async () => {
		const fake = fakeDependencies({ auth: { authEnabled: true, defaultProvider: 'ldap' } });
		await reconcileOidcEnvironment(enabledEnv(), fake.dependencies);
		const managedId = (fake.state.metadata as { providerId: number }).providerId;
		fake.state.providers.delete(managedId);

		await reconcileOidcEnvironment({}, fake.dependencies);

		expect(fake.state.auth).toMatchObject({ authEnabled: true, defaultProvider: 'ldap' });
		expect(fake.state.metadata).toBeNull();
	});

	it('performs no writes when validation fails', async () => {
		const fake = fakeDependencies();
		await expect(reconcileOidcEnvironment(enabledEnv({ OIDC_REDIRECT_URI: 'ftp://bad' }), fake.dependencies))
			.rejects.toThrow('OIDC_REDIRECT_URI');
		expect(fake.state.calls).toEqual([]);
	});

	it('keeps the journal after create, update, delete, or restore failures', async () => {
		const createFailure = fakeDependencies({ fail: 'create' });
		await expect(reconcileOidcEnvironment(enabledEnv(), createFailure.dependencies)).rejects.toThrow();
		expect(createFailure.state.metadata).toEqual({ providerId: null, authEnabled: false, defaultProvider: 'local' });
		expect(createFailure.state.calls).not.toContain('updateAuth');

		const ownershipFailure = fakeDependencies({ fail: 'ownership' });
		await expect(reconcileOidcEnvironment(enabledEnv(), ownershipFailure.dependencies)).rejects.toThrow();
		expect(ownershipFailure.state.metadata).toEqual({ providerId: null, authEnabled: false, defaultProvider: 'local' });
		expect(ownershipFailure.state.providers.size).toBe(0);

		const updateFailure = fakeDependencies({ fail: 'update' });
		await reconcileOidcEnvironment(enabledEnv(), updateFailure.dependencies);
		await expect(reconcileOidcEnvironment(enabledEnv({ OIDC_CLIENT_ID: 'changed' }), updateFailure.dependencies)).rejects.toThrow();
		expect(updateFailure.state.metadata).not.toBeNull();

		const deleteFailure = fakeDependencies({ fail: 'delete' });
		await reconcileOidcEnvironment(enabledEnv(), deleteFailure.dependencies);
		await expect(reconcileOidcEnvironment({ OIDC_ENABLED: 'false' }, deleteFailure.dependencies)).rejects.toThrow();
		expect(deleteFailure.state.metadata).not.toBeNull();

		const restoreFailure = fakeDependencies({ fail: 'restore' });
		await reconcileOidcEnvironment(enabledEnv(), restoreFailure.dependencies);
		await expect(reconcileOidcEnvironment({}, restoreFailure.dependencies)).rejects.toThrow();
		expect(restoreFailure.state.metadata).not.toBeNull();
	});

	it('does not expose the client secret in failures or result objects', async () => {
		const fake = fakeDependencies({ fail: 'create' });
		let error: unknown;
		try {
			await reconcileOidcEnvironment(enabledEnv(), fake.dependencies);
		} catch (value) {
			error = value as Error;
		}

		expect(error).toBeInstanceOf(Error);
		expect(error instanceof Error ? error.message : '').not.toContain(SECRET);
		expect(JSON.stringify(error)).not.toContain(SECRET);
	});
});
