import { json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import {
	getGitRepository,
	updateGitRepository,
	deleteGitRepository,
	getGitCredentials,
	getGitStacksByRepositoryId
} from '$lib/server/db';
import { deleteRepositoryFiles, deleteGitStackFiles, renameRepositoryFiles, syncRepositoryExclusive } from '$lib/server/git';
import { createJob, completeJob, failJob } from '$lib/server/jobs';
import { authorize } from '$lib/server/authorize';
import { auditGitRepository } from '$lib/server/audit';
import { computeAuditDiff } from '$lib/utils/diff';
import { registerSchedule, unregisterSchedule } from '$lib/server/scheduler';

export const GET: RequestHandler = async ({ params, cookies }) => {
	const auth = await authorize(cookies);
	if (auth.authEnabled && !await auth.can('git', 'view')) {
		return json({ error: 'Permission denied' }, { status: 403 });
	}

	try {
		const id = parseInt(params.id);
		if (isNaN(id)) {
			return json({ error: 'Invalid repository ID' }, { status: 400 });
		}

		const repository = await getGitRepository(id);
		if (!repository) {
			return json({ error: 'Repository not found' }, { status: 404 });
		}

		return json(repository);
	} catch (error) {
		console.error('Failed to get git repository:', error);
		return json({ error: 'Failed to get git repository' }, { status: 500 });
	}
};

export const PUT: RequestHandler = async (event) => {
	const { params, request, cookies } = event;
	const auth = await authorize(cookies);
	if (auth.authEnabled && !await auth.can('git', 'edit')) {
		return json({ error: 'Permission denied' }, { status: 403 });
	}

	try {
		const id = parseInt(params.id);
		if (isNaN(id)) {
			return json({ error: 'Invalid repository ID' }, { status: 400 });
		}

		const existing = await getGitRepository(id);
		if (!existing) {
			return json({ error: 'Repository not found' }, { status: 404 });
		}

		const data = await request.json();

		// Validate credential if provided
		if (data.credentialId) {
			const credentials = await getGitCredentials();
			const credential = credentials.find(c => c.id === data.credentialId);
			if (!credential) {
				return json({ error: 'Invalid credential ID' }, { status: 400 });
			}
		}

		// Update repository fields
		const repository = await updateGitRepository(id, {
			name: data.name,
			url: data.url,
			branch: data.branch,
			credentialId: data.credentialId,
			autoUpdate: data.autoUpdate,
			autoUpdateSchedule: data.autoUpdateSchedule,
			autoUpdateCron: data.autoUpdateCron,
			webhookEnabled: data.webhookEnabled,
			webhookSecret: data.webhookSecret
		});

		if (!repository) {
			return json({ error: 'Failed to update repository' }, { status: 500 });
		}

		// Compute diff for audit
		const diff = computeAuditDiff(existing, repository);

		// Audit log
		await auditGitRepository(event, 'update', repository.id, repository.name, diff);

		// Manage schedule if auto-update settings changed
		if (repository.autoUpdate) {
			await registerSchedule(repository.id, 'git_repository_sync', null);
		} else {
			unregisterSchedule(repository.id, 'git_repository_sync');
		}

		// Rename on-disk clone if the display name changed (path is name-based)
		if (existing.name !== repository.name) {
			renameRepositoryFiles(existing.name, repository.name);
		}

		// Only re-sync when clone identity changes (URL, branch, or credentials)
		const needsResync =
			existing.url !== repository.url ||
			existing.branch !== repository.branch ||
			existing.credentialId !== repository.credentialId;

		if (!needsResync) {
			return json(repository);
		}

		const job = createJob();
		syncRepositoryExclusive(id).then((result) => {
			if (result.success) {
				completeJob(job, { success: true, commit: result.commit });
			} else {
				failJob(job, result.error ?? 'Clone failed');
			}
		}).catch((err: unknown) => {
			failJob(job, err instanceof Error ? err.message : String(err));
		});

		return json({ ...repository, jobId: job.id });
	} catch (error: any) {
		console.error('Failed to update git repository:', error);
		if (error.message?.includes('UNIQUE constraint failed')) {
			return json({ error: 'A repository with this name already exists' }, { status: 400 });
		}
		return json({ error: 'Failed to update git repository' }, { status: 500 });
	}
};

export const DELETE: RequestHandler = async (event) => {
	const { params, cookies } = event;
	const auth = await authorize(cookies);
	if (auth.authEnabled && !await auth.can('git', 'delete')) {
		return json({ error: 'Permission denied' }, { status: 403 });
	}

	try {
		const id = parseInt(params.id);
		if (isNaN(id)) {
			return json({ error: 'Invalid repository ID' }, { status: 400 });
		}

		// Get repository name before deletion for audit log
		const repository = await getGitRepository(id);
		if (!repository) {
			return json({ error: 'Repository not found' }, { status: 404 });
		}

		// Delete git stack clone directories before cascade deletes the DB rows
		const stacks = await getGitStacksByRepositoryId(id);
		console.log(`[GitStack] Repository "${repository.name}" (id=${id}) deletion affects ${stacks.length} stacks: ${stacks.map(s => s.stackName).join(', ')}`);
		for (const stack of stacks) {
			await deleteGitStackFiles(stack.id, stack.stackName, stack.environmentId);
		}

		// Delete repository clone directory
		deleteRepositoryFiles(repository.name, id);
		
		// Unregister schedule
		unregisterSchedule(id, 'git_repository_sync');

		const deleted = await deleteGitRepository(id);
		if (!deleted) {
			return json({ error: 'Failed to delete repository' }, { status: 500 });
		}

		// Audit log
		await auditGitRepository(event, 'delete', id, repository.name);

		return json({ success: true });
	} catch (error) {
		console.error('Failed to delete git repository:', error);
		return json({ error: 'Failed to delete git repository' }, { status: 500 });
	}
};
