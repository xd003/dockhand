// @ts-expect-error -- bun:test is a runtime built-in with no types installed
import { describe, test, expect } from 'bun:test';
import { buildImagePruneFilters, buildKeepLabelFilter, imageRefsToRemove, pruneAllUnused, PRUNE_KEEP_LABEL, type PruneImageSummary, holderFailureWarning } from '../src/lib/server/image-prune-core';

function decode(filters: string): Record<string, string[]> {
	return JSON.parse(decodeURIComponent(filters));
}

describe('buildImagePruneFilters', () => {
	test('dangling=true has no label filter (untagged images have no keep label)', () => {
		expect(decode(buildImagePruneFilters(true))).toEqual({ dangling: ['true'] });
	});

	test('dangling=false excludes keep-labelled images via the label! key', () => {
		// The negation MUST be the separate `label!` key, not a `!=` value prefix -
		// the API ignores the `!=` form (verified against a live daemon).
		expect(decode(buildImagePruneFilters(false))).toEqual({
			dangling: ['false'],
			'label!': ['dockhand.prune=false']
		});
	});

	test('does NOT use a plain "label" key (which would invert the meaning)', () => {
		const f = decode(buildImagePruneFilters(false));
		expect(f['label']).toBeUndefined();
		expect(f['label!']).toEqual([PRUNE_KEEP_LABEL]);
	});

	test('the produced value is URL-encoded', () => {
		expect(buildImagePruneFilters(false)).not.toContain('{');
		expect(buildImagePruneFilters(false)).toContain('%7B');
	});
});

describe('buildKeepLabelFilter', () => {
	// The image list rejects `label!` before Docker 29.4.1 ("invalid filter 'label!'").
	test('lists images with the keep label through the plain label key', () => {
		expect(decode(buildKeepLabelFilter())).toEqual({ label: [PRUNE_KEEP_LABEL] });
	});
});

describe('imageRefsToRemove', () => {
	const images = [
		{ Id: 'sha256:used', RepoTags: ['busybox:1.36'] },
		{ Id: 'sha256:kept', RepoTags: ['keep:1'] },
		{ Id: 'sha256:multi', RepoTags: ['alpine:3.20', 'multi:x'] },
		{ Id: 'sha256:one', RepoTags: ['hello-world:latest'] },
		{ Id: 'sha256:dangling', RepoTags: ['<none>:<none>'] },
		{ Id: 'sha256:untagged', RepoTags: null }
	];

	test('skips what a container uses and what carries the keep label', () => {
		const refs = imageRefsToRemove(images, new Set(['sha256:kept']), new Set(['sha256:used']));
		expect(refs).toEqual([['alpine:3.20', 'multi:x'], ['hello-world:latest'], ['sha256:dangling'], ['sha256:untagged']]);
	});

	test('an image used and labelled is kept once, and with nothing protected everything goes', () => {
		expect(imageRefsToRemove(images.slice(0, 1), new Set(['sha256:used']), new Set(['sha256:used']))).toEqual([]);
		expect(imageRefsToRemove(images.slice(0, 2), new Set(), new Set())).toEqual([['busybox:1.36'], ['keep:1']]);
	});
});

