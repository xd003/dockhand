<script lang="ts">
	import { Box } from 'lucide-svelte';

	interface Props {
		containerId: string;
		containerName: string;
		ipv4Address?: string;
		ipv6Address?: string;
		macAddress?: string;
		onclick?: () => void;
	}

	let { containerId, containerName, ipv4Address, ipv6Address, macAddress, onclick }: Props = $props();
</script>

<button
	type="button"
	class="w-full min-h-11 min-w-0 overflow-hidden rounded-lg bg-muted p-3 text-left transition-all hover:bg-muted/80 hover:ring-1 hover:ring-border focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 cursor-pointer"
	onclick={onclick}
>
	<div class="flex items-center gap-2">
		<Box class="w-4 h-4 text-muted-foreground shrink-0" />
		<span class="min-w-0 truncate text-sm font-medium" title={containerName}>{containerName}</span>
	</div>
	<div class="text-xs space-y-1">
		{#if ipv4Address}
			<div>
				<span class="text-muted-foreground">IPv4: </span>
				<code class="break-all text-foreground">{ipv4Address}</code>
			</div>
		{/if}
		{#if ipv6Address}
			<div>
				<span class="text-muted-foreground">IPv6: </span>
				<code class="break-all text-foreground">{ipv6Address}</code>
			</div>
		{/if}
		{#if macAddress}
			<div>
				<span class="text-muted-foreground">MAC: </span>
				<code class="break-all text-foreground">{macAddress}</code>
			</div>
		{/if}
	</div>
	<code class="text-2xs text-muted-foreground">{containerId.slice(0, 12)}</code>
</button>
