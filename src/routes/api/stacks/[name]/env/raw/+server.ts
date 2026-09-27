import { json } from '@sveltejs/kit';
import { findStackDir, getStackComposeFile, hawserRelativeFilePath } from '$lib/server/stacks';
import { getStackSource, getEnvironment } from '$lib/server/db';
import { authorize } from '$lib/server/authorize';
import { existsSync, rmSync, readFileSync, writeFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import type { RequestHandler } from './$types';
import { hawserStackFiles } from '$lib/server/hawser-stack-files';
import { ensureHawserStackFilesReady } from '$lib/server/hawser-stack-file-migration';

async function remoteEnv(name: string, envId: number | null) {
	const source = await getStackSource(name, envId);
	if (!source || envId == null) return null;
	const env = await getEnvironment(envId);
	if (env?.connectionType !== 'hawser-standard' && env?.connectionType !== 'hawser-edge') return null;
	await ensureHawserStackFilesReady(name, envId);
	const files = await hawserStackFiles(envId, name);
	const { root } = await files.binding();
	const current = await getStackSource(name, envId);
	return { files, root, path: current?.envPath || join(dirname(current?.composePath || join(root, 'compose.yaml')), '.env'), noEnvFile: current?.envPath === '' };
}

async function resolveEnvFilePath(stackName: string, envId: number | null): Promise<{ path: string | null; noEnvFile: boolean }> {
	const source = await getStackSource(stackName, envId);

	if (source?.envPath === '') return { path: null, noEnvFile: true };
	if (source?.envPath) return { path: source.envPath, noEnvFile: false };

	// This resolver converts Git's repository-relative compose paths into paths
	// in the copied stack directory. Older stack_sources rows may be relative too.
	const composeResult = await getStackComposeFile(stackName, envId ?? undefined);
	if (composeResult.success && composeResult.composePath) {
		return { path: join(dirname(composeResult.composePath), '.env'), noEnvFile: false };
	}

	const stackDir = await findStackDir(stackName, envId);
	return { path: stackDir ? join(stackDir, '.env') : null, noEnvFile: false };
}

/**
 * GET /api/stacks/[name]/env/raw?env=X
 *
 * @openapi
 * summary: Get the raw .env file content as-is (comments and formatting preserved) for a stack
 * path: name:string! Stack name (from GET /api/stacks)
 * query: env:integer Environment ID the stack belongs to (from GET /api/environments)
 * resp-200: {content:string!, noEnvFile:boolean}
 * resp-200-example: {"content":"FOO=bar\n# comment\nBAZ=qux\n"}
 * resp-403: Permission denied (requires stacks:view, or environment access denied on enterprise)
 * resp-503: Env file could not be read (e.g. the Hawser agent is offline, must be upgraded, or migration is pending); agent 4xx statuses are passed through
 */
export const GET: RequestHandler = async ({ params, url, cookies }) => {
	const auth = await authorize(cookies);
	const envId = url.searchParams.get('env');
	const envIdNum = envId ? parseInt(envId) : null;

	// Permission check with environment context
	if (auth.authEnabled && !await auth.can('stacks', 'view', envIdNum ?? undefined)) {
		return json({ error: 'Permission denied' }, { status: 403 });
	}

	// Environment access check (enterprise only)
	if (envIdNum && auth.isEnterprise && !await auth.canAccessEnvironment(envIdNum)) {
		return json({ error: 'Access denied to this environment' }, { status: 403 });
	}

	try {
		const stackName = decodeURIComponent(params.name);
		const remote = await remoteEnv(stackName, envIdNum);
		if (remote) {
			if (remote.noEnvFile) return json({ content: '', noEnvFile: true });
			try {
				const file = await remote.files.read(hawserRelativeFilePath(remote.root, remote.path));
				return json({ content: new TextDecoder().decode(file.content), revision: file.revision });
			} catch (error) {
				if (error && typeof error === 'object' && 'status' in error && error.status === 404) return json({ content: '' });
				throw error;
			}
		}

		const { path: envFilePath, noEnvFile } = await resolveEnvFilePath(stackName, envIdNum);
		if (noEnvFile) {
			return json({ content: '', noEnvFile: true });
		}

		let content = '';
		if (envFilePath && existsSync(envFilePath)) {
			try {
				content = readFileSync(envFilePath, 'utf-8');
			} catch {
				// File read failed
			}
		}

		return json({ content });
	} catch (error) {
		console.error('Error getting raw env file:', error);
		const agentStatus = error && typeof error === 'object' && 'status' in error && typeof error.status === 'number' ? error.status : null;
		if (agentStatus) return json({ error: error instanceof Error ? error.message : 'Failed to get environment file' }, { status: agentStatus });
		return json({ error: error instanceof Error ? error.message : 'Failed to get environment file' }, { status: 503 });
	}
};

/**
 * PUT /api/stacks/[name]/env/raw?env=X
 *
 * @openapi
 * summary: Write raw .env file content for a stack (to the Hawser agent's stack directory on Hawser environments); empty content deletes the .env file, and masked "***" placeholders are rejected to avoid corrupting secrets
 * path: name:string! Stack name (from GET /api/stacks)
 * query: env:integer Environment ID the stack belongs to (from GET /api/environments)
 * body: {content:string!}
 * body-example: {"content":"FOO=bar\nBAZ=qux\n"}
 * resp-200: {success:boolean!, noEnvFile:boolean, deleted:boolean}
 * resp-200-example: {"success":true}
 * resp-400: Invalid body (content string required) or refusal to write a masked "***" placeholder
 * resp-403: Permission denied (requires stacks:edit, or environment access denied on enterprise)
 * resp-503: Env file could not be written (e.g. the Hawser agent is offline or must be upgraded); a stale revision returns the agent's 409
 */
export const PUT: RequestHandler = async ({ params, url, cookies, request }) => {
	const auth = await authorize(cookies);
	const envId = url.searchParams.get('env');
	const envIdNum = envId ? parseInt(envId) : null;

	// Permission check with environment context
	if (auth.authEnabled && !await auth.can('stacks', 'edit', envIdNum ?? undefined)) {
		return json({ error: 'Permission denied' }, { status: 403 });
	}

	// Environment access check (enterprise only)
	if (envIdNum && auth.isEnterprise && !await auth.canAccessEnvironment(envIdNum)) {
		return json({ error: 'Access denied to this environment' }, { status: 403 });
	}

	try {
		const stackName = decodeURIComponent(params.name);
		const body = await request.json();
		if (typeof body.content !== 'string') return json({ error: 'Invalid request body: content string required' }, { status: 400 });
		const remote = await remoteEnv(stackName, envIdNum);
		if (remote) {
			if (remote.noEnvFile) return json({ success: true, noEnvFile: true });
			if (body.content.match(/^[A-Za-z_][A-Za-z0-9_]*=\*\*\*$/m)) return json({ error: 'Cannot write masked placeholder "***" to .env file' }, { status: 400 });
			const path = hawserRelativeFilePath(remote.root, remote.path);
			let revision: string | undefined;
			try { revision = (await remote.files.stat(path)).revision; }
			catch (error) {
				if (!(error && typeof error === 'object' && 'status' in error && error.status === 404)) throw error;
			}
			if (!body.content.trim()) {
				if (revision) await remote.files.delete(path, revision);
				return json({ success: true, deleted: !!revision });
			}
			await remote.files.write(path, Buffer.from(body.content.endsWith('\n') ? body.content : `${body.content}\n`), revision);
			return json({ success: true });
		}

		if (typeof body.content !== 'string') {
			return json({ error: 'Invalid request body: content string required' }, { status: 400 });
		}

		const { path: envFilePath, noEnvFile } = await resolveEnvFilePath(stackName, envIdNum);
		if (noEnvFile) {
			return json({ success: true, noEnvFile: true });
		}

		// Only write if we have a valid path
		if (!envFilePath) {
			return json({ success: true });
		}

		let content = body.content;

		// If content is empty, delete the .env file instead of writing empty file
		if (!content || !content.trim()) {
			if (existsSync(envFilePath)) {
				rmSync(envFilePath);
				return json({ success: true, deleted: true });
			}
			return json({ success: true });
		}

		// Guard against writing masked secret placeholders (would corrupt the file)
		if (content.match(/^[A-Za-z_][A-Za-z0-9_]*=\*\*\*$/m)) {
			return json({
				error: 'Cannot write masked placeholder "***" to .env file - this would corrupt secret values'
			}, { status: 400 });
		}

		// Ensure content ends with newline
		if (!content.endsWith('\n')) {
			content += '\n';
		}

		writeFileSync(envFilePath, content);

		return json({ success: true });
	} catch (error) {
		console.error('Error saving raw env file:', error);
		const agentStatus = error && typeof error === 'object' && 'status' in error && typeof error.status === 'number' ? error.status : null;
		if (agentStatus) return json({ error: error instanceof Error ? error.message : 'Failed to save environment file' }, { status: agentStatus });
		return json({ error: error instanceof Error ? error.message : 'Failed to save environment file' }, { status: 503 });
	}
};
