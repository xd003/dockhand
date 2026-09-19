import { accessSync, constants as fsConstants, existsSync, lstatSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { dirname, isAbsolute, join, relative, resolve } from 'node:path';
import {
	createGitRepository,
	createGitStack,
	deleteGitRepository,
	deleteGitStack,
	getEnvironment,
	getGitCredentials,
	getGitRepository,
	getGitStacksByRepositoryId,
	getStackEnvVars,
	getStackSource,
	setStackEnvVars,
	upsertStackSource
} from './db';
import { notifyGitSync, type ProgressCallback } from './git';
import { assertSafeGitRef, assertSafeRepoUrl } from './git-url-safety';
import { deleteRepositoryFiles, getEngineForStack } from './git';
import { adoptPendingGitClone, discardPendingGitClone } from './git-stack';
import { deployStackFromSync } from './git-deploy-shared';
import { getStackDir, getStackPathHints, isHawserConnection, validateStackPath, withStackLock } from './stacks';
import { isPathUnderRoot, prepareStackDirectoryRelocation, resolveComposePathHints, type StackDirectoryRelocation } from './stack-path-utils';
import { parseComposePathsColumn, validateComposePathsInput } from './compose-files';
import { registerSchedule, unregisterSchedule } from './scheduler';
import { isProtectedPath } from './fs-guard';
import { finalizeHawserStackDirAdoption, hawserSupportsStackDirAdoption, rollbackHawserStackDirAdoption } from './hawser-stack-adoption';

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
}

export type GitStackAdoptionPreflight = {
	ok: true;
	stackName: string;
	environmentId: number | null;
	composePath: string;
	sourceDir: string;
	destinationDir: string;
	source: ExternalAdoptionSource;
	remoteSource: boolean;
	remoteComposePaths?: string[];
} | {
	ok: false;
	status: number;
	error: string;
};

