<script lang="ts">
	import type { Snippet } from 'svelte';
	import { FolderOpen } from 'lucide-svelte';
	import CodeEditor, { type LintMarker, type VariableMarker } from '$lib/components/CodeEditor.svelte';
	import * as Tabs from '$lib/components/ui/tabs';
	import type { StackFileEditorDraft } from '$lib/stack-file-editor';

	interface Props {
		composePaths?: string[];
		composeContents?: Record<string, string>;
		readonly?: boolean;
		theme?: 'light' | 'dark';
		onChange?: (draft: StackFileEditorDraft) => void;
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
		readonly = false,
		theme = 'dark',
		onChange,
		initialPath = '',
		onActivePathChange,
		variableMarkers = [],
		lintMarkers = [],
		onLintClick,
		headerActions,
		editorOverlay
	}: Props = $props();

	let activePath = $state('');
	const activeContent = $derived(composeContents[activePath] ?? '');

	$effect(() => {
		if (!composePaths.includes(activePath)) activePath = composePaths[0] ?? '';
		if (initialPath && composePaths.includes(initialPath) && activePath !== initialPath) activePath = initialPath;
	});

	function selectPath(path: string) {
		activePath = path;
		onActivePathChange?.(path);
	}

	function changeContent(content: string) {
		onChange?.({
			composePaths: [...composePaths],
			composeContents: { ...composeContents, [activePath]: content }
		});
	}
</script>

<div class="flex min-h-0 flex-1 flex-col px-4 py-4 sm:px-8 sm:py-6">
	{#if headerActions}
		<div class="mb-3.5 flex flex-wrap items-center justify-end gap-3">
			{@render headerActions()}
		</div>
	{/if}

	{#if composePaths.filter(Boolean).length > 0}
		<Tabs.Root value={activePath} onValueChange={selectPath} class="flex-wrap border-b border-zinc-200 dark:border-zinc-700">
			<Tabs.List class="flex w-full flex-wrap justify-start gap-0.5 rounded-none bg-transparent p-0">
				{#each composePaths.filter(Boolean) as path}
					<Tabs.Trigger value={path} class="min-w-0 break-all rounded-none border-b-2 px-3.5 py-2.5 font-mono text-xs data-[state=active]:border-primary">{path.split('/').pop()}</Tabs.Trigger>
				{/each}
			</Tabs.List>
		</Tabs.Root>

		<div class="flex min-h-0 flex-1 flex-col overflow-hidden rounded-lg border border-zinc-200 bg-zinc-50 dark:border-zinc-700 dark:bg-zinc-900/40">
			<div class="flex items-center justify-between gap-3 border-b border-zinc-200 bg-zinc-100/80 px-3.5 py-2 dark:border-zinc-700 dark:bg-zinc-800/60">
				<div class="min-w-0 flex-1 truncate font-mono text-[11px] text-muted-foreground" title={activePath}>{activePath}</div>
			</div>
			<div class="relative flex min-h-0 flex-1">
				<CodeEditor value={activeContent} language="yaml" {readonly} {theme} onchange={readonly ? undefined : changeContent} {variableMarkers} {lintMarkers} onLintClick={onLintClick} class="min-h-0 flex-1 overflow-hidden" />
				{#if editorOverlay}{@render editorOverlay()}{/if}
			</div>
		</div>
	{:else}
		<div class="flex flex-1 flex-col items-center justify-center gap-3 rounded-lg border border-dashed text-sm text-muted-foreground">
			<FolderOpen class="h-8 w-8 opacity-50" />
			<span>Select a Compose file.</span>
		</div>
	{/if}
</div>
