import { json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { authorize } from '$lib/server/authorize';
import { dockerJsonRequest, inspectContainer, inspectImage, listContainers } from '$lib/server/docker';
import { getSecretKeysToMask } from '$lib/server/db';
import type { DockerInspect } from '$lib/utils/inspect-to-compose';
import { stackInspectsToCompose, type StackContainer, type StackResource } from '$lib/utils/stack-inspect-to-compose';

/**
 * GET /api/stacks/[name]/generated-compose
 *
 * @openapi
 * summary: Rebuild a Compose project's compose file from its containers, for taking over an untracked stack whose files are gone
 * description: One service per com.docker.compose.service label, from the lowest-numbered container (replicas become deploy.replicas). Networks and volumes this project created map back to their Compose keys (the default network stays implicit); others are declared external. Generated container names, compose bookkeeping labels and image defaults are dropped. Env keys stored as Dockhand secrets for the stack are emitted as KEY=${KEY}.
 * path: name:string! Compose project name (from GET /api/stacks)
 * query: env:integer Environment ID the project runs on (from GET /api/environments)
 * resp-200: {compose:string!}
 * resp-403: Permission denied (requires stacks:create and containers:view) or environment access denied
 * resp-404: The project has no containers
 * resp-500: Docker could not be queried
 */
export const GET: RequestHandler = async ({ params, url, cookies }) => {
	const rawEnvId = url.searchParams.get('env');
	const envId = rawEnvId ? Number(rawEnvId) : null;
	const auth = await authorize(cookies);
	if (auth.authEnabled && (!(await auth.can('stacks', 'create', envId ?? undefined)) || !(await auth.can('containers', 'view', envId ?? undefined)))) {
		return json({ error: 'Permission denied' }, { status: 403 });
	}
	const denied = await auth.requireEnvAccess(envId);
	if (denied) return denied;

	try {
		const project = params.name;
		const ids = (await listContainers(true, envId)).filter((container) => container.labels['com.docker.compose.project'] === project).map((container) => container.id);
		if (ids.length === 0) return json({ error: `Compose project "${project}" has no containers` }, { status: 404 });
		const inspects = await Promise.all(ids.map((id) => inspectContainer(id, envId) as Promise<DockerInspect>));
		// Image defaults are subtracted when the image is still present; otherwise every value is kept.
		type ImageConfig = { Env?: string[] | null; Entrypoint?: string[] | null; Cmd?: string[] | null; Labels?: Record<string, string> | null; ExposedPorts?: Record<string, unknown> | null };
		const images = new Map(await Promise.all([...new Set(inspects.map((inspect) => inspect.Config?.Image).filter((image): image is string => !!image))]
			.map(async (image) => [image, await (inspectImage(image, envId) as Promise<{ Config?: ImageConfig }>).catch(() => null)] as const)));
		const containers: StackContainer[] = inspects.map((inspect) => {
			const config = images.get(inspect.Config?.Image ?? '')?.Config;
			return {
				inspect,
				image: config ? { env: config.Env, entrypoint: config.Entrypoint, cmd: config.Cmd, labels: config.Labels, exposedPorts: config.ExposedPorts } : null
			};
		});
		// Without the listings every network and volume is declared external, which still reuses them.
		const [networks, volumes, secretKeys] = await Promise.all([
			dockerJsonRequest<StackResource[]>('/networks', {}, envId).catch(() => []),
			dockerJsonRequest<{ Volumes?: StackResource[] | null }>('/volumes', {}, envId).then((result) => result.Volumes ?? []).catch(() => []),
			getSecretKeysToMask(project, envId)
		]);
		return json({ compose: stackInspectsToCompose(project, containers, { networks, volumes, secretKeys }) });
	} catch (error) {
		return json({ error: error instanceof Error ? error.message : 'Failed to generate compose' }, { status: 500 });
	}
};
