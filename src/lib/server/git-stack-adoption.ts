import { isAbsolute, join, dirname } from 'node:path';
import {
	createGitRepository,
	createGitStack,
	deleteGitRepository,
	deleteGitStack,
	getGitCredentials,
	getGitRepository,
	getEnvironment,
	getGitStacksByRepositoryId,
	getStackEnvVars,
	getStackSource,
	setStackEnvVars,
	upsertStackSource
} from './db';
import { getGitReposDir, notifyGitSync, type ProgressCallback } from './git';
import { assertSafeGitRef, assertSafeRepoUrl } from './git-url-safety';
import { deleteRepositoryFiles, getEngineForStack } from './git';
import { adoptPendingGitClone, discardPendingGitClone } from './git-stack';
import { deployStackFromSync } from './git-deploy-shared';
import { getStackDir, isHawserConnection, listComposeStacks, validateStackPath, withStackLock } from './stacks';
import { resolveGitStackPaths, isPathUnderRoot } from './stack-path-utils';
import { parseComposePathsColumn, validateComposePathsInput } from './compose-files';
import { registerSchedule, unregisterSchedule } from './scheduler';
import { hawserComposeProjectLabels } from './hawser-stack-files';
import { resolveExistingComposeFile } from './in-place-project';
import { checkDockerHostSharesProjectDir } from './in-place-host-check';

export interface GitStackAdoptionInput {
	stackName: string;
	environmentId?: number | null;
	repositoryId?: number;
	url?: string;
	repoName?: string;
	branch?: string;
	credentialId?: number | null;
	composePath?: string;
	composePaths?: string[] | null;
	envFilePath?: string | null;
	contextDir?: string | null;
	buildOnDeploy?: boolean;
	noBuildCache?: boolean;
	repullImages?: boolean;
	forceRedeploy?: boolean;
	webhookEnabled?: boolean;
	webhookSecret?: string | null;
	autoUpdate?: boolean;
	autoUpdateSchedule?: string;
	autoUpdateCron?: string;
	engine?: 'stack' | 'centralized';
	envVars?: Array<{ key?: string; value?: string; isSecret?: boolean }>;
	temporaryCloneToken?: string;
	/**
	 * Absolute path of the project's existing Compose file, chosen from Dockhand's (local) or the agent's (Hawser)
	 * filesystem. Omitted when the project's files are gone: the repository deploys to Dockhand's managed stack directory.
	 */
	existingComposePath?: string;
}

export type GitStackAdoptionPreflight = {
	ok: true;
	stackName: string;
	environmentId: number | null;
	/** Selected existing project directory Git files are published into in place; null deploys to the managed stack directory. */
	destinationDir: string | null;
	sourceEnvPath: string | null;
	remoteGitRoot?: string;
	remoteGitSourceComposePaths?: string[];
} | {
	ok: false;
	status: number;
	error: string;
};

function invalid(error: string, status = 400): GitStackAdoptionPreflight {
	return { ok: false, status, error };
}

function validateRepoRelativePath(value: unknown, label: string, allowEmpty = false): string | null {
	if (value == null || value === '') return allowEmpty ? null : `${label} is required`;
	if (typeof value !== 'string' || isAbsolute(value) || value.split(/[\\/]/).includes('..')) {
		return `${label} must be a safe repository-relative path`;
	}
	return null;
}

async function getExternalAdoptionSource(
	stackName: string,
	environmentId: number | null
): Promise<{ sourceType: string; envPath: string | null } | null> {
	const source = await getStackSource(stackName, environmentId);
	if (source) return { sourceType: source.sourceType, envPath: source.envPath ?? null };
	if (!(await listComposeStacks(environmentId)).some((stack) => stack.name === stackName)) return null;
	return { sourceType: 'external', envPath: null };
}

