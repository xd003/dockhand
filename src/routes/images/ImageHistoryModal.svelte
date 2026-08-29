<script lang="ts">
	import * as Dialog from '$lib/components/ui/dialog';
	import { Button } from '$lib/components/ui/button';
	import { Layers } from 'lucide-svelte';
	import ImageLayersView from './ImageLayersView.svelte';

	interface Props {
		open: boolean;
		imageId: string;
		imageName?: string;
	}

	let { open = $bindable(), imageId, imageName }: Props = $props();
</script>

<Dialog.Root bind:open>
	<Dialog.Content class="max-w-5xl max-h-[90vh] flex flex-col min-h-[min(400px,calc(100dvh-1rem))] !animate-none">
		<Dialog.Header>
			<Dialog.Title class="flex min-w-0 items-center gap-2 max-sm:pr-12">
				<Layers class="w-5 h-5 shrink-0" />
				<span class="shrink-0">Image layers:</span> <span class="min-w-0 truncate text-muted-foreground font-normal">{imageName || imageId.slice(7, 19)}</span>
			</Dialog.Title>
		</Dialog.Header>

		<div class="flex-1 overflow-auto space-y-4 pr-2">
			<ImageLayersView
				imageId={imageId}
				imageName={imageName}
				visible={open}
			/>
		</div>

		<Dialog.Footer>
			<Button variant="outline" onclick={() => (open = false)}>Close</Button>
		</Dialog.Footer>
	</Dialog.Content>
</Dialog.Root>
