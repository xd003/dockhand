/** Transport-neutral Hawser stack-file contract (no I/O imports; safe for pure modules). */
export type HawserFileEntry = { path: string; type: 'file' | 'directory'; size?: number; revision?: string };
export type HawserBinding = { root: string; composeFileNames: string[]; /** True for Hawser's own STACKS_DIR/<project> leaf; false for an in-place adopted root. */ managed?: boolean };
export type HawserFile = { content: Uint8Array; revision: string; size: number };
/** Git index mode for a published regular file; omitted for edits and untracked files (agent keeps the existing mode). */
export type HawserFileMode = 0o755 | 0o644;
export type HawserFileChange = { path: string; contentBase64: string; revision?: string; mode?: HawserFileMode };
export type HawserFileDeletion = { path: string; sha256: string };
export interface HawserStackFileClient {
	/** Agent's per-file limit in bytes (MAX_STACK_FILE_SIZE_MB); undefined for agents that do not report it. */
	readonly maxFileSize?: number;
	bind(composeFileNames?: string[], existingOnly?: boolean): Promise<HawserBinding>;
	enroll(root: string, composeFileNames: string[]): Promise<HawserBinding>;
	binding(): Promise<HawserBinding>;
	relocate(root: string): Promise<HawserBinding>;
	/** Forget the binding (never deletes files); optionally remove an EMPTY managed root. */
	unbind(removeEmptyRoot?: boolean): Promise<{ rootRemoved: boolean }>;
	list(path?: string): Promise<HawserFileEntry[]>;
	stat(path: string): Promise<HawserFileEntry>;
	read(path: string): Promise<HawserFile>;
	write(path: string, content: Uint8Array, revision?: string): Promise<HawserFileEntry>;
	mkdir(path: string): Promise<HawserFileEntry>;
	move(path: string, targetPath: string, revision?: string): Promise<HawserFileEntry>;
	/** `recursive` also removes what `list` never shows (.git, symlinks); older agents ignore it and need an empty directory. */
	delete(path: string, revision?: string, recursive?: boolean): Promise<void>;
	apply(files: HawserFileChange[], deletions?: HawserFileDeletion[]): Promise<HawserApplyResult>;
}
export type HawserApplyResult = { deletedFiles: string[]; skippedFiles: { path: string; reason: string }[] };
