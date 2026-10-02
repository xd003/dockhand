import yaml from 'js-yaml';

/** A service declared in a stack's compose file(s), independent of whether a container exists. */
export interface DeclaredComposeService {
	name: string;
	/** Image reference as written (uninterpolated); absent for build-only services. */
	image?: string;
	/** Compose profiles gating the service; empty when always enabled. */
	profiles: string[];
}

/**
 * Services declared across an ordered compose file set. Later files merge into earlier ones
 * the way Compose does for the fields read here: service order follows first declaration,
 * and image/profiles from a later file override. Unparseable files throw, so a broken
 * compose surfaces instead of looking like a stack without services.
 */
export function listDeclaredComposeServices(contents: string[]): DeclaredComposeService[] {
	const services = new Map<string, DeclaredComposeService>();
	for (const content of contents) {
		const doc = yaml.load(content) as { services?: unknown } | null | undefined;
		const declared = doc && typeof doc === 'object' ? doc.services : undefined;
		if (!declared || typeof declared !== 'object' || Array.isArray(declared)) continue;
		for (const [name, raw] of Object.entries(declared as Record<string, unknown>)) {
			const definition = raw && typeof raw === 'object' ? raw as { image?: unknown; profiles?: unknown } : {};
			const service = services.get(name) ?? { name, profiles: [] };
			if (typeof definition.image === 'string') service.image = definition.image;
			if (Array.isArray(definition.profiles)) {
				service.profiles = definition.profiles.filter((profile): profile is string => typeof profile === 'string');
			}
			services.set(name, service);
		}
	}
	return [...services.values()];
}
