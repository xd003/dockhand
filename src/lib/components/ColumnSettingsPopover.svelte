<script lang="ts">
	import { Settings2, RotateCcw, ChevronUp, ChevronDown } from 'lucide-svelte';
	import { Button } from '$lib/components/ui/button';
	import * as Popover from '$lib/components/ui/popover';
	import { Checkbox } from '$lib/components/ui/checkbox';
	import { Label } from '$lib/components/ui/label';
	import { gridPreferencesStore } from '$lib/stores/grid-preferences';
	import { getConfigurableColumns } from '$lib/config/grid-columns';
	import type { GridId, ColumnPreference } from '$lib/types';

	interface Props {
		gridId: GridId;
		/** Column ids hidden by the current environment; not listed and never reordered across */
		hiddenColumns?: readonly string[];
	}

	let { gridId, hiddenColumns = [] }: Props = $props();

	let open = $state(false);
	let columns = $state<ColumnPreference[]>([]);

	// Load columns when popover opens
	$effect(() => {
		if (open) {
			columns = gridPreferencesStore.getAllColumns(gridId);
		}
	});

	// Get column labels from config
	const columnConfigs = $derived(getConfigurableColumns(gridId));
	function getColumnLabel(id: string): string {
		const config = columnConfigs.find((c) => c.id === id);
		return config?.label || id;
	}

	// Save columns and update grid immediately
	async function saveColumns(newColumns: ColumnPreference[]) {
		columns = newColumns;
		await gridPreferencesStore.setColumns(gridId, columns);
	}

	// Toggle column visibility
	function toggleColumn(index: number) {
		const newColumns = columns.map((col, i) =>
			i === index ? { ...col, visible: !col.visible } : col
		);
		saveColumns(newColumns);
	}

	// Nearest column in direction `dir` that is not hidden by the environment, or -1
	function neighborIndex(index: number, dir: -1 | 1): number {
		for (let i = index + dir; i >= 0 && i < columns.length; i += dir) {
			if (!hiddenColumns.includes(columns[i].id)) return i;
		}
		return -1;
	}

	// Move column up/down (skipping environment-hidden columns)
	function moveUp(index: number) {
		const target = neighborIndex(index, -1);
		if (target === -1) return;
		const newColumns = [...columns];
		[newColumns[target], newColumns[index]] = [newColumns[index], newColumns[target]];
		saveColumns(newColumns);
	}

	function moveDown(index: number) {
		const target = neighborIndex(index, 1);
		if (target === -1) return;
		const newColumns = [...columns];
		[newColumns[index], newColumns[target]] = [newColumns[target], newColumns[index]];
		saveColumns(newColumns);
	}

	// Reset to defaults
	async function resetToDefaults() {
		await gridPreferencesStore.resetGrid(gridId);
		columns = gridPreferencesStore.getAllColumns(gridId);
		open = false;
	}
</script>

<Popover.Root bind:open>
	<Popover.Trigger asChild>
		{#snippet child({ props })}
			<button
				type="button"
				title="Column settings"
				{...props}
				class="inline-flex items-center justify-center p-1 rounded hover:bg-muted/50 text-muted-foreground hover:text-foreground transition-colors"
			>
				<Settings2 class="w-4 h-4" />
			</button>
		{/snippet}
	</Popover.Trigger>
	<Popover.Content class="w-64 p-0" side="bottom" align="end" sideOffset={8}>
		<div class="p-3 border-b">
			<div class="flex items-center justify-between">
				<span class="font-medium text-sm">Columns</span>
				<Button
					variant="ghost"
					size="sm"
					class="h-6 px-2 text-xs"
					onclick={resetToDefaults}
					title="Reset to defaults"
				>
					<RotateCcw class="w-3 h-3" />
					Reset
				</Button>
			</div>
		</div>

		<div class="max-h-64 overflow-y-auto p-2">
			{#each columns as column, index (column.id)}
				{#if !hiddenColumns.includes(column.id)}
					<div class="flex items-center gap-1 p-1 rounded hover:bg-muted/50">
						<div class="flex flex-col">
							<button
								type="button"
								class="p-0.5 hover:bg-muted rounded disabled:opacity-30"
								disabled={neighborIndex(index, -1) === -1}
								onclick={() => moveUp(index)}
							>
								<ChevronUp class="w-3 h-3" />
							</button>
							<button
								type="button"
								class="p-0.5 hover:bg-muted rounded disabled:opacity-30"
								disabled={neighborIndex(index, 1) === -1}
								onclick={() => moveDown(index)}
							>
								<ChevronDown class="w-3 h-3" />
							</button>
						</div>
						<Checkbox
							id="col-{column.id}"
							checked={column.visible}
							onCheckedChange={() => toggleColumn(index)}
						/>
						<Label
							for="col-{column.id}"
							class="text-sm cursor-pointer flex-1 truncate"
						>
							{getColumnLabel(column.id)}
						</Label>
					</div>
				{/if}
			{/each}
		</div>

	</Popover.Content>
</Popover.Root>
