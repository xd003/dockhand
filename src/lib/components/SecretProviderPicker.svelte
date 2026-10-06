<script lang="ts">
	import { Label } from '$lib/components/ui/label';
	import { Input } from '$lib/components/ui/input';
	import * as Select from '$lib/components/ui/select';
	import { getProviderIcon } from '$lib/components/provider-icons';
	import { BULK_SELECTOR_FIELDS } from '../../routes/settings/secrets/ProviderModal.svelte';
	import { SELECTOR_VARS, BULK_SELECTOR_VAR, bulkSelectorValue as selectorValueOf } from '$lib/utils/bulk-selector';
	import { parseInfisicalSelector, formatInfisicalSelector, type InfisicalScope } from '$lib/utils/infisical-selector';
	import type { EnvVar } from '$lib/components/StackEnvVarsEditor.svelte';

	type ProviderOption = { id: number; name: string; type: string };

	interface Props {
		secretProviderId: number | null;
		/** ALL env vars - the bulk-selector field is a live view of the
		 *  DOCKHAND_SECRET_SELECTOR row within this list. */
		envVars: EnvVar[];
		providers: ProviderOption[];
		/** Suffix for element ids so two pickers on one page don't collide. */
		idSuffix?: string;
		onchange?: () => void;
	}

	let {
		secretProviderId = $bindable(null),
		envVars = $bindable([]),
		providers,
		idSuffix = '',
		onchange
	}: Props = $props();

	const selectedType = $derived(providers.find((p) => p.id === secretProviderId)?.type ?? null);
	const bulkSelectorField = $derived(selectedType ? BULK_SELECTOR_FIELDS[selectedType] ?? null : null);

	// Live view of the DOCKHAND_SECRET_SELECTOR (or legacy OP_ENVIRONMENT_ID) row.
	const bulkSelectorValue = $derived(selectorValueOf(envVars));
	function writeSelector(value: string) {
		const others = envVars.filter((v) => !SELECTOR_VARS.includes(v.key.trim()));
		envVars = value.trim()
			? [...others, { key: BULK_SELECTOR_VAR, value, isSecret: false }]
			: others;
		onchange?.();
	}

	// The selector is provider-specific (a 1Password Environment id, an Infisical
	// project scope, a Vault path, ...), so it goes with the provider: unbinding
	// (None) or switching to a provider of another type drops the stale row.
	function selectProvider(value: string) {
		const next = value ? parseInt(value) : null;
		const nextType = providers.find((p) => p.id === next)?.type ?? null;
		if (next === null || nextType !== selectedType) {
			envVars = envVars.filter((v) => !SELECTOR_VARS.includes(v.key.trim()));
		}
		secretProviderId = next;
		onchange?.();
	}

	// --- Infisical: pick the project / environment from what the identity can read.
	type ProjectOption = { id: string; name: string; environments: { slug: string; name: string }[] };
	type ProjectList = {
		providerId: number;
		projects: ProjectOption[] | null;
		defaults: { projectId: string; environment: string; path: string };
		error: string;
	};
	let projectList = $state<ProjectList | null>(null);

	$effect(() => {
		const id = secretProviderId;
		if (id === null || selectedType !== 'infisical') return;
		const controller = new AbortController();
		projectList = null;
		fetch(`/api/secret-providers/${id}/projects`, { signal: controller.signal })
			.then((res) => res.json())
			.then((data) => {
				projectList = {
					providerId: id,
					projects: data?.ok ? data.projects : null,
					defaults: data?.defaults ?? { projectId: '', environment: '', path: '' },
					error: data?.ok ? '' : data?.error || 'Could not list projects'
				};
			})
			.catch((e) => {
				if (controller.signal.aborted) return;
				projectList = { providerId: id, projects: null, defaults: { projectId: '', environment: '', path: '' }, error: e instanceof Error ? e.message : 'Could not list projects' };
			});
		return () => controller.abort();
	});

	// Only the list for the currently bound provider counts (a stale one is mid-refetch).
	const infisical = $derived(
		selectedType === 'infisical' && projectList?.providerId === secretProviderId && projectList.projects ? projectList : null
	);
	const scope = $derived(parseInfisicalSelector(bulkSelectorValue));
	const effectiveProjectId = $derived(scope.projectId || infisical?.defaults.projectId || '');
	const environmentOptions = $derived(
		infisical?.projects?.find((p) => p.id === effectiveProjectId)?.environments ?? []
	);
	const projectName = (id: string) => infisical?.projects?.find((p) => p.id === id)?.name ?? id;

	function writeScope(next: InfisicalScope) {
		// An environment only means something together with a project: an explicit
		// environment on the default project names that project explicitly.
		const projectId = next.projectId || (next.environment ? infisical?.defaults.projectId : '');
		writeSelector(formatInfisicalSelector({ ...next, projectId }));
	}

	function onProjectChange(projectId: string) {
		const slugs = new Set(
			infisical?.projects?.find((p) => p.id === (projectId || infisical?.defaults.projectId))?.environments.map((e) => e.slug) ?? []
		);
		// Keep the chosen environment when the new project has it; otherwise fall back to
		// the provider default when that exists there, else the project's first environment.
		const defaultEnv = infisical?.defaults.environment ?? '';
		const environment =
			scope.environment && slugs.has(scope.environment)
				? scope.environment
				: slugs.has(defaultEnv) || slugs.size === 0
					? ''
					: [...slugs][0];
		writeScope({ projectId, environment, path: scope.path });
	}
