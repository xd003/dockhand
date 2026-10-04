<script lang="ts">
	import { Input } from '$lib/components/ui/input';
	import { Label } from '$lib/components/ui/label';
	import { TogglePill } from '$lib/components/ui/toggle-pill';
	import * as Select from '$lib/components/ui/select';
	import { Percent, HardDrive, TriangleAlert, Lock } from 'lucide-svelte';
	import {
		ACTIVITY_OVERRIDE_ENV_VARS,
		NO_ACTIVITY_OVERRIDES,
		type ActivityOverrides
	} from '$lib/utils/activity-overrides';
	import {
		percentageUnsupportedNote,
		percentageOptionDisabled
	} from '$lib/utils/disk-percentage-support';

	interface Props {
		collectActivity: boolean;
		collectMetrics: boolean;
		collectContainerMetrics: boolean;
		highlightChanges: boolean;
		diskWarningEnabled: boolean;
		diskWarningMode: 'percentage' | 'absolute';
		diskWarningThreshold: number;
		diskWarningThresholdGb: number;
		/** Whether this host reports a total to measure against; null = could not ask. */
		percentageSupported?: boolean | null;
		storageDriver?: string | null;
		/** The mode as loaded from the server, so switching away cannot lock it out. */
		storedDiskWarningMode?: 'percentage' | 'absolute' | null;
		/** Values forced by COLLECT_* env vars; non-null locks the matching toggle. */
		overrides?: ActivityOverrides;
	}

	let {
		collectActivity = $bindable(),
		collectMetrics = $bindable(),
		collectContainerMetrics = $bindable(),
		highlightChanges = $bindable(),
		diskWarningEnabled = $bindable(),
		diskWarningMode = $bindable(),
		diskWarningThreshold = $bindable(),
		diskWarningThresholdGb = $bindable(),
		percentageSupported = null,
		storageDriver = null,
		storedDiskWarningMode = null,
		overrides = NO_ACTIVITY_OVERRIDES
	}: Props = $props();

	// Only a definite "no" disables the option. An unreachable host stays unknown, so a
	// momentary outage never takes the setting away from somebody.
	const percentageDead = $derived(percentageSupported === false);
	const percentageNote = $derived(percentageUnsupportedNote(storageDriver));
</script>

