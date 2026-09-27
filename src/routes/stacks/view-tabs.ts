/**
 * Classes for the Settings / Editor / Graph / Deploys / Backups switcher shared by the
 * stack and Git stack dialogs. Phones get equal-width icon-over-label segments so every
 * view stays visible without a horizontal scroller.
 */
export function stackViewTabClass(active: boolean): string {
	const state = active
		? 'bg-background text-foreground shadow-sm'
		: 'text-muted-foreground hover:bg-background/50 hover:text-foreground';
	return `flex items-center gap-1.5 rounded-md px-3 py-1.5 text-sm transition-colors max-md:min-h-11 max-md:min-w-0 max-md:flex-1 max-md:flex-col max-md:justify-center max-md:gap-0.5 max-md:px-1 max-md:text-xs ${state}`;
}

/** Tab list wrapper (inside the bordered strip) matching {@link stackViewTabClass}. */
export const STACK_VIEW_TABLIST_CLASS = 'flex items-center gap-0.5 rounded-lg bg-muted/70 p-1 max-md:w-full';
