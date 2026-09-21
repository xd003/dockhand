import {
	MAX_LINKED_FILE_SIZE,
	defaultLinkedFilePostChange,
	linkedFileLanguage,
	normalizeLinkedFile,
	normalizeLinkedFiles,
	normalizeLinkedPath,
	type LinkedFilePostChange,
	type LinkedStackFile
} from './stack-linked-files';

export type StackEditorEntryKind = 'compose' | 'linked';

export interface StackEditorEntry {
	path: string;
	name: string;
	kind: StackEditorEntryKind;
	content: string;
	originalContent: string;
	language: string;
	ownership: 'local' | 'git';
	tracked?: boolean;
	ignored?: boolean;
	postChange: LinkedFilePostChange;
	originalPostChange: LinkedFilePostChange;
	revision?: string;
	error?: string;
}

export interface StackFileEditorState {
	composePaths: string[];
	composeContents: Record<string, string>;
	linkedEntries: StackEditorEntry[];
	activePath: string;
	activeKind: StackEditorEntryKind;
	createdFolders: string[];
	originalComposeContents: Record<string, string>;
}

export interface StackFileEditorDraft {
	composePaths: string[];
	composeContents: Record<string, string>;
	linkedFiles: LinkedStackFile[];
	linkedFileContents: Record<string, string>;
	createdFolders: string[];
	classifications: Array<{ path: string; tracked: boolean; ignored: boolean }>;
	revisions: Record<string, string>;
}

export function createStackFileEditorState(options: {
	composePaths?: string[];
	composeContents?: Record<string, string>;
	linkedEntries?: StackEditorEntry[];
	createdFolders?: string[];
} = {}): StackFileEditorState {
	const composePaths = [...(options.composePaths ?? [])];
	const composeContents = { ...(options.composeContents ?? {}) };
	const linkedEntries = [...(options.linkedEntries ?? [])];
	const activePath = composePaths[0] ?? linkedEntries[0]?.path ?? '';
	return {
		composePaths,
		composeContents,
		linkedEntries,
		activePath,
		activeKind: linkedEntries.some((entry) => entry.path === activePath) ? 'linked' : 'compose',
		createdFolders: [...(options.createdFolders ?? [])],
		originalComposeContents: { ...composeContents }
	};
}

function assertTextContent(content: unknown, path: string): string {
	if (typeof content !== 'string' || new TextEncoder().encode(content).byteLength > MAX_LINKED_FILE_SIZE || content.includes('\0')) {
		throw new Error(`Invalid text content for linked file: ${path}`);
	}
	return content;
}

function withActive(state: StackFileEditorState, path: string): StackFileEditorState {
	const linked = state.linkedEntries.some((entry) => entry.path === path);
	return { ...state, activePath: path, activeKind: linked ? 'linked' : 'compose' };
}

export function switchEditorFile(state: StackFileEditorState, path: string): StackFileEditorState {
	if (!state.composePaths.includes(path) && !state.linkedEntries.some((entry) => entry.path === path)) return state;
	return withActive(state, path);
}

export function updateEditorContent(state: StackFileEditorState, path: string, content: string): StackFileEditorState {
	assertTextContent(content, path);
	if (state.linkedEntries.some((entry) => entry.path === path)) {
		return {
			...state,
			linkedEntries: state.linkedEntries.map((entry) => entry.path === path ? { ...entry, content } : entry)
		};
	}
	if (!state.composePaths.includes(path)) return state;
	return { ...state, composeContents: { ...state.composeContents, [path]: content } };
}

export function createDraftFile(state: StackFileEditorState, path: string, content = ''): StackFileEditorState {
	const normalized = normalizeLinkedPath(path);
	assertTextContent(content, normalized);
	const linkedFiles = normalizeLinkedFiles(state.linkedEntries.map((entry) => ({ path: entry.path, ownership: entry.ownership, postChange: entry.postChange })).concat({
		path: normalized,
		ownership: 'local',
		postChange: defaultLinkedFilePostChange()
	}), { reservedPaths: state.composePaths });
	const metadata = linkedFiles.find((file) => file.path === normalized)!;
	const entry: StackEditorEntry = {
		path: normalized,
		name: normalized.split('/').pop() ?? normalized,
		kind: 'linked',
		content,
		originalContent: '',
		language: linkedFileLanguage(normalized),
		ownership: metadata.ownership,
		postChange: metadata.postChange,
		originalPostChange: defaultLinkedFilePostChange()
	};
	return { ...state, linkedEntries: [...state.linkedEntries, entry], activePath: normalized, activeKind: 'linked' };
}

