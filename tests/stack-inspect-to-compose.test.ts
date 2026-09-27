/**
 * stackInspectsToCompose rebuilds an untracked project's compose file from its containers
 * so a takeover deploy reuses the same networks, volumes and service graph. Assertions run
 * on the re-parsed YAML so they are independent of formatting.
 */
import { describe, test, expect } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import yaml from 'js-yaml';
import type { DockerInspect } from '../src/lib/utils/inspect-to-compose';
import { stackInspectsToCompose, type StackResource } from '../src/lib/utils/stack-inspect-to-compose';

const gitea = (JSON.parse(readFileSync(join(import.meta.dir, 'fixtures', 'inspect', 'gitea.json'), 'utf8')) as DockerInspect[])[0];

function container(project: string, service: string, overrides: {
	id?: string; name?: string; number?: number; env?: string[]; dependsOn?: string; oneoff?: boolean;
	networks?: Record<string, { Aliases?: string[] } | null>; networkMode?: string; mounts?: DockerInspect['Mounts'];
} = {}): DockerInspect {
	const number = overrides.number ?? 1;
	const name = overrides.name ?? `${project}-${service}-${number}`;
	return {
		Id: overrides.id ?? `${service}${number}`.padEnd(64, '0'),
		Name: `/${name}`,
		Config: {
			Image: `${service}:latest`,
			Env: overrides.env ?? [],
			Labels: {
				'com.docker.compose.project': project,
				'com.docker.compose.service': service,
				'com.docker.compose.container-number': String(number),
				'com.docker.compose.depends_on': overrides.dependsOn ?? '',
				'com.docker.compose.oneoff': overrides.oneoff ? 'True' : 'False'
			}
		},
		HostConfig: { NetworkMode: overrides.networkMode ?? `${project}_default` },
		NetworkSettings: { Networks: overrides.networks ?? { [`${project}_default`]: { Aliases: [name, service] } } },
		Mounts: overrides.mounts ?? []
	};
}

const projectNetwork = (project: string, key: string, extra: Partial<StackResource> = {}): StackResource => ({
	Name: `${project}_${key}`,
	Driver: 'bridge',
	Labels: { 'com.docker.compose.project': project, 'com.docker.compose.network': key },
	...extra
});

const projectVolume = (project: string, key: string): StackResource => ({
	Name: `${project}_${key}`,
	Driver: 'local',
	Labels: { 'com.docker.compose.project': project, 'com.docker.compose.volume': key }
});

type GeneratedService = {
	image?: string; container_name?: string; labels?: Record<string, string>; networks?: unknown; network_mode?: string;
	volumes?: unknown; deploy?: unknown; depends_on?: unknown; environment?: unknown;
};
type GeneratedCompose = { services: Record<string, GeneratedService>; networks?: unknown; volumes?: unknown };

function generate(...args: Parameters<typeof stackInspectsToCompose>): GeneratedCompose {
	return yaml.load(stackInspectsToCompose(...args)) as GeneratedCompose;
}

