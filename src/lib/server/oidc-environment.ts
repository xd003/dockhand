import type { AuthSettingsData, OidcConfigData } from '$lib/server/db';

const MANAGEMENT_SETTING = 'oidc_environment_management';

type OidcEnvironmentProvider = Pick<
	OidcConfigData,
	'name' | 'enabled' | 'issuerUrl' | 'clientId' | 'clientSecret' | 'redirectUri' |
	'scopes' | 'usernameClaim' | 'emailClaim' | 'displayNameClaim' | 'adminClaim' | 'adminValue'
>;

type OidcEnvironmentMetadata = {
	providerId: number | null;
	authEnabled: boolean;
	defaultProvider: AuthSettingsData['defaultProvider'];
};

export type OidcEnvironmentState =
	| { enabled: false }
	| { enabled: true; provider: OidcEnvironmentProvider };

export type OidcEnvironmentResult = {
	status: 'created' | 'updated' | 'unchanged' | 'removed' | 'disabled';
	providerId?: number;
};

export interface OidcEnvironmentDependencies {
	getOidcConfig: (id: number) => Promise<OidcConfigData | null>;
	createOidcConfig: (
		data: Omit<OidcConfigData, 'id' | 'createdAt' | 'updatedAt'>
	) => Promise<OidcConfigData>;
	updateOidcConfig: (id: number, data: Partial<OidcConfigData>) => Promise<OidcConfigData | null>;
	deleteOidcConfig: (id: number) => Promise<boolean>;
	getAuthSettings: () => Promise<AuthSettingsData>;
	updateAuthSettings: (data: Partial<AuthSettingsData>) => Promise<AuthSettingsData>;
	getSetting: (key: string) => Promise<unknown>;
	setSetting: (key: string, value: unknown) => Promise<void>;
	deleteSetting: (key: string) => Promise<void>;
}

function optionalText(env: NodeJS.ProcessEnv, name: string): string | undefined {
	const value = env[name]?.trim();
	return value || undefined;
}

function requiredText(env: NodeJS.ProcessEnv, name: string): string {
	const value = env[name]?.trim();
	if (!value) throw new Error(`Invalid ${name}: a non-empty value is required when OIDC_ENABLED=true`);
	return value;
}

function requiredUrl(env: NodeJS.ProcessEnv, name: string): string {
	const value = requiredText(env, name);
	try {
		const parsed = new URL(value);
		if (!['http:', 'https:'].includes(parsed.protocol) || !parsed.hostname) throw new Error();
	} catch {
		throw new Error(`Invalid ${name}: must be an absolute HTTP(S) URL`);
	}
	return value;
}

export function parseOidcEnvironment(env: NodeJS.ProcessEnv): OidcEnvironmentState {
	const enabled = env.OIDC_ENABLED;
	if (enabled === undefined || enabled === 'false') return { enabled: false };
	if (enabled !== 'true') {
		throw new Error('Invalid OIDC_ENABLED: expected exactly "true" or "false"');
	}

	const clientSecret = env.OIDC_CLIENT_SECRET;
	if (!clientSecret || !/\S/.test(clientSecret)) {
		throw new Error('Invalid OIDC_CLIENT_SECRET: a non-empty value is required when OIDC_ENABLED=true');
	}

	const adminClaim = optionalText(env, 'OIDC_ADMIN_CLAIM');
	const adminValue = optionalText(env, 'OIDC_ADMIN_VALUE');
	if ((adminClaim === undefined) !== (adminValue === undefined)) {
		throw new Error('OIDC_ADMIN_CLAIM and OIDC_ADMIN_VALUE must be provided together');
	}

	return {
		enabled: true,
		provider: {
			name: optionalText(env, 'OIDC_NAME') ?? 'OIDC',
			enabled: true,
			issuerUrl: requiredUrl(env, 'OIDC_ISSUER_URL'),
			clientId: requiredText(env, 'OIDC_CLIENT_ID'),
			clientSecret,
			redirectUri: requiredUrl(env, 'OIDC_REDIRECT_URI'),
			scopes: optionalText(env, 'OIDC_SCOPES') ?? 'openid profile email',
			usernameClaim: optionalText(env, 'OIDC_USERNAME_CLAIM') ?? 'preferred_username',
			emailClaim: optionalText(env, 'OIDC_EMAIL_CLAIM') ?? 'email',
			displayNameClaim: optionalText(env, 'OIDC_DISPLAY_NAME_CLAIM') ?? 'name',
			adminClaim,
			adminValue
		}
	};
}

function readMetadata(value: unknown): OidcEnvironmentMetadata | null {
	if (value === null || value === undefined) return null;
	if (typeof value !== 'object' || value === null) {
		throw new Error('Invalid oidc_environment_management metadata');
	}

	const metadata = value as Partial<OidcEnvironmentMetadata>;
	if (
		(metadata.providerId !== null && (!Number.isInteger(metadata.providerId) || metadata.providerId < 1)) ||
		typeof metadata.authEnabled !== 'boolean' ||
		!['local', 'ldap', 'oidc'].includes(metadata.defaultProvider ?? '')
	) {
		throw new Error('Invalid oidc_environment_management metadata');
	}

	return metadata as OidcEnvironmentMetadata;
}

async function phase<T>(name: string, operation: () => Promise<T>): Promise<T> {
	try {
		return await operation();
	} catch {
		throw new Error(`OIDC environment reconciliation failed during ${name}`);
	}
}

