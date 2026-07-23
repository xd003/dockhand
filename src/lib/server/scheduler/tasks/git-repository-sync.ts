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

	try {
		log(`Starting sync for repository: ${repositoryName}`);

		// Deploy from repository with fan-out logic
		const result = await deployFromRepositoryWithFanOut(repositoryId, log);

		if (result.success) {
			const totalStacks = result.stacks?.length || 0;
			const deployedStacks = result.stacks?.filter(s => s.status === 'deployed').length || 0;
			const skippedStacks = result.stacks?.filter(s => s.status === 'skipped').length || 0;
			const failedStacks = result.stacks?.filter(s => s.status === 'failed').length || 0;

			log(`Sync completed for repository ${repositoryName}. Total stacks: ${totalStacks} (Deployed: ${deployedStacks}, Skipped: ${skippedStacks}, Failed: ${failedStacks})`);

			if (failedStacks > 0) {
				// Partially successful or failed
				await updateScheduleExecution(execution.id, {
					status: deployedStacks > 0 ? 'success' : 'failed', // Mark success if at least some deployed, or maybe failed? Let's use 'success' if no throw, but note details
					completedAt: new Date().toISOString(),
					duration: Date.now() - startTime,
					details: { output: result.output, stacks: result.stacks }
				});

				await sendEventNotification('git_sync_failed', {
					title: 'Git repository sync finished with errors',
					message: `Repository "${repositoryName}" sync had ${failedStacks} failed stack(s).`,
					type: 'warning'
				});
			} else if (deployedStacks > 0) {
				await updateScheduleExecution(execution.id, {
					status: 'success',
					completedAt: new Date().toISOString(),
					duration: Date.now() - startTime,
					details: { output: result.output, stacks: result.stacks }
				});

				await sendEventNotification('git_sync_success', {
					title: 'Git repository synced',
					message: `Repository "${repositoryName}" deployed ${deployedStacks} stack(s) successfully.`,
					type: 'success'
				});
			} else {
				// Everything skipped or no stacks
				await updateScheduleExecution(execution.id, {
					status: 'skipped',
					completedAt: new Date().toISOString(),
					duration: Date.now() - startTime,
					details: { output: result.output, stacks: result.stacks }
				});

				await sendEventNotification('git_sync_skipped', {
					title: 'Git repository sync skipped',
					message: `Repository "${repositoryName}" sync skipped: no changes detected in ${skippedStacks} stack(s).`,
					type: 'info'
				});
			}
		} else {
			throw new Error(result.error || 'Deployment failed');
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
