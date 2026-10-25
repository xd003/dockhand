// Pure helpers for image pruning. Kept dependency-free (no db / better-sqlite3)
// so they can be unit-tested directly, mirroring volume-prune-core.ts.

/**
 * Image label that opts an image out of an "all unused" prune. Tag an image
 * with `dockhand.prune=false` (e.g. `docker build --label dockhand.prune=false`)
 * and Docker's own prune skips it - no holder container needed.
 */
export const PRUNE_KEEP_LABEL = 'dockhand.prune=false';

/**
 * Build the `filters=` query value for a Docker `/images/prune` call.
 *
 * @param dangling true = only untagged images (keep-label does not apply, since
 *   dangling images have no labels of interest); false = all unused, and images
 *   carrying PRUNE_KEEP_LABEL are excluded.
 *
 * IMPORTANT: over the Docker ENGINE API the label negation is a SEPARATE filter
 * key `label!` (`{"label!":["dockhand.prune=false"]}`). The `label!=value` form
 * is the docker CLI surface and is a no-op over the API - verified against a
 * live daemon (both Docker 27 and 20.10 / API 1.41). A plain `label` key would
 * invert the meaning (prune ONLY matching images).
 */
export function buildImagePruneFilters(dangling: boolean): string {
	const filters: Record<string, string[]> = dangling
		? { dangling: ['true'] }
		: { dangling: ['false'], 'label!': [PRUNE_KEEP_LABEL] };
	return encodeURIComponent(JSON.stringify(filters));
}

/** `filters=` for listing the images that carry the keep label. */
export function buildKeepLabelFilter(): string {
	return encodeURIComponent(JSON.stringify({ label: [PRUNE_KEEP_LABEL] }));
}

export interface PruneImageSummary {
	Id: string;
	RepoTags?: string[] | null;
}

/**
 * What a prune of all unused images removes, as the references to delete one image
 * at a time: every image no container uses (stopped ones included) and none with the
 * keep label. A tagged image goes tag by tag - deleting by id refuses an image with
 * several tags - and the last tag removes it; an untagged one goes by id.
 */
export function imageRefsToRemove(
	images: PruneImageSummary[],
	keptIds: Set<string>,
	usedIds: Set<string>
): string[][] {
	return images
		.filter((img) => !keptIds.has(img.Id) && !usedIds.has(img.Id))
		.map((img) => {
			const tags = (img.RepoTags ?? []).filter((t) => t !== '<none>:<none>');
			return tags.length ? tags : [img.Id];
		});
}

export interface ImageDeleteEntry {
	Untagged?: string;
	Deleted?: string;
}

/** A prune result. `SpaceReclaimed` is left out when it is not known. */
export interface ImagePruneResult {
	ImagesDeleted: ImageDeleteEntry[] | null;
	SpaceReclaimed?: number;
}

export interface ImagePrunePorts {
	listImages(filters?: string): Promise<PruneImageSummary[]>;
	listContainers(): Promise<{ ImageID: string }[]>;
	prune(): Promise<ImagePruneResult>;
	remove(ref: string): Promise<ImageDeleteEntry[]>;
	log(message: string): void;
}

/**
 * Prune all unused images except those with the keep label. Docker 29.0 - 29.4.0 with
 * the containerd image store matches no image for the prune's `label!` filter
 * (moby#52338, fixed in 29.4.1), so its prune removes nothing. The image list cannot
 * probe that: engines before 29.4.1 reject `label!` there ("invalid filter"). So the
 * prune runs first; when it removed nothing yet unused, unlabelled images exist, they
 * go one by one instead and Docker still refuses any a container uses. That path
 * cannot say how much space it freed, so it reports only the images.
 */
export async function pruneAllUnused(docker: ImagePrunePorts): Promise<ImagePruneResult> {
	const pruned = await docker.prune();
	if (pruned.ImagesDeleted?.length) return pruned;

	const all = await docker.listImages();
	const kept = await docker.listImages(buildKeepLabelFilter());
	const containers = await docker.listContainers();
	const usedIds = new Set(containers.map((c) => c.ImageID));
	const targets = imageRefsToRemove(all, new Set(kept.map((i) => i.Id)), usedIds);
	if (!targets.length) return pruned;

	docker.log(`prune removed nothing though unused images exist (${all.length} listed, ${kept.length} with the keep label, ${usedIds.size} in use by containers); removing ${targets.length} unused images one by one`);
	const deleted: ImageDeleteEntry[] = [];
	let refused = 0;
	for (const refs of targets) {
		for (const ref of refs) {
			try {
				deleted.push(...await docker.remove(ref));
			} catch (err) {
				// In use since the listing, or a parent of another image: Docker's refusal keeps it.
				refused++;
				if (refused <= MAX_LOGGED_REFUSALS) docker.log(`Kept image "${ref}" (${failure(err)})`);
				break;
			}
		}
	}
	if (refused > MAX_LOGGED_REFUSALS) docker.log(`${refused - MAX_LOGGED_REFUSALS} more images kept by the engine`);
	docker.log(`one-by-one prune done: ${targets.length - refused} of ${targets.length} images removed, ${refused} kept by the engine, space freed not known`);
	return { ImagesDeleted: deleted.length ? deleted : null };
}

/** Refusals logged one per line; the rest are counted, so a large host does not flood the log. */
const MAX_LOGGED_REFUSALS = 5;

/**
 * The warning for a prune holder container that could not be created, or null for a
 * 404: the image is not on the host, so there is nothing to protect.
 */
export function holderFailureWarning(err: unknown, image: string, envId: number | null | undefined): string | null {
	const status = (err as { statusCode?: number } | null)?.statusCode;
	if (status === 404) return null;
	const message = err instanceof Error ? err.message : String(err);
	return `[Prune] env ${envId ?? 'local'}: could not protect ${image} from the prune (HTTP ${status ?? 'no response'}): ${message}`;
}

/** An engine error for the log: its HTTP status, when it has one, and its message. */
function failure(err: unknown): string {
	const status = (err as { statusCode?: number } | null)?.statusCode;
	const message = err instanceof Error ? err.message : String(err);
	return status ? `HTTP ${status}: ${message}` : message;
}
