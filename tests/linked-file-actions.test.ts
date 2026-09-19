import { describe, expect, test } from 'bun:test';
import { planLinkedFileActions } from '../src/lib/server/linked-file-actions';

describe('linked file action planning', () => {
	test('whole-stack actions supersede selected services', () => {
		const actions = planLinkedFileActions([
			{ path: 'a.yaml', postChange: { action: 'restart', target: 'services', services: ['web'] } },
			{ path: 'b.yaml', postChange: { action: 'recreate', target: 'stack', services: [] } }
		], ['web']);
		expect(actions).toEqual([{ target: 'stack', action: 'recreate', services: [], paths: ['b.yaml'] }]);
	});

	test('recreate removes overlapping selected-service restarts', () => {
		const actions = planLinkedFileActions([
			{ path: 'a.yaml', postChange: { action: 'restart', target: 'services', services: ['web', 'db'] } },
			{ path: 'b.yaml', postChange: { action: 'recreate', target: 'services', services: ['web'] } }
		], ['web', 'db']);
		expect(actions).toEqual([
			{ target: 'services', action: 'recreate', services: ['web'], paths: ['b.yaml'] },
			{ target: 'services', action: 'restart', services: ['db'], paths: ['a.yaml'] }
		]);
	});

	test('rejects stale service targets before planning', () => {
		expect(() => planLinkedFileActions([
			{ path: 'a.yaml', postChange: { action: 'restart', target: 'services', services: ['missing'] } }
		], ['web'])).toThrow('Unknown Compose service');
	});
});
