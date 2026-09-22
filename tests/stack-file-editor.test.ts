import { describe, expect, test } from 'bun:test';
import {
	createStackFileEditorState,
	serializeStackFileEditorDraft,
	updateEditorContent
} from '../src/lib/stack-file-editor';

describe('stack file editor draft state', () => {
	test('stages compose changes without touching disk', () => {
		let state = createStackFileEditorState({
			composePaths: ['compose.yaml'],
			composeContents: { 'compose.yaml': 'services: {}\n' }
		});
		state = updateEditorContent(state, 'compose.yaml', 'services:\n  app: {}\n');

		const draft = serializeStackFileEditorDraft(state);
		expect(draft.composeContents['compose.yaml']).toContain('app');
	});
});
