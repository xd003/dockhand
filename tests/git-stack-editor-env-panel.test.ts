import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const modal = readFileSync(join(import.meta.dir, '../src/routes/stacks/GitStackModal.svelte'), 'utf8');
const stackModal = readFileSync(join(import.meta.dir, '../src/routes/stacks/StackModal.svelte'), 'utf8');
const fileEditor = readFileSync(join(import.meta.dir, '../src/routes/stacks/StackFileEditor.svelte'), 'utf8');

describe('Git stack draft editor', () => {
	test('loads and renders environment variables beside the compose editor', () => {
		expect(modal).toContain('await populateEnvVars();');
		expect(modal).toContain('aria-label="Resize compose and variables panels"');
		expect(modal).toContain('<StackEnvVarsPanel');
		expect(modal).toContain("mobilePane === 'vars'");
	});

	test('shows compose variable markers without a successful-load toast', () => {
		expect(modal).toContain('const variableMarkers = $derived.by<VariableMarker[]>');
		expect(modal).toContain('{variableMarkers}');
		expect(modal).not.toContain('toast.success(`Loaded ${count} variable');
	});

	test('keeps the settings tab selected after choosing a compose file', () => {
		const loadEditor = modal.slice(modal.indexOf('async function loadGitDraftEditor()'), modal.indexOf('function applyGitDraftEditor'));
		expect(loadEditor).not.toContain("activeTab = 'editor'");
	});

	test('reloads environment variables after removing a compose override', () => {
		const removeComposePath = modal.slice(modal.indexOf('async function gitRemoveComposePath'), modal.indexOf('function gitMovePathUp'));
		expect(removeComposePath).toContain('if (!gitStack) await populateEnvVars();');
	});

	test('reloads repository environment defaults whenever the stack editor opens', () => {
		expect(stackModal).toContain('await populateGitEnvVars(loadedVars, false);');
	});

	test('allows deployed Git stacks to manage linked files while compose content stays read-only', () => {
		expect(stackModal).toContain('allowFileManagement={isGitView}');
		expect(stackModal).toContain('canLink={isGitView || hasLinkableFile');
		expect(stackModal).toContain("initialPath: '',\n\t\t\tapiUrl: linkedBrowseApiUrl()");
		expect(stackModal).toContain('bind:rootPath={linkedBrowseRoot}');
		expect(fileEditor).toContain('(!readonly || allowFileManagement) && (canLink || canCreate)');
		expect(fileEditor).toContain('activeLinkedEntry && (!readonly || allowFileManagement)');
	});
});
