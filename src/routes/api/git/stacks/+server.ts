import { json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import {
	getGitStacks,
	createGitStack,
	getGitCredentials,
	getGitRepository,
	createGitRepository,
	upsertStackSource,
	setStackEnvVars,
	getStackSource,
	secretProviderExists,
	deleteGitStack
} from '$lib/server/db';
import { deployGitStack, getRepoPath, provisionSharedClone } from '$lib/server/git';
import { adoptPendingGitClone } from '$lib/server/git-stack';
import { validateComposePathsInput } from '$lib/server/compose-files';
import { getDesiredGitMode } from '$lib/server/git-mode';
import { createStackModel } from '$lib/utils/git-model-routing';
import { assertNotMigrating } from '$lib/server/git-migration-guard';
import { authorize } from '$lib/server/authorize';
import { auditGitStack } from '$lib/server/audit';
import { createJobResponse } from '$lib/server/sse';
import { allowSecretlessWebhook, webhookConfigRequiresSecret } from '$lib/server/webhook-secret-policy';
import { registerSchedule } from '$lib/server/scheduler';
import { adoptExternalGitStack, validateExternalGitAdoption } from '$lib/server/git-stack-adoption';
import { acquireStackLock } from '$lib/server/stacks';
import { dirname, relative } from 'node:path';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { getPendingGitClonePath } from '$lib/server/git-stack';
import { mutateGitStackFiles, type GitFileChange } from '$lib/server/git-stack-files';
import { repoFilePath, resolveSafeGitFileTarget } from '$lib/server/git-url-safety';

// Stack name validation: Docker Compose requires lowercase; must start with a
// letter or number, and contain only lowercase letters, numbers, hyphens, underscores
const STACK_NAME_REGEX = /^[a-z0-9][a-z0-9_-]*$/;

function draftChanges(data: any, repoRoot: string): GitFileChange[] {
	const composeContents = data.composeContents && typeof data.composeContents === 'object' && !Array.isArray(data.composeContents) ? data.composeContents : {};
	const composeChanges = Object.entries(composeContents).map(([path, content]) => ({
		path: relative(repoRoot, repoFilePath(repoRoot, path, 'Compose path')).split('/').join('/'),
		content: typeof content === 'string' ? content : (() => { throw new Error(`Compose content must be text: ${path}`); })(),
		expectedRevision: data.editorRevisions?.[path]
	}));
	return composeChanges;
}

function draftClassifications(data: any, repoRoot: string): Array<{ path: string; tracked: boolean; ignored: boolean }> | undefined {
	if (!Array.isArray(data.editorClassifications)) return undefined;
	return data.editorClassifications.map((entry: any) => ({
		...entry,
		path: relative(repoRoot, repoFilePath(repoRoot, entry.path, 'Compose path')).split('/').join('/')
	}));
}

function writeDraftComposeFiles(root: string, data: any): void {
	const composeContents = data.composeContents && typeof data.composeContents === 'object' && !Array.isArray(data.composeContents) ? data.composeContents : {};
	for (const [path, content] of Object.entries(composeContents)) {
		if (typeof content !== 'string') throw new Error(`Compose content must be text: ${path}`);
		const target = resolveSafeGitFileTarget(root, path);
		mkdirSync(dirname(target), { recursive: true });
		writeFileSync(target, content, { encoding: 'utf8', mode: 0o640 });
	}
}

/**
 * @openapi
 * summary: List git-deployed stacks (optionally scoped to one environment)
 * query: env:integer Filter to a single environment id
 * resp-403: Permission denied (needs stacks:view)
 * resp-500: Failed to list git stacks
 */
export const GET: RequestHandler = async ({ url, cookies }) => {
	const auth = await authorize(cookies);

	const envId = url.searchParams.get('env');
	const envIdNum = envId ? parseInt(envId) : undefined;

	// Permission check with environment context
	if (auth.authEnabled && !await auth.can('stacks', 'view', envIdNum)) {
		return json({ error: 'Permission denied' }, { status: 403 });
	}

	try {

		const stacks = await getGitStacks(envIdNum);
		return json(stacks);
	} catch (error) {
		console.error('Failed to get git stacks:', error);
		return json({ error: 'Failed to get git stacks' }, { status: 500 });
	}
};

/**
 * @openapi
 * summary: Create a git-deployed stack (from an existing repo or new repo url/branch)
 * body: {stackName:string!, environmentId:integer, repositoryId:integer, composePath:string, composePaths:array<string>, secretProviderId:integer, webhookEnabled:boolean, webhookSecret:string, adoptExternal:boolean, deployNow:boolean}
 * resp-400: Invalid stack name, or secretProviderId is not a number/null
 * resp-403: Permission denied (needs stacks:create; binding a secret provider also needs secrets:view)
 * resp-404: The requested external stack does not exist
 * resp-409: A git stack with this name already exists, or the external stack is already managed/migrating
 * resp-500: Failed to create the git stack
 */
export const POST: RequestHandler = async (event) => {
	const { request, cookies } = event;
	const auth = await authorize(cookies);

	try {
		const data = await request.json();
		if (data.environmentId != null) {
			data.environmentId = Number(data.environmentId);
			if (!Number.isInteger(data.environmentId) || data.environmentId <= 0) {
				return json({ error: 'environmentId must be a positive integer or null' }, { status: 400 });
			}
		}

		// Block only when the target repository is being provisioned by a migration.
		// New stacks themselves are never in an active job's scope (narrow lock).
		const locked = await assertNotMigrating([], typeof data?.repositoryId === 'number' ? [data.repositoryId] : []);
		if (locked) return locked;

		// Permission check with environment context
		if (auth.authEnabled && !await auth.can('stacks', 'create', data.environmentId || undefined)) {
			return json({ error: 'Permission denied' }, { status: 403 });
		}

		// New stacks inherit the GLOBAL DEFAULT (env lock wins). Any model sent by
		// the client is ignored — there is no per-stack chooser (createStackModel).
		const model = createStackModel(await getDesiredGitMode(), data.engine);

		if (!data.stackName || typeof data.stackName !== 'string') {
			return json({ error: 'Stack name is required' }, { status: 400 });
		}

		const trimmedStackName = data.stackName.trim();
		if (!STACK_NAME_REGEX.test(trimmedStackName)) {
			return json({ error: 'Stack name must be lowercase, start with a letter or number, and contain only letters, numbers, hyphens, and underscores' }, { status: 400 });
		}

		if (
			'secretProviderId' in data &&
			data.secretProviderId !== null &&
			typeof data.secretProviderId !== 'number'
		) {
			return json({ error: 'secretProviderId must be a number or null' }, { status: 400 });
		}

		// Binding a secret provider resolves its secrets into the container at deploy;
		// require the secrets permission so a stacks-only user can't exfiltrate a
		// provider's secrets by binding it and reading the container env.
		if (
			typeof data.secretProviderId === 'number' &&
			auth.authEnabled &&
			!(await auth.can('secrets', 'view', data.environmentId || undefined))
		) {
			return json({ error: 'Permission denied: binding a secret provider requires the secrets permission' }, { status: 403 });
		}

		// A stale provider id (e.g. the provider was deleted/recreated while the editor
		// held the old list) would otherwise hit a raw foreign-key error on save. Reject
		// it cleanly so the user knows to reselect a provider (#1522).
		if (typeof data.secretProviderId === 'number' && !(await secretProviderExists(data.secretProviderId))) {
			return json({ error: 'The selected secret provider no longer exists. Reopen the stack and pick a current provider.' }, { status: 400 });
		}

		// Check for name conflicts with existing stacks (regular/external/git).
		// Adoption is the only explicit exception, and only for an external source.
		const adoptingExternal = data.adoptExternal === true;
		const existing = await getStackSource(trimmedStackName, data.environmentId || null);
		if (existing && !adoptingExternal) {
			return json({ error: 'A stack with this name already exists on this environment' }, { status: 409 });
		}
		if (adoptingExternal && existing && existing.sourceType !== 'external') {
			return json({ error: 'Only an external stack can be adopted from Git' }, { status: 409 });
		}

		// A secret is mandatory when the webhook is enabled.
		if (webhookConfigRequiresSecret(!!data.webhookEnabled, !!data.webhookSecret?.trim(), allowSecretlessWebhook())) {
			return json({ error: 'A webhook secret is required when the webhook is enabled' }, { status: 400 });
		}

		const composePathsError = validateComposePathsInput(data.composePaths);
		if (composePathsError) return json({ error: composePathsError }, { status: 400 });

		// composePaths[0] is the primary compose file; normalize composePath
		// from it so the denormalized column can't diverge from the array.
		const composePaths = Array.isArray(data.composePaths) && data.composePaths.length > 0
			? data.composePaths
			: [data.composePath || 'compose.yaml'];
		const composePath = composePaths[0];
		let pendingDraftPath: string | null = null;
		const hasEditorDraft = data.composeContents !== undefined;
		const draftToken = typeof data.temporaryCloneToken === 'string' ? data.temporaryCloneToken.trim() : '';
		if (hasEditorDraft && model !== 'centralized' && !draftToken) return json({ error: 'A valid pending repository checkout is required for Git editor drafts' }, { status: 400 });

		if (adoptingExternal) {
			if (data.deployNow !== true) {
				return json({ error: 'External Git adoption requires deployNow=true' }, { status: 400 });
			}
			if (auth.authEnabled && !await auth.can('stacks', 'edit', data.environmentId || undefined)) {
				return json({ error: 'Permission denied: adopting a stack requires the stacks edit permission' }, { status: 403 });
			}
			const releaseAdoptionLock = await acquireStackLock(trimmedStackName);
			try {
				const preflight = await validateExternalGitAdoption({ ...data, stackName: trimmedStackName, engine: model });
				if (!preflight.ok) {
					releaseAdoptionLock();
					if (preflight.status === 404) return json({ error: preflight.error }, { status: 404 });
					return json({ error: preflight.error }, { status: preflight.status });
				}
				const adoptionMigrationLock = await assertNotMigrating(
					[],
					typeof data.repositoryId === 'number' ? [data.repositoryId] : []
				);
				if (adoptionMigrationLock) {
					releaseAdoptionLock();
					return adoptionMigrationLock;
				}

				return createJobResponse(async (send) => {
					try {
						const result = await adoptExternalGitStack(
							{ ...data, stackName: trimmedStackName, environmentId: data.environmentId || null, engine: model },
							(line) => send('progress', { type: 'line', line }),
							undefined,
							{ lockHeld: true }
						);
						if (result.success) {
							const adopted = await getStackSource(trimmedStackName, data.environmentId || null);
							if (adopted?.gitStack) {
								await auditGitStack(event, 'create', adopted.gitStack.id, trimmedStackName, data.environmentId || null, { adoptedFrom: 'external' });
								await auditGitStack(event, 'deploy', adopted.gitStack.id, trimmedStackName, data.environmentId || null);
							}
						}
						send('result', { deployResult: result, adoptExternal: true });
					} finally {
						releaseAdoptionLock();
					}
				}, request);
			} catch (error) {
				releaseAdoptionLock();
				throw error;
			}
		}

		// Either repositoryId or new repo details (url, branch) must be provided
		let repositoryId = data.repositoryId;

		if (!repositoryId) {
			// Create a new repository if URL is provided
			if (!data.url || typeof data.url !== 'string') {
				return json({ error: 'Repository URL or existing repository ID is required' }, { status: 400 });
			}

			// Validate credential if provided
			if (data.credentialId) {
				const credentials = await getGitCredentials();
				const credential = credentials.find(c => c.id === data.credentialId);
				if (!credential) {
					return json({ error: 'Invalid credential ID' }, { status: 400 });
				}
			}

			// Create the repository first
			const repoName = data.repoName || data.stackName;
			try {
				if (model === 'centralized') {
					const repo = await createGitRepository({
						name: repoName,
						url: data.url,
						branch: data.branch || 'main',
						credentialId: data.credentialId || null,
						autoUpdate: data.autoUpdate || false,
						autoUpdateSchedule: data.autoUpdateSchedule || undefined,
						autoUpdateCron: data.autoUpdate ? (data.autoUpdateCron || '0 3 * * *') : undefined,
						webhookEnabled: data.webhookEnabled || false,
						webhookSecret: data.webhookEnabled ? (data.webhookSecret || null) : null
					});
					repositoryId = repo.id;
					if (repo.autoUpdate) {
						await registerSchedule(repo.id, 'git_repository_sync', null);
					}
				} else {
					// Stack mode: repositories are thin records — no clone, no repo-level
					// schedule/webhook. Syncs and webhooks are configured per stack.
					const repo = await createGitRepository({
						name: repoName,
						url: data.url,
						branch: data.branch || 'main',
						credentialId: data.credentialId || null
					});
					repositoryId = repo.id;
				}
			} catch (error: any) {
				if (error.message?.includes('UNIQUE constraint failed')) {
					return json({ error: 'A repository with this name already exists' }, { status: 400 });
				}
				throw error;
			}
		} else {
			// Verify repository exists
			const repo = await getGitRepository(repositoryId);
			if (!repo) {
				return json({ error: 'Repository not found' }, { status: 400 });
			}
		}

		if (hasEditorDraft) {
			const draftRepository = await getGitRepository(Number(repositoryId));
			pendingDraftPath = model === 'centralized' && draftRepository
				? getRepoPath(draftRepository.name)
				: getPendingGitClonePath(draftToken, Number(repositoryId));
			if (!pendingDraftPath || !existsSync(pendingDraftPath)) return json({ error: model === 'centralized' ? 'Shared repository checkout not found' : 'Pending repository checkout not found or expired' }, { status: 404 });
			try {
				for (const change of draftChanges(data, pendingDraftPath)) {
					if (typeof change.content !== 'string') throw new Error(`Invalid draft content: ${change.path}`);
				}
			} catch (error) {
				return json({ error: error instanceof Error ? error.message : String(error) }, { status: 400 });
			}
		}

		let pendingDraftMutation: Awaited<ReturnType<typeof mutateGitStackFiles>> | null = null;
		if (model === 'stack' && hasEditorDraft && pendingDraftPath) {
			const repository = await getGitRepository(repositoryId);
			if (!repository) return json({ error: 'Repository not found' }, { status: 400 });
			const credential = repository.credentialId ? (await getGitCredentials()).find((entry) => entry.id === repository.credentialId) ?? null : null;
			const trackedDecision = data.trackedDecision === 'internal' ? 'internal' : 'commit';
			const untrackedDecision = data.untrackedDecision === 'local' ? 'local' : 'add';
			const changes = draftChanges(data, pendingDraftPath);
			if (changes.length > 0) {
				const expectedClassifications = draftClassifications(data, pendingDraftPath);
				pendingDraftMutation = await mutateGitStackFiles({
					repositoryId,
					repoPath: pendingDraftPath,
					branch: data.branch || repository.branch,
					credential,
					changes,
					trackedDecision,
					untrackedDecision,
					commitMessage: data.commitMessage,
					expectedClassifications
				});
			}
		}
		let centralizedDraftMutation: Awaited<ReturnType<typeof mutateGitStackFiles>> | null = null;
		let centralizedRepoPath: string | null = null;

		const gitStack = await createGitStack(model === 'centralized'
			? {
				stackName: trimmedStackName,
				environmentId: data.environmentId || null,
				repositoryId: repositoryId,
				// Per-stack branch override — only when targeting an existing repository.
				// In new-repo mode data.branch becomes the repository's default instead;
				// the stack inherits it (branch stays null).
				...(data.repositoryId && typeof data.branch === 'string' && data.branch.trim()
					? { branch: data.branch.trim() }
					: {}),
				composePath: composePath,
				composePaths: composePaths,
				envFilePath: data.envFilePath || null,
				contextDir: data.contextDir || null,
				buildOnDeploy: data.buildOnDeploy ?? false,
				noBuildCache: data.noBuildCache ?? false,
				repullImages: data.repullImages ?? false,
				forceRedeploy: data.forceRedeploy ?? false,
				engine: model,
				webhookEnabled: data.forceRedeploy ? (data.webhookEnabled || false) : false,
				webhookSecret: (data.forceRedeploy && data.webhookEnabled) ? (data.webhookSecret || null) : null
			}
			: {
				// Stack mode: stack-level scheduled sync + webhook, not gated by forceRedeploy.
				stackName: trimmedStackName,
				environmentId: data.environmentId || null,
				repositoryId: repositoryId,
				// Per-stack branch override — only when targeting an existing repository.
				// In new-repo mode data.branch becomes the repository's default instead;
				// the stack inherits it (branch stays null).
				...(data.repositoryId && typeof data.branch === 'string' && data.branch.trim()
					? { branch: data.branch.trim() }
					: {}),
				composePath: composePath,
				composePaths: composePaths,
				envFilePath: data.envFilePath || null,
				contextDir: data.contextDir || null,
				buildOnDeploy: data.buildOnDeploy ?? false,
				noBuildCache: data.noBuildCache ?? false,
				repullImages: data.repullImages ?? false,
				forceRedeploy: data.forceRedeploy ?? false,
				engine: model,
				webhookEnabled: data.webhookEnabled || false,
				webhookSecret: data.webhookEnabled ? (data.webhookSecret || null) : null,
				autoUpdate: data.autoUpdate || false,
				autoUpdateSchedule: data.autoUpdate ? (data.autoUpdateSchedule || 'daily') : undefined,
				autoUpdateCron: data.autoUpdate ? (data.autoUpdateCron || '0 3 * * *') : undefined
			}
		);

		if (model === 'centralized' && hasEditorDraft && pendingDraftPath) {
			try {
				const repository = await getGitRepository(repositoryId);
				if (!repository) throw new Error('Repository not found');
				const provision = await provisionSharedClone(repositoryId);
				if (!provision.success) throw new Error(provision.error || 'Failed to provision the shared repository checkout');
				centralizedRepoPath = getRepoPath(repository.name);
				const credential = repository.credentialId ? (await getGitCredentials()).find((entry) => entry.id === repository.credentialId) ?? null : null;
				const changes = draftChanges(data, pendingDraftPath);
				if (changes.length > 0) {
					centralizedDraftMutation = await mutateGitStackFiles({
						repositoryId,
						repoPath: centralizedRepoPath,
						branch: data.branch || repository.branch,
						credential,
						changes,
						trackedDecision: data.trackedDecision === 'internal' ? 'internal' : 'commit',
						untrackedDecision: data.untrackedDecision === 'local' ? 'local' : 'add',
						commitMessage: data.commitMessage,
						expectedClassifications: draftClassifications(data, pendingDraftPath, composePaths, composePath)
					});
				}
			} catch (error) {
				await deleteGitStack(gitStack.id).catch(() => false);
				return json({ error: error instanceof Error ? error.message : String(error) }, { status: 400 });
			}
		}

		if (model === 'stack' && typeof data.temporaryCloneToken === 'string' && data.temporaryCloneToken.trim()) {
			const adoption = await adoptPendingGitClone(gitStack.id, data.temporaryCloneToken.trim());
			if (!adoption.success) {
				return json({ error: adoption.error || 'Failed to attach the pre-cloned repository' }, { status: 400 });
			}
			if (hasEditorDraft && adoption.path) {
				writeDraftComposeFiles(adoption.path, data);
			}
		}

		if (model === 'centralized' && hasEditorDraft && centralizedRepoPath) {
			try {
				writeDraftComposeFiles(centralizedRepoPath, data);
			} catch (error) {
				await deleteGitStack(gitStack.id).catch(() => false);
				return json({ error: error instanceof Error ? error.message : String(error) }, { status: 400 });
			}
		}

		// Stack mode: register the per-stack schedule when scheduled sync is enabled.
		if (model === 'stack' && gitStack.autoUpdate && gitStack.autoUpdateCron) {
			await registerSchedule(gitStack.id, 'git_stack_sync', gitStack.environmentId);
		}

		// Create stack_sources entry so the stack appears in the list immediately
		await upsertStackSource({
			stackName: trimmedStackName,
			environmentId: data.environmentId || null,
			sourceType: 'git',
			gitRepositoryId: repositoryId,
			gitStackId: gitStack.id,
			secretProviderId: data.secretProviderId ?? null
		});

		// Audit log
		await auditGitStack(event, 'create', gitStack.id, gitStack.stackName, gitStack.environmentId);

		// Save environment variable overrides before deploying
		if (data.envVars && Array.isArray(data.envVars) && data.envVars.length > 0) {
			// Filter out masked secrets - on initial creation there are no existing secrets
			// If a secret has value '***', it means something went wrong in the UI
			const varsToSave = data.envVars
				.filter((v: any) => v.key?.trim())
				.filter((v: any) => !(v.isSecret && v.value === '***'))
				.map((v: any) => ({
					key: v.key.trim(),
					value: v.value ?? '',
					isSecret: v.isSecret ?? false
				}));

			if (varsToSave.length > 0) {
				await setStackEnvVars(trimmedStackName, data.environmentId || null, varsToSave);
			}
		}

		// If deployNow is set, deploy immediately via SSE to keep connection alive
		if (data.deployNow) {
			return createJobResponse(async (send) => {
				try {
					const deployResult = await deployGitStack(gitStack.id, {
						triggeredBy: 'manual',
						userId: auth.user?.id,
						onLine: (line) => send('progress', { type: 'line', line })
					});
					await auditGitStack(event, 'deploy', gitStack.id, gitStack.stackName, gitStack.environmentId);
					send('result', {
						...gitStack,
						deployResult: deployResult
					});
				} catch (error) {
					console.error('Failed to deploy git stack:', error);
					send('result', {
						...gitStack,
						deployResult: { success: false, error: 'Failed to deploy git stack' }
					});
				}
			}, request);
		}

		return json(gitStack);
	} catch (error: any) {
		console.error('Failed to create git stack:', error);
		if (error.message?.includes('UNIQUE constraint failed')) {
			if (error.message?.includes('stack_environment_variables')) {
				return json({ error: 'Duplicate environment variable keys detected' }, { status: 400 });
			}
			return json({ error: 'A git stack with this name already exists for this environment' }, { status: 400 });
		}
		return json({ error: 'Failed to create git stack' }, { status: 500 });
	}
};