describe('stackInspectsToCompose', () => {
	test('a real compose-managed container becomes its Compose service on the implicit default network', () => {
		const doc = generate('semver-demo-stack', [{ inspect: gitea }], { networks: [projectNetwork('semver-demo-stack', 'default')] });
		expect(Object.keys(doc.services)).toEqual(['gitea']);
		const service = doc.services.gitea;
		expect(service.image).toBe('gitea/gitea:1.21.0');
		expect(service.container_name).toBeUndefined();
		expect(service.networks).toBeUndefined();
		expect(doc.networks).toBeUndefined();
		expect(Object.keys(service.labels ?? {}).some((key) => key.startsWith('com.docker.compose.'))).toBe(false);
		// The anonymous volume stays anonymous instead of pinning the generated id.
		expect(service.volumes).toEqual(['/data']);
	});

	test('project networks and volumes map back to their Compose keys; foreign ones stay external', () => {
		const project = 'teldrive';
		const app = container(project, 'app', {
			networks: {
				teldrive_default: { Aliases: ['teldrive-app-1', 'app'] },
				teldrive_backend: { Aliases: ['teldrive-app-1', 'app', 'api'] },
				proxy: { Aliases: ['teldrive-app-1', 'app'] }
			},
			mounts: [
				{ Type: 'volume', Name: 'teldrive_data', Destination: '/data', RW: true },
				{ Type: 'volume', Name: 'shared-cache', Destination: '/cache', RW: false },
				{ Type: 'bind', Source: '/opt/docker/stacks/teldrive/config', Destination: '/config', RW: true }
			]
		});
		const doc = generate(project, [{ inspect: app }], {
			networks: [projectNetwork(project, 'default'), projectNetwork(project, 'backend', { Internal: true }), { Name: 'proxy', Driver: 'bridge', Labels: {} }],
			volumes: [projectVolume(project, 'data'), { Name: 'shared-cache', Driver: 'local', Labels: null }]
		});
		const service = doc.services.app;
		// On other networks too, so `default` must be listed to keep the project network.
		expect(service.networks).toEqual({ default: null, backend: { aliases: ['api'] }, proxy: null });
		expect(doc.networks).toEqual({ backend: { internal: true }, proxy: { external: true } });
		expect(service.volumes).toEqual(['data:/data', 'shared-cache:/cache:ro', '/opt/docker/stacks/teldrive/config:/config']);
		expect(doc.volumes).toEqual({ data: {}, 'shared-cache': { external: true } });
	});

	test('without network/volume listings every resource is reused as external under its real name', () => {
		const project = 'teldrive';
		const app = container(project, 'app', { mounts: [{ Type: 'volume', Name: 'teldrive_data', Destination: '/data', RW: true }] });
		const doc = generate(project, [{ inspect: app }]);
		expect(doc.services.app.networks).toEqual(['teldrive_default']);
		expect(doc.networks).toEqual({ teldrive_default: { external: true } });
		expect(doc.volumes).toEqual({ teldrive_data: { external: true } });
	});

	test('keeps custom container names, scales replicas, and rebuilds the service graph', () => {
		const project = 'shop';
		const db = container(project, 'db', { name: 'shop-postgres', id: 'd'.repeat(64) });
		const web1 = container(project, 'web', { number: 1, dependsOn: 'db:service_healthy:true,ghost:service_started:false' });
		const web2 = container(project, 'web', { number: 2, dependsOn: 'db:service_healthy:true' });
		const sidecar = container(project, 'sidecar', { networks: {}, networkMode: `container:${'d'.repeat(64)}`, dependsOn: 'db:service_started:false' });
		const runOnce = container(project, 'migrate', { oneoff: true });
		const doc = generate(project, [{ inspect: web2 }, { inspect: db }, { inspect: web1 }, { inspect: sidecar }, { inspect: runOnce }], {
			networks: [projectNetwork(project, 'default')]
		});
		expect(Object.keys(doc.services)).toEqual(['db', 'sidecar', 'web']);
		expect(doc.services.db.container_name).toBe('shop-postgres');
		expect(doc.services.web.container_name).toBeUndefined();
		expect(doc.services.web.deploy).toEqual({ replicas: 2 });
		// Dependencies on services outside the project are dropped.
		expect(doc.services.web.depends_on).toEqual({ db: { condition: 'service_healthy', restart: true } });
		expect(doc.services.sidecar.depends_on).toEqual(['db']);
		expect(doc.services.sidecar.network_mode).toBe('service:db');
	});

	test('Dockhand secrets become interpolation references instead of literal or masked values', () => {
		const app = container('vault', 'app', { env: ['DB_PASSWORD=hunter2', 'PRICE=$5'] });
		const doc = generate('vault', [{ inspect: app }], { secretKeys: new Set(['DB_PASSWORD']) });
		expect(doc.services.app.environment).toEqual(['DB_PASSWORD=${DB_PASSWORD}', 'PRICE=$$5']);
	});

	test('rejects a project without service containers', () => {
		expect(() => stackInspectsToCompose('ghost', [{ inspect: container('other', 'app') }])).toThrow('has no service containers');
	});
});
