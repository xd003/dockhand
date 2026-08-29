<script lang="ts">
	import type { Snippet } from 'svelte';
	import { EllipsisVertical } from 'lucide-svelte';
	import * as DropdownMenu from '$lib/components/ui/dropdown-menu';

	interface Props {
		label: string;
		children: Snippet;
	}

	let { label, children }: Props = $props();
</script>

<DropdownMenu.Root>
	<DropdownMenu.Trigger>
		{#snippet child({ props })}
			<button {...props} type="button" class="flex size-11 shrink-0 items-center justify-center rounded-lg hover:bg-muted" aria-label={label}>
				<EllipsisVertical class="size-5" />
			</button>
		{/snippet}
	</DropdownMenu.Trigger>
	<DropdownMenu.Content align="end" class="w-56 p-1">
		{@render children()}
	</DropdownMenu.Content>
</DropdownMenu.Root>
