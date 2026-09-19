import { describe, expect, it } from 'bun:test';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const adoption = readFileSync(join(root, 'src/lib/server/git-stack-adoption.ts'), 'utf8');
const sharedDeploy = readFileSync(join(root, 'src/lib/server/git-deploy-shared.ts'), 'utf8');
const stacks = readFileSync(join(root, 'src/lib/server/stacks.ts'), 'utf8');
const route = readFileSync(join(root, 'src/routes/api/git/stacks/+server.ts'), 'utf8');
const modal = readFileSync(join(root, 'src/routes/stacks/GitStackModal.svelte'), 'utf8');

describe('external Git adoption wiring', () => {
	it('keeps the selected external stack name fixed', () => {
		expect(modal).toContain('formStackName = adoptionTarget.stackName;\n\t\t\tformStackNameUserModified = true;');
		expect(modal).toContain("formRepositoryId && !gitStack && !isAdopting && !formStackNameUserModified");
	});

	it('submits the environment captured by the adoption target', () => {
		expect(modal).toContain('adoptionTarget?.environmentId ?? environmentId ?? null');
		expect(modal).toContain('environmentId: effectiveEnvId');
	});

	it('performs the authoritative preflight while holding the route lock', () => {
		const acquire = route.indexOf('await acquireStackLock(trimmedStackName)');
		const preflight = route.indexOf('await validateExternalGitAdoption', acquire);
		const job = route.indexOf('return createJobResponse', preflight);

		expect(acquire).toBeGreaterThan(-1);
		expect(preflight).toBeGreaterThan(acquire);
		expect(job).toBeGreaterThan(preflight);
		expect(route.slice(preflight, job)).toContain('status: preflight.status');
		expect(route).toContain('{ lockHeld: true }');
	});

	it('normalizes persisted environment IDs before detecting Hawser staging', () => {
		const normalization = route.indexOf('data.environmentId = Number(data.environmentId)');
		const preflight = route.indexOf('await validateExternalGitAdoption');

		expect(normalization).toBeGreaterThan(-1);
		expect(preflight).toBeGreaterThan(normalization);
		expect(route).toContain("environmentId must be a positive integer or null");
	});

	it('stores an explicit env file relative to the managed stack root', () => {
		expect(adoption).toContain('join(preflight.destinationDir, syncResult.envFileName)');
		expect(adoption).not.toContain('join(targetComposeDir, syncResult.envFileName)');
	});

	it('adopts and cleans the temporary repository checkout', () => {
		expect(adoption).toContain('await adoptPendingGitClone(gitStack.id, temporaryCloneToken)');
		expect(adoption).toContain('discardPendingGitClone(temporaryCloneToken, repositoryId)');
	});

	it('derives rowless untracked stack paths from server-side Docker labels', () => {
		expect(adoption).toContain('await getStackPathHints(stackName, environmentId)');
		expect(adoption).toContain('resolveComposePathHints(hints.workingDir, hints.configFiles)');
	});

	it('does not require Hawser host paths to exist on the Dockhand filesystem', () => {
		expect(adoption).toContain('isHawserConnection(await getEnvironment(environmentId))');
		expect(adoption).toContain('if (!remoteSource) {');
		expect(adoption).toContain('if (!preflight.remoteSource) {');
	});

	it('allows adoption when the external directory is already the managed destination', () => {
		expect(adoption).toContain('const sameDirectory = resolve(sourceState.sourceDir) === destinationDir');
		expect(adoption).toContain('!sameDirectory && sourceDirOverlaps');
		expect(adoption).toContain('!sameDirectory && existsSync(destinationDir)');
		expect(adoption).toContain('allowExistingStackDir: true');
		expect(sharedDeploy).toContain('allowExistingStackDir: args.allowExistingStackDir');
		expect(stacks).toContain('if (!allowExistingDir && existsSync(flatDir))');
	});
});
