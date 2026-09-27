<script lang="ts">
	import { tick } from 'svelte';
	import { Button } from '$lib/components/ui/button';
	import StackEnvVarsEditor, { type EnvVar, type ValidationResult } from '$lib/components/StackEnvVarsEditor.svelte';
	import CodeEditor from '$lib/components/CodeEditor.svelte';
	import ConfirmPopover from '$lib/components/ConfirmPopover.svelte';
	import { Plus, Upload, Trash2, List, FileText, ShieldAlert, HelpCircle, Info } from 'lucide-svelte';
	import * as Tooltip from '$lib/components/ui/tooltip';
	import { providerTypeLabel } from '../../routes/settings/secrets/ProviderModal.svelte';
	import { effectiveMissing, isInlineProviderRef } from '$lib/utils/invault-markers';
	import { parseRawContent, generateRawContent, keysInRawContent, mergeParsedIntoVariables, textEditorContent as deriveTextEditorContent } from '$lib/utils/env-panel-core';

	interface Props {
		variables: EnvVar[]; // Bindable - ALL variables (secrets + non-secrets)
		rawContent?: string; // Bindable - raw .env file content (comments preserved, no secrets)
		validation?: ValidationResult | null;
		readonly?: boolean;
		showSource?: boolean;
		sources?: Record<string, 'file' | 'override'>;
		fileValues?: Record<string, string>;
		placeholder?: { key: string; value: string };
		infoText?: string;
		existingSecretKeys?: Set<string>;
		/** Provider-injected key NAMES from the last deploy (banner). */
		injectedSecretKeys?: string[];
		/** Bound provider type/name, for the injected banner + pills. */
		providerType?: string | null;
		providerName?: string | null;
		/**
		 * Whether a secret provider is CURRENTLY bound to this stack. When false but
		 * injectedSecretKeys is non-empty, the keys are historical (from the last deploy)
		 * and the next deploy will drop them - the banner says so instead of implying they
		 * are still active (#1522).
		 */
		providerBound?: boolean;
		/** Set when the live provider probe failed - shown as an amber line. */
		probeError?: string | null;
		/** Key NAMES the live probe found in the bound provider (present RIGHT NOW).
		 *  These are not "missing" even without a local value. Empty on probe failure. */
		providerKeySet?: Set<string>;
		theme?: 'light' | 'dark';
		class?: string;
		onchange?: () => void;
	}

	let {
		variables = $bindable([]),
		rawContent = $bindable(''),
		validation = null,
		readonly = false,
		showSource = false,
		sources = {},
		fileValues = {},
		placeholder = { key: 'VARIABLE_NAME', value: 'value' },
		infoText,
		existingSecretKeys = new Set<string>(),
		injectedSecretKeys = [],
		providerType = null,
		providerName = null,
		providerBound = true,
		probeError = null,
		providerKeySet = new Set<string>(),
		theme = 'dark',
		class: className = '',
		onchange
	}: Props = $props();


	// A ${VAR} the bound provider currently supplies (LIVE probe) is NOT "missing" even
	// without a local value. Drop those from the panel's missing count / "Add missing"
	// list so the panel matches the editor's IN VAULT markers - same source, one truth.
	// This is purely live: the last-deploy injected names drive only the banner, never
	// this set. A failed probe leaves providerKeySet empty, so those keys stay missing.
	const effectiveValidation = $derived.by<ValidationResult | null>(() => {
		if (!validation || providerKeySet.size === 0) return validation;
		return {
			...validation,
			missing: effectiveMissing(validation.missing, providerKeySet)
		};
	});

	const STORAGE_KEY_VIEW_MODE = 'dockhand-env-vars-view-mode';

	let fileInputRef: HTMLInputElement;
	let viewMode = $state<'form' | 'text'>(
		(typeof localStorage !== 'undefined' && localStorage.getItem(STORAGE_KEY_VIEW_MODE) as 'form' | 'text') || 'form'
	);
	let confirmClearOpen = $state(false);
	let contentAreaRef: HTMLDivElement;
	let parseWarnings = $state<string[]>([]);

	// Count of secrets (for display in hint)
	const secretCount = $derived(variables.filter(v => v.isSecret && v.key.trim()).length);

	// True when any variable's VALUE is a provider reference. Such a reference is
	// resolved only here (stack env), never when written straight into a compose
	// environment: block - so we surface a hint.
	const hasProviderReference = $derived(
		variables.some((v) => isInlineProviderRef((v.value ?? '').trim()))
	);

	// What text view shows: the .env file, or the non-secret rows rendered as text when
	// there is no file yet.
	const textEditorContent = $derived(deriveTextEditorContent(rawContent, variables));

	/**
	 * Sync variables with rawContent after initial load.
	 * Pass the loaded data directly to avoid timing issues with bindable props.
	 * Merges: secrets from loadedVars (DB) + non-secrets from loadedRaw (file).
	 */
	export function syncAfterLoad(loadedVars: EnvVar[], loadedRaw: string) {
		if (!loadedRaw.trim()) {
			// No raw content from file - just set variables; text view renders them as text
			variables = loadedVars;
			rawContent = '';
			return;
		}

		const { vars: rawVars } = parseRawContent(loadedRaw);

		// Secrets come from loadedVars (DB), non-secrets come from loadedRaw (file)
		const secrets = loadedVars.filter(v => v.isSecret);

		// Also keep non-secrets from loadedVars that aren't in raw (new vars added before first save)
		const rawKeys = new Set(rawVars.map(v => v.key));
		const newNonSecrets = loadedVars.filter(v => !v.isSecret && v.key.trim() && !rawKeys.has(v.key));

		// Set both at once to avoid any intermediate states
		variables = [...rawVars, ...newNonSecrets, ...secrets];
		rawContent = loadedRaw;
	}


	/**
	 * Sync variables (non-secrets) TO rawContent.
	 * Preserves comments and formatting. Secrets are excluded.
	 */
	function syncVariablesToRaw() {
		const nonSecretVars = variables.filter(v => v.key.trim() && !v.isSecret);

		// If no raw content exists, generate fresh
		if (!rawContent.trim()) {
			if (nonSecretVars.length > 0) {
				rawContent = generateRawContent(nonSecretVars);
			}
			return;
		}

		// Update existing raw content - preserve comments, update/add/remove variables
		const varMap = new Map(nonSecretVars.map(v => [v.key.trim(), v]));
		const usedKeys = new Set<string>();
		const lines = rawContent.split('\n');
		const resultLines: string[] = [];

		for (const line of lines) {
			const trimmed = line.trim();

			// Keep comments and blank lines
			if (!trimmed || trimmed.startsWith('#')) {
				resultLines.push(line);
				continue;
			}

			// Check if this is a variable line
			const eqIndex = trimmed.indexOf('=');
			if (eqIndex > 0) {
				const key = trimmed.slice(0, eqIndex).trim();
				if (/^[a-zA-Z_][a-zA-Z0-9_]*$/.test(key)) {
					const varData = varMap.get(key);
					if (varData) {
						// Update value
						resultLines.push(`${key}=${varData.value}`);
						usedKeys.add(key);
					}
					// If not in varMap, variable was deleted - skip line
					continue;
				}
			}

			resultLines.push(line);
		}

		// Append new variables
		for (const v of nonSecretVars) {
			if (!usedKeys.has(v.key.trim())) {
				resultLines.push(`${v.key.trim()}=${v.value}`);
			}
		}

		let result = resultLines.join('\n');
		if (result && !result.endsWith('\n')) {
			result += '\n';
		}
		rawContent = result;
	}

	/**
	 * Parse editor text back into variables.
	 *
	 * `shownBefore` is what the editor was displaying before this text arrived. Rows
	 * outside it were never on screen - a selector written straight into variables by
	 * the provider picker, say - so they are kept rather than wiped (#1620). Rows that
	 * WERE on screen and are absent from the new text were deleted by the user.
	 */
	function syncRawToVariables(content?: string, shownBefore?: Set<string>) {
		const { vars, warnings } = parseRawContent(content ?? rawContent);
		parseWarnings = warnings;
		variables = mergeParsedIntoVariables(vars, variables, shownBefore ?? keysInRawContent(textEditorContent));
	}

	/**
	 * Call before saving. Ensures variables and rawContent are in sync.
	 * Always syncs variables→raw to get proper .env content for disk.
	 */
	export function prepareForSave(): { rawContent: string; variables: EnvVar[] } {
		// If in text view, first sync raw->variables to capture edits. Parse what the
		// editor SHOWS: with an empty .env that is the rows rendered as text, and reading
		// rawContent instead would drop every visible non-secret row (#1620).
		if (viewMode === 'text') {
			syncRawToVariables(textEditorContent);
		}
		// Then sync variables→raw to ensure rawContent is up to date
		syncVariablesToRaw();

		return {
			rawContent,
			variables: variables.filter(v => v.key.trim())
		};
	}

	function handleTextChange(value: string) {
		// Capture what was on screen BEFORE the edit, so a row the user just deleted is
		// not mistaken for one the editor never showed.
		const shownBefore = keysInRawContent(textEditorContent);
		rawContent = value;
		syncRawToVariables(value, shownBefore); // keeps parent's envVars live for compose decorations
		onchange?.();
	}

	function handleViewModeChange(newMode: 'form' | 'text') {
		if (newMode === 'text' && viewMode === 'form') {
			// Form → Text: sync variables to raw (preserves comments)
			syncVariablesToRaw();
		} else if (newMode === 'form' && viewMode === 'text') {
			// Text -> Form: parse what the editor shows, which is the rows rendered as text
			// when there is no .env file (keeps vars that only exist as rows)
			syncRawToVariables(textEditorContent);
		}

		viewMode = newMode;
		localStorage.setItem(STORAGE_KEY_VIEW_MODE, newMode);
	}

	async function addEnvVariable() {
		variables = [...variables, { key: '', value: '', isSecret: false }];
		onchange?.();
		await tick();
		if (contentAreaRef) {
			contentAreaRef.scrollTop = contentAreaRef.scrollHeight;
		}
	}

	async function addMissingVariable(key: string) {
		variables = [...variables, { key, value: '', isSecret: false }];
		onchange?.();
		await tick();
		if (contentAreaRef) {
			contentAreaRef.scrollTop = contentAreaRef.scrollHeight;
		}
	}

	function handleLoadFromFile() {
		fileInputRef?.click();
	}

	function handleFileSelect(event: Event) {
		const input = event.target as HTMLInputElement;
		const file = input.files?.[0];
		if (!file) return;

		const reader = new FileReader();
		reader.onload = (e) => {
			rawContent = e.target?.result as string;
			// Parse and merge with existing secrets
			syncRawToVariables();
			// Switch to text view to show loaded content
			viewMode = 'text';
			localStorage.setItem(STORAGE_KEY_VIEW_MODE, 'text');
			onchange?.();
		};
		reader.readAsText(file);
		input.value = '';
	}

	function clearAll() {
		rawContent = '';
		variables = [];
		onchange?.();
	}

	const hasContent = $derived(!!rawContent?.trim() || variables.some(v => v.key.trim()));
