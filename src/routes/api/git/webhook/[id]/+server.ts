import { json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { getGitRepository } from '$lib/server/db';
import { triggerGitRepositorySyncFromWebhook } from '$lib/server/scheduler';
import { auditGitRepository } from '$lib/server/audit';
import { verifyWebhookSignature, secureSecretEqual } from '$lib/server/webhook-signature';

function detectSource(request: Request): string {
	if (request.headers.get('x-hub-signature-256')) return 'github';
	if (request.headers.get('x-gitlab-token')) return 'gitlab';
	return 'unknown';
}

export const POST: RequestHandler = async (event) => {
	const { params, request } = event;
	try {
		const id = parseInt(params.id);
		if (isNaN(id)) {
			return json({ error: 'Invalid repository ID' }, { status: 400 });
		}

		const repository = await getGitRepository(id);
		if (!repository) {
			return json({ error: 'Repository not found' }, { status: 404 });
		}

		if (!repository.webhookEnabled) {
			return json({ error: 'Webhook is not enabled for this repository' }, { status: 403 });
		}

		const source = detectSource(request);

		// A secret is mandatory: reject if none is configured.
		if (!repository.webhookSecret) {
			await auditGitRepository(event, 'webhook', id, repository.name, {
				method: 'POST', source, error: 'no_secret_configured'
			});
			return json({ error: 'Webhook secret is not configured for this repository' }, { status: 401 });
		}

		const payload = await request.text();
		const githubSignature = request.headers.get('x-hub-signature-256');
		const gitlabToken = request.headers.get('x-gitlab-token');

		const signature = githubSignature || gitlabToken;

		if (!verifyWebhookSignature(payload, signature, repository.webhookSecret)) {
			await auditGitRepository(event, 'webhook', id, repository.name, {
				method: 'POST', source, error: 'invalid_signature'
			});
			return json({ error: 'Invalid webhook signature' }, { status: 401 });
		}

		// Trigger the fan-out in the background and return 202 immediately. The run is
		// tracked as a schedule_executions job (runGitRepositorySync) so the UI has a
		// record; awaiting the full multi-stack fan-out here would let GitHub/GitLab
		// retry the webhook on any slow deploy (stack webhooks already return 202).
		const result = await triggerGitRepositorySyncFromWebhook(id);
		await auditGitRepository(event, 'webhook', id, repository.name, {
			method: 'POST', source, result: result.success ? 'triggered' : 'failed'
		});
		if (!result.success) {
			return json({ success: false, error: result.error }, { status: 500 });
		}
		return json({ success: true, message: 'Repository sync triggered' }, { status: 202 });
	} catch (error: any) {
		console.error('Webhook error:', error);
		return json({ success: false, error: error.message }, { status: 500 });
	}
};

// Also support GET for simple polling/manual triggers
export const GET: RequestHandler = async (event) => {
	const { params, url } = event;
	try {
		const id = parseInt(params.id);
		if (isNaN(id)) {
			return json({ error: 'Invalid repository ID' }, { status: 400 });
		}

		const repository = await getGitRepository(id);
		if (!repository) {
			return json({ error: 'Repository not found' }, { status: 404 });
		}

		if (!repository.webhookEnabled) {
			return json({ error: 'Webhook is not enabled for this repository' }, { status: 403 });
		}

		// A secret is mandatory (see POST handler). Reject if none is configured.
		if (!repository.webhookSecret) {
			await auditGitRepository(event, 'webhook', id, repository.name, {
				method: 'GET', source: 'get', error: 'no_secret_configured'
			});
			return json({ error: 'Webhook secret is not configured for this repository' }, { status: 401 });
		}

		// Verify secret via query parameter for GET requests (constant-time)
		const secret = url.searchParams.get('secret');
		if (!secureSecretEqual(secret, repository.webhookSecret)) {
			await auditGitRepository(event, 'webhook', id, repository.name, {
				method: 'GET', source: 'get', error: 'invalid_secret'
			});
			return json({ error: 'Invalid webhook secret' }, { status: 401 });
		}

		// Trigger the fan-out in the background and return 202 immediately (see POST).
		const result = await triggerGitRepositorySyncFromWebhook(id);
		await auditGitRepository(event, 'webhook', id, repository.name, {
			method: 'GET', source: 'get', result: result.success ? 'triggered' : 'failed'
		});
		if (!result.success) {
			return json({ success: false, error: result.error }, { status: 500 });
		}
		return json({ success: true, message: 'Repository sync triggered' }, { status: 202 });
	} catch (error: any) {
		console.error('Webhook GET error:', error);
		return json({ success: false, error: error.message }, { status: 500 });
	}
};
