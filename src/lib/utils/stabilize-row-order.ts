/**
 * Keep a live-sorted list in a frozen visual order while the pointer is over a
 * row. Stats/filters still produce a fresh `items` array; we just replay the
 * captured key order so rows don't shuffle under the cursor. Items that
 * disappeared are dropped; newly appeared items are appended in their current
 * sorted position among the newcomers.
 */
export function stabilizeRowOrder<T>(
	items: T[],
	frozenKeys: readonly unknown[],
	getKey: (item: T) => unknown
): T[] {
	if (frozenKeys.length === 0 || items.length === 0) return items;

	const byKey = new Map<unknown, T>();
	for (const item of items) {
		byKey.set(getKey(item), item);
	}

	const out: T[] = [];
	for (const key of frozenKeys) {
		const item = byKey.get(key);
		if (item !== undefined) {
			out.push(item);
			byKey.delete(key);
		}
	}
	for (const item of items) {
		if (byKey.has(getKey(item))) out.push(item);
	}
	return out;
}
