<script lang="ts">
	import type { Snippet } from 'svelte';
	import yaml from 'js-yaml';
	import { Code, FolderOpen } from 'lucide-svelte';
	import CodeEditor, { type LintMarker, type VariableMarker } from '$lib/components/CodeEditor.svelte';
	import { Button } from '$lib/components/ui/button';
	import * as Dialog from '$lib/components/ui/dialog';
	import { Input } from '$lib/components/ui/input';
	import { Label } from '$lib/components/ui/label';
	import * as Tabs from '$lib/components/ui/tabs';
	import {
		defaultLinkedFilePostChange,
		linkedFileLanguage,
		normalizeLinkedFile,
		normalizeLinkedPath,
		type LinkedFilePostChange
	} from '$lib/stack-linked-files';
	import type { StackEditorEntry, StackFileEditorDraft } from '$lib/stack-file-editor';

	interface Props {
		composePaths?: string[];
		composeContents?: Record<string, string>;
		linkedEntries?: StackEditorEntry[];
		createdFolders?: string[];
		readonly?: boolean;
		allowFileManagement?: boolean;
		theme?: 'light' | 'dark';
		onChange?: (draft: StackFileEditorDraft) => void;
		onRequestLink?: () => void;
		onCreateFile?: (path: string, content: string) => void | Promise<void>;
		onCreateFolder?: (path: string) => void | Promise<void>;
		canLink?: boolean;
		canCreate?: boolean;
		onUnlink?: () => void | Promise<void>;
		folderWarning?: string;
		onPolicyChange?: (patch: Partial<LinkedFilePostChange>) => void;
		initialPath?: string;
		onActivePathChange?: (path: string) => void;
		variableMarkers?: VariableMarker[];
		lintMarkers?: LintMarker[];
		onLintClick?: (line: number) => void;
		headerActions?: Snippet;
		editorOverlay?: Snippet;
	}

	let {
		composePaths = [],
		composeContents = {},
		linkedEntries = [],
		createdFolders = [],
		readonly = false,
		allowFileManagement = false,
		theme = 'dark',
		onChange,
		onRequestLink,
		onCreateFile,
		onCreateFolder,
		canLink = false,
		canCreate = true,
		onUnlink,
		folderWarning,
		onPolicyChange,
		initialPath = '',
		onActivePathChange,
		variableMarkers = [],
		lintMarkers = [],
		onLintClick,
		headerActions,
		editorOverlay
	}: Props = $props();

	let activePath = $state('');
	let draftError = $state<string | null>(null);
	type ActionDialog = 'file' | 'folder' | 'unlink';
	let actionDialog = $state<ActionDialog | null>(null);
	let actionPath = $state('');
	let actionContent = $state('');
	let actionError = $state<string | null>(null);
	let actionSubmitting = $state(false);

	const allPaths = $derived([...composePaths.filter(Boolean), ...linkedEntries.map((entry) => entry.path)]);
	const activeLinkedEntry = $derived(linkedEntries.find((entry) => entry.path === activePath));
	const activeContent = $derived(activeLinkedEntry?.content ?? composeContents[activePath] ?? '');
	const activeLanguage = $derived(activeLinkedEntry?.language ?? 'yaml');
	const composeServices = $derived.by(() => {
		const services = new Set<string>();
		for (const content of Object.values(composeContents)) {
			try {
				const parsed = yaml.load(content) as { services?: Record<string, unknown> } | undefined;
				for (const service of Object.keys(parsed?.services ?? {})) services.add(service);
			} catch {
				// Compose validation reports malformed YAML; policy controls can remain empty.
			}
		}
		return [...services].sort();
	});

	$effect(() => {
		if (!allPaths.includes(activePath)) activePath = allPaths[0] ?? '';
		if (initialPath && allPaths.includes(initialPath) && activePath !== initialPath) activePath = initialPath;
	});

	function selectPath(path: string) {
		activePath = path;
		onActivePathChange?.(path);
	}

	function draft(): StackFileEditorDraft {
		return {
			composePaths: [...composePaths],
			composeContents: { ...composeContents },
			linkedFiles: linkedEntries.map((entry) => normalizeLinkedFile({ path: entry.path, ownership: entry.ownership, postChange: entry.postChange })),
			linkedFileContents: Object.fromEntries(linkedEntries.map((entry) => [entry.path, entry.content])),
			createdFolders: [...createdFolders],
			classifications: linkedEntries.map((entry) => ({ path: entry.path, tracked: entry.tracked === true, ignored: entry.ignored === true })),
			revisions: Object.fromEntries(linkedEntries.filter((entry) => entry.revision).map((entry) => [entry.path, entry.revision!]))
		};
	}

	function emit(mutator: (next: StackFileEditorDraft) => void): boolean {
		try {
			const next = draft();
			mutator(next);
			draftError = null;
			onChange?.(next);
			return true;
		} catch (error) {
			draftError = error instanceof Error ? error.message : String(error);
			return false;
		}
	}

	function changeContent(content: string) {
		emit((next) => {
			if (activeLinkedEntry) next.linkedFileContents[activePath] = content;
			else next.composeContents[activePath] = content;
		});
	}

	function openActionDialog(action: ActionDialog) {
		if (action === 'unlink' && !activeLinkedEntry) return;
		actionDialog = action;
		actionPath = action === 'unlink' ? activePath : '';
		actionContent = '';
		actionError = null;
	}

	function closeActionDialog() {
		if (!actionSubmitting) actionDialog = null;
	}

	async function submitAction() {
		if (!actionDialog) return;
		const action = actionDialog;
		if (action !== 'unlink' && !actionPath.trim()) {
			actionError = `${action === 'file' ? 'File' : 'Folder'} path is required.`;
			return;
		}

		actionSubmitting = true;
		actionError = null;
		try {
			if (action === 'unlink') {
				if (onUnlink) await onUnlink();
				else if (!emit((next) => {
					next.linkedFiles = next.linkedFiles.filter((file) => file.path !== activePath);
					delete next.linkedFileContents[activePath];
					next.classifications = next.classifications.filter((entry) => entry.path !== activePath);
					delete next.revisions[activePath];
				})) throw new Error(draftError ?? 'Failed to unlink file');
				activePath = composePaths[0] ?? '';
				onActivePathChange?.(activePath);
			} else {
				const normalized = normalizeLinkedPath(actionPath);
				if (action === 'file') {
					if (onCreateFile) await onCreateFile(normalized, actionContent);
					else {
						const metadata = normalizeLinkedFile({ path: normalized, ownership: 'local', postChange: defaultLinkedFilePostChange() });
						if (!emit((next) => {
							next.linkedFiles = [...next.linkedFiles, metadata];
							next.linkedFileContents[normalized] = actionContent;
						})) throw new Error(draftError ?? 'Failed to create file');
					}
					activePath = normalized;
					onActivePathChange?.(normalized);
				} else {
					if (onCreateFolder) await onCreateFolder(normalized);
					else if (!emit((next) => {
						if (!next.createdFolders.some((folder) => folder.toLocaleLowerCase() === normalized.toLocaleLowerCase())) next.createdFolders = [...next.createdFolders, normalized];
					})) throw new Error(draftError ?? 'Failed to create folder');
				}
			}
			actionDialog = null;
		} catch (error) {
			actionError = error instanceof Error ? error.message : String(error);
		} finally {
			actionSubmitting = false;
		}
	}

	function updatePolicy(patch: Partial<LinkedFilePostChange>) {
		if (!activeLinkedEntry) return;
		if (onPolicyChange) {
			onPolicyChange(patch);
			return;
		}
		emit((next) => {
			next.linkedFiles = next.linkedFiles.map((file) => file.path === activePath ? { ...file, postChange: { ...file.postChange, ...patch } } : file);
		});
	}

	export function addLinkedFile(file: { path: string; content: string; ownership?: 'local' | 'git'; tracked?: boolean; ignored?: boolean; revision?: string; postChange?: LinkedFilePostChange }) {
		const normalized = normalizeLinkedPath(file.path);
		const metadata = normalizeLinkedFile({ path: normalized, ownership: file.ownership ?? 'local', postChange: file.postChange ?? defaultLinkedFilePostChange() });
		if (emit((next) => {
			next.linkedFiles = [...next.linkedFiles, metadata];
			next.linkedFileContents[normalized] = file.content;
			next.classifications = [...next.classifications, { path: normalized, tracked: file.tracked === true, ignored: file.ignored === true }];
			if (file.revision) next.revisions[normalized] = file.revision;
		})) activePath = normalized;
	}
