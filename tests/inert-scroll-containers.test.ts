import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { Glob } from 'bun';
import { parse } from 'svelte/compiler';

/**
 * No scroll container may sit on or under an `inert` element.
 *
 * Browsers drop inert subtrees from hit-testing, so wheel and touch scrolling never
 * reach a scroller inside one: the scrollbar renders, the content cannot be scrolled.
 * This shipped repeatedly in the read-only Git stack settings view
 * (GitStackModal: `inert={readonly}` on the form row wrapping the `overflow-y-auto`
 * column), which scrolled fine in edit mode only because edit mode is not inert.
 *
 * Correct pattern: keep the scroller outside the inert subtree and put `inert` on its
 * content (`<div class="overflow-y-auto"><div inert={readonly}>…</div></div>`).
 *
 * A browser is not available to `bun test`, so this checks the invariant on the
 * Svelte AST of every component: any element carrying `inert` (static or bound),
 * and every descendant of it, must not declare an overflow auto/scroll class or style.
 */

const SRC = new URL('../src/', import.meta.url);
const SCROLLER = /(?:^|[\s'"`:!{])overflow(?:-[xy])?-(?:auto|scroll)\b|overflow(?:-[xy])?\s*:\s*(?:auto|scroll)\b/;
const CHILD_KEYS = ['fragment', 'nodes', 'consequent', 'alternate', 'body', 'fallback', 'pending', 'then', 'catch'] as const;

type Node = {
	type: string;
	name?: string;
	start: number;
	attributes?: { type: string; name: string; start: number; end: number }[];
	[key: string]: unknown;
};

function violations(file: string, source: string): string[] {
	const found: string[] = [];
	const line = (offset: number) => source.slice(0, offset).split('\n').length;

	function visit(node: Node, inertAt: number | null): void {
		let inert = inertAt;
		if (inert === null && node.attributes?.some((a) => a.type === 'Attribute' && a.name === 'inert')) inert = node.start;
		if (inert !== null) {
			for (const attr of node.attributes ?? []) {
				if (attr.type !== 'Attribute' || (attr.name !== 'class' && attr.name !== 'style')) continue;
				if (SCROLLER.test(source.slice(attr.start, attr.end))) {
					found.push(`${file}:${line(node.start)} <${node.name}> scrolls inside inert element at line ${line(inert)}`);
				}
			}
		}
		for (const key of CHILD_KEYS) {
			const child = node[key];
			if (Array.isArray(child)) for (const c of child) visit(c as Node, inert);
			else if (child && typeof child === 'object' && 'type' in child) visit(child as Node, inert);
		}
	}

	// Svelte's modern AST root fragment is structurally a Node for this walk.
	visit(parse(source, { modern: true }).fragment as unknown as Node, null);
	return found;
}

describe('inert subtrees', () => {
	test('contain no scroll containers in any Svelte component', () => {
		const files = [...new Glob('**/*.svelte').scanSync({ cwd: SRC.pathname })];
		expect(files.length).toBeGreaterThan(0);
		const all = files.flatMap((f) => violations(`src/${f}`, readFileSync(new URL(f, SRC), 'utf8')));
		expect(all).toEqual([]);
	});

	test('the detector flags a scroller under inert and accepts inert content inside a scroller', () => {
		expect(
			violations('bad.svelte', '<div inert={ro}><div class="flex overflow-y-auto"><p>x</p></div></div>')
		).toHaveLength(1);
		expect(violations('bad.svelte', '{#if a}<div inert style="overflow: auto"></div>{/if}')).toHaveLength(1);
		expect(
			violations('good.svelte', '<div class="overflow-y-auto"><div inert={ro}><p>x</p></div></div>')
		).toEqual([]);
	});
});
