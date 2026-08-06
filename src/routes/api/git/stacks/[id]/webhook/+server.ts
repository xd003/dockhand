import { json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { getGitStack, type GitStackWithRepo } from '$lib/server/db';
import { triggerGitStackSyncFromWebhook } from '$lib/server/scheduler';
import { deployGitStack } from '$lib/server/git';
import { getGitMode } from '$lib/server/git-mode';
import { auditGitStack } from '$lib/server/audit';
import { handleGitWebhookRequest, type GitWebhookHandlerOptions } from '$lib/server/git-webhook-handler';
import { gitTransitionActive } from '$lib/server/scheduler';
import { Semaphore } from '$lib/server/semaphore';

// Stack-mode synchronous deploys re-clone the repo per sync, so they hold the
// request worker for the full clone+deploy. Cap concurrent in-flight deploys
// so a burst of webhook calls cannot pile up unbounded workers (F7). The
// network hang risk is bounded at the git layer: the stack engine passes a
// 10-minute timeout to every `git clone` it runs (see execGit in git.ts —
// the subprocess is SIGKILLed on timeout, so the slot is genuinely released).
// A full deploy-level Promise.race is deliberately NOT used: it would return a
// false "timed out" to the provider (triggering a duplicate retry) while the
// deploy keeps running, defeating the point of the concurrency cap.
const MAX_STACK_WEBHOOKS = 5;
const stackWebhookSlots = new Semaphore(MAX_STACK_WEBHOOKS);
async function stackDeployTrigger(id: number): Promise<{ success: boolean; error?: string; output?: string; skipped?: boolean }> {
	if (await gitTransitionActive()) {
		return { success: false, error: 'Git repository mode transition in progress' };
	}
	const run = stackWebhookSlots.tryRun(() => deployGitStack(id, { force: false }));
	if (!run) {
		return { success: false, error: 'Too many concurrent webhook deploys, try again shortly' };
	}
	return run;
}

/**
 * Stack-level git webhook.
 * - Stack mode: the primary webhook — synchronous deploy (per-stack contract),
 *   no force-redeploy precondition.
 * - Centralized mode: deprecated compat shim (webhooks moved to the
 *   repository); only stacks with force redeployment enabled can have their
 *   own webhook, triggered in the background.
 */
async function buildOptions(): Promise<GitWebhookHandlerOptions<GitStackWithRepo>> {
	if (await getGitMode() !== 'centralized') {
		return {
			load: (id) => getGitStack(id),
			audit: async (event, id, stack, meta) => {
				await auditGitStack(event, 'webhook', id, stack.stackName, stack.environmentId, meta);
			},
			trigger: (id) => stackDeployTrigger(id),
			invalidIdMessage: 'Invalid stack ID',
			notFoundMessage: 'Stack not found',
			webhookDisabledMessage: 'Webhook is not enabled for this stack',
			secretNotConfiguredMessage: 'Webhook secret is not configured for this stack',
			successMessage: 'Stack sync triggered',
			synchronous: true
		};
	}

	return {
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
}

/**
 * Stack-level git webhook. See git-webhook-handler.ts for the shared flow.
 */
export const POST: RequestHandler = async (event) => {
	try {
		return await handleGitWebhookRequest(event, await buildOptions());
	} catch (error: any) {
		console.error('Stack webhook error:', error);
		return json({ success: false, error: error.message }, { status: 500 });
	}
};

// Also support GET for simple polling/manual triggers
export const GET: RequestHandler = async (event) => {
	try {
		return await handleGitWebhookRequest(event, await buildOptions());
	} catch (error: any) {
		console.error('Stack webhook GET error:', error);
		return json({ success: false, error: error.message }, { status: 500 });
	}
};