/** Validate adoption without creating a repository, stack row, or files. */
export async function validateExternalGitAdoption(
	input: GitStackAdoptionInput
): Promise<GitStackAdoptionPreflight> {
	const stackName = input.stackName?.trim();
	if (!stackName || !/^[a-z0-9][a-z0-9_-]*$/.test(stackName)) {
		return invalid('Stack name must be lowercase, start with a letter or number, and contain only letters, numbers, hyphens, and underscores');
	}
	const environmentId = input.environmentId ?? null;
	const source = await getExternalAdoptionSource(stackName, environmentId);
	if (!source) return invalid(`Stack "${stackName}" was not found`, 404);
	if (source.sourceType !== 'external') return invalid('Only an external stack can be adopted from Git', 409);

	const composePaths = Array.isArray(input.composePaths) && input.composePaths.length > 0
		? input.composePaths
		: [input.composePath || 'compose.yaml'];
	const composeError = validateComposePathsInput(composePaths);
	if (composeError) return invalid(composeError);
	const pathErrors = [
		validateRepoRelativePath(input.envFilePath, 'envFilePath', true),
		validateRepoRelativePath(input.contextDir, 'contextDir', true)
	].filter(Boolean);
	if (pathErrors.length > 0) return invalid(pathErrors[0]!);
	if (input.envFilePath) {
		const envPathValidation = await validateStackPath(input.envFilePath);
		if (!envPathValidation.ok) return invalid(envPathValidation.error || 'Invalid envFilePath');
	}
	if (input.repositoryId !== undefined && (!Number.isInteger(input.repositoryId) || input.repositoryId <= 0)) {
		return invalid('repositoryId must be a positive integer');
	}
	if (!input.repositoryId && (!input.url || typeof input.url !== 'string' || !input.url.trim())) {
		return invalid('Repository URL or existing repository ID is required');
	}
	if (!input.repositoryId) {
		try { assertSafeRepoUrl(input.url!); } catch (error) { return invalid(error instanceof Error ? error.message : String(error)); }
	}
	if (input.branch) {
		try { assertSafeGitRef(input.branch); } catch (error) { return invalid(error instanceof Error ? error.message : String(error)); }
	}
	if (input.repositoryId && !(await getGitRepository(input.repositoryId))) {
		return invalid('Repository not found', 400);
	}
	if (input.credentialId != null) {
		const credentials = await getGitCredentials();
		if (!credentials.some((credential) => credential.id === input.credentialId)) return invalid('Invalid credential ID');
	}
	if (typeof input.existingComposePath !== 'string' || !input.existingComposePath.trim()) {
		// The project's files are gone: deploy like a new Git stack under the running project's name.
		return { ok: true, stackName, environmentId, destinationDir: null, sourceEnvPath: null };
	}
	const hawser = typeof environmentId === 'number' && isHawserConnection(await getEnvironment(environmentId));
	if (hawser) {
		// The agent verifies the selection against the running project's Compose labels,
		// exactly like managing the stack internally.
		try {
			const labels = await hawserComposeProjectLabels(environmentId!, stackName, input.existingComposePath.trim());
			return {
				ok: true,
				stackName,
				environmentId,
				destinationDir: labels.root,
				sourceEnvPath: source.envPath,
				remoteGitRoot: labels.root,
				remoteGitSourceComposePaths: labels.composeFileNames
			};
		} catch (error) {
			return invalid(error instanceof Error ? error.message : String(error), 409);
		}
	}
	const selected = resolveExistingComposeFile(input.existingComposePath);
	if (!selected.ok) return invalid(selected.error);
	const reposDir = getGitReposDir();
	if (isPathUnderRoot(selected.projectDir, reposDir) || isPathUnderRoot(reposDir, selected.projectDir)) {
		return invalid('The selected project directory overlaps Dockhand\'s Git checkouts; choose the stack\'s own Compose directory', 409);
	}
	const hostError = await checkDockerHostSharesProjectDir(selected.projectDir, environmentId);
	if (hostError) return invalid(hostError, 409);
	return {
		ok: true,
		stackName,
		environmentId,
		destinationDir: selected.projectDir,
		sourceEnvPath: source.envPath
	};
}

async function cleanupProvisionalGitState(
	gitStackId: number | undefined,
	repositoryId: number,
	repositoryCreated: boolean,
	stackName: string,
	environmentId: number | null
): Promise<void> {
	if (gitStackId) {
		unregisterSchedule(gitStackId, 'git_stack_sync');
		try {
			const engine = await getEngineForStack(gitStackId);
			await engine.deleteGitStackFiles(gitStackId, stackName, environmentId);
		} catch (error) {
			console.warn('[Git adoption] Failed to clean provisional clone:', error);
		}
		await deleteGitStack(gitStackId).catch(() => false);
	}
	if (!repositoryCreated) return;
	const references = await getGitStacksByRepositoryId(repositoryId).catch(() => []);
	if (references.length === 0) {
		if (!repositoryId) throw new Error('Repository not found');
		const repository = await getGitRepository(repositoryId);
		if (repository) deleteRepositoryFiles(repository.name, repositoryId);
		await unregisterSchedule(repositoryId, 'git_repository_sync');
		await deleteGitRepository(repositoryId).catch(() => false);
	}
}

/**
 * Convert an external stack to Git in place: the checkout stays separate, tracked files are
 * published into the selected project directory, and Compose runs there.
 */