</script>

<div class="flex flex-col h-full {className}">
	<div class="mb-3 flex flex-col gap-2">
		<div class="flex flex-wrap items-center justify-between gap-2">
			<div class="flex flex-wrap items-center gap-2 min-w-0">
				<div class="flex items-center gap-0.5 rounded bg-zinc-100 p-0.5 dark:bg-zinc-800">
					<button type="button" class="flex items-center gap-1 rounded px-1.5 py-0.5 text-2xs transition-colors max-md:p-2 {viewMode === 'form' ? 'bg-white text-zinc-800 shadow-sm dark:bg-zinc-700 dark:text-zinc-100' : 'text-zinc-500 hover:text-zinc-700 dark:text-zinc-400 dark:hover:text-zinc-200'}" onclick={() => handleViewModeChange('form')} title="Form view">
						<List class="h-3 w-3" />
					</button>
					<button type="button" class="flex items-center gap-1 rounded px-1.5 py-0.5 text-2xs transition-colors max-md:p-2 {viewMode === 'text' ? 'bg-white text-zinc-800 shadow-sm dark:bg-zinc-700 dark:text-zinc-100' : 'text-zinc-500 hover:text-zinc-700 dark:text-zinc-400 dark:hover:text-zinc-200'}" onclick={() => handleViewModeChange('text')} title="Text view">
						<FileText class="h-3 w-3" />
					</button>
				</div>
				{#if effectiveValidation}
					<div class="flex flex-wrap gap-1">
						{#if effectiveValidation.missing.length > 0}
							<span class="inline-flex items-center rounded bg-red-100 px-1.5 py-0.5 text-2xs font-medium text-red-700 dark:bg-red-900/30 dark:text-red-300">{effectiveValidation.missing.length} missing</span>
						{/if}
						{#if effectiveValidation.required.length > 0}
							<span class="inline-flex items-center rounded bg-green-100 px-1.5 py-0.5 text-2xs font-medium text-green-700 dark:bg-green-900/30 dark:text-green-300">{effectiveValidation.required.length - effectiveValidation.missing.length} defined</span>
						{/if}
					</div>
				{/if}
			</div>
			<div class="flex items-center gap-1 shrink-0 max-md:ml-auto">
				{#if infoText}
					<Tooltip.Root>
						<Tooltip.Trigger><HelpCircle class="h-3.5 w-3.5 cursor-help text-muted-foreground" /></Tooltip.Trigger>
						<Tooltip.Content class="max-w-xs text-xs">{@html infoText}</Tooltip.Content>
					</Tooltip.Root>
				{/if}
				<Tooltip.Root>
					<Tooltip.Trigger>
						<button type="button" class="flex h-7 w-7 items-center justify-center rounded-md border border-zinc-200 text-muted-foreground hover:text-foreground dark:border-zinc-700 max-md:h-9 max-md:w-9" aria-label="Show syntax legend">
							<HelpCircle class="h-3.5 w-3.5" />
						</button>
					</Tooltip.Trigger>
					<Tooltip.Content class="max-w-xs">
						<div class="space-y-1.5 text-xs">
							<p><code>${'{VAR}'}</code> — required</p>
							<p><code>${'{VAR:-default}'}</code> — optional</p>
							<p><code>${'{VAR:?error}'}</code> — required w/ error</p>
						</div>
					</Tooltip.Content>
				</Tooltip.Root>
				{#if !readonly}
					<Button type="button" size="sm" variant="ghost" onclick={handleLoadFromFile} class="h-7 px-2 text-xs max-md:h-9">
						<Upload class="h-3.5 w-3.5" />
						Load
					</Button>
					<Button type="button" size="sm" variant="ghost" onclick={addEnvVariable} class="h-7 px-2 text-xs max-md:h-9">
						<Plus class="h-3.5 w-3.5" />
						Add
					</Button>
					<ConfirmPopover
						bind:open={confirmClearOpen}
						title="Clear all variables?"
						action="clear"
						itemType="environment variables"
						confirmText="Clear all"
						onConfirm={clearAll}
						onOpenChange={(o) => confirmClearOpen = o}
					>
						{#snippet children({ open })}
							<Button
								type="button"
								size="sm"
								variant="ghost"
								class="h-7 px-2 text-xs max-md:h-9 {hasContent ? 'text-destructive hover:text-destructive' : 'text-muted-foreground/50 cursor-not-allowed'}"
								disabled={!hasContent}
							>
								<Trash2 class="h-3.5 w-3.5" />
								Clear
							</Button>
						{/snippet}
					</ConfirmPopover>
				{/if}
			</div>
		</div>
		{#if viewMode === 'text' && secretCount > 0}
			<div class="flex items-start gap-2 rounded border border-amber-200 bg-amber-50 px-2.5 py-2 text-xs text-amber-700 dark:border-amber-800/50 dark:bg-amber-900/20 dark:text-amber-300">
				<ShieldAlert class="h-4 w-4 shrink-0" />
				{secretCount} secret{secretCount === 1 ? '' : 's'} not shown. Secrets are injected at deploy and never written to disk.
			</div>
		{/if}
		{#if hasProviderReference}
			<div class="flex items-start gap-2 rounded border border-amber-200 bg-amber-50 px-2.5 py-2 text-xs text-amber-700 dark:border-amber-800/50 dark:bg-amber-900/20 dark:text-amber-300">
				<Info class="h-4 w-4 shrink-0" />
				Provider references resolve in the stack environment, not directly in a Compose <code>environment:</code> block. Reference the variable there using <code>${'{VAR}'}</code>.
			</div>
		{/if}
		{#if viewMode === 'form' && parseWarnings.length > 0}
			<div class="rounded border border-amber-200 bg-amber-50 px-2.5 py-2 text-xs text-amber-700 dark:border-amber-800/50 dark:bg-amber-900/20 dark:text-amber-300">
				Some lines couldn't be parsed:
				<ul class="list-inside list-disc">
					{#each parseWarnings.slice(0, 3) as warning}<li>{warning}</li>{/each}
					{#if parseWarnings.length > 3}<li>...and {parseWarnings.length - 3} more</li>{/if}
				</ul>
				Switch to text view to edit these lines.
			</div>
		{/if}
		{#if injectedSecretKeys.length > 0}
			<div class="rounded border px-2.5 py-2 text-xs {providerBound ? 'border-emerald-200 bg-emerald-50 text-emerald-700 dark:border-emerald-800/50 dark:bg-emerald-900/20 dark:text-emerald-300' : 'border-amber-200 bg-amber-50 text-amber-700 dark:border-amber-800/50 dark:bg-amber-900/20 dark:text-amber-300'}">
				{#if providerBound}
					<strong>{injectedSecretKeys.length} secret{injectedSecretKeys.length === 1 ? '' : 's'} loaded</strong>
					from {providerType ? providerTypeLabel(providerType) : 'the provider'}{providerName ? ` · ${providerName}` : ''} at last deploy, never written to <code>.env</code>.
				{:else}
					<strong>No secret provider is bound.</strong> These {injectedSecretKeys.length} secret{injectedSecretKeys.length === 1 ? ' was' : 's were'} injected at last deploy; the next deploy will drop {injectedSecretKeys.length === 1 ? 'it' : 'them'}. Reselect a provider to keep them.
				{/if}
				<div class="mt-1 flex flex-wrap gap-1">
					{#each injectedSecretKeys as key}<span class="rounded-full border px-2 py-0.5 font-mono">{key}</span>{/each}
				</div>
			</div>
		{/if}
		{#if probeError}
			<div class="rounded border border-amber-200 bg-amber-50 px-2.5 py-2 text-xs text-amber-700 dark:border-amber-800/50 dark:bg-amber-900/20 dark:text-amber-300">
				Couldn't check {providerName ?? 'the secret provider'}: {probeError}
			</div>
		{/if}
		{#if viewMode === 'form' && effectiveValidation && effectiveValidation.missing.length > 0 && !readonly}
			<div class="flex flex-wrap items-center gap-1">
				<span class="mr-1 text-xs text-muted-foreground">Add missing:</span>
				{#each effectiveValidation.missing as missing}
					<button type="button" onclick={() => addMissingVariable(missing)} class="rounded bg-red-100 px-1.5 py-0.5 text-xs text-red-700 transition-colors hover:bg-red-200 dark:bg-red-900/30 dark:text-red-300 dark:hover:bg-red-900/50">{missing}</button>
				{/each}
			</div>
		{/if}
	</div>
	{#if !readonly}
		<input
			bind:this={fileInputRef}
			type="file"
			accept=".env,.env.*,text/plain"
			class="hidden"
			onchange={handleFileSelect}
		/>
	{/if}
	<!-- Content area -->
	<div bind:this={contentAreaRef} class="flex-1 overflow-auto pt-2.5">
		{#if viewMode === 'form'}
			<StackEnvVarsEditor
				bind:variables
				validation={effectiveValidation}
				{readonly}
				{showSource}
				{sources}
				{fileValues}
				{placeholder}
				{existingSecretKeys}
				{onchange}
			/>
		{:else}
			<CodeEditor
				value={textEditorContent}
				language="dotenv"
				theme={theme}
				readonly={readonly}
				onchange={handleTextChange}
				class="h-full min-h-[200px] rounded-md overflow-hidden border border-zinc-200 dark:border-zinc-700"
			/>
		{/if}
	</div>
</div>
