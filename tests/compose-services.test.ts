/**
 * Declared compose services for stacks whose services have no containers yet.
 *
 * Run with: bun test tests/compose-services.test.ts
 */
import { describe, test, expect } from 'bun:test';
import { listDeclaredComposeServices } from '../src/lib/utils/compose-services';

describe('listDeclaredComposeServices', () => {
	test('merges multi-file stacks in Compose order, later files overriding', () => {
		const base = `services:
  db:
    image: postgres:16
  app:
    build: .
`;
		const override = `services:
  app:
    image: example/app:2
    profiles: [full]
  worker:
    image: example/worker
`;
		expect(listDeclaredComposeServices([base, override])).toEqual([
			{ name: 'db', image: 'postgres:16', profiles: [] },
			{ name: 'app', image: 'example/app:2', profiles: ['full'] },
			{ name: 'worker', image: 'example/worker', profiles: [] }
		]);
	});

	test('treats files without services as contributing nothing', () => {
		expect(listDeclaredComposeServices(['', 'volumes:\n  data: {}\n', 'services:\n'])).toEqual([]);
	});

	test('throws on invalid YAML instead of reporting no services', () => {
		expect(() => listDeclaredComposeServices(['services: [unterminated'])).toThrow();
	});
});
