import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
	DEPLOY_FAILURE_PREFIX,
	isDeployFailure,
	mergeDeployGitStackOpts,
	repoFanOutDefersStack,
	shouldDeployGitStack,
	shouldForceRecreateGitStack
} from '../src/lib/utils/git-deploy-gating';

describe('shouldDeployGitStack', () => {
	const base = {
		force: false,
		ignoreForceRedeploy: false,
		forceRedeploy: false,
		updated: false
	};

	it('skips when nothing changed and no force/redeploy flag is set', () => {
		assert.equal(shouldDeployGitStack(base), false);
	});

	it('deploys when the sync found changes', () => {
		assert.equal(shouldDeployGitStack({ ...base, updated: true }), true);
	});

	it('always deploys when force is set, even with no changes', () => {
		assert.equal(shouldDeployGitStack({ ...base, force: true }), true);
	});

	it('deploys when forceRedeploy is set and no caller ignores it', () => {
		assert.equal(shouldDeployGitStack({ ...base, forceRedeploy: true }), true);
	});

	it('suppresses forceRedeploy when every caller opted into ignoreForceRedeploy', () => {
		const result = shouldDeployGitStack({
			...base,
			forceRedeploy: true,
			ignoreForceRedeploy: true
		});
		assert.equal(result, false);
	});

	it('still deploys changed stacks even when forceRedeploy is ignored', () => {
		assert.equal(
			shouldDeployGitStack({ ...base, ignoreForceRedeploy: true, updated: true }),
			true
		);
	});

	it('treats an undefined updated flag as falsy', () => {
		assert.equal(shouldDeployGitStack({ ...base, updated: undefined }), false);
	});

	it('retries after a deploy that failed, with no git change of its own', () => {
		// The commit is recorded before the deploy runs, so a failed deploy leaves git
		// reporting no change. Without this the stack is skipped forever on the old
		// version while it reports being in sync.
		assert.equal(shouldDeployGitStack({ ...base, lastDeployFailed: true }), true);
	});

	it('retries a failed deploy even when every caller ignores forceRedeploy', () => {
		assert.equal(
			shouldDeployGitStack({ ...base, forceRedeploy: true, ignoreForceRedeploy: true, lastDeployFailed: true }),
			true
		);
	});
});

describe('shouldForceRecreateGitStack', () => {
	const base = { updated: false, forceRedeploy: false, ignoreForceRedeploy: false, lastDeployFailed: false };

	it('recreates on a real git change', () => {
		assert.equal(shouldForceRecreateGitStack({ ...base, updated: true }), true);
	});

	it('#1523: recreates when forceRedeploy is on even with NO git change', () => {
		// The core bug: this was false before the fix, so the container never recreated
		// and the shell-env secrets were never re-injected.
		assert.equal(shouldForceRecreateGitStack({ ...base, forceRedeploy: true }), true);
	});

	it('recreates when both a git change and forceRedeploy are set', () => {
		assert.equal(shouldForceRecreateGitStack({ ...base, updated: true, forceRedeploy: true }), true);
	});

	it('does not recreate for forceRedeploy when every caller ignores it', () => {
		assert.equal(shouldForceRecreateGitStack({ ...base, forceRedeploy: true, ignoreForceRedeploy: true }), false);
	});

	it('recreates on a retry, so containers are not left out of step with the commit', () => {
		// git reports no change on a retry, so a plain up would no-op against the
		// containers the failed deploy never replaced.
		assert.equal(shouldForceRecreateGitStack({ ...base, lastDeployFailed: true }), true);
	});

	it('still recreates on a retry when forceRedeploy is ignored', () => {
		assert.equal(
			shouldForceRecreateGitStack({ ...base, forceRedeploy: true, ignoreForceRedeploy: true, lastDeployFailed: true }),
			true
		);
	});

	it('default (setting off, no git change, last deploy fine) does NOT recreate', () => {
		assert.equal(shouldForceRecreateGitStack(base), false);
		assert.equal(shouldForceRecreateGitStack({ forceRedeploy: false, ignoreForceRedeploy: false }), false);
	});
});

describe('isDeployFailure', () => {
	// syncStatus 'error' has several writers; only a failed deploy leaves the
	// containers out of step with the recorded commit, and only it may retry.
	it('recognises a deploy failure', () => {
		assert.equal(isDeployFailure('error', `${DEPLOY_FAILURE_PREFIX}no such image`), true);
	});

	it('does not treat a failed clone as a deploy failure', () => {
		assert.equal(isDeployFailure('error', 'Git clone failed: Permission denied (publickey)'), false);
	});

	it('does not treat a healthy stack as a deploy failure whatever the stored text', () => {
		assert.equal(isDeployFailure('synced', null), false);
		assert.equal(isDeployFailure('synced', `${DEPLOY_FAILURE_PREFIX}stale text`), false);
		assert.equal(isDeployFailure('pending', null), false);
		assert.equal(isDeployFailure(null, null), false);
	});

	it('does not treat an error with no stored reason as a deploy failure', () => {
		assert.equal(isDeployFailure('error', null), false);
		assert.equal(isDeployFailure('error', ''), false);
		assert.equal(isDeployFailure('error', undefined), false);
	});

	it('requires the prefix to lead, not merely appear', () => {
		assert.equal(isDeployFailure('error', `clone said: ${DEPLOY_FAILURE_PREFIX}x`), false);
	});
});

describe('mergeDeployGitStackOpts', () => {
	it('keeps the weaker intent when both callers agree', () => {
		assert.deepEqual(
			mergeDeployGitStackOpts(
				{ force: false, ignoreForceRedeploy: false },
				{ force: false, ignoreForceRedeploy: false }
			),
			{ force: false, ignoreForceRedeploy: false }
		);
	});

	it('merges force with OR so any caller forcing wins', () => {
		assert.deepEqual(
			mergeDeployGitStackOpts(
				{ force: true, ignoreForceRedeploy: false },
				{ force: false, ignoreForceRedeploy: false }
			),
			{ force: true, ignoreForceRedeploy: false }
		);
	});

	it('merges ignoreForceRedeploy with AND so a single non-ignoring caller wins', () => {
		assert.deepEqual(
			mergeDeployGitStackOpts(
				{ force: false, ignoreForceRedeploy: true },
				{ force: false, ignoreForceRedeploy: false }
			),
			{ force: false, ignoreForceRedeploy: false }
		);
	});

	it('preserves forceRedeploy honoring when all callers ignore it', () => {
		assert.deepEqual(
			mergeDeployGitStackOpts(
				{ force: false, ignoreForceRedeploy: true },
				{ force: false, ignoreForceRedeploy: true }
			),
			{ force: false, ignoreForceRedeploy: true }
		);
	});
});

describe('repoFanOutDefersStack', () => {
	it('defers only stacks with forceRedeploy AND a stack-level webhook', () => {
		assert.equal(repoFanOutDefersStack({ forceRedeploy: true, webhookEnabled: true }), true);
		assert.equal(repoFanOutDefersStack({ forceRedeploy: true, webhookEnabled: false }), false);
		assert.equal(repoFanOutDefersStack({ forceRedeploy: false, webhookEnabled: true }), false);
		assert.equal(repoFanOutDefersStack({ forceRedeploy: false, webhookEnabled: false }), false);
	});
});
