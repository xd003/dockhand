import { json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { getGitRepository, type GitRepository } from '$lib/server/db';
import { triggerGitRepositorySyncFromWebhook } from '$lib/server/scheduler';
import { auditGitRepository } from '$lib/server/audit';
import { handleGitWebhookRequest, type GitWebhookHandlerOptions } from '$lib/server/git-webhook-handler';
import { getGitMode } from '$lib/server/git-mode';

const options: GitWebhookHandlerOptions<GitRepository> = {
	load: (id) => getGitRepository(id),
	audit: async (event, id, repository, meta) => {
		await auditGitRepository(event, 'webhook', id, repository.name, meta);
	},
	trigger: (id) => triggerGitRepositorySyncFromWebhook(id),
	invalidIdMessage: 'Invalid repository ID',
	notFoundMessage: 'Repository not found',
	webhookDisabledMessage: 'Webhook is not enabled for this repository',
	secretNotConfiguredMessage: 'Webhook secret is not configured for this repository',
	successMessage: 'Repository sync triggered'
};

/** Repository-level webhooks are a centralized-mode concept (stack mode is per-stack). */
async function stackModeDisabled(): Promise<Response | null> {
	if (await getGitMode() !== 'centralized') {
		return json({ error: 'Webhooks are configured per stack in stack mode' }, { status: 404 });
	}
	return null;
}

/**
 * Repository-level git webhook. See git-webhook-handler.ts for the shared flow.
 */
export const POST: RequestHandler = async (event) => {
	try {
		const disabled = await stackModeDisabled();
		if (disabled) return disabled;
		return await handleGitWebhookRequest(event, options);
	} catch (error: any) {
		console.error('Webhook error:', error);
		return json({ success: false, error: error.message }, { status: 500 });
	}
};

// GET is kept for simple polling/manual triggers, but the secret is no longer
// passed in the URL (it leaked into access/proxy logs and Referer headers).
// Auth: ?ts=<unix-seconds>&sig=<hex HMAC-SHA256(secret, ts)>, valid for 5 minutes.
export const GET: RequestHandler = async (event) => {
	try {
		const disabled = await stackModeDisabled();
		if (disabled) return disabled;
		return await handleGitWebhookRequest(event, options);
	} catch (error: any) {
		console.error('Webhook GET error:', error);
		return json({ success: false, error: error.message }, { status: 500 });
	}
};
