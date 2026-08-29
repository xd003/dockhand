<script lang="ts">
	import { Tabs as TabsPrimitive } from "bits-ui";
	import { cn } from "$lib/utils.js";

	let {
		ref = $bindable(null),
		class: className,
		...restProps
	}: TabsPrimitive.ListProps = $props();
</script>

<TabsPrimitive.List
	bind:ref
	data-slot="tabs-list"
	class={cn(
		"bg-muted/50 text-muted-foreground flex max-w-full h-auto min-h-10 w-fit flex-wrap items-center justify-center rounded-t-lg p-1 gap-1",
		className
	)}
	{...restProps}
/>
