import {
	ACTIVITY_OVERRIDE_ENV_VARS,
	type ActivityOverrideField,
	type ActivityOverrides
} from '$lib/utils/activity-overrides';

const warned = new Set<string>();

/** true/1 -> true, false/0 -> false, unset/empty -> null, anything else -> 'invalid'. */
export function parseActivityOverride(raw: string | undefined): boolean | null | 'invalid' {
	if (raw === undefined) return null;
	const v = raw.trim().toLowerCase();
	if (v === '') return null;
	if (v === 'true' || v === '1') return true;
	if (v === 'false' || v === '0') return false;
	return 'invalid';
}

/** Read per call (not at import) so env changes are visible to tests. */
export function getActivityOverrides(): ActivityOverrides {
	const result = { collectActivity: null, collectMetrics: null, collectContainerMetrics: null } as ActivityOverrides;
	for (const field of Object.keys(ACTIVITY_OVERRIDE_ENV_VARS) as ActivityOverrideField[]) {
		const name = ACTIVITY_OVERRIDE_ENV_VARS[field];
		const raw = process.env[name];
		const parsed = parseActivityOverride(raw);
		if (parsed === 'invalid') {
			if (!warned.has(name)) {
				warned.add(name);
				console.warn(`[ActivityOverrides] Ignoring invalid value for ${name}: "${raw}" (expected true/false/1/0)`);
			}
			continue;
		}
		result[field] = parsed;
	}
	return result;
}

export function applyActivityOverrides<
	T extends { collectActivity: boolean | null; collectMetrics: boolean | null; collectContainerMetrics: boolean | null }
>(env: T): T {
	const ov = getActivityOverrides();
	if (ov.collectActivity === null && ov.collectMetrics === null && ov.collectContainerMetrics === null) return env;
	const out = { ...env };
	for (const field of Object.keys(ov) as ActivityOverrideField[]) {
		const v = ov[field];
		if (v !== null) out[field] = v as T[ActivityOverrideField];
	}
	return out;
}
