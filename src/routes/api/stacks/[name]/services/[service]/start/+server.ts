import { json } from '@sveltejs/kit';
import { startStackService } from '$lib/server/stacks';
import { authorize } from '$lib/server/authorize';
import { auditStack } from '$lib/server/audit';
import { createJobResponse } from '$lib/server/sse';
import type { RequestHandler } from './$types';

/**
 * @openapi
 * summary: Start one service of a stack (docker compose up -d <service>), asynchronously
 * description: Creates and starts the service's container (plus its depends_on services) even when the stack was never deployed. A never-deployed Git stack is synced and deployed for just this service.
 * path: name:string! Stack name (from GET /api/stacks)
 * path: service:string! Service name (from GET /api/stacks/{name}/services)
 * query: env:integer Environment id (from GET /api/environments)
 * resp-200: {jobId:string!}
 * resp-200-desc: Fire-and-forget job id — poll GET /api/jobs/{jobId} for the result. Send "Accept: application/json" (without text/event-stream) to instead block and receive the final {success,output|error} synchronously.
 * resp-403: Permission denied (needs stacks:start), or access denied to this environment
 */
export const POST: RequestHandler = async (event) => {
	const { params, url, cookies } = event;
	const auth = await authorize(cookies);
	const envId = url.searchParams.get('env');
	const envIdNum = envId ? parseInt(envId) : undefined;

	if (auth.authEnabled && !(await auth.can('stacks', 'start', envIdNum))) {
		return json({ error: 'Permission denied' }, { status: 403 });
	}
	const envAccessDenied = await auth.requireEnvAccess(envIdNum ?? null);
	if (envAccessDenied) return envAccessDenied;

	const stackName = params.name;
	const serviceName = params.service;

	return createJobResponse(async (send) => {
		try {
			const result = await startStackService(stackName, serviceName, envIdNum, {
				userId: auth.user?.id,
				onLine: (line) => send('progress', { type: 'line', line })
			});
			await auditStack(event, 'start', stackName, envIdNum, { service: serviceName });
			if (!result.success) {
				send('result', { success: false, error: result.error, output: result.output });
				return;
			}
			send('result', { success: true, output: result.output });
		} catch (error) {
			console.error(`Error starting service ${serviceName} of stack ${stackName}:`, error);
			send('result', { success: false, error: 'Failed to start service' });
		}
	}, event.request);
};
