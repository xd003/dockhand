/**
 * Shared post-sync git deploy body.
 *
 * Both engines (stack git-stack.ts, centralized git-centralized.ts) run the
 * same "deploy a stack from a successful sync result" skeleton: decide whether
 * to deploy, record the deploy run, run docker compose, finalize the deletion
 * sync, record the stack source, mark a failed deploy for retry, and emit the
 * single git_sync_* notification. Extracted here so a fix to that body (e.g. a
 * deploy bugfix) lands in ONE place instead of two/three near-duplicates.
 *
 * The SYNC half differs per engine (per-stack re-clone vs shared-clone sync),
 * so each engine keeps its own syncGitStack and feeds the resulting SyncResult
 * into this function.
 */

import { dirname, join, relative } from 'node:path';
import {
	getEnvironment,
	getNonSecretEnvVarsAsRecord,
	getSecretEnvVarsAsRecord,
	updateGitStack,
	upsertStackSource
} from './db';
import { deployStack, deployStackUnlocked, getStackDir, isHawserConnection, type StackOperationResult } from './stacks';
import { createRunRecorder } from './deploy-run-record';
import { hashComposeContent, hashEnvFingerprint } from './deploy-run-record-core';
import {
	finalizeDeletionSync,
	notifyGitSync,
	type SyncResult,
	type DeployGitStackResult,
	type ProgressCallback
} from './git';
import { parseComposePathsColumn } from './compose-files';
import { buildSyncChangeSummary, formatChangeTable, skipReasonMessage } from './git-deletions';
import {
	shouldDeployGitStack,
	shouldForceRecreateGitStack,
	isDeployFailure,
	DEPLOY_FAILURE_PREFIX,
	type DeployGitStackOpts
} from '../utils/git-deploy-gating';

/**
 * The git stack fields this deploy body reads (structural, so both engines fit).
 * Callers pass the row read BEFORE the sync: syncStatus/syncError must still
 * reflect the previous deploy, since the sync overwrites them with 'synced'.
 */
export interface GitStackForDeploy {
	stackName: string;
	environmentId: number | null;
	forceRedeploy: boolean;
	buildOnDeploy: boolean;
	noBuildCache: boolean;
	repullImages: boolean;
	composePaths: string | null;
	repositoryId: number;
	composePath: string;
	syncStatus: string | null;
	syncError: string | null;
}

export interface DeployStackFromSyncArgs {
	stackId: number;
	gitStack: GitStackForDeploy;
	opts: DeployGitStackOpts;
	syncResult: SyncResult;
	onLine?: (line: string) => void;
	onComposeStarted?: () => void;
	onProgress?: ProgressCallback;
	logPrefix: string;
	/** Set by adoption, which already holds the stack lock. */
	lockHeld?: boolean;
	/** Existing Dockhand-accessible project directory selected for in-place Git conversion. */
	projectDir?: string;
	/** Existing agent Compose root and files, verified by Hawser before Git conversion. */
	remoteGitRoot?: string;
	remoteGitSourceComposePaths?: string[];
	/** Commit stack_sources only after Compose succeeds. */
	sourceCommit?: (result: StackOperationResult) => Promise<void>;

}

/**
 * Mark a git stack whose deploy failed, so the next scheduled sync or webhook
 * deploys the same commit again instead of skipping it.
 *
 * The commit is persisted as synced before the deploy runs, so without this the
 * stack reports being in sync while its containers stay on the old version.
 * Best-effort: a write failure must not turn a reported deploy outcome into
 * something else, so it logs and returns.
 */
async function markGitStackDeployFailed(
	stackId: number,
	logPrefix: string,
	error: string | undefined
): Promise<void> {
	try {
		await updateGitStack(stackId, {
			syncStatus: 'error',
			syncError: `${DEPLOY_FAILURE_PREFIX}${error ?? 'unknown error'}`
		});
	} catch (e) {
		console.error(`${logPrefix} Failed to record the deploy failure on the stack:`, e);
	}
}

