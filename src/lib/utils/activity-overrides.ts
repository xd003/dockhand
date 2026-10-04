export type ActivityOverrideField = 'collectActivity' | 'collectMetrics' | 'collectContainerMetrics';

/** null = not overridden (per-environment setting applies). */
export type ActivityOverrides = Record<ActivityOverrideField, boolean | null>;

export const ACTIVITY_OVERRIDE_ENV_VARS: Record<ActivityOverrideField, string> = {
	collectActivity: 'COLLECT_CONTAINER_ACTIVITY',
	collectMetrics: 'COLLECT_SYSTEM_METRICS',
	collectContainerMetrics: 'COLLECT_CONTAINER_METRICS'
};

export const NO_ACTIVITY_OVERRIDES: ActivityOverrides = {
	collectActivity: null,
	collectMetrics: null,
	collectContainerMetrics: null
};