describe('pruneAllUnused', () => {
	// The engine as measured on Docker 29.2.1 (containerd): the prune's `label!` matches
	// nothing, the list rejects `label!`, the positive `label` filter works, DELETE of a
	// tag answers with what it untagged and 409s the last tag of an image a container uses.
	function engine(images: (PruneImageSummary & { label?: boolean })[], used: string[], broken: boolean) {
		const calls: string[] = [];
		const removed: string[] = [];
		const ports = {
			listImages: async (filters?: string) => {
				calls.push(`list ${filters ? Object.keys(decode(filters))[0] : 'all'}`);
				if (!filters) return images;
				const f = decode(filters);
				if (f['label!']) throw Object.assign(new Error("invalid filter 'label!'"), { statusCode: 400 });
				return images.filter((i) => i.label);
			},
			listContainers: async () => used.map((ImageID) => ({ ImageID })),
			prune: async () => {
				calls.push('prune');
				return broken ? { ImagesDeleted: null, SpaceReclaimed: 0 } : { ImagesDeleted: [{ Deleted: 'sha256:x' }], SpaceReclaimed: 42 };
			},
			remove: async (ref: string) => {
				calls.push(`delete ${ref}`);
				const img = images.find((i) => i.Id === ref || i.RepoTags?.includes(ref))!;
				const tagsLeft = (img.RepoTags ?? []).filter((t) => t !== '<none>:<none>' && !removed.includes(t));
				if (used.includes(img.Id) && tagsLeft.length <= 1) throw Object.assign(new Error('conflict: image is being used'), { statusCode: 409 });
				if (img.RepoTags?.includes(ref)) removed.push(ref);
				return tagsLeft.length > 1 ? [{ Untagged: ref }] : [{ Untagged: ref }, { Deleted: img.Id }];
			},
			log: (_message: string) => {}
		};
		return { ports, calls };
	}
	const images = [
		{ Id: 'sha256:busybox', RepoTags: ['busybox:1.36'] },
		{ Id: 'sha256:keep', RepoTags: ['keep:1'], label: true },
		{ Id: 'sha256:alpine', RepoTags: ['alpine:3.20', 'multi:x'] },
		{ Id: 'sha256:hello', RepoTags: ['hello-world:latest'] }
	];

	test('a working engine gets one ordinary prune, its result untouched', async () => {
		const { ports, calls } = engine(images, ['sha256:busybox'], false);
		expect(await pruneAllUnused(ports)).toEqual({ ImagesDeleted: [{ Deleted: 'sha256:x' }], SpaceReclaimed: 42 });
		expect(calls).toEqual(['prune']);
	});

	test('a broken engine removes the unused, unlabelled images one by one and reports no space', async () => {
		const { ports, calls } = engine(images, ['sha256:busybox'], true);
		const result = await pruneAllUnused(ports);
		expect(calls.filter((c) => c.startsWith('delete') || c === 'prune')).toEqual(['prune', 'delete alpine:3.20', 'delete multi:x', 'delete hello-world:latest']);
		expect(result).toEqual({
			ImagesDeleted: [{ Untagged: 'alpine:3.20' }, { Untagged: 'multi:x' }, { Deleted: 'sha256:alpine' }, { Untagged: 'hello-world:latest' }, { Deleted: 'sha256:hello' }]
		});
		expect('SpaceReclaimed' in result).toBe(false);
	});

	test('a refusal keeps that image and the loop carries on with the next', async () => {
		// `two` comes into use after the listing: the engine untags one tag and refuses the last.
		const { ports, calls } = engine([images[0], { Id: 'sha256:two', RepoTags: ['two:a', 'two:b'] }, images[3]], ['sha256:two'], true);
		ports.listContainers = async () => [];
		const result = await pruneAllUnused(ports);
		expect(calls.filter((c) => c.startsWith('delete'))).toEqual(['delete busybox:1.36', 'delete two:a', 'delete two:b', 'delete hello-world:latest']);
		expect(result.ImagesDeleted).toContainEqual({ Deleted: 'sha256:hello' });
		expect(result.ImagesDeleted).not.toContainEqual({ Deleted: 'sha256:two' });
	});

	test('once the engine refuses a tag, the image keeps its other tags', async () => {
		const { ports, calls } = engine([{ Id: 'sha256:two', RepoTags: ['two:a', 'two:b'] }, images[3]], [], true);
		const remove = ports.remove;
		ports.remove = async (ref) => { if (ref === 'two:a') throw new Error('conflict'); return remove(ref); };
		await pruneAllUnused(ports);
		expect(calls.filter((c) => c.startsWith('delete'))).toEqual(['delete hello-world:latest']);
	});

	test('the one-by-one path logs the counts behind it and its outcome', async () => {
		const broken = engine(images, ['sha256:busybox'], true);
		const logs: string[] = [];
		broken.ports.log = (m: string) => { logs.push(m); };
		await pruneAllUnused(broken.ports);
		expect(logs).toEqual([
			'prune removed nothing though unused images exist (4 listed, 1 with the keep label, 1 in use by containers); removing 2 unused images one by one',
			'one-by-one prune done: 2 of 2 images removed, 0 kept by the engine, space freed not known'
		]);
	});

	test('refusals are logged five at a time with their HTTP status, the rest counted', async () => {
		const many = Array.from({ length: 8 }, (_, i) => ({ Id: `sha256:i${i}`, RepoTags: [`img${i}:1`] }));
		const { ports } = engine(many, [], true);
		ports.remove = async () => { throw Object.assign(new Error('conflict: image has dependent child images'), { statusCode: 409 }); };
		const logs: string[] = [];
		ports.log = (m: string) => { logs.push(m); };
		await pruneAllUnused(ports);
		expect(logs.filter((l) => l.startsWith('Kept image'))).toHaveLength(5);
		expect(logs).toContain('Kept image "img0:1" (HTTP 409: conflict: image has dependent child images)');
		expect(logs).toContain('3 more images kept by the engine');
		expect(logs.at(-1)).toBe('one-by-one prune done: 0 of 8 images removed, 8 kept by the engine, space freed not known');
	});

	test('nothing to remove keeps the empty prune result untouched', async () => {
		const { ports, calls } = engine([images[1]], [], true);
		expect(await pruneAllUnused(ports)).toEqual({ ImagesDeleted: null, SpaceReclaimed: 0 });
		expect(calls).toEqual(['prune', 'list all', 'list label']);
	});
});

describe('holderFailureWarning', () => {
	test('an image that is not on the host (404) needs no warning', () => {
		expect(holderFailureWarning(Object.assign(new Error('No such image: grype'), { statusCode: 404 }), 'anchore/grype:v1', 3)).toBeNull();
	});

	test('any other engine failure leaves the image unprotected and says so', () => {
		expect(holderFailureWarning(Object.assign(new Error('server error'), { statusCode: 500 }), 'anchore/grype:v1', 3))
			.toBe('[Prune] env 3: could not protect anchore/grype:v1 from the prune (HTTP 500): server error');
	});

	test('a failure with no HTTP answer says so too', () => {
		expect(holderFailureWarning(new Error('connect ECONNREFUSED'), 'aquasec/trivy:0.1', undefined))
			.toBe('[Prune] env local: could not protect aquasec/trivy:0.1 from the prune (HTTP no response): connect ECONNREFUSED');
	});
});
