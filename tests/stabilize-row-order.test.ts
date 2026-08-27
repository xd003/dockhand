import { describe, it, expect } from 'bun:test';
import { stabilizeRowOrder } from '../src/lib/utils/stabilize-row-order';

describe('stabilizeRowOrder', () => {
	const key = (r: { id: string }) => r.id;

	it('replays the frozen key order using the latest item objects', () => {
		const frozen = ['a', 'b', 'c'];
		const fresh = [
			{ id: 'c', cpu: 90 },
			{ id: 'a', cpu: 10 },
			{ id: 'b', cpu: 50 }
		];
		expect(stabilizeRowOrder(fresh, frozen, key)).toEqual([
			{ id: 'a', cpu: 10 },
			{ id: 'b', cpu: 50 },
			{ id: 'c', cpu: 90 }
		]);
	});

	it('drops keys that are no longer in the live list', () => {
		const frozen = ['a', 'gone', 'b'];
		const fresh = [
			{ id: 'b', cpu: 2 },
			{ id: 'a', cpu: 1 }
		];
		expect(stabilizeRowOrder(fresh, frozen, key).map((r) => r.id)).toEqual(['a', 'b']);
	});

	it('appends items that appeared after the freeze, in live-list order', () => {
		const frozen = ['a', 'b'];
		const fresh = [
			{ id: 'new-1', cpu: 9 },
			{ id: 'b', cpu: 2 },
			{ id: 'new-2', cpu: 8 },
			{ id: 'a', cpu: 1 }
		];
		expect(stabilizeRowOrder(fresh, frozen, key).map((r) => r.id)).toEqual([
			'a',
			'b',
			'new-1',
			'new-2'
		]);
	});

	it('returns the live list unchanged when there is nothing to freeze', () => {
		const fresh = [{ id: 'a', cpu: 1 }];
		expect(stabilizeRowOrder(fresh, [], key)).toBe(fresh);
		expect(stabilizeRowOrder([], ['a'], key)).toEqual([]);
	});
});
