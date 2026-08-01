import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
	fanOutDeployStacks,
	mergeDeployGitStackOpts,
	shouldDeployGitStack,
	type DeployGitStackOpts,
	type FanOutStack
} from '../src/lib/utils/git-deploy-gating';

interface TestStack extends FanOutStack {
	/** Whether the repository sync found changes for this stack. */
	updated: boolean;
}

/**
 * Faithful simulation of deployGitStackCore (git.ts): the (possibly
 * coalesced) deploy intent goes straight into shouldDeployGitStack. This is
 * the same composition the real fan-out uses, minus the DB/git/docker
 * machinery.
 */
function coreDeploy(opts: DeployGitStackOpts, stack: TestStack): { success: boolean; skipped: boolean } {
	const shouldDeploy = shouldDeployGitStack({
		force: opts.force,
		ignoreForceRedeploy: opts.ignoreForceRedeploy,
		forceRedeploy: stack.forceRedeploy,
		updated: stack.updated
	});
	return shouldDeploy ? { success: true, skipped: false } : { success: true, skipped: true };
}

describe('repo webhook fan-out gating', () => {
	it('defers stacks with their own webhook: only deploys when the sync found changes', async () => {
		const stacks: TestStack[] = [
			{ id: 1, stackName: 'deferred', forceRedeploy: true, webhookEnabled: true, updated: false },
			{ id: 2, stackName: 'plain-force', forceRedeploy: true, webhookEnabled: false, updated: false },
			{ id: 3, stackName: 'passive', forceRedeploy: false, webhookEnabled: false, updated: false }
		];

		const intents: Array<{ stackId: number; opts: DeployGitStackOpts }> = [];
		const result = await fanOutDeployStacks(stacks, (stackId, opts) => {
			const stack = stacks.find((s) => s.id === stackId)!;
			intents.push({ stackId, opts });
			return Promise.resolve(coreDeploy(opts, stack));
		});

		// Deferred stack: called with ignoreForceRedeploy, no changes -> skipped
		assert.deepEqual(intents.find((i) => i.stackId === 1)?.opts, {
			force: false,
			ignoreForceRedeploy: true
		});
		// Plain forceRedeploy stack: honored, redeploys without changes
		assert.deepEqual(intents.find((i) => i.stackId === 2)?.opts, {
			force: false,
			ignoreForceRedeploy: false
		});
		assert.deepEqual(
			result.stacks.map((s) => [s.id, s.status]),
			[[1, 'skipped'], [2, 'deployed'], [3, 'skipped']]
		);
		assert.equal(result.success, true);
	});

	it('deploys a deferred stack when the sync found changes', async () => {
		const stacks: TestStack[] = [
			{ id: 1, stackName: 'deferred', forceRedeploy: true, webhookEnabled: true, updated: true }
		];

		const intents: Array<{ stackId: number; opts: DeployGitStackOpts }> = [];
		const result = await fanOutDeployStacks(stacks, (stackId, opts) => {
			const stack = stacks.find((s) => s.id === stackId)!;
			intents.push({ stackId, opts });
			return Promise.resolve(coreDeploy(opts, stack));
		});

		assert.deepEqual(intents[0].opts, { force: false, ignoreForceRedeploy: true });
		assert.deepEqual(
			result.stacks.map((s) => [s.id, s.status]),
			[[1, 'deployed']]
		);
	});

	it('keeps a stack-level webhook able to force redeploy its own stack', async () => {
		// Stack webhook path (scheduler runGitStackSync): deployGitStack(stackId,
		// { force: false }) — no ignoreForceRedeploy, so the stack's own
		// forceRedeploy setting is honored even without changes.
		const deferredStack: TestStack = {
			id: 1,
			stackName: 'deferred',
			forceRedeploy: true,
			webhookEnabled: true,
			updated: false
		};

		const webhookIntent = { force: false, ignoreForceRedeploy: false };
		const result = coreDeploy(webhookIntent, deferredStack);

		assert.equal(result.skipped, false);
		assert.equal(
			shouldDeployGitStack({
				force: false,
				ignoreForceRedeploy: false,
				forceRedeploy: true,
				updated: false
			}),
			true,
			'stack webhook must force-redeploy the stack even when nothing changed'
		);
	});

	it('stack webhook intent wins over the repo fan-out deferral in a race', () => {
		// Concurrent coalescing (runCoalesced): the fan-out intent
		// { force: false, ignoreForceRedeploy: true } and the stack webhook's
		// { force: false, ignoreForceRedeploy: false } merge with AND, so the
		// non-ignoring caller wins and forceRedeploy is still honored.
		const merged = mergeDeployGitStackOpts(
			{ force: false, ignoreForceRedeploy: true },
			{ force: false, ignoreForceRedeploy: false }
		);

		assert.deepEqual(merged, { force: false, ignoreForceRedeploy: false });
		assert.equal(
			shouldDeployGitStack({
				force: merged.force,
				ignoreForceRedeploy: merged.ignoreForceRedeploy,
				forceRedeploy: true,
				updated: false
			}),
			true
		);
	});

	it('skips stacks that never opted into any redeploy behaviour', async () => {
		const stacks: TestStack[] = [
			{ id: 1, stackName: 'passive', forceRedeploy: false, webhookEnabled: false, updated: false }
		];

		const result = await fanOutDeployStacks(stacks, (stackId, opts) => {
			const stack = stacks.find((s) => s.id === stackId)!;
			return Promise.resolve(coreDeploy(opts, stack));
		});

		assert.deepEqual(
			result.stacks.map((s) => [s.id, s.status]),
			[[1, 'skipped']]
		);
		assert.equal(result.success, true);
	});

	it('continues fan-out and reports failure when one stack fails', async () => {
		const stacks: TestStack[] = [
			{ id: 1, stackName: 'deferred', forceRedeploy: true, webhookEnabled: true, updated: true },
			{ id: 2, stackName: 'broken', forceRedeploy: false, webhookEnabled: false, updated: false }
		];

		const result = await fanOutDeployStacks(stacks, (stackId) => {
			if (stackId === 2) return Promise.resolve({ success: false, error: 'compose failed' });
			const stack = stacks.find((s) => s.id === stackId)!;
			return Promise.resolve(coreDeploy({ force: false, ignoreForceRedeploy: true }, stack));
		});

		assert.deepEqual(
			result.stacks.map((s) => [s.id, s.status]),
			[[1, 'deployed'], [2, 'failed']]
		);
		assert.equal(result.success, false);
		assert.match(result.error ?? '', /failed/i);
	});

	it('succeeds with no stacks', async () => {
		const result = await fanOutDeployStacks([], () => Promise.resolve({ success: true }));

		assert.equal(result.success, true);
		assert.deepEqual(result.stacks, []);
	});
});
