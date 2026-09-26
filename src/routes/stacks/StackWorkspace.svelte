<script lang="ts">
	import type { Snippet } from 'svelte';
	import { ChevronDown, ChevronLeft, ChevronRight, CircleDashed, File, FileCode2, FilePenLine, FilePlus2, FileText, Folder, FolderInput, FolderPlus, GitBranch, GitCompareArrows, HardDrive, Loader2, PanelLeftOpen, Save, Settings2, Trash2, Upload, X } from 'lucide-svelte';
	import { untrack } from 'svelte';
	import { toast } from 'svelte-sonner';
	import { Button } from '$lib/components/ui/button';
	import { Input } from '$lib/components/ui/input';
	import * as Dialog from '$lib/components/ui/dialog';
	import CodeEditor from '$lib/components/CodeEditor.svelte';
	import { currentEnvironment, environments } from '$lib/stores/environment';

	interface GitState { tracked: boolean; ignored: boolean; mixed?: boolean }
	interface Entry { path: string; name: string; type: 'file' | 'directory'; size: number; depth?: number; git?: GitState | null }
	export interface WorkspaceDraft { files: Record<string, string>; binaryFiles: Record<string, string>; folders: string[] }
	interface Props { apiUrl?: string; readonly?: boolean; theme?: 'light' | 'dark'; rootName?: string; draft?: WorkspaceDraft; onDraftChange?: (draft: WorkspaceDraft) => void; onFilesChanged?: (paths: string[]) => Promise<void> | void; onConverted?: () => Promise<void> | void; stackConfig?: Snippet; onStackConfigSelect?: () => void }
	let { apiUrl, readonly = false, theme = 'dark', rootName = 'stack', draft, onDraftChange, onFilesChanged, onConverted, stackConfig, onStackConfigSelect }: Props = $props();
	const hawserHost = $derived($environments.some((env) => env.id === $currentEnvironment?.id && (env.connectionType === 'hawser-standard' || env.connectionType === 'hawser-edge')));
	let entries = $state<Entry[]>([]);
	let expanded = $state(new Set<string>());
	let rootExpanded = $state(true);
	let explorerOpen = $state(true);
	let activeTab = $state<'stack-config' | string>('stack-config');
	let activePath = $state('');
	let activeType = $state<'file' | 'directory' | ''>('');
	let openPaths = $state<string[]>([]);
	let content = $state('');
	let original = $state('');
	let revision = $state('');
	let git = $state<GitState | null>(null);
	let binary = $state(false);
	let loading = $state(false);
	let error = $state('');
	let uploadInput = $state<HTMLInputElement | null>(null);
	let createDialog = $state<'file' | 'directory' | null>(null);
	let createPath = $state('');
	let renameDialog = $state(false);
	let renameName = $state('');
	let moveDialog = $state(false);
	let moveDirectory = $state('');
	let deleteDialog = $state(false);
	let discardDialog = $state(false);
	let pendingEntry = $state<Entry | null>(null);
	let saveDialog = $state<'tracked' | 'untracked' | 'convert' | null>(null);
	let commitMessage = $state('');

	let localDraft = $state<WorkspaceDraft>({ files: {}, binaryFiles: {}, folders: [] });
	const rootGit = $derived.by(() => {
		const states = entries.filter((entry) => (entry.depth ?? 0) === 0).map((entry) => entry.git).filter((state): state is GitState => !!state);
		if (!states.length) return null;
		if (states.every((state) => state.tracked && !state.mixed)) return { tracked: true, ignored: false };
		if (states.every((state) => state.ignored)) return { tracked: false, ignored: true };
		return { tracked: true, ignored: false, mixed: true };
	});

	function gitLabel(state: GitState): string {
		if (state.mixed) return `Git tracked and ${hawserHost ? 'Hawser host' : 'local'} files`;
		if (state.tracked) return 'Git tracked';
		if (state.ignored) return hawserHost ? 'Hawser host only' : 'Local only';
		return 'Untracked';
	}

	function fileKind(path: string): 'compose' | 'env' | 'yaml' | 'other' {
		const name = path.split('/').pop()?.toLowerCase() ?? '';
		if (name === 'compose.yaml' || name === 'compose.yml' || name.startsWith('docker-compose')) return 'compose';
		if (name === '.env' || name.endsWith('.env')) return 'env';
		if (name.endsWith('.yaml') || name.endsWith('.yml')) return 'yaml';
		return 'other';
	}

	function editorLanguage(path: string): string {
		const kind = fileKind(path);
		if (kind === 'compose' || kind === 'yaml') return 'yaml';
		if (kind === 'env') return 'env';
		return path.split('.').pop()?.toLowerCase() ?? 'text';
	}

	function closePath(path: string, event: Event) {
		event.stopPropagation();
		const index = openPaths.indexOf(path);
		openPaths = openPaths.filter((openPath) => openPath !== path);
		if (activeTab !== path) return;
		const nextPath = openPaths[Math.min(index, openPaths.length - 1)];
		const next = entries.find((entry) => entry.path === nextPath);
		if (next) void open(next);
		else { activeTab = 'stack-config'; activePath = ''; activeType = ''; content = ''; }
	}

	function selectStackConfig() {
		activeTab = 'stack-config';
		onStackConfigSelect?.();
	}

	async function toggleRoot() {
		rootExpanded = !rootExpanded;
		if (rootExpanded) apiUrl ? await refresh() : refreshLocal();
	}

	$effect(() => {
		const endpoint = apiUrl;
		const initialDraft = draft;
		untrack(() => {
			if (endpoint) void refresh();
			else {
				localDraft = { files: { ...(initialDraft?.files ?? {}) }, binaryFiles: { ...(initialDraft?.binaryFiles ?? {}) }, folders: [...(initialDraft?.folders ?? [])] };
				refreshLocal();
			}
		});
	});

	function refreshLocal() {
		const paths = new Set([...Object.keys(localDraft.files), ...Object.keys(localDraft.binaryFiles), ...localDraft.folders]);
		for (const path of [...paths]) {
			const parts = path.split('/');
			for (let index = 1; index < parts.length; index++) paths.add(parts.slice(0, index).join('/'));
		}
		entries = [...paths].filter((path) => {
			const parts = path.split('/');
			return parts.slice(1).every((_, index) => expanded.has(parts.slice(0, index + 1).join('/')));
		}).map((path) => {
			const isFile = path in localDraft.files || path in localDraft.binaryFiles;
			return { path, name: path.split('/').pop()!, type: isFile ? 'file' as const : 'directory' as const, size: isFile ? (localDraft.files[path]?.length ?? localDraft.binaryFiles[path]?.length ?? 0) : 0, depth: path.split('/').length - 1 };
		}).sort((a, b) => a.path.localeCompare(b.path));
	}

	function emitDraft() { onDraftChange?.({ files: { ...localDraft.files }, binaryFiles: { ...localDraft.binaryFiles }, folders: [...localDraft.folders] }); refreshLocal(); }

	async function request(path = '', options?: RequestInit, contentMode = false) {
		if (!apiUrl) throw new Error('Draft workspace has no server endpoint');
		const separator = apiUrl.includes('?') ? '&' : '?';
		const url = options ? apiUrl : `${apiUrl}${separator}path=${encodeURIComponent(path)}${contentMode ? '&content=1' : ''}`;
		const response = await fetch(url, options);
		const data = await response.json();
		if (!response.ok) throw new Error(data.error || 'Workspace operation failed');
		return data;
	}

	async function refresh() {
		loading = true; error = '';
		try {
			const result: Entry[] = [];
			async function load(path: string, depth: number) {
				const data = await request(path);
				for (const entry of data.entries as Entry[]) {
					result.push({ ...entry, depth });
					if (entry.type === 'directory' && expanded.has(entry.path)) await load(entry.path, depth + 1);
				}
			}
			await load('', 0); entries = result;
		} catch (e) { error = e instanceof Error ? e.message : 'Failed to load workspace'; }
		finally { loading = false; }
	}

	async function open(entry: Entry) {
		if (entry.type === 'directory') {
			activePath = entry.path;
			activeType = 'directory';
			expanded.has(entry.path) ? expanded.delete(entry.path) : expanded.add(entry.path);
			expanded = new Set(expanded); apiUrl ? await refresh() : refreshLocal(); return;
		}
		if (activePath && !binary && content !== original) {
			pendingEntry = entry;
			discardDialog = true;
			return;
		}
		if (!apiUrl) {
			activePath = entry.path; activeTab = entry.path; activeType = 'file'; binary = entry.path in localDraft.binaryFiles; content = localDraft.files[entry.path] ?? ''; original = content;
			if (!openPaths.includes(entry.path)) openPaths = [...openPaths, entry.path];
			return;
		}
		loading = true; error = '';
		try {
			const data = await request(entry.path, undefined, true);
			activePath = entry.path; activeTab = entry.path; activeType = 'file'; binary = data.binary; content = data.content ?? ''; original = content; revision = data.revision ?? ''; git = data.git ?? null;
			if (!openPaths.includes(entry.path)) openPaths = [...openPaths, entry.path];
		} catch (e) { error = e instanceof Error ? e.message : 'Failed to open file'; }
		finally { loading = false; }
	}

	async function discardAndOpen() {
		const entry = pendingEntry;
		pendingEntry = null;
		discardDialog = false;
		content = original;
		if (entry) await open(entry);
	}

	export async function reloadFromDisk() {
		if (!apiUrl) return;
		await refresh();
		if (activeType === 'file' && activePath && (binary || content === original)) {
			await open({ path: activePath, name: activePath.split('/').pop()!, type: 'file', size: 0 });
		}
	}

	async function mutate(method: string, body: object): Promise<boolean> {
		error = '';
		if (!apiUrl) {
			const change = body as { path: string; type?: string; destination?: string; content?: string };
			if (method === 'POST') {
				if (change.type === 'directory') localDraft.folders = [...new Set([...localDraft.folders, change.path])];
				else localDraft.files = { ...localDraft.files, [change.path]: '' };
			} else if (method === 'PUT' && change.destination) {
				const from = change.path; const to = change.destination;
				localDraft.files = Object.fromEntries(Object.entries(localDraft.files).map(([path, value]) => [path === from || path.startsWith(`${from}/`) ? `${to}${path.slice(from.length)}` : path, value]));
				localDraft.binaryFiles = Object.fromEntries(Object.entries(localDraft.binaryFiles).map(([path, value]) => [path === from || path.startsWith(`${from}/`) ? `${to}${path.slice(from.length)}` : path, value]));
				localDraft.folders = localDraft.folders.map((path) => path === from || path.startsWith(`${from}/`) ? `${to}${path.slice(from.length)}` : path);
			} else if (method === 'PUT' && typeof change.content === 'string') localDraft.files = { ...localDraft.files, [change.path]: change.content };
			else if (method === 'DELETE') {
				localDraft.files = Object.fromEntries(Object.entries(localDraft.files).filter(([path]) => path !== change.path && !path.startsWith(`${change.path}/`)));
				localDraft.binaryFiles = Object.fromEntries(Object.entries(localDraft.binaryFiles).filter(([path]) => path !== change.path && !path.startsWith(`${change.path}/`)));
				localDraft.folders = localDraft.folders.filter((path) => path !== change.path && !path.startsWith(`${change.path}/`));
			}
			emitDraft(); return true;
		}
		try {
			await request('', { method, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
			await refresh();
			const change = body as { path?: string; destination?: string };
			void onFilesChanged?.([change.path, change.destination].filter((path): path is string => !!path));
			return true;
		}
		catch (e) { error = e instanceof Error ? e.message : 'Workspace operation failed'; return false; }
	}

	function openCreate(type: 'file' | 'directory') {
		const parent = activeType === 'directory' ? `${activePath}/` : activePath.includes('/') ? activePath.slice(0, activePath.lastIndexOf('/') + 1) : '';
		createPath = parent;
		createDialog = type;
	}
	async function submitCreate() {
		if (!createDialog || !createPath.trim()) return;
		if (await mutate('POST', { path: createPath.trim(), type: createDialog })) createDialog = null;
	}
	function openRename() {
		renameName = activePath.split('/').pop() ?? '';
		renameDialog = true;
	}
	async function submitRename() {
		const name = renameName.trim();
		if (!name || name.includes('/')) { error = 'A name cannot contain slashes'; return; }
		const parent = activePath.includes('/') ? activePath.slice(0, activePath.lastIndexOf('/')) : '';
		await relocate(parent ? `${parent}/${name}` : name, () => renameDialog = false);
	}
	function openMove() {
		moveDirectory = activePath.includes('/') ? activePath.slice(0, activePath.lastIndexOf('/')) : '';
		moveDialog = true;
	}
	async function submitMove() {
		const directory = moveDirectory.trim().replace(/^\.?\//, '').replace(/\/$/, '');
		const name = activePath.split('/').pop()!;
		await relocate(directory ? `${directory}/${name}` : name, () => moveDialog = false);
	}
	async function relocate(destination: string, close: () => void) {
		if (!destination || destination === activePath) { close(); return; }
		const previous = activePath;
		if (!(await mutate('PUT', { path: previous, destination }))) return;
		openPaths = openPaths.map((path) => path === previous || path.startsWith(`${previous}/`) ? `${destination}${path.slice(previous.length)}` : path);
		activePath = destination;
		close();
	}
	async function removeActive() {
		if (!activePath) return;
		const deletedPath = activePath;
		if (!(await mutate('DELETE', { path: deletedPath }))) return;
		openPaths = openPaths.filter((path) => path !== deletedPath && !path.startsWith(`${deletedPath}/`));
		if (activePath === deletedPath || activePath.startsWith(`${deletedPath}/`)) {
			activePath = '';
			activeType = '';
			content = '';
		}
		deleteDialog = false;
	}
	async function persist(gitDecision?: 'push' | 'local' | 'internal') {
		saveDialog = null;
		if (!(await mutate('PUT', { path: activePath, content, expectedRevision: revision, gitDecision, commitMessage: gitDecision === 'push' ? commitMessage.trim() : undefined }))) return;
		if (gitDecision === 'push') toast.success('Changes pushed to Git');
		original = content;
		if (gitDecision === 'internal') await onConverted?.();
		if (apiUrl) { const data = await request(activePath, undefined, true); revision = data.revision ?? ''; git = data.git ?? null; }
	}

	function save() {
		if (!git) { void persist(); return; }
		commitMessage = `${git.tracked ? 'Update' : 'Add'} ${activePath}`;
		saveDialog = git.tracked ? 'tracked' : 'untracked';
	}

	function keepLocal() {
		if (saveDialog === 'tracked') saveDialog = 'convert';
		else void persist('local');
	}
	async function upload(event: Event) {
		const file = (event.currentTarget as HTMLInputElement).files?.[0]; if (!file) return;
		const parent = activeType === 'directory' ? `${activePath}/` : activePath.includes('/') ? activePath.slice(0, activePath.lastIndexOf('/') + 1) : '';
		const path = `${parent}${file.name}`;
		if (!apiUrl) {
			const bytes = new Uint8Array(await file.arrayBuffer());
			const isBinary = bytes.includes(0) || (() => { try { new TextDecoder('utf-8', { fatal: true }).decode(bytes); return false; } catch { return true; } })();
			if (isBinary) {
				let value = ''; for (const byte of bytes) value += String.fromCharCode(byte);
				localDraft.binaryFiles = { ...localDraft.binaryFiles, [path]: btoa(value) };
			} else localDraft.files = { ...localDraft.files, [path]: new TextDecoder().decode(bytes) };
			emitDraft(); (event.currentTarget as HTMLInputElement).value = ''; return;
		}
		const form = new FormData(); form.set('path', path); form.set('file', file);
		try { await request('', { method: 'POST', body: form }); await refresh(); void onFilesChanged?.([path]); } catch (e) { error = e instanceof Error ? e.message : 'Upload failed'; }
		(event.currentTarget as HTMLInputElement).value = '';
	}
</script>

<div class="flex min-h-0 flex-1 overflow-hidden">
	{#if explorerOpen}<aside class="flex w-64 shrink-0 flex-col border-r bg-muted/20 max-md:w-40">
		<div class="flex min-h-11 items-center justify-between border-b px-2">
			<span class="text-xs font-semibold uppercase tracking-wide text-muted-foreground">File Explorer</span>
			<div class="flex items-center gap-0.5">{#if !readonly}<Button variant="ghost" size="icon-sm" class="size-8" aria-label="New file" title="New file" onclick={() => openCreate('file')}><FilePlus2 /></Button><Button variant="ghost" size="icon-sm" class="size-8" aria-label="New folder" title="New folder" onclick={() => openCreate('directory')}><FolderPlus /></Button><Button variant="ghost" size="icon-sm" class="size-8" aria-label="Upload file" title="Upload file" onclick={() => uploadInput?.click()}><Upload /></Button><input bind:this={uploadInput} class="hidden" type="file" onchange={upload} />{/if}<Button variant="ghost" size="icon-sm" class="size-8" aria-label="Collapse file explorer" title="Collapse file explorer" onclick={() => explorerOpen = false}><ChevronLeft /></Button></div>
		</div>
		<div class="min-h-0 flex-1 overflow-auto py-1">
			{#if loading && !entries.length}<div class="flex justify-center p-4"><Loader2 class="h-4 w-4 animate-spin" /></div>{/if}
			<button type="button" class="flex min-h-8 w-full items-center gap-1.5 truncate px-2 text-left text-xs font-medium outline-none hover:bg-muted/50 focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring" aria-expanded={rootExpanded} onclick={toggleRoot}><span class="flex size-4 items-center justify-center">{#if rootExpanded}<ChevronDown class="size-3.5" />{:else}<ChevronRight class="size-3.5" />{/if}</span><Folder class="size-3.5 shrink-0 text-muted-foreground" /><span class="truncate">{rootName}</span>{#if rootGit}<span class="ml-auto shrink-0 text-muted-foreground" title={gitLabel(rootGit)}>{#if rootGit.mixed}<GitCompareArrows class="h-3.5 w-3.5" />{:else if rootGit.tracked}<GitBranch class="h-3.5 w-3.5" />{:else}<HardDrive class="h-3.5 w-3.5" />{/if}<span class="sr-only">{gitLabel(rootGit)}</span></span>{/if}</button>
			{#if rootExpanded}{#each entries as entry}
				<button type="button" class="group relative flex min-h-8 w-full items-center gap-1.5 truncate border-l-2 border-transparent pr-2 text-left text-xs outline-none transition-colors hover:bg-muted/50 focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring {activePath === entry.path ? 'border-l-primary bg-primary/12 text-foreground' : ''}" style={`padding-left:${30 + (entry.depth ?? 0) * 20}px`} onclick={() => open(entry)}>
					{#each Array((entry.depth ?? 0) + 1) as _, level}<span class="pointer-events-none absolute inset-y-0 w-px bg-border" style={`left:${18 + level * 20}px`}></span>{/each}
					<span class="flex size-4 shrink-0 items-center justify-center">{#if entry.type === 'directory'}{#if expanded.has(entry.path)}<ChevronDown class="size-3.5" />{:else}<ChevronRight class="size-3.5" />{/if}{/if}</span>
					{#if entry.type === 'directory'}<Folder class="size-3.5 shrink-0 text-muted-foreground" />{:else if fileKind(entry.path) === 'compose' || fileKind(entry.path) === 'yaml'}<FileCode2 class="size-3.5 shrink-0 text-muted-foreground" aria-hidden="true" />{:else if entry.name.endsWith('.txt') || entry.name.endsWith('.md')}<FileText class="size-3.5 shrink-0 text-muted-foreground" aria-hidden="true" />{:else}<File class="size-3.5 shrink-0 text-muted-foreground" aria-hidden="true" />{/if}<span class="truncate">{entry.name}</span>{#if entry.git}<span class="ml-auto shrink-0 text-muted-foreground" title={gitLabel(entry.git)}>{#if entry.git.mixed}<GitCompareArrows class="h-3.5 w-3.5" />{:else if entry.git.tracked}<GitBranch class="h-3.5 w-3.5" />{:else if entry.git.ignored}<HardDrive class="h-3.5 w-3.5" />{:else}<CircleDashed class="h-3.5 w-3.5" />{/if}<span class="sr-only">{gitLabel(entry.git)}</span></span>{/if}
				</button>
			{/each}{/if}
		</div>
	</aside>{/if}
	<section class="flex min-w-0 flex-1 flex-col">
		<div class="flex min-h-10 overflow-x-auto border-b"><div class="relative flex shrink-0 items-center border-r transition-colors hover:bg-muted/40 {activeTab === 'stack-config' ? 'after:absolute after:inset-x-0 after:bottom-0 after:h-0.5 after:bg-primary font-medium' : ''}">{#if !explorerOpen}<Button variant="ghost" size="icon-sm" class="ml-1 size-8" aria-label="Expand file explorer" title="Expand file explorer" onclick={() => explorerOpen = true}><PanelLeftOpen /></Button>{/if}<button class="flex min-h-10 items-center gap-2 px-3 py-2 text-xs" onclick={() => selectStackConfig()}><Settings2 class="size-3.5 text-muted-foreground" /><span>Stack Config</span></button></div>{#each openPaths as path}<div class="group relative flex min-h-10 shrink-0 items-center border-r transition-colors hover:bg-muted/40 {path === activeTab ? 'after:absolute after:inset-x-0 after:bottom-0 after:h-0.5 after:bg-primary font-medium' : ''}"><button class="flex min-h-10 items-center gap-2 py-2 pl-3 font-mono text-xs" onclick={() => { const entry = entries.find((item) => item.path === path); if (entry) open(entry); }}><File class="size-3.5 shrink-0 text-muted-foreground" aria-hidden="true" /><span>{path.split('/').pop()}</span></button><button type="button" aria-label={`Close ${path.split('/').pop()}`} class="mx-1 flex size-5 items-center justify-center rounded opacity-0 transition-opacity hover:bg-muted group-hover:opacity-100 focus:opacity-100" onclick={(event) => closePath(path, event)}><X class="size-3" /></button></div>{/each}</div>
		{#if error}<div class="border-b bg-destructive/10 px-3 py-2 text-xs text-destructive">{error}</div>{/if}
		{#if activeTab === 'stack-config'}
			<p class="border-b px-3 py-2 text-xs text-muted-foreground">Preview compose and environment values here.{#if !readonly} Select a file in the explorer to edit it.{/if}</p>
			{#if stackConfig}{@render stackConfig()}{/if}
		{:else if activePath}
			<div class="flex min-h-11 items-center justify-between border-b px-3"><nav aria-label="Current file" class="truncate font-mono text-xs text-muted-foreground">{activePath.split('/').join(' / ')}</nav>{#if !readonly}<div class="flex items-center gap-1"><Button variant="ghost" size="sm" onclick={openRename}><FilePenLine /> Rename</Button><Button variant="ghost" size="sm" onclick={openMove}><FolderInput /> Move</Button><Button variant="ghost" size="icon-sm" aria-label={`Delete ${activePath}`} title="Delete" class="text-muted-foreground hover:text-destructive" onclick={() => deleteDialog = true}><Trash2 /></Button>{#if activeType === 'file'}<Button size="sm" disabled={binary || content === original} onclick={save}><Save /> Save</Button>{/if}</div>{/if}</div>
			{#if activeType === 'directory'}<div class="flex flex-1 items-center justify-center text-sm text-muted-foreground">Folder selected. Use the toolbar to rename, move, or delete it.</div>{:else if binary}<div class="flex flex-1 items-center justify-center text-sm text-muted-foreground">Binary file. It can be managed but not edited as text.</div>{:else}<CodeEditor value={content} language={editorLanguage(activePath)} {readonly} {theme} onchange={(value) => content = value} class="min-h-0 flex-1 overflow-hidden" />{/if}
		{:else}<div class="flex flex-1 items-center justify-center text-sm text-muted-foreground">Select a file to open it.</div>{/if}
	</section>
</div>

<Dialog.Root open={createDialog !== null} onOpenChange={(open) => { if (!open) createDialog = null; }}>
	<Dialog.Content class="max-w-md">
		<Dialog.Header><Dialog.Title>{createDialog === 'directory' ? 'New folder' : 'New file'}</Dialog.Title><Dialog.Description>Enter a path relative to the stack directory.</Dialog.Description></Dialog.Header>
		<Input bind:value={createPath} placeholder={createDialog === 'directory' ? 'config' : 'config/app.conf'} onkeydown={(event) => event.key === 'Enter' && submitCreate()} />
		<Dialog.Footer><Button variant="outline" onclick={() => createDialog = null}>Cancel</Button><Button onclick={submitCreate}>Create</Button></Dialog.Footer>
	</Dialog.Content>
</Dialog.Root>

<Dialog.Root open={saveDialog !== null} onOpenChange={(open) => { if (!open) saveDialog = null; }}>
	<Dialog.Content class="max-w-md">
		<Dialog.Header>
			<Dialog.Title>{saveDialog === 'untracked' ? 'Save untracked file' : saveDialog === 'convert' ? 'Convert stack to Internal?' : 'Save Git-tracked file'}</Dialog.Title>
			<Dialog.Description>
				{#if saveDialog === 'untracked'}Choose whether to add <code>{activePath}</code> to Git or keep it only on this host.
				{:else if saveDialog === 'tracked'}Push this change to Git, or keep it {hawserHost ? 'on the Hawser host' : 'local'} by converting the stack to Internal.
				{:else}Tracked files cannot safely remain host-only while Git synchronization is active. This will disable Git synchronization and webhooks, preserve the stack files, and save this change {hawserHost ? 'on the Hawser host' : 'locally'}.{/if}
			</Dialog.Description>
		</Dialog.Header>
		{#if saveDialog !== 'convert'}
			<div class="space-y-2"><label for="workspace-commit-message" class="text-sm font-medium">Commit message</label><Input id="workspace-commit-message" bind:value={commitMessage} /></div>
		{/if}
		<Dialog.Footer>
			<Button variant="outline" onclick={() => saveDialog = null}>Cancel</Button>
			{#if saveDialog === 'convert'}
				<Button onclick={() => persist('internal')}>Convert & save {hawserHost ? 'on Hawser' : 'locally'}</Button>
			{:else}
				<Button variant="outline" onclick={keepLocal}>Keep {hawserHost ? 'on Hawser host' : 'local only'}</Button>
				<Button onclick={() => persist('push')} disabled={!commitMessage.trim()}>{saveDialog === 'untracked' ? 'Track & push' : 'Push changes'}</Button>
			{/if}
		</Dialog.Footer>
	</Dialog.Content>
</Dialog.Root>

<Dialog.Root bind:open={discardDialog} onOpenChange={(open) => { if (!open) pendingEntry = null; }}>
	<Dialog.Content class="max-w-sm">
		<Dialog.Header>
			<Dialog.Title>Discard unsaved changes?</Dialog.Title>
			<Dialog.Description>Your edits to <code>{activePath}</code> have not been saved. Discard them and open <code>{pendingEntry?.name ?? 'the selected file'}</code>?</Dialog.Description>
		</Dialog.Header>
		<Dialog.Footer>
			<Button variant="outline" onclick={() => discardDialog = false}>Keep editing</Button>
			<Button variant="destructive" onclick={discardAndOpen}>Discard changes</Button>
		</Dialog.Footer>
	</Dialog.Content>
</Dialog.Root>

<Dialog.Root bind:open={renameDialog}>
	<Dialog.Content class="max-w-md">
		<Dialog.Header><Dialog.Title>Rename {activeType === 'directory' ? 'folder' : 'file'}</Dialog.Title><Dialog.Description>Change the name without moving it from its current folder.</Dialog.Description></Dialog.Header>
		<Input bind:value={renameName} onkeydown={(event) => event.key === 'Enter' && submitRename()} />
		<Dialog.Footer><Button variant="outline" onclick={() => renameDialog = false}>Cancel</Button><Button onclick={submitRename}>Rename</Button></Dialog.Footer>
	</Dialog.Content>
</Dialog.Root>

<Dialog.Root bind:open={moveDialog}>
	<Dialog.Content class="max-w-md">
		<Dialog.Header><Dialog.Title>Move {activeType === 'directory' ? 'folder' : 'file'}</Dialog.Title><Dialog.Description>Enter the destination folder relative to the stack directory. Leave it empty to move to the root.</Dialog.Description></Dialog.Header>
		<div class="space-y-2"><label for="workspace-move-directory" class="text-sm font-medium">Destination folder</label><Input id="workspace-move-directory" bind:value={moveDirectory} placeholder="config" onkeydown={(event) => event.key === 'Enter' && submitMove()} /><p class="truncate text-xs text-muted-foreground">New path: {moveDirectory ? `${moveDirectory.replace(/\/$/, '')}/` : ''}{activePath.split('/').pop()}</p></div>
		<Dialog.Footer><Button variant="outline" onclick={() => moveDialog = false}>Cancel</Button><Button onclick={submitMove}>Move</Button></Dialog.Footer>
	</Dialog.Content>
</Dialog.Root>

<Dialog.Root bind:open={deleteDialog}>
	<Dialog.Content class="max-w-sm">
		<Dialog.Header><Dialog.Title>Delete {activeType === 'directory' ? 'folder' : 'file'}?</Dialog.Title><Dialog.Description>This permanently deletes <code>{activePath}</code>{activeType === 'directory' ? ' and everything inside it' : ''}.</Dialog.Description></Dialog.Header>
		<Dialog.Footer><Button variant="outline" onclick={() => deleteDialog = false}>Cancel</Button><Button variant="destructive" onclick={removeActive}>Delete</Button></Dialog.Footer>
	</Dialog.Content>
</Dialog.Root>