export function stageDraftFolder(state: StackFileEditorState, path: string): StackFileEditorState {
	const normalized = normalizeLinkedPath(path);
	if (state.createdFolders.some((folder) => folder.toLocaleLowerCase() === normalized.toLocaleLowerCase())) return state;
	return { ...state, createdFolders: [...state.createdFolders, normalized] };
}

export function linkDraftFile(
	state: StackFileEditorState,
	file: { path: string; content: string; ownership?: 'local' | 'git'; postChange?: LinkedFilePostChange; revision?: string; tracked?: boolean; ignored?: boolean }
): StackFileEditorState {
	const normalized = normalizeLinkedPath(file.path);
	const content = assertTextContent(file.content, normalized);
	const metadata = normalizeLinkedFile({
		path: normalized,
		ownership: file.ownership ?? 'local',
		postChange: file.postChange ?? defaultLinkedFilePostChange()
	});
	const linkedFiles = normalizeLinkedFiles(state.linkedEntries.map((entry) => ({ path: entry.path, ownership: entry.ownership, postChange: entry.postChange })).concat(metadata), {
		reservedPaths: state.composePaths
	});
	const next = linkedFiles.find((entry) => entry.path === normalized)!;
	const entry: StackEditorEntry = {
		path: normalized,
		name: normalized.split('/').pop() ?? normalized,
		kind: 'linked',
		content,
		originalContent: content,
		language: linkedFileLanguage(normalized),
		ownership: next.ownership,
		tracked: file.tracked,
		ignored: file.ignored,
		postChange: next.postChange,
		originalPostChange: structuredClone(next.postChange),
		revision: file.revision
	};
	return { ...state, linkedEntries: [...state.linkedEntries, entry], activePath: normalized, activeKind: 'linked' };
}

export function unlinkDraftFile(state: StackFileEditorState, path: string): StackFileEditorState {
	const linkedEntries = state.linkedEntries.filter((entry) => entry.path !== path);
	const activePath = state.activePath === path ? state.composePaths[0] ?? linkedEntries[0]?.path ?? '' : state.activePath;
	return {
		...state,
		linkedEntries,
		activePath,
		activeKind: linkedEntries.some((entry) => entry.path === activePath) ? 'linked' : 'compose'
	};
}

export function updateDraftPolicy(state: StackFileEditorState, path: string, patch: Partial<LinkedFilePostChange>): StackFileEditorState {
	return {
		...state,
		linkedEntries: state.linkedEntries.map((entry) => entry.path === path
			? { ...entry, postChange: { ...entry.postChange, ...patch } }
			: entry)
	};
}

export function renameComposePath(state: StackFileEditorState, from: string, to: string): StackFileEditorState {
	if (!state.composePaths.includes(from)) return state;
	const normalized = normalizeLinkedPath(to);
	const paths = state.composePaths.map((path) => path === from ? normalized : path);
	const contents = { ...state.composeContents };
	if (from in contents) {
		contents[normalized] = contents[from];
		delete contents[from];
	}
	return {
		...state,
		composePaths: paths,
		composeContents: contents,
		activePath: state.activePath === from ? normalized : state.activePath
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
	return state.composePaths.some((path) => state.composeContents[path] !== state.originalComposeContents[path]) ||
		state.linkedEntries.some((entry) => entry.content !== entry.originalContent || JSON.stringify(entry.postChange) !== JSON.stringify(entry.originalPostChange)) ||
		state.createdFolders.length > 0;
}

export function serializeStackFileEditorDraft(state: StackFileEditorState): StackFileEditorDraft {
	const composePaths = state.composePaths.map(normalizeLinkedPath);
	const linkedFiles = normalizeLinkedFiles(state.linkedEntries.map((entry) => ({ path: entry.path, ownership: entry.ownership, postChange: entry.postChange })), {
		reservedPaths: composePaths
	});
	const linkedFileContents = Object.fromEntries(state.linkedEntries.map((entry) => [normalizeLinkedPath(entry.path), assertTextContent(entry.content, entry.path)]));
	const classifications = state.linkedEntries.map((entry) => ({ path: entry.path, tracked: entry.tracked === true, ignored: entry.ignored === true }));
	const revisions = Object.fromEntries(state.linkedEntries.filter((entry) => entry.revision).map((entry) => [entry.path, entry.revision!]));
	return {
		composePaths,
		composeContents: Object.fromEntries(composePaths.map((path) => [path, state.composeContents[path] ?? ''])),
		linkedFiles,
		linkedFileContents,
		createdFolders: state.createdFolders.map(normalizeLinkedPath),
		classifications,
		revisions
	};
}
