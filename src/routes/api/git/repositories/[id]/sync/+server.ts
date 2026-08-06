import { json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { getGitRepository } from '$lib/server/db';
import { syncRepository, checkForUpdates } from '$lib/server/git';
import { assertNotTransitioning } from '$lib/server/git-transition-guard';
import { authorize } from '$lib/server/authorize';

export const POST: RequestHandler = async (event) => {
	const { params, cookies } = event;
	const auth = await authorize(cookies);
	if (auth.authEnabled && !await auth.can('git', 'edit')) {
		return json({ error: 'Permission denied' }, { status: 403 });
	}

	try {
		// Refuse to start a sync while a git mode transition is running (F9)
		const locked = await assertNotTransitioning();
		if (locked) return locked;

		const id = parseInt(params.id);
		if (isNaN(id)) {
			return json({ error: 'Invalid repository ID' }, { status: 400 });
		}

		const repository = await getGitRepository(id);
		if (!repository) {
			return json({ error: 'Repository not found' }, { status: 404 });
		}

		const result = await syncRepository(id);
		return json(result);
	} catch (error: any) {
		console.error('Failed to sync git repository:', error);
		return json({ success: false, error: error.message }, { status: 500 });
	}
};

export const GET: RequestHandler = async ({ params, cookies }) => {
	// Check for updates without syncing
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

		const result = await checkForUpdates(id);
		return json(result);
	} catch (error: any) {
		console.error('Failed to check for updates:', error);
		return json({ hasUpdates: false, error: error.message }, { status: 500 });
	}
};
