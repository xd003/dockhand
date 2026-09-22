import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const modal = readFileSync(join(import.meta.dir, '../src/routes/stacks/StackModal.svelte'), 'utf8');

describe('local stack create editor', () => {
	test('uses the shared compose and environment variables split', () => {
		expect(modal).toContain("activeTab === 'editor' && (mode === 'create' || (mode === 'edit' && !needsFileLocation))");
		expect(modal).toContain('onChange={applyEditorDraft}');
		expect(modal).not.toContain("{#if mode === 'create' && activeTab === 'editor'}");
	});

	test('shows the generated env file path in the shared editor', () => {
		const sharedEditor = modal.slice(
			modal.indexOf("activeTab === 'editor' && (mode === 'create' || (mode === 'edit' && !needsFileLocation))"),
			modal.indexOf("{:else if activeTab === 'editor'}")
		);

		expect(sharedEditor).toContain("title={displayEnvPath}");
		expect(sharedEditor).toContain("{displayEnvPath || 'Enter stack name above'}");
	});

	test('only allows browsing for an env file during initial internal deployment', () => {
		expect(modal.match(/\{#if mode === 'create' && !isGitView\}/g)).toHaveLength(2);
	});
});
