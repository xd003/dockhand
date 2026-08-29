<svelte:head>
	<title>Settings - Dockhand</title>
</svelte:head>

<script lang="ts">
	import { page } from '$app/stores';
	import { goto } from '$app/navigation';
	import { tick } from 'svelte';
	import * as Tabs from '$lib/components/ui/tabs';
	import * as Select from '$lib/components/ui/select';
	import {
		Settings,
		Globe,
		Download,
		Layers,
		Bell,
		Crown,
		Users,
		Info,
		GitBranch,
		Tags,
		KeyRound,
		Archive
	} from 'lucide-svelte';
	import PageHeader from '$lib/components/PageHeader.svelte';

	// Import tab components
	import GeneralTab from './general/GeneralTab.svelte';
	import EnvironmentsTab from './environments/EnvironmentsTab.svelte';
	import LabelsTab from './labels/LabelsTab.svelte';
	import RegistriesTab from './registries/RegistriesTab.svelte';
	import GitTab from './git/GitTab.svelte';
	import SecretsTab from './secrets/SecretsTab.svelte';
	import ConfigSetsTab from './config-sets/ConfigSetsTab.svelte';
	import NotificationsTab from './notifications/NotificationsTab.svelte';
	import BackupsTab from './backups/BackupsTab.svelte';
	import AuthTab from './auth/AuthTab.svelte';
	import LicenseTab from './license/LicenseTab.svelte';
	import AboutTab from './about/AboutTab.svelte';

	// Tab state from URL
	let activeTab = $derived($page.url.searchParams.get('tab') || 'general');
	let editEnvId = $derived($page.url.searchParams.get('edit'));
	let newEnv = $derived($page.url.searchParams.get('new') === 'true');
	let tabList = $state<HTMLElement | null>(null);

	function handleTabChange(tab: string) {
		goto(`/settings?tab=${tab}`, { replaceState: true, noScroll: true });
	}

	$effect(() => {
		const tab = activeTab;
		if (!tabList) return;
		void tick().then(() => {
			tabList?.querySelector<HTMLElement>(`[data-value="${tab}"]`)?.scrollIntoView({ block: 'nearest', inline: 'nearest' });
		});
	});

	// Single source of truth for the tab list: desktop tabs + the mobile Select dropdown.
	const TABS = $derived([
		{ value: 'general', label: 'General', Icon: Settings },
		{ value: 'environments', label: 'Environments', Icon: Globe },
		{ value: 'labels', label: 'Labels', Icon: Tags },
		{ value: 'registries', label: 'Registries', Icon: Download },
		{ value: 'git', label: 'Git', Icon: GitBranch },
		{ value: 'secrets', label: 'Secrets', Icon: KeyRound },
		{ value: 'config-sets', label: 'Config sets', Icon: Layers },
		{ value: 'notifications', label: 'Notifications', Icon: Bell },
		// BETA GATE: Backups tab hidden unless FEAT_BACKUPS_ENABLED (see features.ts)
		...($page.data.backupsEnabled ? [{ value: 'backups', label: 'Backups', Icon: Archive }] : []),
		{ value: 'auth', label: 'Authentication', Icon: Users },
		{ value: 'license', label: 'License', Icon: Crown },
		{ value: 'about', label: 'About', Icon: Info }
	]);
	const activeTabMeta = $derived(TABS.find((t) => t.value === activeTab));
</script>

