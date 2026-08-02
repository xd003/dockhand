import { json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { getGitStack, type GitStackWithRepo } from '$lib/server/db';
import { triggerGitStackSyncFromWebhook } from '$lib/server/scheduler';
import { auditGitStack } from '$lib/server/audit';
import { handleGitWebhookRequest, type GitWebhookHandlerOptions } from '$lib/server/git-webhook-handler';

const options: GitWebhookHandlerOptions<GitStackWithRepo> = {
	load: (id) => getGitStack(id),
	preconditions: (stack) => {
		if (!stack.forceRedeploy) {
			return { error: 'Force redeployment is not enabled for this stack', status: 403 };
		}
		return null;
	},
	audit: async (event, id, stack, meta) => {
		await auditGitStack(event, 'webhook', id, stack.stackName, stack.environmentId, meta);
	},
	trigger: (id) => triggerGitStackSyncFromWebhook(id),
	invalidIdMessage: 'Invalid stack ID',
	notFoundMessage: 'Stack not found',
	webhookDisabledMessage: 'Webhook is not enabled for this stack',
	secretNotConfiguredMessage: 'Webhook secret is not configured for this stack',
	successMessage: 'Stack sync triggered',
	deprecated: true
};

/**
 * Stack-level git webhook. See git-webhook-handler.ts for the shared flow.
 * Deprecated compat shim: webhooks moved to the repository
 * (/api/git/webhook/[id]). Kept so existing external systems keep
 * working without re-pointing; each stack still verifies its own secret.
 */
export const POST: RequestHandler = async (event) => {
	try {
		return await handleGitWebhookRequest(event, options);
	} catch (error: any) {
		console.error('Stack webhook error:', error);
		return json({ success: false, error: error.message }, { status: 500 });
	}
};

// Also support GET for simple polling/manual triggers
export const GET: RequestHandler = async (event) => {
	try {
		return await handleGitWebhookRequest(event, options);
	} catch (error: any) {
		console.error('Stack webhook GET error:', error);
		return json({ success: false, error: error.message }, { status: 500 });
	}
};
