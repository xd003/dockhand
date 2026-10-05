import { SELECTOR_VARS } from '$lib/utils/bulk-selector';
import { isInlineProviderRef, resolvedRefVarNames } from '$lib/utils/invault-markers';

type EnvVarLike = { key: string; value?: string | null };

export type ProviderProbeInput = {
	providerId: number;
	selector?: string;
	refPairs: { varName: string; ref: string }[];
};

export type ProviderProbeResult = { keys: Set<string>; error: string | null };

/**
 * What a live probe of the bound provider needs from the stack's env vars: the bulk
 * selector (DOCKHAND_SECRET_SELECTOR / legacy OP_ENVIRONMENT_ID) and the inline
 * provider references, mapped var -> ref so a resolved ref maps back to its var.
 * Null only when no provider is bound. A bound provider is probed even with neither
 * a selector nor a ref: the server decides whether its config alone scopes a bulk
 * pull (Infisical, Doppler), exactly as deploy-time resolution does.
 */
export function providerProbeInput(providerId: number | null, envVars: EnvVarLike[]): ProviderProbeInput | null {
	if (providerId === null) return null;
	let selector: string | undefined;
	for (const name of SELECTOR_VARS) {
		const hit = envVars.find((v) => v.key.trim() === name);
		const value = hit?.value?.trim();
		if (value) {
			selector = value;
			break;
		}
	}
	const refPairs: { varName: string; ref: string }[] = [];
	for (const v of envVars) {
		const key = v.key.trim();
		const value = (v.value ?? '').trim();
		if (key && isInlineProviderRef(value)) refPairs.push({ varName: key, ref: value });
	}
	return { providerId, selector, refPairs };
}

/**
 * Asks the provider which key NAMES it supplies right now (bulk keys plus the vars
 * whose inline ref resolved). Only names cross the wire. Any failure yields an empty
 * key set plus an error, so callers never show a false "present".
 */
export async function probeProviderKeys(input: ProviderProbeInput | null): Promise<ProviderProbeResult> {
	if (!input) return { keys: new Set(), error: null };
	try {
		const response = await fetch(`/api/secret-providers/${input.providerId}/probe`, {
			method: 'POST',
			headers: { 'Content-Type': 'application/json' },
			body: JSON.stringify({ selector: input.selector, refs: input.refPairs.map((p) => p.ref) })
		});
		const data = await response.json().catch(() => ({}));
		if (!response.ok || !data.ok) {
			return { keys: new Set(), error: data.error || `Provider check failed (${response.status})` };
		}
		return {
			keys: new Set([...(data.bulkKeys ?? []), ...resolvedRefVarNames(input.refPairs, data.resolvedRefs ?? [])]),
			error: null
		};
	} catch (e) {
		return { keys: new Set(), error: e instanceof Error ? e.message : 'Provider check failed' };
	}
}
