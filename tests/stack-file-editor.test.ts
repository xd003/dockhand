import { describe, expect, test } from 'bun:test';
import {
	createStackFileEditorState,
	createDraftFile,
	serializeStackFileEditorDraft,
	stageDraftFolder,
	updateEditorContent
} from '../src/lib/stack-file-editor';

describe('stack file editor draft state', () => {
	test('stages compose, linked-file, and folder changes without touching disk', () => {
		let state = createStackFileEditorState({
			composePaths: ['compose.yaml'],
			composeContents: { 'compose.yaml': 'services: {}\n' }
		});
		state = createDraftFile(state, 'config/app.env', 'APP_ENV=dev\n');
		state = stageDraftFolder(state, 'data');
		state = updateEditorContent(state, 'compose.yaml', 'services:\n  app: {}\n');

		const draft = serializeStackFileEditorDraft(state);
		expect(draft.composeContents['compose.yaml']).toContain('app');
		expect(draft.linkedFiles[0].path).toBe('config/app.env');
		expect(draft.linkedFileContents['config/app.env']).toBe('APP_ENV=dev\n');
		expect(draft.createdFolders).toEqual(['data']);
	});

	test('rejects paths reserved by compose files', () => {
		const state = createStackFileEditorState({ composePaths: ['compose.yaml'] });
		expect(() => createDraftFile(state, 'compose.yaml', '')).toThrow();
	});
});
