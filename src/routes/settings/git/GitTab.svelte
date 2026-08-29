<script lang="ts">
	import { page } from '$app/stores';
	import { FolderGit2, Key } from 'lucide-svelte';
	import GitCredentialsTab from './GitCredentialsTab.svelte';
	import GitRepositoriesTab from './GitRepositoriesTab.svelte';

	let gitSubTab = $derived<'repositories' | 'credentials'>(
		($page.url.searchParams.get('subtab') as 'repositories' | 'credentials') || 'repositories'
	);
</script>

<div class="space-y-4">
	<!-- Git subtabs -->
	<div class="inline-flex gap-1 p-1 bg-muted/50 rounded-lg max-md:w-full max-md:flex-wrap max-md:[&>a]:min-h-11 max-md:[&>a]:grow max-md:[&>a]:whitespace-nowrap">
		<a
			href="/settings?tab=git&subtab=repositories"
			class="px-3 py-1.5 text-sm font-medium rounded-md transition-all flex items-center gap-1.5 {gitSubTab === 'repositories' ? 'bg-background text-foreground shadow-sm' : 'text-muted-foreground hover:text-foreground'}"
		>
			<FolderGit2 class="w-4 h-4" />
			Repositories
		</a>
		<a
			href="/settings?tab=git&subtab=credentials"
			class="px-3 py-1.5 text-sm font-medium rounded-md transition-all flex items-center gap-1.5 {gitSubTab === 'credentials' ? 'bg-background text-foreground shadow-sm' : 'text-muted-foreground hover:text-foreground'}"
		>
			<Key class="w-4 h-4" />
			Credentials
		</a>
	</div>

	{#if gitSubTab === 'repositories'}
		<GitRepositoriesTab />
	{:else}
		<GitCredentialsTab />
	{/if}
</div>
