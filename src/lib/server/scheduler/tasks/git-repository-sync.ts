/**
 * Git Repository Auto-Sync Task
 *
 * Handles automatic syncing and fan-out deploying of git-based repositories.
 */

import type { ScheduleTrigger } from '../../db';
import {
	createScheduleExecution,
	updateScheduleExecution,
	appendScheduleExecutionLog
} from '../../db';
import { deployFromRepositoryWithFanOut } from '../../git';
import { sendEventNotification } from '../../notifications';

/**
 * Execute a git repository sync.
 */
export async function runGitRepositorySync(
	repositoryId: number,
	repositoryName: string,
	triggeredBy: ScheduleTrigger
): Promise<void> {
	const startTime = Date.now();

	// Create execution record
	// Note: environmentId is null since repositories are global, not env-specific
	const execution = await createScheduleExecution({
		scheduleType: 'git_repository_sync',
		scheduleId: repositoryId,
		environmentId: null,
		entityName: repositoryName,
		triggeredBy,
		status: 'running'
	});

	await updateScheduleExecution(execution.id, {
		startedAt: new Date().toISOString()
	});

	const log = (message: string) => {
		console.log(`[Git-repo-sync] ${message}`);
		appendScheduleExecutionLog(execution.id, `[${new Date().toISOString()}] ${message}`);
	};

	const persistStackDetails = async (
		status: 'success' | 'failed' | 'skipped',
		result: { output?: string; stacks?: unknown[]; error?: string },
		errorMessage?: string
	) => {
		await updateScheduleExecution(execution.id, {
			status,
			completedAt: new Date().toISOString(),
			duration: Date.now() - startTime,
			details: { output: result.output, stacks: result.stacks },
			...(errorMessage ? { errorMessage } : {})
		});
	};

	try {
		log(`Starting sync for repository: ${repositoryName}`);

		// Deploy from repository with fan-out logic
		const result = await deployFromRepositoryWithFanOut(repositoryId, log);

		const totalStacks = result.stacks?.length || 0;
		const deployedStacks = result.stacks?.filter(s => s.status === 'deployed').length || 0;
		const skippedStacks = result.stacks?.filter(s => s.status === 'skipped').length || 0;
		const failedStacks = result.stacks?.filter(s => s.status === 'failed').length || 0;

		// deployFromRepositoryWithFanOut returns success:false whenever any stack fails,
		// so inside result.success failedStacks is always 0 — the "partial failure"
		// branch was unreachable. Partial failures land in the else below.
		if (result.success) {
			log(`Sync completed for repository ${repositoryName}. Total stacks: ${totalStacks} (Deployed: ${deployedStacks}, Skipped: ${skippedStacks})`);

			if (deployedStacks > 0) {
				await persistStackDetails('success', result);

				await sendEventNotification('git_sync_success', {
					title: 'Git repository synced',
					message: `Repository "${repositoryName}" deployed ${deployedStacks} stack(s) successfully.`,
					type: 'success'
				});
			} else {
				await persistStackDetails('skipped', result);

				await sendEventNotification('git_sync_skipped', {
					title: 'Git repository sync skipped',
					message: `Repository "${repositoryName}" sync skipped: no changes detected in ${skippedStacks} stack(s).`,
					type: 'info'
				});
			}
		} else {
			// Fan-out finished with one or more stack failures (or a repo-level error).
			// Always persist per-stack results so the UI keeps the breakdown.
			log(`Sync finished with errors for repository ${repositoryName}. Total stacks: ${totalStacks} (Deployed: ${deployedStacks}, Skipped: ${skippedStacks}, Failed: ${failedStacks})`);

			await persistStackDetails(
				deployedStacks > 0 ? 'success' : 'failed',
				result,
				result.error || 'Deployment failed'
			);

			await sendEventNotification('git_sync_failed', {
				title: 'Git repository sync failed',
				message: `Repository "${repositoryName}" sync failed: ${result.error || 'Deployment failed'}`,
				type: 'error'
			});
		}
	} catch (error: any) {
		log(`Error: ${error.message}`);
		await updateScheduleExecution(execution.id, {
			status: 'failed',
			completedAt: new Date().toISOString(),
			duration: Date.now() - startTime,
			errorMessage: error.message
		});

		// Send notification for failed sync
		await sendEventNotification('git_sync_failed', {
			title: 'Git repository sync failed',
			message: `Repository "${repositoryName}" sync failed: ${error.message}`,
			type: 'error'
		});
	}
}
