/**
 * A failed git deploy must be marked on the stack so the next sync retries it:
 * the commit is recorded as synced before the deploy runs, so otherwise the
 * stack reports being in sync while its containers stay on the old version.
 */

import { describe, test, expect, beforeEach } from 'bun:test';
import { registerDbFake } from './helpers/db-fake';
import { registerStacksFake } from './helpers/stacks-fake';
import { registerGitFake } from './helpers/git-fake';
import { DEPLOY_FAILURE_PREFIX } from '../src/lib/utils/git-deploy-gating';
import type { GitStackForDeploy } from '../src/lib/server/git-deploy-shared';

// git.ts cannot load under the db fake (its notification imports need real db exports).
registerGitFake('finalizeDeletionSync', async () => {});
registerGitFake('notifyGitSync', async () => {});

// Dynamic so the db/stacks fakes above are registered before the module under
// test first resolves those specifiers (Bun freezes them on first resolution).
const { deployStackFromSync } = await import('../src/lib/server/git-deploy-shared');

type Update = { syncStatus?: string; syncError?: string | null };

let updates: Array<{ id: number; patch: Update }>;
let deployCalls: Array<{ forceRecreate?: boolean }>;
let deployImpl: () => Promise<{ success: boolean; error?: string }>;

beforeEach(() => {
	updates = [];
	deployCalls = [];
	registerDbFake('updateGitStack', async (id: number, patch: Update) => {
		updates.push({ id, patch });
	});
	registerDbFake('upsertStackSource', async () => {});
	registerDbFake('getNonSecretEnvVarsAsRecord', async () => ({}));
	registerDbFake('getSecretEnvVarsAsRecord', async () => ({}));
	registerStacksFake('getStackDir', async () => '/tmp/stack');
	registerStacksFake('isHawserConnection', () => false);
	registerStacksFake('deployStack', async (opts: { forceRecreate?: boolean }) => {
		deployCalls.push(opts);
		return deployImpl();
	});
});

const gitStack = (over: Partial<GitStackForDeploy> = {}): GitStackForDeploy => ({
	stackName: 'web',
	environmentId: null,
	forceRedeploy: false,
	buildOnDeploy: false,
	noBuildCache: false,
	repullImages: false,
	composePaths: null,
	composePath: 'compose.yaml',
	repositoryId: 1,
	syncStatus: 'synced',
	syncError: null,
	...over
});

const syncResult = (updated: boolean) => ({
	success: true,
	updated,
	commit: 'abc1234',
	composeContent: 'services: {}\n',
	composeDir: '/tmp/repo',
	composeFileName: 'compose.yaml'
});

const run = (stack: GitStackForDeploy, updated: boolean) =>
	deployStackFromSync({
		stackId: 7,
		gitStack: stack,
		opts: { force: false, ignoreForceRedeploy: false },
		syncResult: syncResult(updated),
		logPrefix: '[test]'
	});

describe('deployStackFromSync failure marking', () => {
	test('a thrown deployStack error is marked as a deploy failure and rethrown', async () => {
		deployImpl = async () => {
			throw new Error('docker daemon gone');
		};
		await expect(run(gitStack(), true)).rejects.toThrow('docker daemon gone');
		expect(updates).toEqual([
			{ id: 7, patch: { syncStatus: 'error', syncError: `${DEPLOY_FAILURE_PREFIX}docker daemon gone` } }
		]);
	});

	test('a failed forceRedeploy deploy with no new commit is marked', async () => {
		deployImpl = async () => ({ success: false, error: 'port is already allocated' });
		const result = await run(gitStack({ forceRedeploy: true }), false);
		expect(result.success).toBe(false);
		expect(deployCalls).toHaveLength(1);
		// #1523: forceRedeploy force-recreates even with no git change.
		expect(deployCalls[0].forceRecreate).toBe(true);
		expect(updates).toEqual([
			{ id: 7, patch: { syncStatus: 'error', syncError: `${DEPLOY_FAILURE_PREFIX}port is already allocated` } }
		]);
	});

	test('the sync after a marked failure redeploys the same commit with force-recreate', async () => {
		deployImpl = async () => ({ success: true });
		const marked = gitStack({ syncStatus: 'error', syncError: `${DEPLOY_FAILURE_PREFIX}no such image` });
		const result = await run(marked, false);
		expect(result.success).toBe(true);
		expect(result.skipped).toBeUndefined();
		expect(deployCalls).toHaveLength(1);
		expect(deployCalls[0].forceRecreate).toBe(true);
		// Success does not touch the failure mark here; the sync already wrote 'synced'.
		expect(updates).toEqual([]);
	});

	test('a failed clone is not retried as a deploy failure', async () => {
		deployImpl = async () => ({ success: true });
		const cloneFailed = gitStack({ syncStatus: 'error', syncError: 'Git clone failed: auth' });
		const result = await run(cloneFailed, false);
		expect(result.skipped).toBe(true);
		expect(deployCalls).toHaveLength(0);
	});
});
