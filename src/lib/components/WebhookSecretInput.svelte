<script lang="ts">
	import { Button } from '$lib/components/ui/button';
	import { Input } from '$lib/components/ui/input';
	import { Label } from '$lib/components/ui/label';
	import * as Tooltip from '$lib/components/ui/tooltip';
	import { Check, Copy, Key, XCircle } from 'lucide-svelte';
	import { copyToClipboard } from '$lib/utils/clipboard';
	import { generateWebhookSecret } from '$lib/utils/webhook-secret';

	interface Props {
		id: string;
		value?: string;
		error?: string;
		label?: string;
		showCopy?: boolean;
		oninput?: () => void;
	}

	let {
		id,
		value = $bindable(''),
		error,
		label = 'Webhook secret',
		showCopy = false,
		oninput
	}: Props = $props();

	let copied = $state<'ok' | 'error' | null>(null);

	async function copySecret() {
		const ok = await copyToClipboard(value);
		copied = ok ? 'ok' : 'error';
		setTimeout(() => copied = null, 2000);
	}
</script>

<div class="space-y-2">
	<Label for={id}>{label}</Label>
	<div class="flex gap-2">
		<Input
			{id}
			bind:value
			placeholder="Required - generate or paste a secret"
			class="font-mono text-xs {error ? 'border-destructive focus-visible:ring-destructive' : ''}"
			oninput={() => oninput?.()}
		/>
		{#if showCopy && value}
			<Button variant="outline" size="sm" onclick={copySecret} title="Copy secret">
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
		{/if}
		<Tooltip.Root>
			<Tooltip.Trigger>
				<Button
					variant="outline"
					size="sm"
					type="button"
					onclick={() => value = generateWebhookSecret()}
				>
					<Key class="w-4 h-4" />
				</Button>
			</Tooltip.Trigger>
			<Tooltip.Content>Generate secret</Tooltip.Content>
		</Tooltip.Root>
	</div>
	{#if error}
		<p class="text-xs text-destructive">{error}</p>
	{/if}
</div>
