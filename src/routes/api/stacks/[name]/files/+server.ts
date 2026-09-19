import { json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { dirname, join, relative, sep } from 'node:path';
import { authorize } from '$lib/server/authorize';
import { auditStack } from '$lib/server/audit';
import { getGitCredential, getGitRepository, getStackSource, updateGitStack, updateStackSource } from '$lib/server/db';
import { deployGitStack, getRepoPath } from '$lib/server/git';
import { getStackRepoPath } from '$lib/server/git-stack';
import { classifyGitFiles, mutateGitStackFiles } from '$lib/server/git-stack-files';
import {
	createLinkedFile,
	createStackFolder,
	getStackFileWorkspace,
	linkStackFile,
	saveLinkedFileContents,
	publishLinkedFilesToLocal,
	unlinkStackFile
} from '$lib/server/stack-linked-files';
import { normalizeLinkedFiles, normalizePostChangePolicy, normalizeLinkedPath, type LinkedStackFile } from '$lib/stack-linked-files';
import { planLinkedFileActions } from '$lib/server/linked-file-actions';
import { runLinkedFileAction } from '$lib/server/stacks';
import { convertGitStackToInternal } from '$lib/server/stack-source-conversion';

function errorResponse(error: unknown): Response {
	const message = error instanceof Error ? error.message : String(error);
	const status = /not found/i.test(message) ? 404 : /changed since|tracking state|checkout.*clean|ownership|push failed/i.test(message) ? 409 : /permission|protected|outside|relative|duplicate|invalid|must |cannot|exceeds|UTF-8|binary|ignored/i.test(message) ? 400 : 500;
	return json({ error: message }, { status });
}

async function authorized(cookies: Parameters<RequestHandler>[0]['cookies'], envId: number | undefined, action: 'view' | 'edit' | 'restart'): Promise<Response | null> {
	const auth = await authorize(cookies);
	if (auth.authEnabled && !(await auth.can('stacks', action, envId))) return json({ error: 'Permission denied' }, { status: 403 });
	return auth.requireEnvAccess(envId ?? null);
}

async function gitContext(stackName: string, envId: number | undefined, workspaceRoot: string) {
	const source = await getStackSource(stackName, envId);
	if (!source?.gitStack || source.sourceType !== 'git') return null;
	const gitStack = source.gitStack as any;
	const repository = (source as any).repository ?? gitStack.repository ?? await getGitRepository(gitStack.repositoryId);
	if (!repository) throw new Error('Git repository not found');
	const repoPath = gitStack.engine === 'centralized'
		? getRepoPath(repository.name)
		: await getStackRepoPath(gitStack.id, gitStack.stackName, gitStack.environmentId);
	const credential = repository.credentialId ? await getGitCredential(repository.credentialId) : null;
	const prefix = relative(repoPath, workspaceRoot).split(sep).join('/');
	return {
		repoPath,
		credential,
		branch: gitStack.branch || repository.branch,
		relativePath: (path: string) => (prefix ? `${prefix}/${normalizeLinkedPath(path)}` : normalizeLinkedPath(path))
	};
}

async function readWorkspace(stackName: string, envId: number | undefined) {
	const workspace = await getStackFileWorkspace(stackName, envId);
	const git = workspace.git ? await gitContext(stackName, envId, workspace.root) : null;
	if (git) {
		const paths = workspace.entries.map((entry) => git.relativePath(entry.path));
		const classifications = await classifyGitFiles(git.repoPath, paths, git.credential);
		const statusByPath = new Map(classifications.map((entry) => [entry.path, entry]));
		for (const entry of workspace.entries) {
			const status = statusByPath.get(git.relativePath(entry.path));
			if (status) {
				entry.tracked = status.tracked;
				entry.ignored = status.ignored;
			}
		}
	}
	return { workspace, git };
}

/**
 * @openapi
 * summary: List a stack's Compose and explicitly linked configuration files
 * path: name:string The stack name
 * query: env:integer Environment id
 * resp-403: Permission denied (needs stacks:view)
 * resp-404: Stack or Compose directory not found
 */
export const GET: RequestHandler = async ({ params, url, cookies }) => {
	const rawEnv = url.searchParams.get('env');
	const envValue = rawEnv ? Number(rawEnv) : NaN;
	const envId = Number.isInteger(envValue) ? envValue : undefined;
	// Shared authorization/workspace helpers emit these documented responses.
	// status: 403
	// status: 404
	const denied = await authorized(cookies, envId, 'view');
	if (denied) return denied;
	try {
		const { workspace } = await readWorkspace(params.name, envId);
		return json({ root: workspace.root, git: workspace.git, composeServices: workspace.composeServices, entries: workspace.entries });
	} catch (error) {
		return errorResponse(error);
	}
};

/**
 * @openapi
 * summary: Link or create a stack configuration file, or create a folder
 * path: name:string The stack name
 * query: env:integer Environment id
 * body: {operation:string!, path:string!, content:string, postChange:object}
 * resp-403: Permission denied (needs stacks:edit)
 * resp-400: Invalid path, policy, or text content
 */
export const POST: RequestHandler = async ({ params, request, url, cookies, ...event }) => {
	const rawEnv = url.searchParams.get('env');
	const envValue = rawEnv ? Number(rawEnv) : NaN;
	const envId = Number.isInteger(envValue) ? envValue : undefined;
	// Shared authorization emits the documented response.
	// status: 403
	const denied = await authorized(cookies, envId, 'edit');
	if (denied) return denied;
	try {
		const body = await request.json();
		const operation = body?.operation;
		const path = normalizeLinkedPath(body?.path);
		const postChange = operation === 'create-folder' ? null : normalizePostChangePolicy(body.postChange);
		if (postChange?.action !== 'none') {
			const restartDenied = await authorized(cookies, envId, 'restart');
			if (restartDenied) return restartDenied;
		}
		let result: unknown;
		if (operation === 'link') {
			const { workspace, git } = await readWorkspace(params.name, envId);
			let ownership: 'local' | 'git' | undefined;
			if (git) {
				const classification = (await classifyGitFiles(git.repoPath, [git.relativePath(path)], git.credential))[0];
				ownership = classification.tracked ? 'git' : 'local';
			}
			result = await linkStackFile(params.name, envId, path, postChange!, ownership);
		} else if (operation === 'create-file') {
			result = await createLinkedFile(params.name, envId, path, typeof body.content === 'string' ? body.content : '', postChange!);
		} else if (operation === 'create-folder') {
			result = { path: await createStackFolder(params.name, envId, path), localOnly: true };
		} else {
			return json({ error: 'operation must be link, create-file, or create-folder' }, { status: 400 });
		}
		await auditStack(event as any, 'create', params.name, envId, { operation, path });
		return json({ success: true, result });
	} catch (error) {
		return errorResponse(error);
	}
};

/**
 * @openapi
 * summary: Save linked text files and their policies
 * path: name:string The stack name
 * query: env:integer Environment id
 * body: {changes:array<object>, linkedFiles:array<object>, classifications:array<object>, actionPaths:array<string>, trackedDecision:string, untrackedDecision:string, commitMessage:string, redeploy:boolean, restart:boolean, runActions:boolean, preflight:boolean}
 * resp-403: Permission denied (needs stacks:edit or stacks:restart)
 * resp-400: Invalid path, policy, or Git decision
 * resp-409: Stale content or Git tracking/push conflict
 */
export const PUT: RequestHandler = async ({ params, request, url, cookies, ...event }) => {
	const rawEnv = url.searchParams.get('env');
	const envValue = rawEnv ? Number(rawEnv) : NaN;
	const envId = Number.isInteger(envValue) ? envValue : undefined;
	// Shared authorization and Git/revision helpers emit these documented responses.
	// status: 403
	// status: 409
	const denied = await authorized(cookies, envId, 'edit');
	if (denied) return denied;
	try {
		const body = await request.json();
		const { workspace, git } = await readWorkspace(params.name, envId);
		let committed = false;
		let convertedToInternal = false;
		if (body?.changes !== undefined && !Array.isArray(body.changes)) return json({ error: 'changes must be an array' }, { status: 400 });
		const changes = (body?.changes ?? []).map((change: any) => {
			if (!change || typeof change.path !== 'string' || typeof change.content !== 'string') throw new Error('Each file change requires a path and string content');
			return { ...change, path: normalizeLinkedPath(change.path) };
		});
		const entriesByPath = new Map(workspace.entries.map((entry) => [entry.path, entry]));
		for (const change of changes) {
			const entry = entriesByPath.get(change.path);
			if (!entry) throw new Error(`File is not part of this stack workspace: ${change.path}`);
			if (!entry.revision || change.expectedRevision !== entry.revision) throw new Error(`File changed since it was loaded: ${change.path}`);
		}
		const currentFiles = workspace.linkedFiles;
		const nextFiles = body?.linkedFiles === undefined
			? currentFiles
			: normalizeLinkedFiles(body.linkedFiles, {
				reservedPaths: workspace.entries.filter((entry) => entry.kind === 'compose').map((entry) => entry.path),
				forceLocalOwnership: !workspace.git
			});
		if (nextFiles.length !== currentFiles.length || nextFiles.some((file, index) => file.path !== currentFiles[index]?.path || file.ownership !== currentFiles[index]?.ownership)) {
			throw new Error('Linked file associations and ownership cannot be changed through the save operation');
		}
		// Validate every persisted service target, not only policies attached to a
		// content change, so stale metadata cannot be saved back silently.
		planLinkedFileActions(nextFiles.map((file) => ({ path: file.path, postChange: file.postChange })), workspace.composeServices);
		const contentChanged = changes.length > 0;
		let gitStackId: number | undefined;
		const explicitRedeploy = body?.redeploy === true || body?.restart === true;
		const actionPaths = body?.actionPaths === undefined ? changes.map((change: any) => change.path) : (Array.isArray(body.actionPaths) ? body.actionPaths.map(normalizeLinkedPath) : (() => { throw new Error('actionPaths must be an array'); })());
		for (const path of actionPaths) {
			if (!currentFiles.some((file) => file.path === path)) throw new Error(`Post-change action path is not linked: ${path}`);
		}
		const requestedActions = planLinkedFileActions(
			actionPaths.map((path: string) => ({ path, postChange: nextFiles.find((file) => file.path === path)?.postChange ?? { action: 'none', target: 'stack', services: [] } })),
			workspace.composeServices,
			explicitRedeploy
		);
		const preliminaryActions = body?.runActions === false ? [] : requestedActions;
		const policyRequiresRestart = nextFiles.some((file, index) =>
			JSON.stringify(file.postChange) !== JSON.stringify(currentFiles[index]?.postChange) && file.postChange.action !== 'none'
		);
		if (explicitRedeploy || requestedActions.length > 0 || policyRequiresRestart) {
			const auth = await authorize(cookies);
			if (auth.authEnabled && !(await auth.can('stacks', 'restart', envId))) return json({ error: 'Permission denied: post-change actions require stacks:restart' }, { status: 403 });
		}
		if (body?.preflight === true) return json({ success: true, preflight: true });

		if (!git) {
			if (contentChanged) await saveLinkedFileContents(params.name, envId, changes);
			if (body?.linkedFiles !== undefined) await updateStackSource(params.name, envId ?? null, { linkedFiles: nextFiles });
		} else {
			if (!git.repoPath) throw new Error('Git checkout is not available');
			const trackedDecision = body?.trackedDecision === 'internal' || body?.trackedDecision === 'keep-internal' ? 'internal' : 'commit';
			const untrackedDecision = body?.untrackedDecision === 'local' || body?.untrackedDecision === 'keep-local' ? 'local' : 'add';
			if (contentChanged && !body?.trackedDecision && !body?.untrackedDecision) return json({ error: 'Git save decisions are required' }, { status: 400 });
			if (contentChanged && !Array.isArray(body?.classifications)) return json({ error: 'Git file classifications are required; reload and retry' }, { status: 400 });
			const repoChanges = changes.map((change: any) => ({ ...change, path: git.relativePath(normalizeLinkedPath(change.path)) }));
			const expected = Array.isArray(body?.classifications) ? body.classifications.map((entry: any) => ({ ...entry, path: git.relativePath(entry.path) })) : undefined;
			let mutation: Awaited<ReturnType<typeof mutateGitStackFiles>> | null = null;
			gitStackId = (await getStackSource(params.name, envId))?.gitStack?.id;
			if (!gitStackId) throw new Error('Git stack metadata is no longer available');
			if (trackedDecision === 'internal') {
				await convertGitStackToInternal(params.name, envId, changes, nextFiles);
				convertedToInternal = true;
			} else if (contentChanged) {
				const source = (await getStackSource(params.name, envId))!;
				mutation = await mutateGitStackFiles({
					repositoryId: source.gitStack!.repositoryId,
					repoPath: git.repoPath,
					branch: git.branch,
					credential: git.credential,
					changes: repoChanges,
					trackedDecision,
					untrackedDecision,
					commitMessage: body?.commitMessage,
					expectedClassifications: expected,
					afterPush: async (result) => {
						const committedMetadata = nextFiles.map((file) => {
							const classification = result.classifications.find((entry) => entry.path === git.relativePath(file.path));
							return classification ? { ...file, ownership: classification.tracked || untrackedDecision === 'add' ? 'git' as const : 'local' as const } : file;
						});
						await publishLinkedFilesToLocal(params.name, envId, changes);
						await updateStackSource(params.name, envId ?? null, { linkedFiles: committedMetadata });
						if (result.commit) await updateGitStack(source.gitStack!.id, { lastCommit: result.commit, lastSync: new Date().toISOString(), syncStatus: 'synced', syncError: null });
					}
				});
			}
			committed = !!mutation?.committed;
			const changedMetadata = nextFiles.map((file) => {
				if (convertedToInternal) return { ...file, ownership: 'local' as const };
				const classification = mutation?.classifications.find((entry) => entry.path === git.relativePath(file.path));
				if (!classification) return file;
				return { ...file, ownership: classification.tracked || untrackedDecision === 'add' ? 'git' as const : 'local' as const };
			});
			if (!mutation && !convertedToInternal && body?.linkedFiles !== undefined) await updateStackSource(params.name, envId ?? null, { linkedFiles: changedMetadata });
			if (!convertedToInternal && !mutation && contentChanged) {
				const localChanges = changes.filter((change: any) => changedMetadata.find((file) => file.path === normalizeLinkedPath(change.path))?.ownership === 'local');
				if (localChanges.length) await publishLinkedFilesToLocal(params.name, envId, localChanges);
			}
		}

		let action: { success: boolean; error?: string; output?: string[] } | undefined;
		if (mutation?.reconciliationError) {
			action = { success: false, error: `Changes were pushed, but local reconciliation failed: ${mutation.reconciliationError}` };
		} else if (body?.redeploy === true && gitStackId && !convertedToInternal) {
			const deployment = await deployGitStack(gitStackId, { force: true });
			action = { success: deployment.success, error: deployment.error, output: deployment.output ? deployment.output.split('\n') : [] };
		} else if (preliminaryActions.length > 0) {
			const output: string[] = [];
			for (const planned of preliminaryActions) {
				const result = await runLinkedFileAction(params.name, envId, planned.action, planned.services, (line) => output.push(line));
				action = { success: result.success, error: result.error, output };
				if (!result.success) break;
			}
		}
		await auditStack(event as any, 'update', params.name, envId, { files: changes.map((change: any) => normalizeLinkedPath(change.path)), contentChanged, committed });
		return json({ success: true, saved: true, pushed: committed, convertedToInternal, reconciliationError: mutation?.reconciliationError, action });
	} catch (error) {
		return errorResponse(error);
	}
};

/**
 * @openapi
 * summary: Unlink a configuration file without deleting it
 * path: name:string The stack name
 * query: env:integer Environment id
 * body: {path:string!}
 * resp-403: Permission denied (needs stacks:edit)
 */
export const DELETE: RequestHandler = async ({ params, request, url, cookies, ...event }) => {
	const rawEnv = url.searchParams.get('env');
	const envValue = rawEnv ? Number(rawEnv) : NaN;
	const envId = Number.isInteger(envValue) ? envValue : undefined;
	// Shared authorization emits the documented response.
	// status: 403
	const denied = await authorized(cookies, envId, 'edit');
	if (denied) return denied;
	try {
		const body = await request.json();
		const file = await unlinkStackFile(params.name, envId, normalizeLinkedPath(body?.path));
		await auditStack(event as any, 'delete', params.name, envId, { operation: 'unlink', path: file.path });
		return json({ success: true, unlinked: file.path, preserved: true });
	} catch (error) {
		return errorResponse(error);
	}
};
