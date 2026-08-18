<script lang="ts">
	import { onMount } from 'svelte';
	import { toast } from 'svelte-sonner';
	import { Button } from '$lib/components/ui/button';
	import * as Card from '$lib/components/ui/card';
	import { Badge } from '$lib/components/ui/badge';
	import { Checkbox } from '$lib/components/ui/checkbox';
	import { Plus, Trash2, Pencil, GitBranch, FolderGit2, Plug, CheckCircle, XCircle, Loader2, Lock, Globe, ArrowRight } from 'lucide-svelte';
	import { forgeIcon } from '$lib/utils/git-forge';
	import ConfirmPopover from '$lib/components/ConfirmPopover.svelte';
	import { canAccess } from '$lib/stores/auth';
	import { appSettings } from '$lib/stores/settings';
	import GitRepositoryModal from './GitRepositoryModal.svelte';
	import { EmptyState } from '$lib/components/ui/empty-state';

	interface GitCredential {
		id: number;
		name: string;
		authType: string;
	}

	interface GitRepository {
		id: number;
		name: string;
		url: string;
		branch: string;
		credentialId: number | null;
		credentialName?: string;
		autoUpdate: boolean;
		autoUpdateCron: string;
		webhookEnabled: boolean;
		webhookSecret: string | null;
		createdAt: string;
	}

	let repositories = $state<GitRepository[]>([]);
	let credentials = $state<GitCredential[]>([]);
	let loading = $state(true);
	let showModal = $state(false);
	let editingRepo = $state<GitRepository | null>(null);
	let confirmDeleteId = $state<number | null>(null);
	let testingId = $state<number | null>(null);
	let testResult = $state<{ id: number; success: boolean; message: string } | null>(null);

	// Per-stack migration job state — while active, migration controls are disabled.
	const gitStackMigration = $derived($appSettings.gitStackMigration);
	const migrationActive = $derived(gitStackMigration.state !== 'idle');

	interface StackModelRow {
		id: number;
		stackName: string;
		environmentId: number | null;
		gitModel: 'stack' | 'centralized';
	}
	let stackModelStacks = $state<StackModelRow[]>([]);
	let stacksLoading = $state(true);
	let selectedForMigration = $state<Set<number>>(new Set());
	let migrateBusy = $state(false);

	async function fetchStackModelStacks() {
		try {
			const response = await fetch('/api/git/stacks');
			if (response.ok) {
				const stacks = await response.json();
				stackModelStacks = (Array.isArray(stacks) ? stacks : []).map((s: any) => ({
					id: s.id,
					stackName: s.stackName,
					environmentId: s.environmentId ?? null,
					gitModel: s.gitModel === 'centralized' ? 'centralized' : 'stack'
				}));
				// Drop selections for stacks that no longer exist or are already migrated.
				const validIds = new Set(stackModelStacks.filter((s) => s.gitModel === 'stack').map((s) => s.id));
				selectedForMigration = new Set([...selectedForMigration].filter((id) => validIds.has(id)));
			}
		} catch {
			toast.error('Failed to load git stacks');
		} finally {
			stacksLoading = false;
		}
	}

	function toggleStackSelection(id: number, checked: boolean) {
		const next = new Set(selectedForMigration);
		if (checked) next.add(id);
		else next.delete(id);
		selectedForMigration = next;
	}

	async function migrateSelected() {
		if (selectedForMigration.size === 0 || migrateBusy || migrationActive) return;
		if (!window.confirm(
			`Migrate ${selectedForMigration.size} stack(s) to centralized Git mode?\n\nSelected stacks move onto shared repository clones; their per-stack sync schedules and webhook URLs may change. Unselected stacks are unaffected.`
		)) return;
		migrateBusy = true;
		try {
			const res = await fetch('/api/git/stacks/migrate-batch', {
				method: 'POST',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify({ stackIds: [...selectedForMigration] })
			});
			const data = await res.json();
			if (res.ok) {
				toast.success(`Migration started for ${data.count ?? selectedForMigration.size} stack(s)`);
				selectedForMigration = new Set();
			} else {
				toast.error(data.error || 'Failed to start migration');
			}
		} catch {
			toast.error('Failed to start migration');
		} finally {
			migrateBusy = false;
		}
	}

	onMount(() => {
		// F11: sync the client's git mode with the server before showing the list.
		appSettings.reload();
	});

	async function fetchRepositories() {
		try {
			const response = await fetch('/api/git/repositories');
			repositories = await response.json();
		} catch (error) {
			console.error('Failed to fetch git repositories:', error);
			toast.error('Failed to fetch git repositories');
		} finally {
			loading = false;
		}
	}

	async function fetchCredentials() {
		try {
			const response = await fetch('/api/git/credentials');
			credentials = await response.json();
		} catch (error) {
			console.error('Failed to fetch git credentials:', error);
			toast.error('Failed to fetch git credentials');
		}
	}

	function openModal(repo?: GitRepository) {
		editingRepo = repo || null;
		showModal = true;
	}

	function closeModal() {
		showModal = false;
		editingRepo = null;
	}

	async function handleSaved() {
		await fetchRepositories();
	}

	async function deleteRepository(id: number) {
		try {
			const response = await fetch(`/api/git/repositories/${id}`, { method: 'DELETE' });
			if (response.ok) {
				await fetchRepositories();
				toast.success('Repository deleted');
			} else {
				toast.error('Failed to delete repository');
			}
		} catch (error) {
			console.error('Failed to delete repository:', error);
			toast.error('Failed to delete repository');
		}
	}

	async function testRepository(id: number) {
		testingId = id;
		testResult = null;
		try {
			const response = await fetch(`/api/git/repositories/${id}/test`, { method: 'POST' });
			const data = await response.json();
			if (data.success) {
				testResult = {
					id,
					success: true,
					message: `Connected! Branch: ${data.branch}, Last commit: ${data.lastCommit}`
				};
				toast.success('Repository connection successful');
			} else {
				testResult = {
					id,
					success: false,
					message: data.error || 'Connection failed'
				};
				toast.error(`Connection failed: ${data.error || 'Unknown error'}`);
			}
			// Auto-clear after 5 seconds
			setTimeout(() => {
				if (testResult?.id === id) {
					testResult = null;
				}
			}, 5000);
		} catch (error) {
			testResult = {
				id,
				success: false,
				message: 'Failed to test connection'
			};
			toast.error('Failed to test repository connection');
		} finally {
			testingId = null;
		}
	}

	onMount(() => {
		fetchCredentials();
		fetchRepositories();
		fetchStackModelStacks();
	});
