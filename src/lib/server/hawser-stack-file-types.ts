/** Transport-neutral Hawser stack-file contract (no I/O imports; safe for pure modules). */
export type HawserFileEntry = { path: string; type: 'file' | 'directory'; size?: number; revision?: string };
export type HawserBinding = { root: string; composeFileNames: string[]; /** True for Hawser's own STACKS_DIR/<project> leaf; false for an in-place adopted root. */ managed?: boolean };
export type HawserFile = { content: Uint8Array; revision: string; size: number };
export type HawserFileChange = { path: string; contentBase64: string; revision?: string };
export type HawserFileDeletion = { path: string; sha256: string };
export interface HawserStackFileClient {
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
	delete(path: string, revision?: string): Promise<void>;
	apply(files: HawserFileChange[], deletions?: HawserFileDeletion[]): Promise<HawserApplyResult>;
}
export type HawserApplyResult = { deletedFiles: string[]; skippedFiles: { path: string; reason: string }[] };
