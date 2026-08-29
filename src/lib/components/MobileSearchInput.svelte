<script lang="ts">
	import { Search } from 'lucide-svelte';
	import { Input } from '$lib/components/ui/input';

	interface Props {
		value: string;
		/** Accessible label; the placeholder is `${label}...` */
		label: string;
		/** Wrapper classes */
		class: string;
	}

	let { value = $bindable(), label, class: className }: Props = $props();
</script>

<div class={className}>
	<Search class="absolute left-3 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" />
	<Input
		type="search"
		aria-label={label}
		placeholder="{label}..."
		bind:value
		onkeydown={(e) => e.key === 'Escape' && (value = '')}
		class="h-11 rounded-lg pl-10"
	/>
</div>
