/**
 * Pure decision logic for git stack deploys — extracted from git.ts so the
 * webhook / repository fan-out gating rules can be unit tested without a
 * database.
 */

export interface DeployGitStackOpts {
	force: boolean;
	ignoreForceRedeploy: boolean;
}

export interface ShouldDeployGitStackInput extends DeployGitStackOpts {
	/** Stack-level "redeploy even when nothing changed" setting. */
	forceRedeploy: boolean;
	/** Whether the repository sync detected changed files (undefined = falsy). */
	updated?: boolean;
}

/**
 * Whether a stack should be deployed after a sync:
 * - `force` (manual trigger / stack-level webhook) always deploys
 * - `forceRedeploy` redeploys unless every caller opted into
 *   `ignoreForceRedeploy` (repo-level fan-out defers stacks with their own
 *   webhook so those are triggered explicitly)
 * - `updated` (the sync found changed files) always deploys
 */
export function shouldDeployGitStack(input: ShouldDeployGitStackInput): boolean {
	const { force, ignoreForceRedeploy, forceRedeploy, updated } = input;
	return force || (!ignoreForceRedeploy && forceRedeploy) || !!updated;
}

/**
 * Merge concurrent deploy intents: stronger wins.
 * - `force` if either caller forces
 * - honor `forceRedeploy` unless ALL callers opt into `ignoreForceRedeploy`
 *   (a stack-level webhook must not lose to a repo fan-out)
 */
export function mergeDeployGitStackOpts(
	a: DeployGitStackOpts,
	b: DeployGitStackOpts
): DeployGitStackOpts {
	return {
		force: a.force || b.force,
		ignoreForceRedeploy: a.ignoreForceRedeploy && b.ignoreForceRedeploy
	};
}

/**
 * Repository-level fan-out gating: a stack with its own webhook enabled is
 * excluded from the repository's force-redeploy behaviour and is only
 * redeployed when the sync actually found changes.
 */
export function repoFanOutDefersStack(stack: {
	forceRedeploy: boolean;
	webhookEnabled: boolean;
}): boolean {
	return stack.forceRedeploy && stack.webhookEnabled;
}

export interface FanOutStack {
	id: number;
	stackName: string;
	forceRedeploy: boolean;
	webhookEnabled: boolean;
}

export type FanOutStackResult =
	| { id: number; name: string; status: 'deployed' | 'skipped' }
	| { id: number; name: string; status: 'failed'; error?: string };

export interface FanOutStacksResult {
	success: boolean;
	stacks: FanOutStackResult[];
	error?: string;
}

/**
 * Fan a repository webhook out over its stacks (deployGitStack per stack):
 * - a stack with its own webhook (forceRedeploy + webhookEnabled) is deferred:
 *   it is called with `ignoreForceRedeploy: true` so it only deploys when the
 *   sync found changes — its own webhook is the only force trigger
 * - every other stack is called with `ignoreForceRedeploy: false`, so its
 *   forceRedeploy setting is honored and it redeploys even without changes
 */
export async function fanOutDeployStacks(
	stacks: FanOutStack[],
	deploy: (
		stackId: number,
		opts: DeployGitStackOpts
	) => Promise<{ success: boolean; skipped?: boolean; error?: string }>,
	log?: (msg: string) => void
): Promise<FanOutStacksResult> {
	const _log = log ?? (() => {});
	const results: FanOutStackResult[] = [];
	let hasError = false;

	for (const stack of stacks) {
		_log(`[Git] Evaluating stack "${stack.stackName}"...`);

		try {
			const ignoreForceRedeploy = repoFanOutDefersStack(stack);
			if (ignoreForceRedeploy) {
				_log(`[Git] Stack "${stack.stackName}" has a stack-level webhook enabled — ignoring force redeploy from repo webhook. Will only deploy if changes exist.`);
			}

			const deployResult = await deploy(stack.id, { force: false, ignoreForceRedeploy });

			if (deployResult.success) {
				if (deployResult.skipped) {
					_log(`[Git] Stack "${stack.stackName}" was skipped (no changes).`);
					results.push({ id: stack.id, name: stack.stackName, status: 'skipped' });
				} else {
					_log(`[Git] Stack "${stack.stackName}" was successfully deployed.`);
					results.push({ id: stack.id, name: stack.stackName, status: 'deployed' });
				}
			} else {
				_log(`[Git] Stack "${stack.stackName}" failed to deploy: ${deployResult.error}`);
				hasError = true;
				results.push({ id: stack.id, name: stack.stackName, status: 'failed', error: deployResult.error });
			}
		} catch (err: any) {
			_log(`[Git] Stack "${stack.stackName}" threw an error: ${err.message}`);
			hasError = true;
			results.push({ id: stack.id, name: stack.stackName, status: 'failed', error: err.message });
		}
	}

	return {
		success: !hasError,
		stacks: results,
		error: hasError ? 'One or more stacks failed to deploy' : undefined
	};
}
