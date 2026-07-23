/**
 * Shared schedule list builder used by REST and SSE endpoints.
 */

import {
	getAllAutoUpdateSettings,
	getAllAutoUpdateRepositories,
	getAllEnvUpdateCheckSettings,
	getAllImagePruneSettings,
	getLastExecutionForSchedule,
	getRecentExecutionsForSchedule,
	getEnvironment,
	getEnvironmentTimezone,
	getDefaultTimezone,
	type ScheduleExecutionData,
	type VulnerabilityCriteria
} from '$lib/server/db';
import { getNextRun, getSystemSchedules } from '$lib/server/scheduler';
import { getGlobalScannerDefaults, getScannerSettingsWithDefaults } from '$lib/server/scanner';

export interface ScheduleInfo {
	id: number;
	type: 'container_update' | 'git_stack_sync' | 'git_repository_sync' | 'system_cleanup' | 'env_update_check' | 'image_prune';
	name: string;
	entityName: string;
	description?: string;
	environmentId: number | null;
	environmentName: string | null;
	enabled: boolean;
	scheduleType: string;
	cronExpression: string | null;
	nextRun: string | null;
	lastExecution: ScheduleExecutionData | null;
	recentExecutions: ScheduleExecutionData[];
	isSystem: boolean;
	envHasScanning?: boolean;
	vulnerabilityCriteria?: VulnerabilityCriteria | null;
	autoUpdate?: boolean;
	pruneMode?: string;
}

