import { describe, expect, test } from 'bun:test';
import { readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const sourcesRoutePath = join(root, 'src', 'routes', 'api', 'stacks', 'sources', '+server.ts');
const composeRoutePath = join(root, 'src', 'routes', 'api', 'stacks', '[name]', 'compose', '+server.ts');
const stacksPath = join(root, 'src', 'lib', 'server', 'stacks.ts');
const stackModalPath = join(root, 'src', 'routes', 'stacks', 'StackModal.svelte');
const stackFileEditorPath = join(root, 'src', 'routes', 'stacks', 'StackFileEditor.svelte');

describe('stack staging display paths', () => {
	test('/stacks sources uses stored staging paths without Hawser display remapping', async () => {
		const source = await readFile(sourcesRoutePath, 'utf8');
		expect(source).toContain('resolveStackSourceDisplayPaths(source)');
		expect(source).not.toContain('remapHawserStagingDisplayPaths');
	});

	test('the editor keeps staging paths and exposes only the Hawser directory as secondary metadata', async () => {
		const source = await readFile(composeRoutePath, 'utf8');
		const modal = await readFile(stackModalPath, 'utf8');
		const editor = await readFile(stackFileEditorPath, 'utf8');
		const stacks = await readFile(stacksPath, 'utf8');
		expect(source).toContain('composePath: result.composePath');
		expect(source).toContain('composeContents: result.composeContents ?? null');
		expect(source).toContain('remoteComposePath');
		expect(source).not.toContain('unmapHawserDisplayComposeOptionsToStaging');
		expect(modal).toContain('hostPath={activeHostPath}');
		expect(editor).toContain('Dockhand path');
		expect(editor).toContain('Hawser host path');
		expect(stacks).not.toContain("getEnvSetting('remote_stacks_dir', environmentId)");
	});

	test('the editor reads Git compose and env files from the deployed stack directory', async () => {
		const source = await readFile(stacksPath, 'utf8');
		expect(source).toContain('foundStackDir = await getStackDir(stackName, envId)');
		expect(source).toContain('source.gitStack.envFilePath');
	});
});
