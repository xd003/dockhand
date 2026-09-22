import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const modal = readFileSync(join(import.meta.dir, '../src/routes/stacks/GitStackModal.svelte'), 'utf8');
const stackModal = readFileSync(join(import.meta.dir, '../src/routes/stacks/StackModal.svelte'), 'utf8');

describe('Git stack draft editor', () => {
	test('loads and renders environment variables beside the compose editor', () => {
		expect(modal).toContain('await populateEnvVars();');
		expect(modal).toContain('aria-label="Resize compose and variables panels"');
		expect(modal).toContain('<StackEnvVarsPanel');
		expect(modal).toContain("mobilePane === 'vars'");
	});

	test('shows the effective repository env file path in the variables pane', () => {
		expect(modal).toContain('const displayEnvFilePath = $derived(');
		expect(modal).toContain(".replace(/(^|\\/)[^/]+$/, '$1.env')");
		expect(modal).toContain('title={displayEnvFilePath}');
		expect(modal).toContain('>Env file</div>');
		expect(modal).not.toContain('Repository env file');
	});

	test('offers compose validation and copy actions in the editor', () => {
		expect(modal).toContain('async function validateGitDraft()');
		expect(modal).toContain('async function copyDraftCompose()');
		expect(modal).toContain('{#snippet headerActions()}');
		expect(modal).toContain('<ComposeValidatePanel report={draftValidateReport}');
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

});
