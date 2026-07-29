import { json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { getGitRepository } from '$lib/server/db';
import { deployFromRepositoryWithFanOut } from '$lib/server/git';
import { auditGitRepository } from '$lib/server/audit';

export const POST: RequestHandler = async (event) => {
	const { params } = event;
	try {
		const id = parseInt(params.id);
		if (isNaN(id)) {
			return json({ error: 'Invalid repository ID' }, { status: 400 });
		}

		const repository = await getGitRepository(id);
		if (!repository) {
			return json({ error: 'Repository not found' }, { status: 404 });
		}

		// Deploy from repository using fan-out logic
		const result = await deployFromRepositoryWithFanOut(id);
		await auditGitRepository(event, 'deploy', id, repository.name, {
			result: result.success ? 'deployed' : 'failed'
		});
		return json(result);
	} catch (error: any) {
		console.error('Failed to deploy from git repository:', error);
		return json({ success: false, error: error.message }, { status: 500 });
	}
};
