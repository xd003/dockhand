import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const workspace = readFileSync(join(import.meta.dir, '../src/routes/stacks/StackWorkspace.svelte'), 'utf8');
const stackModal = readFileSync(join(import.meta.dir, '../src/routes/stacks/StackModal.svelte'), 'utf8');
const gitModal = readFileSync(join(import.meta.dir, '../src/routes/stacks/GitStackModal.svelte'), 'utf8');

describe('stack workspace editor tabs', () => {
	test('opens configured files as editable tabs for every stack type', () => {
		expect(workspace).toContain("let activeTab = $state<'stack-config' | string>('stack-config')");
		expect(workspace).not.toContain('stackConfigSide');
		expect(workspace).not.toContain('gitWorkspace');
		expect(workspace).toContain('{#if stackConfig}{@render stackConfig()}{/if}');
		expect(workspace).not.toContain('if (first) void open(first)');
	});

	test('keeps normal files as closeable tabs and the explorer collapsible', () => {
		expect(workspace).toContain('if (!openPaths.includes(entry.path)) openPaths = [...openPaths, entry.path]');
		expect(workspace).toContain('aria-label="Collapse file explorer"');
		expect(workspace).toContain('aria-label="Expand file explorer"');
	});

	test('keeps the Git compose and env split inside Stack Config', () => {
		expect(gitModal).toContain('{#snippet stackConfig()}{@render stackConfigEditor()}{/snippet}');
		expect(gitModal).toContain("onStackConfigSelect={() => mobilePane = 'form'}");
	});

	test('mirrors saved workspace files into Stack Config for existing stacks', () => {
		expect(workspace).toContain('void onFilesChanged?.([change.path, change.destination]');
		expect(stackModal).toContain("onFilesChanged={mode === 'edit' ? syncStackConfigFromWorkspace : undefined}");
		expect(stackModal).toContain('async function syncStackConfigFromWorkspace(changedPaths: string[])');
	});

	test('shows Stack Config as a view-only preview while workspace files remain editable', () => {
		expect(workspace).toContain('Preview compose and environment values here.{#if !readonly} Select a file in the explorer to edit it.{/if}');
		expect(stackModal).toContain("readonly={readonly || mode === 'edit' || workspaceEnabled}");
		expect(stackModal).toContain("readonly={inspectionReadonly || workspaceEnabled || mode === 'edit' || (readonly && !isGitView)}");
		expect(stackModal).toContain('Enable Stack Workspace to edit files.');
		expect(stackModal).toContain("{:else if !readonly && (activeTab !== 'editor' || needsFileLocation)}");
		expect(gitModal).not.toContain('readonly={workspaceEnabled}');
		expect(gitModal).toContain('Enable Stack Workspace to edit files.');
		expect(gitModal).toMatch(/<StackFileEditor[\s\S]*?readonly\s+[\s\S]*?<\/StackFileEditor>/);
		expect(gitModal).toMatch(/<StackEnvVarsPanel[\s\S]*?readonly\s+[\s\S]*?\/>/);
		expect(workspace).toContain('<CodeEditor value={content} language={editorLanguage(activePath)} {readonly}');
	});
});