/**
 * Deploy a stack after its sync succeeded. Returns the deploy result; the
 * git_sync_success/failed/skipped notification is emitted here (deployStack
 * suppressed its stack_* notification via isGitDeploy, so this is the single
 * one). Deploy failures are marked on the stack (markGitStackDeployFailed) so
 * the next sync retries; a thrown deploy error is marked and rethrown.
 */
export async function deployStackFromSync(args: DeployStackFromSyncArgs): Promise<DeployGitStackResult> {
	const { stackId, gitStack, opts, syncResult, onProgress, logPrefix } = args;
	const { force, ignoreForceRedeploy } = opts;

	// forceRedeploy setting overrides the skip logic for webhooks/scheduled
	// syncs. For new stacks (first deploy), syncResult.updated will be true.
	// lastDeployFailed reads the pre-sync snapshot: the sync has already written
	// 'synced' by now. A failed clone also lands in 'error', so the stored reason
	// decides - those containers are in step and must not be recreated.
	const lastDeployFailed = isDeployFailure(gitStack.syncStatus, gitStack.syncError);
	const shouldDeploy = shouldDeployGitStack({
		force,
		ignoreForceRedeploy,
		forceRedeploy: gitStack.forceRedeploy,
		updated: syncResult.updated,
		lastDeployFailed
	});
	if (lastDeployFailed) {
		console.log(`${logPrefix} Last deploy failed, retrying this commit`);
	}
	if (!shouldDeploy) {
		console.log(`${logPrefix} No changes detected and force=false, forceRedeploy=false, skipping redeploy`);
		const skippedResult = {
			success: true,
			output: 'No changes detected, skipping redeploy',
			skipped: true
		};
		await notifyGitSync(gitStack.stackName, gitStack.environmentId, skippedResult);
		return skippedResult;
	}

	const forceRecreate = shouldForceRecreateGitStack({
		updated: syncResult.updated,
		forceRedeploy: gitStack.forceRedeploy,
		ignoreForceRedeploy,
		lastDeployFailed
	});
	console.log(`${logPrefix} Will force recreate:`, forceRecreate, `(updated=${syncResult.updated}, forceRedeploy=${gitStack.forceRedeploy}, ignoreForceRedeploy=${ignoreForceRedeploy}, lastDeployFailed=${lastDeployFailed})`);
	console.log(`${logPrefix} Build on deploy:`, gitStack.buildOnDeploy);
	console.log(`${logPrefix} Re-pull images:`, gitStack.repullImages);
	console.log(`${logPrefix} Force redeploy setting:`, gitStack.forceRedeploy);

	// Show the git file changes BEFORE the deploy starts, so the user sees what
	// changed while the deploy runs and the deploy start/result lines stay
	// together (#1260). Removals reflect the deletion plan here; apply-stage
	// divergences (rare) are reported after the deploy.
	if (onProgress && syncResult.previousManifest && syncResult.newFiles && syncResult.deletionPlan) {
		const changeTable = formatChangeTable(
			buildSyncChangeSummary(
				syncResult.previousManifest.files,
				syncResult.newFiles,
				{ deleted: syncResult.deletionPlan.toDelete.map((f) => f.path), skipped: [] },
				syncResult.deletionPlan.skipped
			)
		);
		onProgress({ status: 'deploying', message: `File changes: ${changeTable[0]}`, step: 5, totalSteps: 5 });
		for (const line of changeTable.slice(1)) {
			onProgress({ status: 'deploying', message: line, step: 5, totalSteps: 5 });
		}
		onProgress({ status: 'deploying', message: `Deploying ${gitStack.stackName}...`, step: 5, totalSteps: 5 });
		if (syncResult.deletionPlan.toDelete.length > 0) {
			onProgress({
				status: 'deploying',
				message: `Removing ${syncResult.deletionPlan.toDelete.length} file(s) deleted from the repository...`,
				step: 5,
				totalSteps: 5
			});
		}
	}

	console.log(`${logPrefix} Calling deployStack...`);
	console.log(`${logPrefix} Source directory (composeDir):`, syncResult.composeDir);
	console.log(`${logPrefix} Compose filename:`, syncResult.composeFileName);
	console.log(`${logPrefix} Env filename:`, syncResult.envFileName ?? '(none)');

	let effectiveEnvVars: Record<string, string> = { ...(syncResult.envFileVars ?? {}) };
	try {
		const nonSecretVars = await getNonSecretEnvVarsAsRecord(gitStack.stackName, gitStack.environmentId);
		const secretVars = await getSecretEnvVarsAsRecord(gitStack.stackName, gitStack.environmentId);
		effectiveEnvVars = { ...nonSecretVars, ...secretVars, ...(syncResult.envFileVars ?? {}) };
	} catch (error) {
		console.error(`${logPrefix} Failed to read env vars for run recording (deploy continues):`, error);
	}

	const recorder = await createRunRecorder({
		stackName: gitStack.stackName,
		envId: gitStack.environmentId ?? null,
		userId: opts.userId,
		triggeredBy: opts.triggeredBy ?? 'manual',
		options: {
			pull: gitStack.repullImages,
			build: gitStack.buildOnDeploy,
			forceRecreate
		},
		composeHash: hashComposeContent(syncResult.composeContent!),
		envHash: hashEnvFingerprint(effectiveEnvVars),
		secrets: Object.values(effectiveEnvVars)
	}).catch((error) => {
		console.error(`${logPrefix} Failed to create deploy run recorder (deploy continues):`, error);
		return null;
	});

	// Each line is already secret-redacted by deployStack. One stream, three sinks:
	// the run record's log file, the caller's onLine, and the progress UI.
	const onLine = (line: string) => {
		recorder?.line(line);
		args.onLine?.(line);
		onProgress?.({ status: 'deploying', logLine: line, step: 5, totalSteps: 5 });
	};
	const hawser = isHawserConnection(
		typeof gitStack.environmentId === 'number' ? await getEnvironment(gitStack.environmentId) : null
	);

	const deploy = args.lockHeld ? deployStackUnlocked : deployStack;
	let result: StackOperationResult;
	try {
		result = await deploy({
			name: gitStack.stackName,
			compose: syncResult.composeContent!,
			envId: gitStack.environmentId,
			sourceDir: syncResult.composeDir, // Checkout; Hawser and in-place stacks receive only its tracked files
			composeFileName: syncResult.composeFileName, // Use original compose filename from repo
			envFileName: syncResult.envFileName, // Env file relative to compose dir (for --env-file flag, optional)
			composePaths: gitStack.composePaths ? parseComposePathsColumn(gitStack.composePaths) : undefined,
			forceRecreate,
			build: gitStack.buildOnDeploy,
			noBuildCache: gitStack.noBuildCache,
			pullPolicy: gitStack.repullImages ? 'always' : undefined,
			serviceName: opts.serviceName,
			filesToDelete: syncResult.deletionPlan?.toDelete,
			gitPublishPaths: syncResult.newFiles ? Object.keys(syncResult.newFiles) : undefined,
			isGitDeploy: true, // suppress stack_* notification; we emit git_sync_* below
			onLine,
			onComposeStarted: args.onComposeStarted,
			projectDir: args.projectDir,
			remoteGitRoot: args.remoteGitRoot,
			remoteGitSourceComposePaths: args.remoteGitSourceComposePaths
		});
	} catch (error) {
		try {
			await recorder?.end(false, undefined, error instanceof Error ? error.message : String(error));
		} catch (recordError) {
			console.error(`${logPrefix} Failed to close deploy run recorder:`, recordError);
		}
		// A throw skips the result branch below, and leaving the stack on 'synced'
		// is the stuck state the mark records against.
		await markGitStackDeployFailed(stackId, logPrefix, error instanceof Error ? error.message : String(error));
		throw error;
	}

	recorder?.addSecrets(result.resolvedSecrets ?? []);
	try {
		await recorder?.end(result.success, undefined, result.success ? undefined : result.error);
	} catch (error) {
		console.error(`${logPrefix} Failed to close deploy run recorder:`, error);
	}

	console.log(`${logPrefix} ----------------------------------------`);
	console.log(`${logPrefix} DEPLOY GIT STACK RESULT`);
	console.log(`${logPrefix} ----------------------------------------`);
	console.log(`${logPrefix} Success:`, result.success);
	if (result.output) console.log(`${logPrefix} Output:`, result.output);
	if (result.error) console.log(`${logPrefix} Error:`, result.error);

	if (result.success) {
		// Deletion sync: persist manifest + log per-file change summary
		if (syncResult.previousManifest && syncResult.newFiles && syncResult.newCommitFull && syncResult.deletionPlan) {
			await finalizeDeletionSync({
				stackId,
				logPrefix,
				previousManifest: syncResult.previousManifest,
				newCommitFull: syncResult.newCommitFull,
				newFiles: syncResult.newFiles,
				plan: syncResult.deletionPlan,
				applyResult: result.deletion
			});
		}

		// Hawser confirms the bound root after Compose; Dockhand's checkout and
		// local stack path must never be persisted as remote stack-file paths.
		const stackDir = hawser
			? result.managedDirectory
			: args.projectDir ?? await getStackDir(gitStack.stackName, gitStack.environmentId);
		if (!stackDir) throw new Error('Hawser did not confirm the bound stack directory after deployment');
		const resolvedComposePath = syncResult.composeFileName
			? join(stackDir, syncResult.composeFileName)
			: undefined;
		const configuredPaths = gitStack.composePaths ? parseComposePathsColumn(gitStack.composePaths) : null;
		const resolvedComposePaths = hawser && configuredPaths && syncResult.composeFileName
			? configuredPaths.map((path) =>
				join(dirname(resolvedComposePath!), relative(dirname(gitStack.composePath), path))
			)
			: configuredPaths;

		console.log(`${logPrefix} Resolved compose path for stack_sources:`, resolvedComposePath);

		if (args.sourceCommit) {
			await args.sourceCommit(result);
		} else {
			await upsertStackSource({
				stackName: gitStack.stackName,
				environmentId: gitStack.environmentId,
				sourceType: 'git',
				fileLocation: hawser ? 'hawser' : 'dockhand',
				gitRepositoryId: gitStack.repositoryId,
				gitStackId: stackId,
				composePath: resolvedComposePath,
				composePaths: resolvedComposePaths,
				...(hawser && syncResult.envFileName ? { envPath: join(stackDir, syncResult.envFileName) } : {})
			});
		}

		if (onProgress) {
			const applySkips = (result.deletion?.skipped ?? []).filter((s) => s.reason !== 'already-absent');
			for (const skip of applySkips) {
				onProgress({
					status: 'deploying',
					message: `Kept "${skip.path}" — ${skipReasonMessage(skip.reason)}`,
					step: 5,
					totalSteps: 5
				});
			}
			onProgress({ status: 'complete', message: `Successfully deployed ${gitStack.stackName}` });
		}
	} else {
		// The commit was recorded as synced before the deploy ran, so mark the
		// failure on the stack: it is what the next run reads to deploy again, and
		// what stops the UI reporting a stack that never deployed as in sync.
		await markGitStackDeployFailed(stackId, logPrefix, result.error);
		onProgress?.({ status: 'error', error: result.error || 'Failed to deploy stack' });
	}

	await notifyGitSync(gitStack.stackName, gitStack.environmentId, result);
	return result;
}