<div class="flex items-start gap-3">
	<div class="flex-1">
		<Label>Collect container activity</Label>
		<p class="text-xs text-muted-foreground">Track container events (start, stop, restart, etc.) from this environment in real-time</p>
		{#if overrides.collectActivity !== null}
			<p class="text-xs text-amber-500 flex items-center gap-1 mt-1"><Lock class="w-3 h-3" />Set by the <code class="bg-muted px-1 rounded">{ACTIVITY_OVERRIDE_ENV_VARS.collectActivity}</code> environment variable</p>
		{/if}
	</div>
	<TogglePill bind:checked={collectActivity} disabled={overrides.collectActivity !== null} />
</div>
<div class="flex items-start gap-3">
	<div class="flex-1">
		<Label>Collect system metrics</Label>
		<p class="text-xs text-muted-foreground">Collect CPU and memory history for the dashboard tiles and charts. Per-container live stats are controlled separately below.</p>
		{#if overrides.collectMetrics !== null}
			<p class="text-xs text-amber-500 flex items-center gap-1 mt-1"><Lock class="w-3 h-3" />Set by the <code class="bg-muted px-1 rounded">{ACTIVITY_OVERRIDE_ENV_VARS.collectMetrics}</code> environment variable</p>
		{/if}
	</div>
	<TogglePill bind:checked={collectMetrics} disabled={overrides.collectMetrics !== null} />
</div>
<div class="flex items-start gap-3">
	<div class="flex-1">
		<Label>Collect container metrics</Label>
		<p class="text-xs text-muted-foreground">Poll live CPU, memory, network I/O and disk I/O for each container on the containers and stacks pages, in container details, and for the dashboard's top containers. When off, Dockhand sends no per-container stats requests to this environment and these values are hidden.</p>
		{#if overrides.collectContainerMetrics !== null}
			<p class="text-xs text-amber-500 flex items-center gap-1 mt-1"><Lock class="w-3 h-3" />Set by the <code class="bg-muted px-1 rounded">{ACTIVITY_OVERRIDE_ENV_VARS.collectContainerMetrics}</code> environment variable</p>
		{/if}
	</div>
	<TogglePill bind:checked={collectContainerMetrics} disabled={overrides.collectContainerMetrics !== null} />
</div>
<div class="flex items-start gap-3">
	<div class="flex-1">
		<Label>Highlight value changes</Label>
		<p class="text-xs text-muted-foreground">Flash an amber glow on a container's stat cell when its value changes. The numbers keep updating either way - this only controls the highlight animation.</p>
	</div>
	<TogglePill bind:checked={highlightChanges} />
</div>

<div class="border-t pt-4 mt-2 space-y-3">
	<div class="flex items-start gap-3">
		<div class="flex-1">
			<Label>Disk space warnings</Label>
			<p class="text-xs text-muted-foreground">Send notifications when Docker disk usage exceeds the threshold</p>
		</div>
		<TogglePill bind:checked={diskWarningEnabled} />
	</div>

	{#if diskWarningEnabled}
		<div class="flex items-center gap-3">
			<Select.Root type="single" value={diskWarningMode} onValueChange={(v) => { if (v) diskWarningMode = v as 'percentage' | 'absolute'; }}>
				<Select.Trigger class="w-full sm:w-48">
					<div class="flex items-center gap-2">
						{#if diskWarningMode === 'percentage'}
							{#if percentageDead}
								<TriangleAlert class="w-3.5 h-3.5 text-[hsl(39_67%_69%)]" />
							{:else}
								<Percent class="w-3.5 h-3.5" />
							{/if}
							<span>Percentage</span>
						{:else}
							<HardDrive class="w-3.5 h-3.5" />
							<span>Absolute (GB)</span>
						{/if}
					</div>
				</Select.Trigger>
				<Select.Content>
					<Select.Item
						value="percentage"
						disabled={percentageOptionDisabled(percentageSupported, storedDiskWarningMode)}
					>
						<div class="flex flex-col gap-0.5">
							<div class="flex items-center gap-2">
								<Percent class="w-3.5 h-3.5" />
								Percentage
							</div>
							{#if percentageDead}
								<span class="text-xs text-muted-foreground">does not work on this host</span>
							{/if}
						</div>
					</Select.Item>
					<Select.Item value="absolute">
						<div class="flex items-center gap-2">
							<HardDrive class="w-3.5 h-3.5" />
							Absolute (GB)
						</div>
					</Select.Item>
				</Select.Content>
			</Select.Root>

			{#if diskWarningMode === 'percentage'}
				<Input
					type="number"
					min={1}
					max={100}
					bind:value={diskWarningThreshold}
					class="w-full sm:w-24"
				/>
				<span class="text-sm text-muted-foreground">%</span>
			{:else}
				<Input
					type="number"
					min={1}
					bind:value={diskWarningThresholdGb}
					class="w-full sm:w-24"
				/>
				<span class="text-sm text-muted-foreground">GB</span>
			{/if}
		</div>

		{#if percentageDead && diskWarningMode === 'percentage'}
			<!-- A stored mode that cannot fire is worse than no warning: the setting
			     looks on, so nobody goes looking. Say it where the setting is. -->
			<div
				class="flex items-start gap-2 rounded-md border border-[hsl(39_67%_69%_/_0.3)] bg-[hsl(39_67%_69%_/_0.08)] px-3 py-2"
			>
				<TriangleAlert class="mt-0.5 w-4 h-4 shrink-0 text-[hsl(39_67%_69%)]" />
				<div class="flex-1 text-xs">
					<p class="text-[hsl(39_67%_69%)]">{percentageNote}</p>
					<button
						class="mt-1 underline underline-offset-2 text-muted-foreground hover:text-foreground"
						onclick={() => (diskWarningMode = 'absolute')}
					>
						Switch to Absolute (GB)
					</button>
				</div>
			</div>
		{/if}
	{/if}
</div>