</script>

{#if providers.length > 0 || secretProviderId !== null}
	<div class="px-3 py-2 border-b border-zinc-200 dark:border-zinc-700 bg-zinc-100/60 dark:bg-zinc-800/60 flex flex-col gap-1.5 text-xs">
		<div class="flex items-center gap-2">
			<Label for="secret-provider-select{idSuffix}" class="text-xs text-muted-foreground shrink-0">Secret provider</Label>
			<Select.Root
				type="single"
				value={secretProviderId !== null ? String(secretProviderId) : ''}
				onValueChange={selectProvider}
			>
				<Select.Trigger id="secret-provider-select{idSuffix}" class="h-7 text-xs flex-1 min-w-0 max-w-xs overflow-hidden">
					{#if secretProviderId !== null}
						{@const sel = providers.find((p) => p.id === secretProviderId)}
						{@const SelIcon = sel ? getProviderIcon(sel.type) : null}
						<span class="flex items-center gap-2 min-w-0">
							{#if SelIcon}<SelIcon class="h-4 w-4 shrink-0 text-muted-foreground" />{/if}
							<span class="truncate min-w-0">{sel?.name ?? 'Unknown provider'}</span>
						</span>
					{:else}
						<span class="text-muted-foreground truncate">None — disabled</span>
					{/if}
				</Select.Trigger>
				<Select.Content>
					<Select.Item value="" label="None">
						<span class="text-muted-foreground">None — disabled</span>
					</Select.Item>
					{#each providers as provider (provider.id)}
						{@const ProviderIcon = getProviderIcon(provider.type)}
						<Select.Item value={String(provider.id)} label={provider.name}>
							<span class="flex items-center gap-2 min-w-0">
								{#if ProviderIcon}<ProviderIcon class="h-4 w-4 shrink-0 text-muted-foreground" />{/if}
								<span class="truncate">{provider.name}</span>
							</span>
						</Select.Item>
					{/each}
				</Select.Content>
			</Select.Root>
			{#if bulkSelectorField && !infisical}
				<Label for="bulk-selector-input{idSuffix}" class="text-xs text-muted-foreground shrink-0 ml-1">
					{bulkSelectorField.label}
				</Label>
				<Input
					id="bulk-selector-input{idSuffix}"
					class="h-7 text-xs font-mono flex-1 min-w-0 max-w-xs"
					placeholder={bulkSelectorField.placeholder ?? ''}
					value={bulkSelectorValue}
					oninput={(e) => writeSelector(e.currentTarget.value)}
				/>
			{/if}
		</div>
		{#if infisical}
			<div class="flex items-center gap-2">
				<Label for="infisical-project-select{idSuffix}" class="text-xs text-muted-foreground shrink-0">Project</Label>
				<Select.Root type="single" value={scope.projectId ?? ''} onValueChange={(v) => onProjectChange(v)}>
					<Select.Trigger id="infisical-project-select{idSuffix}" class="h-7 text-xs flex-1 min-w-0 max-w-xs overflow-hidden">
						<span class="truncate min-w-0 {scope.projectId ? '' : 'text-muted-foreground'}">
							{scope.projectId
								? projectName(scope.projectId)
								: infisical.defaults.projectId
									? `Default (${projectName(infisical.defaults.projectId)})`
									: 'Select a project'}
						</span>
					</Select.Trigger>
					<Select.Content>
						{#if infisical.defaults.projectId}
							<Select.Item value="" label="Provider default">
								<span class="text-muted-foreground">Default ({projectName(infisical.defaults.projectId)})</span>
							</Select.Item>
						{/if}
						{#if scope.projectId && !infisical.projects?.some((p) => p.id === scope.projectId)}
							<Select.Item value={scope.projectId} label={scope.projectId}>
								<span class="font-mono">{scope.projectId}</span> <span class="text-muted-foreground">(no access)</span>
							</Select.Item>
						{/if}
						{#each infisical.projects ?? [] as project (project.id)}
							<Select.Item value={project.id} label={project.name}>{project.name}</Select.Item>
						{/each}
					</Select.Content>
				</Select.Root>
				<Label for="infisical-env-select{idSuffix}" class="text-xs text-muted-foreground shrink-0 ml-1">Environment</Label>
				<Select.Root
					type="single"
					value={scope.environment ?? ''}
					onValueChange={(v) => writeScope({ projectId: scope.projectId, environment: v, path: scope.path })}
					disabled={!effectiveProjectId}
				>
					<Select.Trigger id="infisical-env-select{idSuffix}" class="h-7 text-xs w-36 min-w-0 overflow-hidden">
						<span class="truncate min-w-0 {scope.environment ? '' : 'text-muted-foreground'}">
							{scope.environment
								? (environmentOptions.find((e) => e.slug === scope.environment)?.name ?? scope.environment)
								: infisical.defaults.environment
									? `Default (${infisical.defaults.environment})`
									: 'Select'}
						</span>
					</Select.Trigger>
					<Select.Content>
						{#if infisical.defaults.environment}
							<Select.Item value="" label="Provider default">
								<span class="text-muted-foreground">Default ({infisical.defaults.environment})</span>
							</Select.Item>
						{/if}
						{#each environmentOptions as env (env.slug)}
							<Select.Item value={env.slug} label={env.name}>
								{env.name} <span class="text-muted-foreground font-mono">{env.slug}</span>
							</Select.Item>
						{/each}
					</Select.Content>
				</Select.Root>
			</div>
		{/if}
		{#if infisical}
			<p class="text-2xs text-muted-foreground/70 pl-0.5">
				{#if infisical.projects?.length === 0}
					This identity can't read any project yet - add it to the project in Infisical (Access Control → Machine Identities).
				{:else}
					Secrets from the chosen project and environment are loaded at deploy{scope.path ? ` (path ${scope.path})` : ''}.
				{/if}
			</p>
		{:else if selectedType === 'infisical' && projectList?.error}
			<p class="text-2xs text-amber-600 dark:text-amber-400 pl-0.5">Couldn't list projects: {projectList.error}. Enter the project id directly.</p>
		{:else if bulkSelectorField?.hint}
			<p class="text-2xs text-muted-foreground/70 pl-0.5">{bulkSelectorField.hint}</p>
		{/if}
	</div>
{/if}
