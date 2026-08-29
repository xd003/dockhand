<script lang="ts">
	import * as Dialog from '$lib/components/ui/dialog';
	import { Button } from '$lib/components/ui/button';
	import { Badge } from '$lib/components/ui/badge';
	import { Loader2, Network, RefreshCw } from 'lucide-svelte';
	import ModalHeader from '$lib/components/ModalHeader.svelte';
	import { currentEnvironment, appendEnvParam } from '$lib/stores/environment';
	import { formatDateTime } from '$lib/stores/settings';
	import ContainerTile from '../containers/ContainerTile.svelte';
	import ContainerInspectModal from '../containers/ContainerInspectModal.svelte';

	interface Props {
		open: boolean;
		networkId: string;
		networkName?: string;
	}

	interface NetworkContainer {
		Name?: string;
		IPv4Address?: string;
		IPv6Address?: string;
		MacAddress?: string;
	}

	let { open = $bindable(), networkId, networkName }: Props = $props();

	let loading = $state(true);
	let error = $state('');
	let networkData = $state<any>(null);
	let requestController: AbortController | null = null;

	// Container inspect modal state
	let showContainerInspect = $state(false);
	let inspectContainerId = $state('');
	let inspectContainerName = $state('');

	function openContainerInspect(containerId: string, containerName: string) {
		inspectContainerId = containerId;
		inspectContainerName = containerName;
		showContainerInspect = true;
	}

	$effect(() => {
		if (open && networkId) {
			fetchNetworkInspect();
			return () => {
				requestController?.abort();
				requestController = null;
			};
		}
	});

	async function fetchNetworkInspect() {
		requestController?.abort();
		const controller = new AbortController();
		requestController = controller;
		loading = true;
		error = '';
		try {
			const envId = $currentEnvironment?.id ?? null;
			const response = await fetch(appendEnvParam(`/api/networks/${encodeURIComponent(networkId)}/inspect`, envId), {
				signal: controller.signal
			});
			if (!response.ok) {
				throw new Error(
					response.status === 404 ? 'This network no longer exists.' : 'Unable to load network details.'
				);
			}
			networkData = await response.json();
		} catch (err: any) {
			if (controller.signal.aborted) return;
			error = err.message || 'Failed to load network details';
			console.error('Failed to fetch network inspect:', err);
		} finally {
			if (requestController === controller) {
				loading = false;
				requestController = null;
			}
		}
	}

	function formatNetworkDate(dateString: string): string {
		if (!dateString) return 'N/A';
		return formatDateTime(dateString, true);
	}

	function getNetworkContainers(containers: unknown): Array<[string, NetworkContainer]> {
		if (!containers || typeof containers !== 'object') return [];
		return Object.entries(containers as Record<string, NetworkContainer>);
	}
</script>

