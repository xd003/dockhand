import { json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import {
	getGitRepositories,
	createGitRepository,
	getGitCredentials
} from '$lib/server/db';
import { syncRepositoryExclusive } from '$lib/server/git';
import { createJob, completeJob, failJob } from '$lib/server/jobs';
import { authorize } from '$lib/server/authorize';
import { auditGitRepository } from '$lib/server/audit';
import { registerSchedule } from '$lib/server/scheduler';

export const GET: RequestHandler = async ({ url, cookies }) => {
	const auth = await authorize(cookies);
	if (auth.authEnabled && !await auth.can('git', 'view')) {
		return json({ error: 'Permission denied' }, { status: 403 });
	}

	try {
		// Note: envId parameter is kept for backwards compatibility but repositories
		// are now global (not tied to environments). Use git stacks for env-specific deployments.
		const repositories = await getGitRepositories();
		return json(repositories);
	} catch (error) {
		console.error('Failed to get git repositories:', error);
		return json({ error: 'Failed to get git repositories' }, { status: 500 });
	}
};

export const POST: RequestHandler = async (event) => {
	const { request, cookies } = event;
	const auth = await authorize(cookies);
	if (auth.authEnabled && !await auth.can('git', 'create')) {
		return json({ error: 'Permission denied' }, { status: 403 });
	}

	try {
		const data = await request.json();

		if (!data.name || typeof data.name !== 'string') {
			return json({ error: 'Name is required' }, { status: 400 });
		}

		if (!data.url || typeof data.url !== 'string') {
			return json({ error: 'Repository URL is required' }, { status: 400 });
		}

		// Validate credential if provided
		if (data.credentialId) {
			const credentials = await getGitCredentials();
			const credential = credentials.find(c => c.id === data.credentialId);
			if (!credential) {
				return json({ error: 'Invalid credential ID' }, { status: 400 });
			}
		}

		// Create repository with basic fields and new sync/webhook settings
		const repository = await createGitRepository({
			name: data.name,
			url: data.url,
			branch: data.branch || 'main',
			credentialId: data.credentialId || null,
			autoUpdate: data.autoUpdate || false,
			autoUpdateSchedule: data.autoUpdate ? (data.autoUpdateSchedule || 'daily') : undefined,
			autoUpdateCron: data.autoUpdate ? (data.autoUpdateCron || '0 3 * * *') : undefined,
			webhookEnabled: data.webhookEnabled || false,
			webhookSecret: data.webhookSecret || null
		});

		// Audit log
		await auditGitRepository(event, 'create', repository.id, repository.name);

		// Register schedule if auto-update is enabled
		if (repository.autoUpdate) {
			await registerSchedule(repository.id, 'git_repository_sync', null);
		}

		// Create a job to track the clone progress so the frontend can poll for the result
		const job = createJob();
		syncRepositoryExclusive(repository.id).then((result) => {
			if (result.success) {
				completeJob(job, { success: true, commit: result.commit });
			} else {
				failJob(job, result.error ?? 'Clone failed');
			}
		}).catch((err: unknown) => {
			failJob(job, err instanceof Error ? err.message : String(err));
		});

		return json({ ...repository, cloneStarted: true, jobId: job.id });
	} catch (error: any) {
		console.error('Failed to create git repository:', error);
		if (error.message?.includes('UNIQUE constraint failed')) {
			return json({ error: 'A repository with this name already exists' }, { status: 400 });
		}
		return json({ error: 'Failed to create git repository' }, { status: 500 });
	}
};