type ExternalAdoptionSource = {
	sourceType: string;
	composePath: string | null;
	composePaths?: string | null;
	envPath?: string | null;
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

function sourceDirectoryState(sourcePath: string): { sourceDir: string; error?: string } {
	const sourceDir = dirname(resolve(sourcePath));
	try {
		if (!existsSync(sourceDir) || !lstatSync(sourceDir).isDirectory()) {
			return { sourceDir, error: `Stack source directory is not accessible: ${sourceDir}` };
		}
		accessSync(sourceDir, fsConstants.R_OK | fsConstants.X_OK);
	} catch {
		return { sourceDir, error: `Stack source directory is not readable: ${sourceDir}` };
	}
	return { sourceDir };
}

async function getExternalAdoptionSource(
	stackName: string,
	environmentId: number | null
): Promise<ExternalAdoptionSource | null> {
	const source = await getStackSource(stackName, environmentId);
	if (source && source.sourceType !== 'external') return source;

	const hints = await getStackPathHints(stackName, environmentId);
	const composePaths = resolveComposePathHints(hints.workingDir, hints.configFiles);
	if (source && composePaths.length === 0) return source;
	if (composePaths.length === 0) return null;
	if (source) {
		return {
			...source,
			composePath: source.composePath ?? composePaths[0],
			composePaths: source.composePaths ?? JSON.stringify(composePaths)
		};
	}
	return {
		sourceType: 'external',
		composePath: composePaths[0],
		composePaths: JSON.stringify(composePaths),
		envPath: null
	};
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
	const remoteSource = typeof environmentId === 'number'
		&& isHawserConnection(await getEnvironment(environmentId));
	const remoteHints = remoteSource ? await getStackPathHints(stackName, environmentId) : null;
	const remoteComposePaths = remoteHints
		? resolveComposePathHints(remoteHints.workingDir, remoteHints.configFiles)
		: [];
	if (!source.composePath && remoteComposePaths.length === 0) return invalid('The external stack has no authoritative compose path', 409);
	if (remoteSource && remoteComposePaths.length === 0) return invalid('Docker did not provide authoritative Compose paths for the remote stack', 409);
	if (remoteSource && !(await hawserSupportsStackDirAdoption(environmentId!))) {
		return invalid('This remote stack cannot be adopted because the Hawser agent does not support stack directory adoption. Update Hawser to a version with the "stack-dir-adoption" capability and reconnect the environment.', 426);
	}

	const sourcePath = resolve(remoteSource ? remoteComposePaths[0]! : source.composePath!);
	const sourceState = remoteSource
		? { sourceDir: dirname(sourcePath) }
		: sourceDirectoryState(sourcePath);
	if (!remoteSource) {
		if (!existsSync(sourcePath) || !lstatSync(sourcePath).isFile()) {
			return invalid(`Compose file is not accessible on the Dockhand filesystem: ${sourcePath}`, 400);
		}
		if (sourceState.error) return invalid(sourceState.error, 403);
		if (isProtectedPath(sourceState.sourceDir)) return invalid('The external compose directory is protected and cannot be relocated', 403);
	}

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

	const destinationDir = resolve(await getStackDir(stackName, environmentId));
	const sameDirectory = resolve(sourceState.sourceDir) === destinationDir;
	if (!remoteSource && !sameDirectory && sourceDirOverlaps(sourceState.sourceDir, destinationDir)) {
		return invalid('The managed Git directory overlaps the existing compose directory', 403);
	}
	if (!remoteSource && !sameDirectory && existsSync(destinationDir)) return invalid(`Managed Git directory already exists: ${destinationDir}`, 409);
	return {
		ok: true,
		stackName,
		environmentId,
		composePath: sourcePath,
		sourceDir: sourceState.sourceDir,
		destinationDir,
		source,
		remoteSource,
		remoteComposePaths: remoteSource ? remoteComposePaths : undefined
	};
}

function sourceDirOverlaps(sourceDir: string, destinationDir: string): boolean {
	return isPathUnderRoot(sourceDir, destinationDir) || isPathUnderRoot(destinationDir, sourceDir);
}

function adoptionEnvPath(
	source: { envPath?: string | null } | null,
	sourceDir: string,
	destinationDir: string
): { path?: string; relativePath?: string } {
	if (!source || source.envPath === '') return {};
	const configured = source.envPath ?? join(sourceDir, '.env');
	if (source.envPath == null && !existsSync(configured)) return {};
	const relativePath = relative(sourceDir, resolve(configured));
	if (relativePath.startsWith('..') || isAbsolute(relativePath)) return { path: configured };
	return { path: resolve(join(destinationDir, relativePath)), relativePath };
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
 * Adopt an external stack while holding its stack lock from validation through
 * Compose, source conversion, and relocation commit.
 */
export async function adoptExternalGitStack(
	input: GitStackAdoptionInput,
	onLine?: (line: string) => void,
	onProgress?: ProgressCallback,
	options?: { lockHeld?: boolean }
): Promise<{ success: boolean; output?: string; error?: string; warning?: string; status?: number }> {
	const stackName = input.stackName.trim();
	const environmentId = input.environmentId ?? null;
	const run = async () => {
		const preflight = await validateExternalGitAdoption(input);
		if (!preflight.ok) return { success: false, error: preflight.error, status: preflight.status };
		const source = preflight.source;

		let repositoryId = input.repositoryId;
		let repositoryCreated = false;
		let gitStackId: number | undefined;
		let relocation: StackDirectoryRelocation | undefined;
		let sourceCommitted = false;
		let deployReturned = false;
		let composeStarted = false;
		let remoteAdoptionId: string | undefined;
		let remoteManagedDirectory: string | undefined;
		let remoteManagedEnvRelativePath: string | undefined;
		let remoteManagedComposeFiles: string[] | undefined;
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

			onProgress?.({ status: 'connecting', message: 'Staging the existing compose directory...', step: 4, totalSteps: 5 });
			const preservedEnv = preflight.remoteSource
				? {}
				: adoptionEnvPath(source, preflight.sourceDir, preflight.destinationDir);
			if (!preflight.remoteSource) {
				relocation = prepareStackDirectoryRelocation(preflight.sourceDir, preflight.destinationDir);
			}
			const targetComposePath = join(preflight.destinationDir, syncResult.composeFileName);
			const targetEnvPath = input.envFilePath && syncResult.envFileName
				? join(preflight.destinationDir, syncResult.envFileName)
				: preservedEnv.path;
			if (preflight.remoteSource) remoteAdoptionId = randomUUID();
			const explicitGitEnvRelativePath = input.envFilePath && syncResult.envFileName
				? join(dirname(syncResult.composeFileName), syncResult.envFileName).split('\\').join('/')
				: null;
			const remotePreservedEnvRelativePath = preflight.remoteSource
				? source.envPath === ''
					? undefined
					: source.envPath
						? (() => {
							const relativePath = relative(preflight.sourceDir, resolve(source.envPath!));
							return relativePath && !relativePath.startsWith('..') && !isAbsolute(relativePath)
								? relativePath.split('\\').join('/')
								: undefined;
						})()
					: '.env'
				: undefined;

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
				preserveEnvPath: input.envFilePath ? undefined : preservedEnv.path,
				allowExistingStackDir: true,
				remoteAdoption: preflight.remoteSource
					? {
						adoptionId: remoteAdoptionId!,
						sourceDir: preflight.sourceDir,
						sourceComposeFiles: preflight.remoteComposePaths ?? [preflight.composePath],
						sourceEnvPath: source.envPath,
						preservedEnvRelativePath: remotePreservedEnvRelativePath,
						preserveExistingEnv: source.envPath !== '',
						explicitGitEnvRelativePath,
						onRemoteAdoptionPrepared: (remoteResult) => {
							remoteManagedDirectory = remoteResult.managedDirectory;
							remoteManagedEnvRelativePath = remoteResult.managedEnvRelativePath;
							remoteManagedComposeFiles = remoteResult.managedComposeFiles;
						}
					}
					: undefined,
				// The deploy helper uses this path for Compose interpolation while the
				// overlay skips it when Git did not explicitly select an env file.
				sourceCommit: async () => {
					if (preflight.remoteSource && (!remoteManagedDirectory || !remoteManagedComposeFiles?.length)) {
						throw new Error('Hawser did not return the managed remote stack path');
					}
					try {
						await upsertStackSource({
							stackName,
							environmentId,
							sourceType: 'git',
							gitRepositoryId: gitStack.repositoryId,
							gitStackId: gitStack.id,
							composePath: preflight.remoteSource
								? (remoteManagedDirectory && remoteManagedComposeFiles?.[0]
									? join(remoteManagedDirectory, remoteManagedComposeFiles[0])
									: targetComposePath)
								: targetComposePath,
							composePaths: preflight.remoteSource
								? (remoteManagedDirectory && remoteManagedComposeFiles?.length
									? remoteManagedComposeFiles.map((path) => join(remoteManagedDirectory!, path))
									: parseComposePathsColumn(gitStack.composePaths))
								: parseComposePathsColumn(gitStack.composePaths),
							envPath: preflight.remoteSource
								? (remoteManagedDirectory && remoteManagedEnvRelativePath ? join(remoteManagedDirectory, remoteManagedEnvRelativePath) : null)
								: targetEnvPath ?? (input.envFilePath ? null : preservedEnv.path ?? source.envPath ?? null)
						});
					} catch (error) {
						throw new Error(`docker compose up succeeded but the Git source could not be committed: ${error instanceof Error ? error.message : String(error)}`);
					}
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
				if (relocation) relocation.rollback();
				if (preflight.remoteSource && remoteAdoptionId) {
					await rollbackHawserStackDirAdoption(environmentId!, remoteAdoptionId).catch((rollbackError) => {
						console.error('[Git adoption] Failed to roll back remote directory adoption:', rollbackError);
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
			try {
				if (preflight.remoteSource && remoteAdoptionId) {
					const finalized = await finalizeHawserStackDirAdoption(environmentId!, remoteAdoptionId);
					if (!finalized.success) throw new Error(finalized.error || 'Hawser could not remove the original directory');
				}
				relocation?.commit();
			} catch (error) {
				return {
					success: true,
					output: result.output,
					warning: `Git deployment succeeded, but the original directory could not be removed: ${error instanceof Error ? error.message : String(error)}`
				};
			}
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
				try { relocation?.rollback(); } catch (rollbackError) {
					console.error('[Git adoption] Failed to remove staged directory:', rollbackError);
				}
				if (preflight.remoteSource && remoteAdoptionId) {
					await rollbackHawserStackDirAdoption(environmentId!, remoteAdoptionId).catch((rollbackError) => {
						console.error('[Git adoption] Failed to roll back remote directory adoption:', rollbackError);
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
