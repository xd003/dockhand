<script lang="ts">
	import { m } from '$lib/paraglide/messages.js';

	interface Props {
		count: number;
		onClear: () => void;
	}

	let { count, onClear }: Props = $props();
</script>

<span class="inline-flex min-h-4 items-center gap-2 text-xs text-muted-foreground">
	<span>{m.containers_list_selected_count({ count })}</span>
	<button
		type="button"
		class="inline-flex min-h-4 items-center rounded border border-border px-2 hover:border-foreground/30 hover:shadow transition-all"
		onclick={onClear}
	>
		{m.containers_list_clear_selection()}
	</button>
</span>
