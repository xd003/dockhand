import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const modal = readFileSync(join(import.meta.dir, '../src/routes/stacks/GitStackModal.svelte'), 'utf8');

describe('centralized Git stack browsing', () => {
	test('uses the shared clone for browsing and the editor draft', () => {
		expect(modal).toContain('else if (!isCentralizedMode && temporaryCloneToken)');
		expect(modal).toContain('if (!gitStack && !isCentralizedMode) {\n\t\t\t\t\tif (!(await prepareTemporaryClone');
		expect(modal).toContain('if (gitStack || !formRepositoryId) return;');
		expect(modal).toContain("isCentralizedMode ? { shared: '1' } : { token: temporaryCloneToken! }");
		expect(modal).toContain('if (!isCentralizedMode && !(await prepareTemporaryClone');
	});

	test('links draft files through the repository browser rooted at the Compose directory', () => {
		expect(modal).not.toContain("window.prompt('Relative configuration file path under the Compose directory')");
		expect(modal).toContain("gitBrowserPurpose = 'link'");
		expect(modal).toContain("gitBrowserInitialPath = (formComposePaths[0] || formComposePath).replace(/\\/[^/]*$/, '')");
		expect(modal).toContain("title={gitBrowserPurpose === 'link' ? 'Link configuration file' : 'Select compose file(s)'}");
		expect(modal).toContain("onSelect={gitBrowserPurpose === 'link' ? selectGitDraftLink");
	});
});