const managedFields = [
	'name',
	'enabled',
	'issuerUrl',
	'clientId',
	'clientSecret',
	'redirectUri',
	'scopes',
	'usernameClaim',
	'emailClaim',
	'displayNameClaim',
	'adminClaim',
	'adminValue'
] as const;

function normalized(value: string | boolean | null | undefined): string | boolean | undefined {
	return value ?? undefined;
}

function providerChanged(existing: OidcConfigData, desired: OidcEnvironmentProvider): boolean {
	return managedFields.some(field => normalized(existing[field]) !== normalized(desired[field]));
}

function providerUpdates(existing: OidcConfigData, desired: OidcEnvironmentProvider): Partial<OidcConfigData> {
	const updates: Partial<OidcConfigData> = {};
	for (const field of managedFields) {
		if (normalized(existing[field]) !== normalized(desired[field])) {
			updates[field] = (desired[field] === undefined && (field === 'adminClaim' || field === 'adminValue'))
				? null
				: desired[field] as never;
		}
	}
	return updates;
}

async function productionDependencies(): Promise<OidcEnvironmentDependencies> {
	const db = await import('$lib/server/db');
	return {
		getOidcConfig: db.getOidcConfig,
		createOidcConfig: db.createOidcConfig,
		updateOidcConfig: db.updateOidcConfig,
		deleteOidcConfig: db.deleteOidcConfig,
		getAuthSettings: db.getAuthSettings,
		updateAuthSettings: db.updateAuthSettings,
		getSetting: db.getSetting,
		setSetting: db.setSetting,
		deleteSetting: db.deleteSetting
	};
}

async function reconcileEnabled(
	provider: OidcEnvironmentProvider,
	deps: OidcEnvironmentDependencies
): Promise<OidcEnvironmentResult> {
	let metadata = readMetadata(await phase('loading management metadata', () => deps.getSetting(MANAGEMENT_SETTING)));
	let authSettings: AuthSettingsData;

	if (!metadata) {
		authSettings = await phase('reading auth settings', deps.getAuthSettings);
		metadata = {
			providerId: null,
			authEnabled: authSettings.authEnabled,
			defaultProvider: authSettings.defaultProvider
		};
		await phase('saving management metadata', () => deps.setSetting(MANAGEMENT_SETTING, metadata));
	} else {
		authSettings = await phase('reading auth settings', deps.getAuthSettings);
	}

	let status: OidcEnvironmentResult['status'] = 'unchanged';
	let managedProvider: OidcConfigData | null = null;
	if (metadata.providerId !== null) {
		managedProvider = await phase('loading managed OIDC provider', () => deps.getOidcConfig(metadata.providerId!));
	}

	if (!managedProvider) {
		const created = await phase('creating OIDC provider', () => deps.createOidcConfig({
			...provider,
			roleMappingsClaim: 'groups',
			roleMappings: undefined
		}));
		metadata = { ...metadata, providerId: created.id };
		try {
			await phase('recording OIDC provider ownership', () => deps.setSetting(MANAGEMENT_SETTING, metadata));
		} catch (error) {
			const deleted = await phase('rolling back untracked OIDC provider', () => deps.deleteOidcConfig(created.id));
			if (!deleted) throw new Error('OIDC environment reconciliation failed during rolling back untracked OIDC provider');
			throw error;
		}
		status = 'created';
	} else if (providerChanged(managedProvider, provider)) {
		const updated = await phase('updating managed OIDC provider', () =>
			deps.updateOidcConfig(managedProvider!.id, providerUpdates(managedProvider!, provider))
		);
		if (!updated) throw new Error('OIDC environment reconciliation failed during updating managed OIDC provider');
		status = 'updated';
	}

	if (!authSettings.authEnabled || authSettings.defaultProvider !== 'oidc') {
		await phase('enabling authentication', () => deps.updateAuthSettings({
			authEnabled: true,
			defaultProvider: 'oidc'
		}));
		if (status === 'unchanged') status = 'updated';
	}

	return { status, providerId: metadata.providerId ?? undefined };
}

async function reconcileDisabled(deps: OidcEnvironmentDependencies): Promise<OidcEnvironmentResult> {
	const metadata = readMetadata(await phase('loading management metadata', () => deps.getSetting(MANAGEMENT_SETTING)));
	if (!metadata) return { status: 'disabled' };

	if (metadata.providerId !== null) {
		const provider = await phase('loading managed OIDC provider', () => deps.getOidcConfig(metadata.providerId!));
		if (provider) {
			const deleted = await phase('deleting managed OIDC provider', () => deps.deleteOidcConfig(metadata.providerId!));
			if (!deleted) throw new Error('OIDC environment reconciliation failed during deleting managed OIDC provider');
		}
	}

	const authSettings = await phase('reading auth settings', deps.getAuthSettings);
	if (
		authSettings.authEnabled !== metadata.authEnabled ||
		authSettings.defaultProvider !== metadata.defaultProvider
	) {
		await phase('restoring authentication settings', () => deps.updateAuthSettings({
			authEnabled: metadata.authEnabled,
			defaultProvider: metadata.defaultProvider
		}));
	}

	await phase('deleting management metadata', () => deps.deleteSetting(MANAGEMENT_SETTING));
	return {
		status: 'removed',
		providerId: metadata.providerId ?? undefined
	};
}

export async function reconcileOidcEnvironment(
	env: NodeJS.ProcessEnv = process.env,
	dependencies?: OidcEnvironmentDependencies
): Promise<OidcEnvironmentResult> {
	const state = parseOidcEnvironment(env);
	const deps = dependencies ?? await productionDependencies();
	return state.enabled ? reconcileEnabled(state.provider, deps) : reconcileDisabled(deps);
}
