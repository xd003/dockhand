<script lang="ts">
	import { themeStore, type FontSize } from '$lib/stores/theme';
	import { sseConnected } from '$lib/stores/events';
	import { Badge } from '$lib/components/ui/badge';
	import { Wifi } from 'lucide-svelte';
	import type { Component } from 'svelte';

	export interface HeaderTab {
		id: string;
		label: string;
		icon: Component;
		/** Optional count badge shown next to the label. */
		count?: number | string;
		/** Optional secondary total, rendered as "count of total" (active tab only). */
		total?: number;
		/** Show the live-connection (wifi) indicator inside this tab's segment. */
		showConnection?: boolean;
	}

	interface Props {
		tabs: HeaderTab[];
		activeTab: string;
		onTabChange: (id: string) => void;
		class?: string;
	}

	let {
		tabs,
		activeTab,
		onTabChange,
		class: className = ''
	}: Props = $props();

	// Font size scaling (mirrors PageHeader so the active tab matches page titles).
	// $themeStore auto-subscribes/cleans up; no manual subscription to leak.
	const fontSize = $derived<FontSize>($themeStore.fontSize);

	const headerTextClass = $derived.by(() => {
		switch (fontSize) {
			case 'small': return 'text-sm md:text-lg';
			case 'normal': return 'text-sm md:text-xl';
			case 'medium': return 'text-sm md:text-2xl';
			case 'large': return 'text-sm md:text-2xl';
			case 'xlarge': return 'text-sm md:text-3xl';
			default: return 'text-sm md:text-xl';
		}
	});

	const headerIconClass = $derived.by(() => {
		switch (fontSize) {
			case 'small': return 'size-4';
			case 'normal': return 'size-4 md:w-5 md:h-5';
			case 'medium': return 'size-4 md:w-6 md:h-6';
			case 'large': return 'size-4 md:w-6 md:h-6';
			case 'xlarge': return 'size-4 md:w-7 md:h-7';
			default: return 'size-4 md:w-5 md:h-5';
		}
	});

	function countDisplay(tab: HeaderTab): string | null {
		if (tab.count === undefined) return null;
		const countStr = typeof tab.count === 'number' ? tab.count.toLocaleString() : tab.count;
		if (tab.total !== undefined) {
			return `${countStr} of ${tab.total.toLocaleString()}`;
		}
		return countStr;
	}

	let active = $derived(tabs.find(t => t.id === activeTab) ?? tabs[0]);
</script>

<!-- A header that IS the switcher: all tabs live in one left-aligned segmented
     control, the active segment filled and scaled to page-title size. Replaces
     the plain PageHeader on pages that have sub-views. -->
<div class="flex min-w-0 flex-1 items-center gap-3 md:flex-none {className}">
	<div class="flex w-full max-w-full flex-nowrap items-center gap-1 rounded-lg bg-muted/60 p-1 md:w-auto md:flex-wrap">
		{#each tabs as tab (tab.id)}
			{@const TabIcon = tab.icon}
			{@const isActive = tab.id === active?.id}
			<button
				type="button"
				aria-pressed={isActive}
				onclick={() => onTabChange(tab.id)}
				class="flex min-w-0 flex-1 shrink-0 items-center justify-center gap-1 rounded-md px-2 py-2 font-bold leading-none transition-colors md:flex-none md:gap-2 md:px-3 {headerTextClass} focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring {isActive
					? 'bg-background text-foreground shadow-sm'
					: 'text-muted-foreground hover:text-foreground hover:bg-background/40'}"
			>
				<TabIcon class={headerIconClass} />
				<span>{tab.label}</span>
				{#if countDisplay(tab)}
					<Badge variant="secondary" class="min-w-6 justify-center px-1.5 text-2xs tabular-nums md:min-w-8 md:text-xs">
						{countDisplay(tab)}
					</Badge>
				{/if}
				{#if tab.showConnection}
					<span title={$sseConnected ? 'Live updates active - grid will auto-refresh' : 'Connecting to live updates...'}>
						<Wifi class="w-3.5 h-3.5 {$sseConnected ? 'text-emerald-500' : 'text-muted-foreground'}" />
					</span>
				{/if}
			</button>
		{/each}
	</div>
</div>
