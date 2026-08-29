<script lang="ts">
	import { Dialog as DialogPrimitive } from "bits-ui";
	import DialogPortal from "./dialog-portal.svelte";
	import XIcon from "@lucide/svelte/icons/x";
	import type { Snippet } from "svelte";
	import * as Dialog from "./index.js";
	import { cn, type WithoutChildrenOrChild } from "$lib/utils.js";
	import type { ComponentProps } from "svelte";

	let {
		ref = $bindable(null),
		class: className,
		portalProps,
		children,
		showCloseButton = true,
		...restProps
	}: WithoutChildrenOrChild<DialogPrimitive.ContentProps> & {
		portalProps?: WithoutChildrenOrChild<ComponentProps<typeof DialogPortal>>;
		children: Snippet;
		showCloseButton?: boolean;
	} = $props();

	// Callers that set their own padding (e.g. `p-0` full-bleed editors) must not
	// inherit the responsive default: tailwind-merge drops `p-6` for `p-0` but keeps
	// the variant `max-sm:p-4`, which would re-pad the dialog on phones.
	const hasCustomPadding = $derived(typeof className === 'string' && /(^|\s)p-\S+/.test(className));
</script>

<DialogPortal {...portalProps}>
	<Dialog.Overlay />
	<DialogPrimitive.Content
		bind:ref
		data-slot="dialog-content"
		class={cn(
			"bg-background fixed start-[50%] top-[50%] z-[150] grid w-full max-w-[calc(100%-2rem)] max-sm:max-w-[calc(100%-1rem)] max-sm:max-h-[calc(100dvh-1rem)] translate-x-[-50%] translate-y-[-50%] gap-4 rounded-lg border shadow-lg",
			!hasCustomPadding && "p-6 max-sm:p-4",
			!className?.includes('max-w-') && "sm:max-w-lg",
			className
		)}
		{...restProps}
	>
		{@render children?.()}
		{#if showCloseButton}
			<DialogPrimitive.Close
				class="ring-offset-background focus:ring-ring rounded-xs focus:outline-hidden absolute end-4 top-4 max-sm:end-2 max-sm:top-2 z-20 flex max-sm:size-11 items-center justify-center opacity-70 transition-opacity hover:opacity-100 focus:ring-2 focus:ring-offset-2 disabled:pointer-events-none [&_svg:not([class*='size-'])]:size-4 [&_svg]:pointer-events-none [&_svg]:shrink-0"
			>
				<XIcon />
				<span class="sr-only">Close</span>
			</DialogPrimitive.Close>
		{/if}
	</DialogPrimitive.Content>
</DialogPortal>
