import { json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { mkdir, open, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { dirname, join, relative } from 'node:path';
import { authorize } from '$lib/server/authorize';
import { getStackComposeFile, getStackDir } from '$lib/server/stacks';
import { deleteGitStack, getGitCredentials, getStackComposePaths, getStackSource, updateStackSource } from '$lib/server/db';
import { isBinaryWorkspaceContent, listWorkspace, MAX_STACK_WORKSPACE_TEXT_SIZE, STACK_WORKSPACE_HIDDEN, normalizeWorkspacePath, resolveWorkspacePath, withInternalStackDirectory, workspaceRevision } from '$lib/server/stack-workspace';
import { execGit } from '$lib/server/git';
import { getRepoPath } from '$lib/server/git';
import { getStackRepoPath } from '$lib/server/git-stack';
import { resolveSafeGitFileTarget } from '$lib/server/git-url-safety';
import { mutateGitStackFiles } from '$lib/server/git-stack-files';
import { unregisterScheduleByFamily } from '$lib/server/scheduler';
import { hawserStackFiles, type HawserStackFileClient } from '$lib/server/hawser-stack-files';
import { ensureHawserStackFilesReady } from '$lib/server/hawser-stack-file-migration';
import { getEnvironment } from '$lib/server/db';


async function context(name: string, url: URL, cookies: Parameters<typeof authorize>[0], permission: 'view' | 'edit') {
	const auth = await authorize(cookies);
	const rawEnv = url.searchParams.get('env');
	const envId = rawEnv ? Number.parseInt(rawEnv) : undefined;
	if (auth.authEnabled && !(await auth.can('stacks', permission, envId))) throw Object.assign(new Error('Permission denied'), { status: 403 });
	const denied = await auth.requireEnvAccess(envId ?? null);
	if (denied) throw Object.assign(new Error('Environment access denied'), { status: 403 });
	const source = await getStackSource(name, envId ?? null);
	const environment = envId ? await getEnvironment(envId) : null;
	const remote = environment?.connectionType === 'hawser-edge' || environment?.connectionType === 'hawser-standard'
		? (await ensureHawserStackFilesReady(name, envId!), await hawserStackFiles(envId!, name))
		: null;
	if (source?.sourceType === 'git' && source.gitStack && source.repository) {
		const repoRoot = source.gitStack.engine === 'centralized'
			? getRepoPath(source.repository.name)
			: await getStackRepoPath(source.gitStack.id, name, envId ?? null);
		const composePath = getStackComposePaths(source.gitStack)[0] || source.gitStack.composePath;
		const composeDirectory = dirname(composePath);
		const root = composeDirectory === '.' ? repoRoot : dirname(resolveSafeGitFileTarget(repoRoot, composePath));
		return { root, source, remote };
	}
	const stack = await getStackComposeFile(name, envId);
	if (!stack.success || !stack.stackDir) throw Object.assign(new Error(stack.error || 'Stack directory not found'), { status: 404 });
	return { root: stack.stackDir, source, remote };
}

function failure(error: unknown) {
	const status = typeof error === 'object' && error && 'status' in error ? Number(error.status) : 400;
	return json({ error: error instanceof Error ? error.message : 'Workspace operation failed' }, { status });
}

async function gitDetails(root: string, source: Awaited<ReturnType<typeof getStackSource>>, path: string) {
	if (source?.sourceType !== 'git' || !source.gitStack || !source.repository) return null;
	const top = await execGit(['rev-parse', '--show-toplevel'], root, process.env);
	if (top.code !== 0) throw new Error('Git checkout is unavailable');
	const repoRoot = top.stdout.trim();
	const repoPath = relative(repoRoot, await resolveWorkspacePath(root, path, { existing: false })).split('/').join('/');
	const trackedResult = await execGit(['ls-files', '--', repoPath], repoRoot, process.env);
	const tracked = trackedResult.code === 0 && trackedResult.stdout.trim().length > 0;
	const ignoredResult = tracked ? { code: 1 } : await execGit(['check-ignore', '--quiet', '--', repoPath], repoRoot, process.env);
	const statusResult = await execGit(['status', '--porcelain', '--untracked-files=all', '--', repoPath], repoRoot, process.env);
	const hasUntrackedChildren = statusResult.code === 0 && statusResult.stdout.split(/\r?\n/).some((line) => line.startsWith('??'));
	return { repoRoot, repoPath, tracked, ignored: ignoredResult.code === 0, mixed: tracked && hasUntrackedChildren };
}

async function convertToInternal(name: string, envId: number | undefined, root: string, source: NonNullable<Awaited<ReturnType<typeof getStackSource>>>, path: string, content: string) {
	if (!source.gitStack) throw new Error('Git stack metadata is unavailable');
	const gitStack = source.gitStack;
	const destination = await getStackDir(name, envId);
	if (destination === root) throw new Error('Stack is already internal');
	const composePaths = getStackComposePaths(gitStack);
	const composeDirectory = dirname(composePaths[0]);
	const localPath = (path: string) => composeDirectory === '.' ? path : relative(composeDirectory, path);
	await withInternalStackDirectory(root, destination, async () => {
		const target = await resolveWorkspacePath(destination, path);
		const temporary = `${target}.dockhand-${crypto.randomUUID()}.tmp`;
		try {
			await writeFile(temporary, content, { encoding: 'utf8', mode: 0o640 });
			await rename(temporary, target);
		} finally { await rm(temporary, { force: true }); }
		if (!await updateStackSource(name, envId ?? null, {
			sourceType: 'internal',
			gitRepositoryId: null,
			gitStackId: null,
			composePath: join(destination, localPath(gitStack.composePath)),
			composePaths: composePaths.map((path) => join(destination, localPath(path))),
			envPath: gitStack.envFilePath ? join(destination, localPath(gitStack.envFilePath)) : null,
			workspaceEnabled: true
		})) throw new Error('Stack source not found');
	});
	await deleteGitStack(gitStack.id);
	unregisterScheduleByFamily(gitStack.id);
}

export const GET: RequestHandler = async ({ params, url, cookies }) => {
	try {
		const { root, source, remote } = await context(params.name, url, cookies, 'view');
		const path = normalizeWorkspacePath(url.searchParams.get('path') ?? '', true);
		if (url.searchParams.get('content') !== '1') {
			if (remote) {
				const entries = (await remote.list(path)).filter((entry) => !STACK_WORKSPACE_HIDDEN.has(entry.path.split('/').at(-1)!)).map((entry) => ({
					...entry, name: entry.path.split('/').at(-1)!, size: entry.size ?? 0
				}));
				if (source?.sourceType !== 'git') return json({ entries });
				const tracked = (await listWorkspace(root, path).catch(() => []))
					.map(async (entry) => ({ ...entry, git: await gitDetails(root, source, entry.path) }));
				const trackedEntries = (await Promise.all(tracked)).filter((entry) => entry.git?.tracked);
				type Listed = (typeof entries)[number] & { git: { tracked: boolean; ignored: boolean } | null };
				const byPath = new Map<string, Listed>(entries.map((entry) => [entry.path, { ...entry, git: { tracked: false, ignored: true } }]));
				for (const entry of trackedEntries) byPath.set(entry.path, entry);
				return json({ entries: [...byPath.values()].sort((a, b) => Number(a.type === 'file') - Number(b.type === 'file') || a.name.localeCompare(b.name)) });
			}
			const entries = await listWorkspace(root, path);
			return json({ entries: await Promise.all(entries.map(async (entry) => ({
				...entry, git: await gitDetails(root, source, entry.path)
			}))) });
		}
		const git = source?.sourceType === 'git' ? await gitDetails(root, source, path) : null;
		const readRemote = !!remote && !git?.tracked;
		const file = readRemote ? await remote!.read(path) : null;
		const content = file ? Buffer.from(file.content) : await readFile(await resolveWorkspacePath(root, path));
		if (content.byteLength > MAX_STACK_WORKSPACE_TEXT_SIZE) return json({ binary: true, size: content.byteLength });
		if (isBinaryWorkspaceContent(content)) return json({ binary: true, size: content.byteLength });
		return json({ binary: false, content: new TextDecoder().decode(content), size: content.byteLength, revision: file?.revision ?? workspaceRevision(content), git: git ? { tracked: git.tracked, ignored: git.ignored } : null });
	} catch (error) { return failure(error); }
};

export const POST: RequestHandler = async ({ params, url, cookies, request }) => {
	try {
		let { root, remote } = await context(params.name, url, cookies, 'edit');
		const contentType = request.headers.get('content-type') ?? '';
		if (contentType.includes('multipart/form-data')) {
			const form = await request.formData();
			const file = form.get('file');
			const path = normalizeWorkspacePath(form.get('path'));
			if (!(file instanceof File)) throw new Error('Upload file is required');
			if (file.size > MAX_STACK_WORKSPACE_TEXT_SIZE) throw new Error('Uploaded file exceeds the 10 MiB workspace limit');
			if (remote) {
				await remote.write(path, Buffer.from(await file.arrayBuffer()));
				return json({ success: true });
			}
			const target = await resolveWorkspacePath(root, path, { existing: false });
			await mkdir(dirname(target), { recursive: true });
			await writeFile(target, Buffer.from(await file.arrayBuffer()), { flag: 'wx', mode: 0o640 });
			return json({ success: true });
		}
		const body = await request.json();
		if (typeof body.workspaceEnabled === 'boolean') {
			const rawEnv = url.searchParams.get('env');
			if (!await updateStackSource(params.name, rawEnv ? Number.parseInt(rawEnv) : null, { workspaceEnabled: body.workspaceEnabled })) throw Object.assign(new Error('Stack source not found'), { status: 404 });
			return json({ success: true });
		}
		if (remote) {
			const path = normalizeWorkspacePath(body.path);
			if (body.type === 'directory') await remote.mkdir(path);
			else if (body.type === 'file') await remote.write(path, Buffer.alloc(0));
			else throw new Error('Type must be file or directory');
			return json({ success: true });
		}
		const target = await resolveWorkspacePath(root, body.path, { existing: false });
		if (body.type === 'directory') await mkdir(target, { recursive: false, mode: 0o750 });
		else if (body.type === 'file') await writeFile(target, '', { flag: 'wx', mode: 0o640 });
		else throw new Error('Type must be file or directory');
		return json({ success: true });
	} catch (error) { return failure(error); }
};

export const PUT: RequestHandler = async ({ params, url, cookies, request }) => {
	try {
		const { root, source: stackSource, remote } = await context(params.name, url, cookies, 'edit');
		const body = await request.json();
		if (typeof body.workspaceEnabled === 'boolean') {
			const rawEnv = url.searchParams.get('env');
			if (!await updateStackSource(params.name, rawEnv ? Number.parseInt(rawEnv) : null, { workspaceEnabled: body.workspaceEnabled })) throw Object.assign(new Error('Stack source not found'), { status: 404 });
			return json({ success: true });
		}
		const source = remote ? normalizeWorkspacePath(body.path) : await resolveWorkspacePath(root, body.path);
		if (typeof body.content === 'string') {
			if (Buffer.byteLength(body.content) > MAX_STACK_WORKSPACE_TEXT_SIZE || body.content.includes('\0')) throw new Error('Invalid or oversized text content');
			if (!remote && typeof body.expectedRevision === 'string' && workspaceRevision(await readFile(source)) !== body.expectedRevision) throw Object.assign(new Error('File changed since it was opened; reload it and try again'), { status: 409 });
			const git = await gitDetails(root, stackSource, body.path);
			if (git && body.gitDecision === 'push') {
				const credential = stackSource?.repository?.credentialId ? (await getGitCredentials()).find((item) => item.id === stackSource?.repository?.credentialId) ?? null : null;
				await mutateGitStackFiles({
					repositoryId: stackSource!.repository!.id,
					repoPath: git.repoRoot,
					branch: stackSource!.gitStack!.branch || stackSource!.repository!.branch,
					credential,
					changes: [{ path: git.repoPath, content: body.content, expectedRevision: body.expectedRevision }],
					trackedDecision: 'commit',
					untrackedDecision: 'add',
					commitMessage: typeof body.commitMessage === 'string' ? body.commitMessage : `Update ${body.path}`,
					expectedClassifications: [{ path: git.repoPath, tracked: git.tracked, ignored: git.ignored }]
				});
				return json({ success: true });
			}
			if (remote) {
				if (git?.tracked && body.gitDecision === 'internal') {
					if (!stackSource?.gitStack) throw new Error('Git stack metadata is unavailable');
					if (typeof body.expectedRevision !== 'string' || workspaceRevision(await readFile(await resolveWorkspacePath(root, body.path))) !== body.expectedRevision) throw Object.assign(new Error('Git file changed since it was opened; reload it'), { status: 409 });
					await remote.write(source, Buffer.from(body.content), (await remote.stat(source)).revision);
					const binding = await remote.binding();
					const gitStack = stackSource.gitStack;
					const composeNames = getStackComposePaths(gitStack);
					const gitDir = dirname(composeNames[0]);
					const relGit = (path: string) => gitDir === '.' ? path : relative(gitDir, path);
					if (!await updateStackSource(params.name, rawEnvId(url) ?? null, {
						sourceType: 'internal', gitRepositoryId: null, gitStackId: null,
						composePath: join(binding.root, relGit(gitStack.composePath)),
						composePaths: composeNames.map((path) => join(binding.root, relGit(path))),
						envPath: gitStack.envFilePath ? join(binding.root, relGit(gitStack.envFilePath)) : null,
						fileLocation: 'hawser', workspaceEnabled: true
					})) throw new Error('Stack source not found');
					await deleteGitStack(gitStack.id);
					unregisterScheduleByFamily(gitStack.id);
					return json({ success: true });
				}
				if (git && body.gitDecision !== 'local') throw Object.assign(new Error('Choose whether to push this Git change or keep it local'), { status: 409 });
				if (typeof body.expectedRevision !== 'string') throw Object.assign(new Error('File revision is required; reopen it and try again'), { status: 409 });
				await remote.write(source, Buffer.from(body.content), git?.tracked ? (await remote.stat(source)).revision : body.expectedRevision);
				return json({ success: true });
			}
			if (git?.tracked && body.gitDecision === 'internal') {
				await convertToInternal(params.name, rawEnvId(url), root, stackSource!, body.path, body.content);
				return json({ success: true });
			} else if (git && body.gitDecision !== 'local') {
				throw Object.assign(new Error('Choose whether to push this Git change or keep it local'), { status: 409 });
			}
			if (git && !git.tracked) {
				// A host-local file must not dirty the tracked checkout or appear in a push.
				const ignorePath = join(git.repoRoot, '.git', 'info', 'exclude');
				const existing = await readFile(ignorePath, 'utf8').catch(() => '');
				if (!existing.split(/\r?\n/).includes(`/${git.repoPath}`)) await writeFile(ignorePath, `${existing}${existing && !existing.endsWith('\n') ? '\n' : ''}/${git.repoPath}\n`, 'utf8');
			}
			const temporary = `${source}.dockhand-${crypto.randomUUID()}.tmp`;
			await writeFile(temporary, body.content, { encoding: 'utf8', mode: 0o640 });
			await rename(temporary, source);
		} else if (typeof body.destination === 'string') {
			if (remote) {
				const path = normalizeWorkspacePath(body.path);
				const target = normalizeWorkspacePath(body.destination);
				const entry = await remote.stat(path);
				await remote.move(path, target, entry.revision);
				return json({ success: true });
			}
			const destination = await resolveWorkspacePath(root, body.destination, { existing: false });
			await mkdir(dirname(destination), { recursive: true });
			const handle = await open(destination, 'wx');
			await handle.close();
			await rm(destination);
			await rename(source, destination);
		} else throw new Error('Content or destination is required');
		return json({ success: true });
	} catch (error) { return failure(error); }
};

/** Scoped recursive delete: Hawser removes one revision-checked file or empty directory per call. */
async function removeRemoteTree(remote: HawserStackFileClient, path: string): Promise<void> {
	const entry = await remote.stat(path);
	if (entry.type === 'directory') {
		for (const child of await remote.list(path)) await removeRemoteTree(remote, child.path);
		await remote.delete(path);
	} else await remote.delete(path, entry.revision);
}

function rawEnvId(url: URL): number | undefined {
	const raw = url.searchParams.get('env');
	return raw ? Number.parseInt(raw) : undefined;
}

export const DELETE: RequestHandler = async ({ params, url, cookies, request }) => {
	try {
		const { root, remote } = await context(params.name, url, cookies, 'edit');
		const { path } = await request.json();
		if (remote) await removeRemoteTree(remote, normalizeWorkspacePath(path));
		else await rm(await resolveWorkspacePath(root, path), { recursive: true, force: false });
		return json({ success: true });
	} catch (error) { return failure(error); }
};
