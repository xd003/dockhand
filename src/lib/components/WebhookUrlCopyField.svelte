<script lang="ts">
	import { Button } from '$lib/components/ui/button';
	import { Input } from '$lib/components/ui/input';
	import { Label } from '$lib/components/ui/label';
	import * as Tooltip from '$lib/components/ui/tooltip';
	import { Check, Copy, XCircle } from 'lucide-svelte';
	import { copyToClipboard } from '$lib/utils/clipboard';

	interface Props {
		url: string;
		label?: string;
	}

	let { url, label = 'Webhook URL' }: Props = $props();

	let copied = $state<'ok' | 'error' | null>(null);

	async function copyUrl() {
		const ok = await copyToClipboard(url);
		copied = ok ? 'ok' : 'error';
		setTimeout(() => copied = null, 2000);
	}
</script>

<div class="space-y-2">
	<Label>{label}</Label>
	<div class="flex gap-2">
		<Input value={url} readonly class="font-mono text-xs bg-background" />
		<Button variant="outline" size="sm" onclick={copyUrl} title="Copy URL">
			{#if copied === 'error'}
				<Tooltip.Root open>
					<Tooltip.Trigger>
						<XCircle class="w-4 h-4 text-red-500" />
					</Tooltip.Trigger>
					<Tooltip.Content>Copy requires HTTPS</Tooltip.Content>
				</Tooltip.Root>
			{:else if copied === 'ok'}
				<Check class="w-4 h-4 text-green-500" />
			{:else}
				<Copy class="w-4 h-4" />
			{/if}
		</Button>
	</div>
</div>
