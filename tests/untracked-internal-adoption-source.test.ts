import { describe, expect, it } from 'bun:test';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const modal = readFileSync(join(root, 'src/routes/stacks/StackModal.svelte'), 'utf8');

describe('untracked internal adoption wiring', () => {
	it('adopts the selected compose file before saving stack data', () => {
		const adoption = modal.indexOf("await fetch('/api/stacks/adopt'");
		const requestBody = modal.indexOf('const requestBody:', adoption);

		expect(adoption).toBeGreaterThan(-1);
		expect(requestBody).toBeGreaterThan(adoption);
		expect(modal.slice(adoption, requestBody)).toContain('needsFileLocation = false');
	});

	it('keeps the stack untracked after loading the selected file', () => {
		const load = modal.indexOf('async function loadFilesFromLocalFilesystem');
		const end = modal.indexOf('// CodeEditor reference', load);

		expect(modal.slice(load, end)).not.toContain('needsFileLocation = false');
	});
});