export async function adoptExternalGitStack(
	input: GitStackAdoptionInput,
	onLine?: (line: string) => void,
	onProgress?: ProgressCallback,
	options?: { lockHeld?: boolean; preflight?: GitStackAdoptionPreflight & { ok: true } }
): Promise<{ success: boolean; output?: string; error?: string; warning?: string; status?: number }> {
	const stackName = input.stackName.trim();
	const environmentId = input.environmentId ?? null;
	const run = async () => {
		// The route validates under the same held lock; reuse it rather than re-running the host check.
		const preflight = options?.preflight ?? await validateExternalGitAdoption(input);
		if (!preflight.ok) return { success: false, error: preflight.error, status: preflight.status };

		let repositoryId = input.repositoryId;
		let repositoryCreated = false;
		let gitStackId: number | undefined;
		let sourceCommitted = false;
		let deployReturned = false;
		let composeStarted = false;
		let envVarsChanged = false;
		const temporaryCloneToken = input.engine === 'stack' && typeof input.temporaryCloneToken === 'string'
			? input.temporaryCloneToken.trim()
			: '';
		let originalEnvVars: Awaited<ReturnType<typeof getStackEnvVars>> | undefined;
		try {
			onProgress?.({ status: 'connecting', message: 'Preparing Git adoption...', step: 1, totalSteps: 5 });
			if (!repositoryId) {
				const repository = await createGitRepository({
					name: input.repoName?.trim() || stackName,
					url: input.url!.trim(),
					branch: input.branch?.trim() || 'main',
					credentialId: input.credentialId ?? null,
					autoUpdate: input.engine === 'centralized' ? input.autoUpdate ?? false : false,
					autoUpdateSchedule: input.engine === 'centralized'
						? input.autoUpdateSchedule as 'daily' | 'weekly' | 'custom' | undefined
						: undefined,
					autoUpdateCron: input.engine === 'centralized' ? input.autoUpdateCron : undefined,
					webhookEnabled: input.engine === 'centralized' ? input.webhookEnabled ?? false : false,
					webhookSecret: input.engine === 'centralized' && input.webhookEnabled ? input.webhookSecret ?? null : null
				});
				repositoryId = repository.id;
				repositoryCreated = true;
			}
			const repository = await getGitRepository(repositoryId);
			if (!repository) throw new Error('Repository not found');
			if (input.envVars && input.envVars.length > 0) {
				originalEnvVars = await getStackEnvVars(stackName, environmentId, false);
				const incoming = input.envVars
					.filter((variable) => variable.key?.trim() && variable.value !== '***')
					.map((variable) => ({
						key: variable.key!.trim(),
						value: variable.value ?? '',
						isSecret: variable.isSecret ?? false
					}));
				if (incoming.length > 0) {
					envVarsChanged = true;
					const merged = new Map(originalEnvVars.map((variable) => [variable.key, {
						key: variable.key,
						value: variable.value,
						isSecret: variable.isSecret
					}]));
					for (const variable of incoming) merged.set(variable.key, variable);
					await setStackEnvVars(stackName, environmentId, [...merged.values()]);
				}
			}

			const composePaths = Array.isArray(input.composePaths) && input.composePaths.length > 0
				? input.composePaths
				: [input.composePath || 'compose.yaml'];
			const gitStack = await createGitStack({
				stackName,
				environmentId,
				repositoryId,
				branch: input.repositoryId ? input.branch?.trim() || null : null,
				composePath: composePaths[0],
				composePaths,
				envFilePath: input.envFilePath || null,
				contextDir: input.contextDir || null,
				buildOnDeploy: input.buildOnDeploy ?? false,
				noBuildCache: input.noBuildCache ?? false,
				repullImages: input.repullImages ?? false,
				forceRedeploy: input.forceRedeploy ?? false,
				webhookEnabled: input.webhookEnabled ?? false,
				webhookSecret: input.webhookSecret ?? null,
				engine: input.engine ?? 'stack',
				autoUpdate: input.engine === 'centralized' ? false : input.autoUpdate ?? false,
				autoUpdateSchedule: input.autoUpdateSchedule,
				autoUpdateCron: input.autoUpdateCron
			});
			gitStackId = gitStack.id;
			if (temporaryCloneToken) {
				const pendingClone = await adoptPendingGitClone(gitStack.id, temporaryCloneToken);
				if (!pendingClone.success) throw new Error(pendingClone.error || 'Failed to attach the selected repository checkout');
			}

			onProgress?.({ status: 'cloning', message: 'Cloning repository...', step: 2, totalSteps: 5 });
			const syncResult = await (await getEngineForStack(gitStack.id)).syncGitStack(gitStack.id, onProgress);
			if (!syncResult.success || !syncResult.composeDir || !syncResult.composeFileName || !syncResult.composeContent) {
				throw new Error(`Git sync failed before Compose ran: ${syncResult.error || 'The repository did not contain a usable compose file'}`);
			}

			const result = await deployStackFromSync({
				stackId: gitStack.id,
				gitStack,
				opts: { force: true, ignoreForceRedeploy: false },
				syncResult,
				onLine,
				onComposeStarted: () => { composeStarted = true; },
				onProgress,
				logPrefix: `[Stack:${stackName}]`,
				lockHeld: true,
				projectDir: preflight.remoteGitRoot ? undefined : preflight.destinationDir ?? undefined,
				remoteGitRoot: preflight.remoteGitRoot,
				remoteGitSourceComposePaths: preflight.remoteGitSourceComposePaths,
				sourceCommit: async (deployResult) => {
					// In place: the selected directory (confirmed by Hawser). Fresh: the managed stack directory the deploy used.
					const destinationDir = preflight.remoteGitRoot
						? deployResult.managedDirectory
						: preflight.destinationDir ?? deployResult.managedDirectory ?? await getStackDir(stackName, environmentId);
					if (!destinationDir) throw new Error('Hawser did not confirm the Compose directory after Git conversion');
					await upsertStackSource({
						stackName,
						environmentId,
						sourceType: 'git',
						...(deployResult.managedDirectory ? { fileLocation: 'hawser' as const }
							: preflight.destinationDir ? { projectDir: destinationDir } : { fileLocation: 'dockhand' as const }),
						gitRepositoryId: gitStack.repositoryId,
						gitStackId: gitStack.id,
						composePath: join(destinationDir, syncResult.composeFileName!),
						composePaths: resolveGitStackPaths(
							parseComposePathsColumn(gitStack.composePaths),
							gitStack.contextDir ?? dirname(gitStack.composePath),
							destinationDir
						),
						envPath: input.envFilePath && syncResult.envFileName
							? join(destinationDir, syncResult.envFileName)
							: preflight.sourceEnvPath
					});
					sourceCommitted = true;
				}
			});
			deployReturned = true;
			if (!result.success) {
				if (envVarsChanged && originalEnvVars) {
					await setStackEnvVars(stackName, environmentId, originalEnvVars.map((variable) => ({
						key: variable.key,
						value: variable.value,
						isSecret: variable.isSecret
					}))).catch((restoreError) => {
						console.error('[Git adoption] Failed to restore environment variables:', restoreError);
					});
				}
				await cleanupProvisionalGitState(gitStack.id, repositoryId, repositoryCreated, stackName, environmentId);
				return {
					success: false,
					error: result.composeStarted || composeStarted
						? `Git adoption failed after docker compose up started; services may have been partially updated: ${result.error || 'Compose failed'}`
						: `Git adoption failed before docker compose ran: ${result.error || 'Compose failed'}`
				};
			}

			if (gitStack.engine === 'centralized') {
				if (repository.autoUpdate && repository.autoUpdateCron) await registerSchedule(repository.id, 'git_repository_sync', null);
			} else if (gitStack.autoUpdate && gitStack.autoUpdateCron) {
				await registerSchedule(gitStack.id, 'git_stack_sync', gitStack.environmentId);
			}
			onProgress?.({ status: 'complete', message: `Successfully adopted ${stackName}` });
			return { success: true, output: result.output };
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error);
			if (temporaryCloneToken && repositoryId) discardPendingGitClone(temporaryCloneToken, repositoryId);
			if (!sourceCommitted) {
				if (envVarsChanged && originalEnvVars) {
					await setStackEnvVars(stackName, environmentId, originalEnvVars.map((variable) => ({
						key: variable.key,
						value: variable.value,
						isSecret: variable.isSecret
					}))).catch((restoreError) => {
						console.error('[Git adoption] Failed to restore environment variables:', restoreError);
					});
				}
				if (gitStackId || repositoryCreated) {
					await cleanupProvisionalGitState(gitStackId, repositoryId!, repositoryCreated, stackName, environmentId);
				}
				if (!deployReturned) await notifyGitSync(stackName, environmentId, { success: false, error: message });
				return {
					success: false,
					error: message.includes('docker compose up') || composeStarted || deployReturned
						? `Git adoption failed after docker compose up started; services may have been partially updated: ${message}`
						: `Git adoption failed before docker compose ran: ${message}`
				};
			}
			throw error;
		}
	};
	return options?.lockHeld ? run() : withStackLock(stackName, run);
}
