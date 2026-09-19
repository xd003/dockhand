import { describe, expect, test } from 'bun:test';
import {
	defaultLinkedFilePostChange,
	linkedFileLanguage,
	normalizeLinkedFiles,
	normalizeLinkedPath,
	normalizePostChangePolicy,
	parseLinkedFiles,
	serializeLinkedFiles
} from '../src/lib/stack-linked-files';

describe('linked stack file metadata', () => {
	test('normalizes safe relative POSIX paths', () => {
		expect(normalizeLinkedPath('config/app.yaml')).toBe('config/app.yaml');
		expect(() => normalizeLinkedPath('../app.yaml')).toThrow();
		expect(() => normalizeLinkedPath('/app.yaml')).toThrow();
		expect(() => normalizeLinkedPath('config\\app.yaml')).toThrow();
	});

	test('rejects duplicates, collisions, and invalid service policies', () => {
		const file = { path: 'config/app.yaml', ownership: 'local', postChange: defaultLinkedFilePostChange() };
		expect(() => normalizeLinkedFiles([file, { ...file, path: 'CONFIG/app.yaml' }])).toThrow('Case-colliding');
		expect(() => normalizePostChangePolicy({ action: 'restart', target: 'services', services: [] })).toThrow();
		expect(normalizePostChangePolicy({ action: 'recreate', target: 'services', services: ['web'] }).services).toEqual(['web']);
	});

	test('round trips the versioned document and detects languages', () => {
		const files = [{ path: 'config/app.yaml', ownership: 'git' as const, postChange: defaultLinkedFilePostChange() }];
		expect(parseLinkedFiles(serializeLinkedFiles(files))).toEqual(files);
		expect(linkedFileLanguage('Dockerfile')).toBe('dockerfile');
		expect(linkedFileLanguage('settings.toml')).toBe('toml');
		expect(linkedFileLanguage('unknown.conf')).toBe('ini');
	});
});
