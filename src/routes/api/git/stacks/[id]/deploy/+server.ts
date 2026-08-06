import { json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { getGitStack } from '$lib/server/db';
import { deployGitStack } from '$lib/server/git';
import { assertNotTransitioning } from '$lib/server/git-transition-guard';
import { authorize } from '$lib/server/authorize';
import { auditGitStack } from '$lib/server/audit';
import { createJobResponse } from '$lib/server/sse';

export const POST: RequestHandler = async (event) => {
	const { params, cookies } = event;
	const auth = await authorize(cookies);

	try {
		// Refuse to start a deploy while a git mode transition is running (F9)
		const locked = await assertNotTransitioning();
		if (locked) return locked;

		const id = parseInt(params.id);
		const gitStack = await getGitStack(id);
		if (!gitStack) {
			return json({ error: 'Git stack not found' }, { status: 404 });
		}

		// Permission check with environment context
		if (auth.authEnabled && !await auth.can('stacks', 'start', gitStack.environmentId || undefined)) {
			return json({ error: 'Permission denied' }, { status: 403 });
		}

		return createJobResponse(async (send) => {
			try {
				const result = await deployGitStack(id);

				// Audit log
				await auditGitStack(event, 'deploy', id, gitStack.stackName, gitStack.environmentId);

				send('result', result);
			} catch (error) {
				console.error('Failed to deploy git stack:', error);
				send('result', { success: false, error: 'Failed to deploy git stack' });
			}
		}, event.request);
	} catch (error) {
		console.error('Failed to deploy git stack:', error);
		return json({ error: 'Failed to deploy git stack' }, { status: 500 });
	}
};
