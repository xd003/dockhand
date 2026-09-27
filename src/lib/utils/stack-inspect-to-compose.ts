/**
 * Rebuild a Compose project's compose file from its containers' inspect payloads, so an
 * untracked stack whose files are gone can be taken over with a near-identical config.
 *
 * Per service it reuses inspectToComposeService, then undoes what Compose itself added:
 * the project-prefixed container names, network and volume names, the default network,
 * the container-name network alias, and container-id `network_mode` references. Networks
 * and volumes Compose created for this project (by their `com.docker.compose.*` labels)
 * map back to their Compose keys so the takeover keeps using the same resources; anything
 * else stays `external: true` under its real name.
 *
 * Pure and dependency-light (js-yaml only) so it is unit-testable without a daemon.
 */
import yaml from 'js-yaml';
import { inspectToComposeService, type DockerInspect } from './inspect-to-compose';

export interface StackContainer {
	inspect: DockerInspect;
	/** The image's own config, when the image could be inspected (subtracts image defaults). */
	image?: {
		env?: string[] | null;
		entrypoint?: string[] | null;
		cmd?: string[] | null;
		labels?: Record<string, string> | null;
		exposedPorts?: Record<string, unknown> | null;
	} | null;
}

/** A Docker network or volume as listed by the daemon (`GET /networks`, `GET /volumes`). */
export interface StackResource {
	Name: string;
	Driver?: string;
	Labels?: Record<string, string> | null;
	Internal?: boolean;
	EnableIPv6?: boolean;
}

export interface StackInspectToComposeOptions {
	networks?: StackResource[];
	volumes?: StackResource[];
	/** Env keys stored as Dockhand secrets; rendered as `KEY=${KEY}` instead of their masked value. */
	secretKeys?: Set<string>;
}

const PROJECT = 'com.docker.compose.project';
const SERVICE = 'com.docker.compose.service';

/** Compose key of a project-owned network/volume, or null when it is not this project's. */
function composeKey(resource: StackResource | undefined, project: string, label: string): string | null {
	if (!resource?.Labels || resource.Labels[PROJECT] !== project) return null;
	return resource.Labels[label] || null;
}

/** `db:service_healthy:true,cache:service_started:false` -> compose `depends_on`. */
function dependsOn(label: string | undefined, services: Set<string>): unknown {
	const entries = (label ?? '').split(',').map((entry) => entry.trim()).filter(Boolean).map((entry) => {
		const [service, condition = 'service_started', restart = 'false'] = entry.split(':');
		return { service, condition, restart: restart === 'true' };
	}).filter((entry) => services.has(entry.service));
	if (entries.length === 0) return undefined;
	if (entries.every((entry) => entry.condition === 'service_started' && !entry.restart)) return entries.map((entry) => entry.service);
	return Object.fromEntries(entries.map((entry) => [entry.service, entry.restart
		? { condition: entry.condition, restart: true }
		: { condition: entry.condition }]));
}