export async function buildSchedulesList(): Promise<ScheduleInfo[]> {
	const schedules: ScheduleInfo[] = [];

	const globalScannerDefaults = await getGlobalScannerDefaults();

	const containerSettings = await getAllAutoUpdateSettings();
	const containerSchedules = await Promise.all(
		containerSettings.map(async (setting) => {
			const [env, lastExecution, recentExecutions, scannerSettings, timezone] = await Promise.all([
				setting.environmentId ? getEnvironment(setting.environmentId) : null,
				getLastExecutionForSchedule('container_update', setting.id),
				getRecentExecutionsForSchedule('container_update', setting.id, 5),
				getScannerSettingsWithDefaults(setting.environmentId ?? undefined, globalScannerDefaults),
				setting.environmentId ? getEnvironmentTimezone(setting.environmentId) : 'UTC'
			]);
			const isEnabled = setting.enabled ?? false;
			const nextRun = isEnabled && setting.cronExpression ? getNextRun(setting.cronExpression, timezone) : null;
			const envHasScanning = scannerSettings.scanner !== 'none';

			return {
				id: setting.id,
				type: 'container_update' as const,
				name: `Update container: ${setting.containerName}`,
				entityName: setting.containerName,
				environmentId: setting.environmentId ?? null,
				environmentName: env?.name ?? null,
				enabled: isEnabled,
				scheduleType: setting.scheduleType ?? 'daily',
				cronExpression: setting.cronExpression ?? null,
				nextRun: nextRun?.toISOString() ?? null,
				lastExecution: lastExecution ?? null,
				recentExecutions,
				isSystem: false,
				envHasScanning,
				vulnerabilityCriteria: setting.vulnerabilityCriteria ?? null
			};
		})
	);
	schedules.push(...containerSchedules);

	const gitRepos = await getAllAutoUpdateRepositories();
	const defaultTimezone = await getDefaultTimezone();
	const gitSchedules = await Promise.all(
		gitRepos.map(async (repo) => {
			const [lastExecution, recentExecutions] = await Promise.all([
				getLastExecutionForSchedule('git_repository_sync', repo.id),
				getRecentExecutionsForSchedule('git_repository_sync', repo.id, 5)
			]);
			const isEnabled = repo.autoUpdate ?? false;
			const nextRun = isEnabled && repo.autoUpdateCron ? getNextRun(repo.autoUpdateCron, defaultTimezone) : null;

			return {
				id: repo.id,
				type: 'git_repository_sync' as const,
				name: `Git sync: ${repo.name}`,
				entityName: repo.name,
				environmentId: null,
				environmentName: null,
				enabled: isEnabled,
				scheduleType: repo.autoUpdateSchedule ?? 'daily',
				cronExpression: repo.autoUpdateCron ?? null,
				nextRun: nextRun?.toISOString() ?? null,
				lastExecution: lastExecution ?? null,
				recentExecutions,
				isSystem: false
			};
		})
	);
	schedules.push(...gitSchedules);

	const envUpdateCheckConfigs = await getAllEnvUpdateCheckSettings();
	const envUpdateCheckSchedules = await Promise.all(
		envUpdateCheckConfigs.map(async ({ envId, settings }) => {
			const [env, lastExecution, recentExecutions, scannerSettings, timezone] = await Promise.all([
				getEnvironment(envId),
				getLastExecutionForSchedule('env_update_check', envId),
				getRecentExecutionsForSchedule('env_update_check', envId, 5),
				getScannerSettingsWithDefaults(envId, globalScannerDefaults),
				getEnvironmentTimezone(envId)
			]);
			const isEnabled = settings.enabled ?? false;
			const nextRun = isEnabled && settings.cron ? getNextRun(settings.cron, timezone) : null;
			const envHasScanning = scannerSettings.scanner !== 'none';

			let description: string;
			if (settings.autoUpdate) {
				description = envHasScanning ? 'Check, scan & auto-update containers' : 'Check & auto-update containers';
			} else {
				description = 'Check containers for updates (notify only)';
			}

			return {
				id: envId,
				type: 'env_update_check' as const,
				name: `Update environment: ${env?.name || 'Unknown'}`,
				entityName: env?.name || 'Unknown',
				description,
				environmentId: envId,
				environmentName: env?.name ?? null,
				enabled: isEnabled,
				scheduleType: 'custom',
				cronExpression: settings.cron ?? null,
				nextRun: nextRun?.toISOString() ?? null,
				lastExecution: lastExecution ?? null,
				recentExecutions,
				isSystem: false,
				autoUpdate: settings.autoUpdate,
				envHasScanning,
				vulnerabilityCriteria: settings.autoUpdate ? (settings.vulnerabilityCriteria ?? null) : null
			};
		})
	);
	schedules.push(...envUpdateCheckSchedules);

	const imagePruneConfigs = await getAllImagePruneSettings();
	const imagePruneSchedules = await Promise.all(
		imagePruneConfigs.map(async ({ envId, settings }) => {
			const [env, lastExecution, recentExecutions, timezone] = await Promise.all([
				getEnvironment(envId),
				getLastExecutionForSchedule('image_prune', envId),
				getRecentExecutionsForSchedule('image_prune', envId, 5),
				getEnvironmentTimezone(envId)
			]);
			const isEnabled = settings.enabled ?? false;
			const nextRun = isEnabled && settings.cronExpression ? getNextRun(settings.cronExpression, timezone) : null;

			const description = settings.pruneMode === 'all'
				? 'Prune all unused images'
				: 'Prune dangling images only';

			return {
				id: envId,
				type: 'image_prune' as const,
				name: `Prune images: ${env?.name || 'Unknown'}`,
				entityName: env?.name || 'Unknown',
				description,
				environmentId: envId,
				environmentName: env?.name ?? null,
				enabled: isEnabled,
				scheduleType: 'custom',
				cronExpression: settings.cronExpression ?? null,
				nextRun: nextRun?.toISOString() ?? null,
				lastExecution: lastExecution ?? null,
				recentExecutions,
				isSystem: false,
				pruneMode: settings.pruneMode
			};
		})
	);
	schedules.push(...imagePruneSchedules);

	const systemSchedules = await getSystemSchedules();
	const sysSchedules = await Promise.all(
		systemSchedules.map(async (sys) => {
			const [lastExecution, recentExecutions] = await Promise.all([
				getLastExecutionForSchedule(sys.type, sys.id),
				getRecentExecutionsForSchedule(sys.type, sys.id, 5)
			]);

			return {
				id: sys.id,
				type: sys.type,
				name: sys.name,
				entityName: sys.name,
				description: sys.description,
				environmentId: null,
				environmentName: null,
				enabled: sys.enabled,
				scheduleType: 'custom',
				cronExpression: sys.cronExpression,
				nextRun: sys.nextRun,
				lastExecution: lastExecution ?? null,
				recentExecutions,
				isSystem: true
			};
		})
	);
	schedules.push(...sysSchedules);

	schedules.sort((a, b) => {
		if (a.isSystem !== b.isSystem) return a.isSystem ? 1 : -1;
		return a.name.localeCompare(b.name);
	});

	return schedules;
}
