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
		expect(modal).toContain("title={displayEnvPath}");
		expect(modal).toContain("{displayEnvPath || 'Enter a stack name to preview the path'}");
	});

	test('reuses the shared editor as the workspace Stack Config tab', () => {
		expect(modal).toContain('{#snippet stackConfig()}{@render stackConfigEditor()}{/snippet}');
		expect(modal).toContain('onDraftChange={mode === \'create\' ? applyWorkspaceDraft : undefined}');
	});

	test('only allows browsing for an env file during initial internal deployment', () => {
		expect(modal).toContain("{#if mode === 'create' && !isGitView && !workspaceEnabled}");
		expect(modal).toContain("{#if mode === 'create' && !isGitView}");
	});
});
