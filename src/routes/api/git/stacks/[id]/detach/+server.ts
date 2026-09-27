import { json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { authorize } from '$lib/server/authorize';
import {
	getGitStack,
	deleteGitStack,
	getStackSource,
	upsertStackSource,
	getStackEnvVars
} from '$lib/server/db';
import { deleteGitStackFiles } from '$lib/server/git';
import { unregisterSchedule } from '$lib/server/scheduler';
import { auditGitStack } from '$lib/server/audit';
import { getStackComposeFile, getStackDir, hawserRelativeFilePath, writeStackEnvFile } from '$lib/server/stacks';
import { hawserStackFiles } from '$lib/server/hawser-stack-files';
import { parseEnvVars } from '$lib/server/env-parser';
import { mergeGitStackEnvVars } from '$lib/env-merge';
import { repoFilePath } from '$lib/server/git-url-safety';
import { assertNotMigrating } from '$lib/server/git-migration-guard';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join, relative, resolve, sep } from 'node:path';

/**
 * Reads env files of the deployed stack. A Hawser stack's files are owned by the agent,
 * so they are read through the bound agent root; everything else is on Dockhand's disk.
 */
async function deployedEnvReader(stackName: string, environmentId: number | null, hawser: boolean) {
	if (!hawser) {
		return async (path: string) => existsSync(path) ? parseEnvVars(readFileSync(path, 'utf-8')) : null;
	}
	const files = await hawserStackFiles(environmentId!, stackName);
	const { root } = await files.binding();
	return async (path: string) => {
		try {
			return parseEnvVars(new TextDecoder().decode((await files.read(hawserRelativeFilePath(root, path))).content));
		} catch (error) {
			if (error && typeof error === 'object' && 'status' in error && error.status === 404) return null;
			throw error;
		}
	};
}

/**
 * @openapi
 * summary: Convert a git-managed stack to a local stack
 * path: id:integer! Git stack ID (from GET /api/git/stacks)
 * resp-200: {success:boolean!}
 * resp-200-example: {"success":true}
 * resp-400: Invalid git stack ID
 * resp-403: Caller lacks the stacks:edit permission for the stack environment
 * resp-404: Git stack not found
 * resp-409: No deployed compose file is available (deploy the Git stack before conversion), or a Git migration is in progress for this stack
 * resp-500: Failed to convert the stack to a local source
 */
export const POST: RequestHandler = async (event) => {
	const { params, cookies } = event;
	const auth = await authorize(cookies);

	try {
		const id = parseInt(params.id, 10);
		if (Number.isNaN(id)) {
			return json({ error: 'Invalid git stack id' }, { status: 400 });
		}

		const gitStack = await getGitStack(id);
		if (!gitStack) {
			return json({ error: 'Git stack not found' }, { status: 404 });
		}

		if (
			auth.authEnabled &&
			!(await auth.can('stacks', 'edit', gitStack.environmentId || undefined))
		) {
			return json({ error: 'Permission denied' }, { status: 403 });
		}

		// Environment access check (enterprise only), matching the sibling stack endpoints.
		if (gitStack.environmentId && auth.isEnterprise && !(await auth.canAccessEnvironment(gitStack.environmentId))) {
			return json({ error: 'Access denied to this environment' }, { status: 403 });
		}

		const locked = await assertNotMigrating([id]);
		if (locked) return locked;

		const composeResult = await getStackComposeFile(
			gitStack.stackName,
			gitStack.environmentId ?? null
		);

		if (!composeResult.success || !composeResult.composePath) {
			return json({ error: 'No deployed compose file is available. Deploy the Git stack successfully before converting it to a local source.' }, { status: 409 });
		}

		const envVars = await getStackEnvVars(gitStack.stackName, gitStack.environmentId ?? null, false);
		const source = await getStackSource(gitStack.stackName, gitStack.environmentId ?? null);
		const readEnv = await deployedEnvReader(gitStack.stackName, gitStack.environmentId ?? null, source?.fileLocation === 'hawser');

		// Internal stacks use the on-disk env file as their non-secret source of truth.
		// Materialize the last-deployed repo env plus DB overrides before switching.
		const targetEnvPath = join(dirname(composeResult.composePath), '.env');
		const baseFileVars = await readEnv(targetEnvPath);
		const baseExists = baseFileVars !== null;
		const baseVars = baseFileVars ?? {};
		let overlayExists = false;
		let overlayVars: Record<string, string> = {};

		if (gitStack.envFilePath) {
			const repoRoot = resolve('/repo');
			const repoComposePath = repoFilePath(repoRoot, gitStack.composePath, 'Compose path');
			const repoEnvPath = repoFilePath(repoRoot, gitStack.envFilePath, 'Env file path');
			const deployedEnvPath = resolve(
				dirname(composeResult.composePath),
				relative(dirname(repoComposePath), repoEnvPath)
			);
			const deployedStackDir = resolve(await getStackDir(gitStack.stackName, gitStack.environmentId));
			const isInsideDeployedStack =
				deployedEnvPath === deployedStackDir || deployedEnvPath.startsWith(deployedStackDir + sep);
			if (isInsideDeployedStack && deployedEnvPath !== targetEnvPath) {
				const deployedVars = await readEnv(deployedEnvPath);
				if (deployedVars) {
					overlayExists = true;
					overlayVars = deployedVars;
				}
			}
		}

		const effectiveVars = mergeGitStackEnvVars({ ...baseVars, ...overlayVars }, envVars);
		const nonSecretVars = effectiveVars.filter((variable) => !variable.isSecret);
		const shouldWriteEnv = baseExists || overlayExists || nonSecretVars.length > 0;

		if (shouldWriteEnv) {
			await writeStackEnvFile(
				gitStack.stackName,
				nonSecretVars,
				gitStack.environmentId ?? null,
				targetEnvPath
			);
		}

		// The stack keeps its file location (fileLocation and projectDir are preserved when
		// omitted) and its Compose file set, so it continues from the deployed files.
		await upsertStackSource({
			stackName: gitStack.stackName,
			environmentId: gitStack.environmentId ?? null,
			sourceType: 'internal',
			gitRepositoryId: null,
			gitStackId: null,
			composePath: composeResult.composePath,
			composePaths: composeResult.composePathsExplicit ? composeResult.composePaths : null,
			envPath: shouldWriteEnv ? targetEnvPath : null
		});

		unregisterSchedule(id, 'git_stack_sync');
		await deleteGitStack(id);
		await deleteGitStackFiles(id, gitStack.stackName, gitStack.environmentId);

		await auditGitStack(event, 'update', gitStack.id, gitStack.stackName, gitStack.environmentId, {
			action: 'convert_to_internal'
		});

		return json({ success: true });
	} catch (error) {
		console.error('Failed to detach git stack:', error);
		return json({ error: 'Failed to convert stack to local source' }, { status: 500 });
	}
};
