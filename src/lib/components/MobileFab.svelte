<script lang="ts">
	import type { Snippet } from 'svelte';
	import { Plus } from 'lucide-svelte';
	import * as DropdownMenu from '$lib/components/ui/dropdown-menu';

	interface Props {
		label: string;
		title?: string;
		/** Click handler for the plain button variant (ignored when `menu` is set) */
		onclick?: () => void;
		/** Dropdown items; when set the button opens a menu above it */
		menu?: Snippet;
	}

	let { label, title = label, onclick, menu }: Props = $props();

	const buttonClass = 'flex size-14 items-center justify-center rounded-full bg-primary text-primary-foreground shadow-lg transition-transform hover:scale-105 active:scale-95';
</script>

<div class="fixed bottom-[max(1rem,env(safe-area-inset-bottom))] right-4 z-40 md:hidden">
	{#if menu}
		<DropdownMenu.Root>
			<DropdownMenu.Trigger>
				{#snippet child({ props })}
					<button
						{...props}
						type="button"
						class={buttonClass}
						aria-label={label}
						{title}
					>
						<Plus class="size-6" />
					</button>
				{/snippet}
			</DropdownMenu.Trigger>
			<DropdownMenu.Content align="end" side="top" sideOffset={8} class="w-48 p-1">
				{@render menu()}
			</DropdownMenu.Content>
		</DropdownMenu.Root>
	{:else}
		<button
			type="button"
			{onclick}
			class={buttonClass}
			aria-label={label}
			{title}
		>
			<Plus class="size-6" />
		</button>
	{/if}
</div>