<div class="flex-1 min-h-0 flex flex-col gap-3 overflow-hidden">
	<div class="shrink-0 flex flex-wrap justify-between items-center gap-3 min-h-8">
		<PageHeader icon={Settings} title="Settings" showConnection={false} />
	</div>

	<Tabs.Root value={activeTab} onValueChange={handleTabChange} class="w-full flex-1 min-h-0 flex flex-col">
		<div class="md:hidden">
			<Select.Root type="single" value={activeTab} onValueChange={(v) => { if (v) handleTabChange(v); }}>
				<Select.Trigger class="max-md:h-11! w-full" aria-label="Settings section">
					<div class="flex items-center gap-2 min-w-0">
						{#if activeTabMeta}
							<activeTabMeta.Icon class="w-4 h-4 shrink-0 text-muted-foreground" />
							<span class="truncate">{activeTabMeta.label}</span>
						{:else}
							<span class="truncate">{activeTab}</span>
						{/if}
					</div>
				</Select.Trigger>
				<Select.Content class="max-md:w-(--bits-select-anchor-width)">
					{#each TABS as t (t.value)}
						<Select.Item value={t.value}>
							<div class="flex items-center gap-2.5">
								<t.Icon class="w-4 h-4 text-muted-foreground" />
								<span>{t.label}</span>
							</div>
						</Select.Item>
					{/each}
				</Select.Content>
			</Select.Root>
		</div>

		<Tabs.List bind:ref={tabList} class="hidden w-full h-auto gap-1 p-1 flex-wrap justify-start md:flex">
			{#each TABS as t (t.value)}
				<Tabs.Trigger value={t.value} class="max-sm:shrink-0 max-sm:min-w-max sm:flex-1 flex items-center justify-center gap-1.5">
					<t.Icon class="w-4 h-4" />
					{t.label}
				</Tabs.Trigger>
			{/each}
		</Tabs.List>

		<Tabs.Content value="general" class="flex-1 min-h-0 overflow-y-auto pr-0 sm:pr-5">
			{#if activeTab === 'general'}<GeneralTab />{/if}
		</Tabs.Content>

		<Tabs.Content value="environments" class="flex-1 min-h-0 overflow-y-auto pr-0 sm:pr-5">
			{#if activeTab === 'environments'}<EnvironmentsTab {editEnvId} {newEnv} />{/if}
		</Tabs.Content>

		<Tabs.Content value="labels" class="flex-1 min-h-0 overflow-y-auto pr-0 sm:pr-5">
			{#if activeTab === 'labels'}<LabelsTab />{/if}
		</Tabs.Content>

		<Tabs.Content value="registries" class="flex-1 min-h-0 overflow-y-auto pr-0 sm:pr-5">
			{#if activeTab === 'registries'}<RegistriesTab />{/if}
		</Tabs.Content>

		<Tabs.Content value="git" class="flex-1 min-h-0 overflow-y-auto pr-0 sm:pr-5">
			{#if activeTab === 'git'}<GitTab />{/if}
		</Tabs.Content>

		<Tabs.Content value="secrets" class="flex-1 min-h-0 overflow-y-auto pr-0 sm:pr-5">
			{#if activeTab === 'secrets'}<SecretsTab />{/if}
		</Tabs.Content>

		<Tabs.Content value="config-sets" class="flex-1 min-h-0 overflow-y-auto pr-0 sm:pr-5">
			{#if activeTab === 'config-sets'}<ConfigSetsTab />{/if}
		</Tabs.Content>

		<Tabs.Content value="notifications" class="flex-1 min-h-0 overflow-y-auto pr-0 sm:pr-5">
			{#if activeTab === 'notifications'}<NotificationsTab />{/if}
		</Tabs.Content>

		<Tabs.Content value="backups" class="flex-1 min-h-0 overflow-y-auto">
			{#if activeTab === 'backups'}<BackupsTab />{/if}
		</Tabs.Content>

		<Tabs.Content value="auth" class="flex-1 min-h-0 flex flex-col">
			{#if activeTab === 'auth'}<AuthTab onTabChange={handleTabChange} />{/if}
		</Tabs.Content>

		<Tabs.Content value="license" class="flex-1 min-h-0 overflow-y-auto pr-0 sm:pr-5">
			{#if activeTab === 'license'}<LicenseTab />{/if}
		</Tabs.Content>

		<Tabs.Content value="about" class="flex-1 min-h-0 overflow-y-auto pr-0 sm:pr-5">
			{#if activeTab === 'about'}<AboutTab />{/if}
		</Tabs.Content>
	</Tabs.Root>
</div>