</script>

<div class="flex min-h-0 flex-1 flex-col px-4 py-4 sm:px-8 sm:py-6">
	<div class="mb-3.5 flex flex-wrap items-center justify-between gap-3">
		<div class="flex items-center gap-2 text-sm font-semibold"><Code class="h-4 w-4 text-muted-foreground" />Managed files <span class="text-xs font-normal text-muted-foreground">({allPaths.length})</span></div>
		{#if (!readonly || allowFileManagement) && (canLink || canCreate)}
			<div class="flex flex-wrap items-center gap-2">
				{#if canLink && onRequestLink}<button type="button" class="rounded border px-2 py-1 text-xs text-muted-foreground hover:text-foreground" onclick={onRequestLink}>+ Link</button>{/if}
				{#if canCreate}<button type="button" class="rounded border px-2 py-1 text-xs text-muted-foreground hover:text-foreground" onclick={() => openActionDialog('file')}>+ File</button>{/if}
				{#if canCreate}<button type="button" class="rounded border px-2 py-1 text-xs text-muted-foreground hover:text-foreground" onclick={() => openActionDialog('folder')}>+ Folder</button>{/if}
			</div>
		{/if}
	</div>

	{#if allPaths.length > 0}
		<Tabs.Root value={activePath} onValueChange={selectPath} class="flex-wrap border-b border-zinc-200 dark:border-zinc-700">
			<Tabs.List class="flex w-full flex-wrap justify-start gap-0.5 rounded-none bg-transparent p-0">
				{#each composePaths as path}
					<Tabs.Trigger value={path} class="min-w-0 break-all rounded-none border-b-2 px-3.5 py-2.5 font-mono text-xs data-[state=active]:border-primary">{path.split('/').pop()}</Tabs.Trigger>
				{/each}
				{#each linkedEntries as entry}
					<Tabs.Trigger value={entry.path} class="min-w-0 break-all rounded-none border-b-2 px-3.5 py-2.5 font-mono text-xs data-[state=active]:border-primary">{entry.name}<span class="ml-1 text-[10px] text-muted-foreground">{entry.ownership}</span></Tabs.Trigger>
				{/each}
			</Tabs.List>
		</Tabs.Root>

		<div class="flex min-h-0 flex-1 flex-col overflow-hidden rounded-lg border border-zinc-200 bg-zinc-50 dark:border-zinc-700 dark:bg-zinc-900/40">
			<div class="flex items-center justify-between gap-3 border-b border-zinc-200 bg-zinc-100/80 px-3.5 py-2 dark:border-zinc-700 dark:bg-zinc-800/60">
				<span class="truncate font-mono text-[11px] text-muted-foreground">{activePath}</span>
				{#if headerActions}{@render headerActions()}{/if}
				{#if activeLinkedEntry && (!readonly || allowFileManagement)}
					<div class="flex flex-wrap items-center justify-end gap-1.5">
						<span class="text-xs text-muted-foreground">When modified:</span>
						<select aria-label="Action when linked file is modified" class="h-7 rounded border bg-background px-1 text-xs" value={activeLinkedEntry.postChange.action} onchange={(event) => { const action = event.currentTarget.value as LinkedFilePostChange['action']; updatePolicy(action === 'none' ? { action, target: 'stack', services: [] } : { action, ...(action === 'ordered' ? { target: 'stack' as const, services: [] } : {}) }); }}>
							<option value="none">No action</option><option value="restart">Restart</option><option value="ordered">Ordered restart</option><option value="recreate">Recreate</option>
						</select>
						{#if activeLinkedEntry.postChange.action !== 'none'}
							<select aria-label="Scope affected when linked file is modified" class="h-7 rounded border bg-background px-1 text-xs" value={activeLinkedEntry.postChange.target} onchange={(event) => { const target = event.currentTarget.value as 'stack' | 'services'; updatePolicy({ target, services: target === 'services' ? composeServices.slice(0, 1) : [] }); }}>
								<option value="stack">Whole stack</option><option value="services" disabled={activeLinkedEntry.postChange.action === 'ordered' || composeServices.length === 0}>Selected services</option>
							</select>
							{#if activeLinkedEntry.postChange.target === 'services'}
								<select class="h-7 max-w-36 rounded border bg-background px-1 text-xs" aria-label="Service affected when linked file is modified" value={activeLinkedEntry.postChange.services[0] ?? ''} onchange={(event) => updatePolicy({ services: [event.currentTarget.value] })}>
									{#each composeServices as service}<option value={service}>{service}</option>{/each}
								</select>
							{/if}
						{/if}
						<button type="button" class="rounded border px-2 py-1 text-xs text-muted-foreground hover:text-destructive" onclick={() => openActionDialog('unlink')}>Unlink</button>
					</div>
				{/if}
			</div>
			<div class="relative flex min-h-0 flex-1">
				<CodeEditor value={activeContent} language={activeLanguage} {readonly} {theme} onchange={readonly ? undefined : changeContent} variableMarkers={activeLinkedEntry ? [] : variableMarkers} lintMarkers={activeLinkedEntry ? [] : lintMarkers} onLintClick={onLintClick} class="min-h-0 flex-1 overflow-hidden" />
				{#if editorOverlay}{@render editorOverlay()}{/if}
			</div>
		</div>
	{:else}
		<div class="flex flex-1 flex-col items-center justify-center gap-3 rounded-lg border border-dashed text-sm text-muted-foreground">
			<FolderOpen class="h-8 w-8 opacity-50" />
			<span>Select a Compose file or create a configuration file.</span>
		</div>
	{/if}
	{#if draftError}<p class="mt-2 text-xs text-destructive">{draftError}</p>{/if}
</div>

<Dialog.Root open={actionDialog !== null} onOpenChange={(open) => { if (!open) closeActionDialog(); }}>
	{#if actionDialog}
		<Dialog.Content class="max-w-md" showCloseButton={!actionSubmitting}>
			<Dialog.Header>
				<Dialog.Title>
					{actionDialog === 'file' ? 'Create configuration file' : actionDialog === 'folder' ? 'Create configuration folder' : 'Unlink configuration file'}
				</Dialog.Title>
				<Dialog.Description>
					{#if actionDialog === 'file'}
						Add a file relative to the Compose directory.
					{:else if actionDialog === 'folder'}
						Add an empty folder relative to the Compose directory.
					{:else}
						The file will remain on disk, but it will no longer be managed as a linked configuration file.
					{/if}
				</Dialog.Description>
			</Dialog.Header>

			{#if actionDialog === 'unlink'}
				<div class="rounded-md border border-destructive/30 bg-destructive/10 px-3 py-2 font-mono text-xs text-foreground break-all">{actionPath}</div>
			{:else}
				<div class="space-y-2">
					<Label for="stack-file-editor-action-path">Relative path</Label>
					<Input id="stack-file-editor-action-path" bind:value={actionPath} placeholder={actionDialog === 'file' ? 'config/settings.env' : 'config'} autofocus disabled={actionSubmitting} />
				</div>
				{#if actionDialog === 'file'}
					<div class="space-y-2">
						<Label for="stack-file-editor-action-content">Initial content</Label>
						<textarea id="stack-file-editor-action-content" bind:value={actionContent} rows="5" class="border-input bg-background placeholder:text-muted-foreground focus-visible:border-ring focus-visible:ring-ring/50 w-full resize-y rounded-md border px-3 py-2 text-sm outline-none focus-visible:ring-[3px] disabled:cursor-not-allowed disabled:opacity-50" disabled={actionSubmitting}></textarea>
					</div>
				{:else if folderWarning}
					<p class="rounded-md border border-amber-500/30 bg-amber-500/10 px-3 py-2 text-xs text-muted-foreground">{folderWarning}</p>
				{/if}
			{/if}

			{#if actionError}<p class="text-sm text-destructive">{actionError}</p>{/if}
			<Dialog.Footer>
				<Button variant="outline" type="button" onclick={closeActionDialog} disabled={actionSubmitting}>Cancel</Button>
				<Button variant={actionDialog === 'unlink' ? 'destructive' : 'default'} type="button" onclick={() => void submitAction()} disabled={actionSubmitting}>
					{actionSubmitting ? 'Working...' : actionDialog === 'file' ? 'Create file' : actionDialog === 'folder' ? 'Create folder' : 'Unlink file'}
				</Button>
			</Dialog.Footer>
		</Dialog.Content>
	{/if}
</Dialog.Root>
