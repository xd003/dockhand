/**
 * Toggle schedule enabled/disabled
 * POST /api/schedules/:type/:id/toggle
 */

import { json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import {
	getAutoUpdateSettingById,
	updateAutoUpdateSettingById,
	getGitRepository,
	updateGitRepository,
	getEnvUpdateCheckSettings,
	setEnvUpdateCheckSettings,
	getImagePruneSettings,
	setImagePruneSettings
} from '$lib/server/db';
import { registerSchedule, unregisterSchedule } from '$lib/server/scheduler';
import { authorize } from '$lib/server/authorize';

export const POST: RequestHandler = async ({ params, cookies }) => {
	const auth = await authorize(cookies);

	const permDenied = await auth.requirePermission('schedules', 'edit');
	if (permDenied) return permDenied;

	try {
		const { type, id } = params;
		const scheduleId = parseInt(id, 10);

		if (isNaN(scheduleId)) {
			return json({ error: 'Invalid schedule ID' }, { status: 400 });
		}

		if (type === 'container_update') {
			const setting = await getAutoUpdateSettingById(scheduleId);
			if (!setting) {
				return json({ error: 'Schedule not found' }, { status: 404 });
			}
			const envDenied = await auth.requireEnvAccess(setting.environmentId);
			if (envDenied) return envDenied;

			const newEnabled = !setting.enabled;
			await updateAutoUpdateSettingById(scheduleId, {
				enabled: newEnabled
			});

			if (newEnabled && setting.cronExpression) {
				await registerSchedule(scheduleId, 'container_update', setting.environmentId);
			} else {
				unregisterSchedule(scheduleId, 'container_update');
			}

			return json({ success: true, enabled: newEnabled });
		} else if (type === 'git_repository_sync') {
			const repo = await getGitRepository(scheduleId);
			if (!repo) {
				return json({ error: 'Schedule not found' }, { status: 404 });
			}

			const newEnabled = !repo.autoUpdate;
			await updateGitRepository(scheduleId, {
				autoUpdate: newEnabled
			});

			if (newEnabled && repo.autoUpdateCron) {
				await registerSchedule(scheduleId, 'git_repository_sync', null);
			} else {
				unregisterSchedule(scheduleId, 'git_repository_sync');
			}

			return json({ success: true, enabled: newEnabled });
		} else if (type === 'git_stack_sync') {
			return json({
				error: 'Stack-level git sync schedules have moved to the repository. Configure scheduled sync on the git repository instead.'
			}, { status: 400 });
		} else if (type === 'env_update_check') {
			const envDenied = await auth.requireEnvAccess(scheduleId);
			if (envDenied) return envDenied;
			const config = await getEnvUpdateCheckSettings(scheduleId);
			if (!config) {
				return json({ error: 'Schedule not found' }, { status: 404 });
			}

			const newEnabled = !config.enabled;
			await setEnvUpdateCheckSettings(scheduleId, {
				...config,
				enabled: newEnabled
			});

			if (newEnabled && config.cron) {
				await registerSchedule(scheduleId, 'env_update_check', scheduleId);
			} else {
				unregisterSchedule(scheduleId, 'env_update_check');
			}

			return json({ success: true, enabled: newEnabled });
		} else if (type === 'image_prune') {
			const envDenied = await auth.requireEnvAccess(scheduleId);
			if (envDenied) return envDenied;
			const config = await getImagePruneSettings(scheduleId);
			if (!config) {
				return json({ error: 'Schedule not found' }, { status: 404 });
			}

			const newEnabled = !config.enabled;
			await setImagePruneSettings(scheduleId, {
				...config,
				enabled: newEnabled
			});

			if (newEnabled && config.cronExpression) {
				await registerSchedule(scheduleId, 'image_prune', scheduleId);
			} else {
				unregisterSchedule(scheduleId, 'image_prune');
			}

			return json({ success: true, enabled: newEnabled });
		} else if (type === 'system_cleanup') {
			return json({ error: 'System schedules cannot be paused' }, { status: 400 });
		} else {
			return json({ error: 'Invalid schedule type' }, { status: 400 });
		}
	} catch (error) {
		console.error('Failed to toggle schedule:', error);
		return json({ error: 'Failed to toggle schedule' }, { status: 500 });
	}
};
