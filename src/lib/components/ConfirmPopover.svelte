<script lang="ts">
	import { Button } from '$lib/components/ui/button';
	import * as Popover from '$lib/components/ui/popover';
	import { cn } from '$lib/utils';
	import type { Snippet } from 'svelte';
	import { appSettings } from '$lib/stores/settings';
	import { IsMobile } from '$lib/hooks/is-mobile.svelte';

	interface Props {
		/** Optional — the popover self-manages its open state; bind only if the parent needs it. */
		open?: boolean;
		action: string;
		itemName?: string;
		itemType: string;
		confirmText?: string;
		variant?: 'destructive' | 'secondary' | 'default';
		autoHideMs?: number;
		title?: string;
		position?: 'left' | 'right';
		unstyled?: boolean;
		disabled?: boolean;
		/** Optional — extra classes for the trigger button. */
		class?: string;
		onConfirm: () => void;
		/** Optional — notified when the popover opens/closes. */
		onOpenChange?: (open: boolean) => void;
		children: Snippet<[{ open: boolean }]>;
		extraContent?: Snippet;
	}

	let {
		open = $bindable(false),
		action,
		itemName = '',
		itemType,
		confirmText = 'Confirm',
		variant = 'destructive',
		autoHideMs = 3000,
		title = '',
		position = 'right',
		unstyled = false,
		disabled = false,
		class: className = '',
		onConfirm,
		onOpenChange,
		children,
		extraContent
	}: Props = $props();

	const isMobile = new IsMobile();

	const triggerClass = $derived(cn('inline-flex items-center cursor-pointer', !unstyled && 'p-1 max-sm:min-h-11 max-sm:min-w-11 max-sm:justify-center rounded hover:bg-muted transition-colors opacity-70 hover:opacity-100', className));

	// Get the confirmDestructive setting from the store
	const confirmDestructive = $derived($appSettings.confirmDestructive);

	// Truncate long names
	const displayName = $derived(itemName && itemName.length > 20 ? itemName.slice(0, 20) + '...' : itemName);

	// Auto-hide after specified time
	$effect(() => {
		if (open && !isMobile.current && autoHideMs > 0) {
			const timeout = setTimeout(() => {
				open = false;
				onOpenChange?.(false);
			}, autoHideMs);
			return () => clearTimeout(timeout);
		}
	});

	function handleConfirm() {
		onConfirm();
		open = false;
		onOpenChange?.(false);
	}

	function handleDismiss() {
		open = false;
		onOpenChange?.(false);
	}

	function handleTriggerClick(e: MouseEvent) {
		e.stopPropagation();
		// If confirmDestructive is disabled, execute action immediately
		if (!confirmDestructive) {
			onConfirm();
			return;
		}
		open = !open;
		onOpenChange?.(open);
	}

	function handleOpenChange(newOpen: boolean) {
		open = newOpen;
		onOpenChange?.(newOpen);
	}
</script>

{#if isMobile.current}
	<!-- Mobile: bottom action sheet instead of a popover (touch-friendly, never clipped) -->
	<button type="button" {title} {disabled} onclick={handleTriggerClick} class={triggerClass}>
		{@render children({ open })}
	</button>
	{#if open}
		<div class="fixed inset-0 z-[200]">
			<button type="button" aria-label="Cancel" class="absolute inset-0 bg-black/60" onclick={handleDismiss}></button>
			<div
				class="absolute inset-x-0 bottom-0 max-h-[85dvh] overflow-y-auto rounded-t-2xl border-t bg-popover p-4 pb-[max(1rem,env(safe-area-inset-bottom))] shadow-lg"
				role="dialog"
				aria-label={`${action} ${itemType} confirmation`}
			>
				<div class="mx-auto mb-3 h-1 w-10 rounded-full bg-muted-foreground/30"></div>
				<p class="text-sm">
					{action} {itemType}{#if displayName}{' '}<strong>{displayName}</strong>{/if}?
				</p>
				{#if extraContent}
					<div class="mt-3">
						{@render extraContent()}
					</div>
				{/if}
				<div class="mt-4 grid grid-cols-2 gap-2">
					<Button variant="outline" class="min-h-11" onclick={handleDismiss}>Cancel</Button>
					<Button {variant} class="min-h-11" onclick={handleConfirm}>{confirmText}</Button>
				</div>
			</div>
		</div>
	{/if}
{:else}
	<Popover.Root bind:open onOpenChange={handleOpenChange}>
		<Popover.Trigger>
			{#snippet child({ props })}
				<button
					type="button"
					{title}
					{disabled}
					{...props}
					onclick={handleTriggerClick}
					class={triggerClass}
				>
					{@render children({ open })}
				</button>
			{/snippet}
		</Popover.Trigger>
		<Popover.Content
			class="w-auto p-2 z-[200]"
			side="top"
			align={position === 'left' ? 'start' : 'end'}
			sideOffset={8}
		>
			<div class="flex flex-col gap-1.5">
				<div class="flex items-center gap-2">
					<span class="text-xs whitespace-nowrap">{action} {itemType} {#if displayName}<strong>{displayName}</strong>{/if}?</span>
					<Button size="sm" {variant} class="h-6 px-2 text-xs" onclick={handleConfirm}>
						{confirmText}
					</Button>
				</div>
				{#if extraContent}
					{@render extraContent()}
				{/if}
			</div>
		</Popover.Content>
	</Popover.Root>
{/if}
