import type { LinkedFileAction, LinkedFilePostChange } from '$lib/stack-linked-files';

export interface LinkedFileActionRequest {
	path: string;
	postChange: LinkedFilePostChange;
}

export interface PlannedLinkedFileAction {
	target: 'stack' | 'services';
	action: Exclude<LinkedFileAction, 'none'>;
	services: string[];
	paths: string[];
}

const priority: Record<Exclude<LinkedFileAction, 'none'>, number> = {
	restart: 1,
	ordered: 2,
	recreate: 3
};

/** Coalesce changed-file policies into the smallest deterministic action set. */
export function planLinkedFileActions(
	requests: LinkedFileActionRequest[],
	composeServices: Iterable<string>,
	explicitRedeploy = false
): PlannedLinkedFileAction[] {
	const serviceSet = new Set(composeServices);
	for (const request of requests) {
		if (request.postChange.target === 'services') {
			const missing = request.postChange.services.filter((service) => !serviceSet.has(service));
			if (missing.length > 0) throw new Error(`Unknown Compose service(s): ${missing.join(', ')}`);
		}
	}
	if (explicitRedeploy) {
		return [{ target: 'stack', action: 'recreate', services: [], paths: requests.map((request) => request.path) }];
	}

	const whole = requests.filter((request) => request.postChange.target === 'stack' && request.postChange.action !== 'none');
	if (whole.length > 0) {
		const selected = whole.reduce((best, request) => priority[request.postChange.action as Exclude<LinkedFileAction, 'none'>] > priority[best]
			? request.postChange.action as Exclude<LinkedFileAction, 'none'>
			: best, 'restart' as Exclude<LinkedFileAction, 'none'>);
		return [{ target: 'stack', action: selected, services: [], paths: whole.map((request) => request.path) }];
	}

	const byAction = new Map<Exclude<LinkedFileAction, 'none'>, { services: Set<string>; paths: string[] }>();
	for (const request of requests) {
		if (request.postChange.action === 'none') continue;
		const action = request.postChange.action as Exclude<LinkedFileAction, 'none'>;
		const current = byAction.get(action) ?? { services: new Set<string>(), paths: [] };
		request.postChange.services.forEach((service) => current.services.add(service));
		current.paths.push(request.path);
		byAction.set(action, current);
	}
	const planned: PlannedLinkedFileAction[] = [...byAction.entries()]
		.sort(([left], [right]) => priority[right] - priority[left])
		.map(([action, value]) => ({ target: 'services' as const, action, services: [...value.services].sort(), paths: value.paths }));
	const recreate = planned.find((item) => item.action === 'recreate');
	if (recreate) {
		const recreated = new Set(recreate.services);
		return planned
			.map((item) => item.action === 'recreate' ? item : { ...item, services: item.services.filter((service) => !recreated.has(service)) })
			.filter((item) => item.services.length > 0);
	}
	return planned;
}