export function stackInspectsToCompose(project: string, containers: StackContainer[], options: StackInspectToComposeOptions = {}): string {
	const networksByName = new Map((options.networks ?? []).map((network) => [network.Name, network]));
	const volumesByName = new Map((options.volumes ?? []).map((volume) => [volume.Name, volume]));
	const members = containers.filter(({ inspect }) => {
		const labels = inspect.Config?.Labels ?? {};
		return labels[PROJECT] === project && labels[SERVICE] && labels['com.docker.compose.oneoff'] !== 'True';
	});
	if (members.length === 0) throw new Error(`Compose project "${project}" has no service containers`);

	// One representative per service: the lowest container number; replicas only count.
	const byService = new Map<string, StackContainer[]>();
	for (const member of members) {
		const service = member.inspect.Config!.Labels![SERVICE];
		byService.set(service, [...(byService.get(service) ?? []), member]);
	}
	const serviceNames = new Set(byService.keys());
	const serviceByContainerId = new Map<string, string>();
	for (const member of members) {
		if (member.inspect.Id) serviceByContainerId.set(member.inspect.Id, member.inspect.Config!.Labels![SERVICE]);
	}

	const services: Record<string, Record<string, unknown>> = {};
	const topNetworks: Record<string, Record<string, unknown>> = {};
	const topVolumes: Record<string, Record<string, unknown>> = {};

	for (const [serviceName, replicas] of [...byService].sort(([a], [b]) => a.localeCompare(b))) {
		const number = (member: StackContainer) => Number(member.inspect.Config?.Labels?.['com.docker.compose.container-number']) || Number.MAX_SAFE_INTEGER;
		const { inspect, image } = [...replicas].sort((a, b) => number(a) - number(b))[0];
		const name = (inspect.Name ?? '').replace(/^\//, '');
		const { service, namedVolumes } = inspectToComposeService(inspect, {
			serviceName,
			imageEnv: image?.env,
			imageEntrypoint: image?.entrypoint,
			imageCmd: image?.cmd,
			imageLabels: image?.labels,
			imageExposedPorts: image?.exposedPorts
		});

		// Compose names containers `<project>-<service>-<n>` (`_` in v1); only a custom name is user intent.
		const numbered = name.match(/[-_]\d+$/);
		const generatedName = !!numbered && [`${project}-${serviceName}`, `${project}_${serviceName}`].includes(name.slice(0, -numbered[0].length));
		if (replicas.length > 1 || generatedName) delete service.container_name;
		else service.container_name = name;
		if (replicas.length > 1) service.deploy = { replicas: replicas.length };
		// inspectToComposeService skips a hostname equal to the service key; Compose never sets the container name as one either.
		if (service.hostname === name) delete service.hostname;

		if (options.secretKeys?.size && Array.isArray(service.environment)) {
			service.environment = (service.environment as string[]).map((entry) => {
				const key = entry.slice(0, entry.indexOf('=') < 0 ? entry.length : entry.indexOf('='));
				return options.secretKeys!.has(key) ? `${key}=\${${key}}` : entry;
			});
		}

		const deps = dependsOn(inspect.Config?.Labels?.['com.docker.compose.depends_on'], serviceNames);
		if (deps) service.depends_on = deps;

		// Networks: project networks back to their Compose keys. The project default stays implicit
		// unless the service is also on other networks (Compose then only attaches listed ones).
		const rawNetworks = service.networks as string[] | Record<string, Record<string, unknown> | null> | undefined;
		if (rawNetworks) {
			const entries: Array<[string, Record<string, unknown> | null]> = Array.isArray(rawNetworks)
				? rawNetworks.map((network) => [network, null])
				: Object.entries(rawNetworks);
			const mapped: Array<[string, Record<string, unknown> | null]> = [];
			let onDefault = false;
			let defaultConfig: Record<string, unknown> | null = null;
			for (const [networkName, config] of entries) {
				const resource = networksByName.get(networkName);
				const key = composeKey(resource, project, 'com.docker.compose.network');
				// Compose aliases each container by its own name and the daemon assigns endpoint MACs;
				// neither is user intent worth pinning in the rebuilt file.
				let cleaned = config;
				if (cleaned) {
					const aliases = Array.isArray(cleaned.aliases) ? (cleaned.aliases as string[]).filter((alias) => alias !== name) : [];
					cleaned = { ...cleaned };
					delete cleaned.mac_address;
					if (aliases.length > 0) cleaned.aliases = aliases;
					else delete cleaned.aliases;
					if (Object.keys(cleaned).length === 0) cleaned = null;
				}
				if (key === 'default') {
					onDefault = true;
					defaultConfig = cleaned;
				} else if (key) {
					const declared: Record<string, unknown> = {};
					if (resource?.Driver && resource.Driver !== 'bridge') declared.driver = resource.Driver;
					if (resource?.Internal) declared.internal = true;
					if (resource?.EnableIPv6) declared.enable_ipv6 = true;
					topNetworks[key] = declared;
					mapped.push([key, cleaned]);
				} else {
					topNetworks[networkName] = { external: true };
					mapped.push([networkName, cleaned]);
				}
			}
			if (onDefault && (mapped.length > 0 || defaultConfig)) mapped.unshift(['default', defaultConfig]);
			if (mapped.length === 0) delete service.networks;
			else if (mapped.every(([, config]) => config === null)) service.networks = mapped.map(([key]) => key);
			else service.networks = Object.fromEntries(mapped);
		}
		const mode = service.network_mode as string | undefined;
		if (mode?.startsWith('container:')) {
			const target = serviceByContainerId.get(mode.slice('container:'.length));
			if (target) service.network_mode = `service:${target}`;
		}

		// Volumes: project volumes back to their Compose keys; others stay external.
		if (Array.isArray(service.volumes)) {
			service.volumes = (service.volumes as string[]).map((spec) => {
				const volumeName = namedVolumes.find((volume) => spec.startsWith(`${volume}:`));
				if (!volumeName) return spec;
				const resource = volumesByName.get(volumeName);
				const key = composeKey(resource, project, 'com.docker.compose.volume');
				if (!key) {
					topVolumes[volumeName] = { external: true };
					return spec;
				}
				topVolumes[key] = resource?.Driver && resource.Driver !== 'local' ? { driver: resource.Driver } : {};
				return `${key}${spec.slice(volumeName.length)}`;
			});
		}

		services[serviceName] = service;
	}

	const doc: Record<string, unknown> = { services };
	if (Object.keys(topNetworks).length > 0) doc.networks = topNetworks;
	if (Object.keys(topVolumes).length > 0) doc.volumes = topVolumes;
	// `{}` declarations dump as `key: {}`; Compose treats them as default-config resources.
	return yaml.dump(doc, { lineWidth: -1, noRefs: true, sortKeys: false });
}