<Dialog.Root bind:open>
	<Dialog.Content class="max-w-4xl max-sm:w-[calc(100%-1rem)] max-sm:h-[calc(100dvh-1rem)] max-h-[calc(100dvh-1rem)] sm:max-h-[90vh] max-sm:rounded-2xl flex flex-col overflow-hidden" onOpenAutoFocus={(e) => e.preventDefault()}>
		<Dialog.Header class="shrink-0 min-w-0 max-sm:pr-8">
			<ModalHeader icon={Network} title="Network" name={networkName || networkId} />
		</Dialog.Header>

		<div class="flex-1 min-h-0 min-w-0 space-y-4 overflow-x-hidden overflow-y-auto overscroll-contain pr-1 sm:pr-2">
			{#if loading}
				<div class="flex flex-col items-center justify-center gap-3 py-8 text-sm text-muted-foreground" role="status" aria-live="polite">
					<Loader2 class="w-6 h-6 animate-spin text-muted-foreground" />
					<span>Loading network details...</span>
				</div>
			{:else if error}
				<div class="flex flex-col items-start gap-3 rounded-lg border border-destructive/30 bg-destructive/10 p-3 text-sm" role="alert">
					<p class="break-words text-destructive">{error}</p>
					<Button variant="outline" class="min-h-11 gap-2" onclick={fetchNetworkInspect}>
						<RefreshCw class="size-4" />
						Try again
					</Button>
				</div>
			{:else if networkData}
				<!-- Basic Info -->
				<div class="space-y-3">
					<h3 class="text-sm font-semibold">Basic information</h3>
					<div class="grid grid-cols-1 gap-3 text-sm sm:grid-cols-2">
						<div class="min-w-0">
							<p class="text-muted-foreground">Name</p>
							<p class="break-words font-medium">{networkData.Name}</p>
						</div>
						<div class="min-w-0">
							<p class="text-muted-foreground">ID</p>
							<code class="break-all text-xs">{networkData.Id?.slice(0, 12)}</code>
						</div>
						<div class="min-w-0">
							<p class="text-muted-foreground">Driver</p>
							<Badge variant="outline">{networkData.Driver}</Badge>
						</div>
						<div class="min-w-0">
							<p class="text-muted-foreground">Scope</p>
							<Badge variant="secondary">{networkData.Scope}</Badge>
						</div>
						<div class="min-w-0">
							<p class="text-muted-foreground">Created</p>
							<p class="break-words">{formatNetworkDate(networkData.Created)}</p>
						</div>
						<div class="min-w-0">
							<p class="text-muted-foreground">Internal</p>
							<Badge variant={networkData.Internal ? 'destructive' : 'secondary'}>
								{networkData.Internal ? 'Yes' : 'No'}
							</Badge>
						</div>
					</div>
				</div>

				<!-- IPAM Configuration -->
				{#if networkData.IPAM}
					<div class="space-y-3">
						<h3 class="text-sm font-semibold">IPAM configuration</h3>
						<div class="space-y-2">
							<div class="text-sm">
								<p class="text-muted-foreground">Driver</p>
								<p>{networkData.IPAM.Driver || 'default'}</p>
							</div>
							{#if networkData.IPAM.Config && networkData.IPAM.Config.length > 0}
								<div class="space-y-2">
									<p class="text-muted-foreground text-sm">Subnets</p>
									{#each networkData.IPAM.Config as config}
										<div class="p-2 bg-muted rounded text-sm space-y-1">
											{#if config.Subnet}
												<div class="flex min-w-0 flex-col gap-1 sm:flex-row sm:items-start sm:justify-between sm:gap-3">
													<span class="text-muted-foreground">Subnet:</span>
													<code class="break-all sm:text-right">{config.Subnet}</code>
												</div>
											{/if}
											{#if config.Gateway}
												<div class="flex min-w-0 flex-col gap-1 sm:flex-row sm:items-start sm:justify-between sm:gap-3">
													<span class="text-muted-foreground">Gateway:</span>
													<code class="break-all sm:text-right">{config.Gateway}</code>
												</div>
											{/if}
											{#if config.IPRange}
												<div class="flex min-w-0 flex-col gap-1 sm:flex-row sm:items-start sm:justify-between sm:gap-3">
													<span class="text-muted-foreground">IP Range:</span>
													<code class="break-all sm:text-right">{config.IPRange}</code>
												</div>
											{/if}
										</div>
									{/each}
								</div>
							{/if}
						</div>
					</div>
				{/if}

				<!-- Connected Containers -->
				{#if networkData.Containers && Object.keys(networkData.Containers).length > 0}
					<div class="space-y-3">
						<h3 class="text-sm font-semibold">Connected containers ({Object.keys(networkData.Containers).length})</h3>
						<div class="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-2">
							{#each getNetworkContainers(networkData.Containers) as [id, container]}
								<ContainerTile
									containerId={id}
									containerName={container.Name ?? id}
									ipv4Address={container.IPv4Address}
									ipv6Address={container.IPv6Address}
									macAddress={container.MacAddress}
									onclick={() => openContainerInspect(id, container.Name ?? id)}
								/>
							{/each}
						</div>
					</div>
				{:else}
					<div class="text-sm text-muted-foreground text-center py-4">
						No containers connected to this network
					</div>
				{/if}

				<!-- Options -->
				{#if networkData.Options && Object.keys(networkData.Options).length > 0}
					<div class="space-y-3">
						<h3 class="text-sm font-semibold">Driver options</h3>
						<div class="space-y-1">
							{#each Object.entries(networkData.Options) as [key, value]}
									<div class="grid min-w-0 grid-cols-1 gap-1 rounded bg-muted p-2 text-sm sm:grid-cols-[minmax(0,1fr)_minmax(0,2fr)] sm:gap-x-3">
										<code class="break-all text-muted-foreground">{key}</code>
										<code class="break-all sm:text-right">{value}</code>
								</div>
							{/each}
						</div>
					</div>
				{/if}

				<!-- Labels -->
				{#if networkData.Labels && Object.keys(networkData.Labels).length > 0}
					<div class="space-y-3">
						<h3 class="text-sm font-semibold">Labels</h3>
						<div class="space-y-1">
							{#each Object.entries(networkData.Labels) as [key, value]}
								<div class="grid min-w-0 grid-cols-1 gap-1 rounded bg-muted p-2 text-sm sm:grid-cols-[minmax(0,1fr)_minmax(0,2fr)] sm:gap-x-3">
									<code class="break-all text-muted-foreground">{key}</code>
									<code class="break-all sm:text-right">{value}</code>
								</div>
							{/each}
						</div>
					</div>
				{/if}
			{/if}
		</div>

		<Dialog.Footer class="shrink-0 max-sm:hidden">
			<Button variant="outline" onclick={() => (open = false)}>Close</Button>
		</Dialog.Footer>
	</Dialog.Content>
</Dialog.Root>

<ContainerInspectModal
	bind:open={showContainerInspect}
	containerId={inspectContainerId}
	containerName={inspectContainerName}
/>