</script>

<div class="space-y-4">
	<div class="flex justify-between items-center">
		<div>
			<h3 class="text-lg font-medium">Git repositories</h3>
			<p class="text-sm text-muted-foreground">Manage Git repositories that can be used to deploy stacks</p>
		</div>
		{#if $canAccess('settings', 'edit')}
			<Button size="sm" onclick={() => openModal()}>
				<Plus class="w-4 h-4" />
				Add repository
			</Button>
		{/if}
	</div>

	{#if stacksLoading}
		<p class="text-sm text-muted-foreground">Loading stacks...</p>
	{:else}
		<Card.Root>
			<Card.Header>
				<Card.Title class="text-sm font-medium flex items-center gap-2">
					<GitBranch class="w-4 h-4" />
					Migrate stacks to centralized mode
				</Card.Title>
				<p class="text-xs text-muted-foreground">
					Select stack-model stacks to move onto the centralized (shared clone) model. This only affects the stacks you select: their per-stack sync schedules and webhook URLs change, and unselected stacks keep their current clone layout, schedules and webhooks. Already-centralized stacks are hidden.
				</p>
			</Card.Header>
			<Card.Content class="space-y-3">
				{#if migrationActive}
					<div class="rounded-md border border-blue-300/60 dark:border-blue-700/60 bg-blue-50 dark:bg-blue-950/30 p-3 text-sm text-blue-700 dark:text-blue-400">
						<span class="inline-flex items-center gap-2">
							<Loader2 class="w-4 h-4 animate-spin" />
							A stack migration is in progress ({gitStackMigration.state}) — migration controls are temporarily disabled.
						</span>
					</div>
				{/if}
				{#if stackModelStacks.filter((s) => s.gitModel === 'stack').length === 0}
					<p class="text-sm text-muted-foreground">No stack-model git stacks to migrate.</p>
				{:else}
					<div class="space-y-1 max-h-64 overflow-y-auto">
						{#each stackModelStacks.filter((s) => s.gitModel === 'stack') as stack (stack.id)}
							<div class="flex items-center gap-3 py-2 px-3 rounded-md border bg-card">
								<Checkbox
									checked={selectedForMigration.has(stack.id)}
									onCheckedChange={(checked) => toggleStackSelection(stack.id, checked === true)}
									disabled={!$canAccess('settings', 'edit') || migrationActive}
								/>
								<FolderGit2 class="w-4 h-4 shrink-0 text-muted-foreground" />
								<span class="font-medium text-sm truncate">{stack.stackName}</span>
								<Badge variant="outline" class="text-xs">Per-stack clone</Badge>
							</div>
						{/each}
					</div>
					<div class="flex items-center gap-2">
						<Button
							size="sm"
							variant="outline"
							onclick={migrateSelected}
							disabled={selectedForMigration.size === 0 || migrateBusy || migrationActive || !$canAccess('settings', 'edit')}
						>
							{#if migrateBusy}
								<Loader2 class="w-4 h-4 animate-spin" />
							{:else}
								<ArrowRight class="w-4 h-4" />
							{/if}
							Migrate selected ({selectedForMigration.size})
						</Button>
					</div>
				{/if}
			</Card.Content>
		</Card.Root>
	{/if}

	{#if loading}
		<p class="text-sm text-muted-foreground">Loading repositories...</p>
	{:else if repositories.length === 0}
		<Card.Root>
			<Card.Content>
				<EmptyState
					icon={FolderGit2}
					title="No Git repositories configured"
					description="Add a repository to use it when deploying stacks from Git"
				/>
			</Card.Content>
		</Card.Root>
	{:else}
		<div class="space-y-1">
			{#each repositories as repo (repo.id)}
				{@const ForgeIcon = forgeIcon(repo.url)}
				<div class="flex items-center justify-between py-2 px-3 rounded-md border bg-card hover:bg-muted/50 transition-colors">
					<div class="flex items-center gap-2 min-w-0 flex-1">
						<ForgeIcon class="w-4 h-4 shrink-0 text-muted-foreground" />
						<span class="font-medium text-sm truncate">{repo.name}</span>
						<span class="text-xs text-muted-foreground truncate hidden sm:inline">{repo.url}</span>
					</div>
					<div class="flex items-center gap-2 shrink-0">
						{#if testResult?.id === repo.id}
							<span class="flex items-center gap-1 text-xs px-2 py-0.5 rounded {testResult.success ? 'text-green-600 bg-green-50 dark:bg-green-950/30' : 'text-red-600 bg-red-50 dark:bg-red-950/30'}">
								{#if testResult.success}
									<CheckCircle class="w-3 h-3" />
								{:else}
									<XCircle class="w-3 h-3" />
								{/if}
								<span class="hidden sm:inline">{testResult.message}</span>
							</span>
						{/if}
						{#if repo.credentialName}
							<span class="flex items-center gap-1 text-xs text-muted-foreground" title="Using credential: {repo.credentialName}">
								<Lock class="w-3 h-3" />
								<span class="hidden sm:inline">{repo.credentialName}</span>
							</span>
						{:else}
							<span class="flex items-center gap-1 text-xs text-muted-foreground" title="Public repository">
								<Globe class="w-3 h-3" />
								<span class="hidden sm:inline">Public</span>
							</span>
						{/if}
						<Badge variant="outline" class="text-xs flex items-center gap-1">
							<GitBranch class="w-3 h-3" />
							{repo.branch}
						</Badge>
						<Button
							variant="ghost"
							size="icon"
							class="h-7 w-7"
							onclick={() => testRepository(repo.id)}
							disabled={testingId === repo.id}
							title="Test connection"
						>
							{#if testingId === repo.id}
								<Loader2 class="w-3.5 h-3.5 animate-spin" />
							{:else}
								<Plug class="w-3.5 h-3.5" />
							{/if}
						</Button>
						{#if $canAccess('settings', 'edit')}
							<Button variant="ghost" size="icon" class="h-7 w-7" onclick={() => openModal(repo)} title="Edit repository">
								<Pencil class="w-3.5 h-3.5" />
							</Button>
							<ConfirmPopover
								open={confirmDeleteId === repo.id}
								action="Delete"
								itemType="repository"
								itemName={repo.name}
								title="Delete"
								onConfirm={() => deleteRepository(repo.id)}
								onOpenChange={(open) => confirmDeleteId = open ? repo.id : null}
							>
								{#snippet children({ open })}
									<Trash2 class="w-3.5 h-3.5 {open ? 'text-destructive' : 'text-muted-foreground hover:text-destructive'}" />
								{/snippet}
							</ConfirmPopover>
						{/if}
					</div>
				</div>
			{/each}
		</div>
	{/if}
</div>

<GitRepositoryModal
	bind:open={showModal}
	repository={editingRepo}
	{credentials}
	onClose={closeModal}
	onSaved={handleSaved}
/>
