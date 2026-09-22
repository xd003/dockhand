export interface StackFileEditorState {
	composePaths: string[];
	composeContents: Record<string, string>;
	activePath: string;
	originalComposeContents: Record<string, string>;
}

export interface StackFileEditorDraft {
	composePaths: string[];
	composeContents: Record<string, string>;
}

export function createStackFileEditorState(options: {
	composePaths?: string[];
	composeContents?: Record<string, string>;
} = {}): StackFileEditorState {
	const composePaths = [...(options.composePaths ?? [])];
	const composeContents = { ...(options.composeContents ?? {}) };
	return {
		composePaths,
		composeContents,
		activePath: composePaths[0] ?? '',
		originalComposeContents: { ...composeContents }
	};
}

export function switchEditorFile(state: StackFileEditorState, path: string): StackFileEditorState {
	return state.composePaths.includes(path) ? { ...state, activePath: path } : state;
}

export function updateEditorContent(state: StackFileEditorState, path: string, content: string): StackFileEditorState {
	if (!state.composePaths.includes(path)) return state;
	return { ...state, composeContents: { ...state.composeContents, [path]: content } };
}

export function renameComposePath(state: StackFileEditorState, from: string, to: string): StackFileEditorState {
	if (!state.composePaths.includes(from)) return state;
	const paths = state.composePaths.map((path) => path === from ? to : path);
	const contents = { ...state.composeContents };
	if (from in contents) {
		contents[to] = contents[from];
		delete contents[from];
	}
	return {
		...state,
		composePaths: paths,
		composeContents: contents,
		activePath: state.activePath === from ? to : state.activePath
	};
}

export function reorderComposePaths(state: StackFileEditorState, from: number, to: number): StackFileEditorState {
	if (from < 0 || to < 0 || from >= state.composePaths.length || to >= state.composePaths.length || from === to) return state;
	const composePaths = [...state.composePaths];
	const [path] = composePaths.splice(from, 1);
	composePaths.splice(to, 0, path);
	return { ...state, composePaths };
}

export function isStackFileEditorDirty(state: StackFileEditorState): boolean {
	return state.composePaths.some((path) => state.composeContents[path] !== state.originalComposeContents[path]);
}

export function serializeStackFileEditorDraft(state: StackFileEditorState): StackFileEditorDraft {
	return {
		composePaths: [...state.composePaths],
		composeContents: Object.fromEntries(state.composePaths.map((path) => [path, state.composeContents[path] ?? '']))
	};
}
