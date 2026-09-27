import { json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { createHash } from 'node:crypto';
import { existsSync, lstatSync, readFileSync, realpathSync, statSync } from 'node:fs';
import { isAbsolute, relative, resolve, sep } from 'node:path';
import { authorize } from '$lib/server/authorize';
import { getGitCredential, getGitRepository } from '$lib/server/db';
import { classifyGitFiles } from '$lib/server/git-stack-files';
import { getPendingGitClonePath } from '$lib/server/git-stack';
import { getRepoPath } from '$lib/server/git';
import { resolveSafeGitFileTarget } from '$lib/server/git-url-safety';

const MAX_DRAFT_FILE_SIZE = 10 * 1024 * 1024;

function draftFileLanguage(path: string): string {
	const name = path.split('/').pop()?.toLowerCase() ?? '';
	if (name === 'dockerfile' || name.startsWith('dockerfile.')) return 'dockerfile';
	const extension = name.includes('.') ? name.slice(name.lastIndexOf('.') + 1) : '';
	return ({
		yml: 'yaml', yaml: 'yaml', json: 'json', json5: 'json', md: 'markdown', markdown: 'markdown',
		css: 'css', scss: 'css', html: 'html', htm: 'html', xml: 'xml', sh: 'shell', bash: 'shell',
		py: 'python', sql: 'sql', js: 'javascript', mjs: 'javascript', cjs: 'javascript', ts: 'javascript',
		toml: 'toml', ini: 'ini', conf: 'ini', properties: 'properties', env: 'dotenv'
	} as Record<string, string>)[extension] ?? 'text';
}

function normalizeDraftPath(value: string): string {
	if (!value || isAbsolute(value) || value.includes('\\')) throw new Error('Draft file path must be a relative POSIX path');
	const parts = value.split('/');
	if (parts.some((part) => !part || part === '.' || part === '..')) throw new Error('Draft file path cannot contain empty, ".", or ".." segments');
	if (parts[0] === '.git' || parts.includes('.dockhand-pending-clone.json')) throw new Error('Protected Git paths cannot be read');
	return parts.join('/');
}

function readDraftFile(root: string, path: string): string {
	const target = resolveSafeGitFileTarget(root, path);
	if (!existsSync(target)) throw new Error(`Draft file not found: ${path}`);
	if (!lstatSync(target).isFile() || statSync(target).isSymbolicLink()) throw new Error(`Draft path is not a regular file: ${path}`);
	const realRoot = realpathSync(root);
	const realTarget = realpathSync(target);
	const rel = relative(realRoot, realTarget);
	if (rel.startsWith(`..${sep}`) || rel === '..' || isAbsolute(rel)) throw new Error('Draft file path escapes the repository');
	const bytes = readFileSync(target);
	if (bytes.byteLength > MAX_DRAFT_FILE_SIZE) throw new Error(`Draft file exceeds the ${MAX_DRAFT_FILE_SIZE} byte limit`);
	let content: string;
	try {
		content = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
	} catch {
		throw new Error('Draft files must contain valid UTF-8 text');
	}
	if (content.includes('\0')) throw new Error('Draft files must contain text, not binary data');
	return content;
}

function draftFileRevision(content: string): string {
	return createHash('sha256').update(content, 'utf8').digest('hex');
}

/** Read selected files from an authorized, repository-bound pending checkout. */
export const GET: RequestHandler = async ({ params, url, cookies }) => {
	const auth = await authorize(cookies);
	if (auth.authEnabled && !await auth.can('git', 'view')) return json({ error: 'Permission denied' }, { status: 403 });
	const repositoryId = Number(params.id);
	if (!Number.isInteger(repositoryId)) return json({ error: 'Invalid repository ID' }, { status: 400 });
	const repository = await getGitRepository(repositoryId);
	if (!repository) return json({ error: 'Repository not found' }, { status: 404 });
	const useSharedCheckout = url.searchParams.get('shared') === '1';
	const token = url.searchParams.get('token') || url.searchParams.get('pending');
	if (!useSharedCheckout && !token) return json({ error: 'Pending checkout token is required' }, { status: 400 });
	const root = useSharedCheckout ? getRepoPath(repository.name) : getPendingGitClonePath(token!, repositoryId);
	if (!root || !existsSync(root)) return json({ error: useSharedCheckout ? 'Shared repository checkout not found' : 'Pending repository checkout not found or expired' }, { status: 404 });
	const rawPaths = [...url.searchParams.getAll('path'), ...url.searchParams.getAll('paths').flatMap((value) => value.split(','))];
	if (rawPaths.length === 0) return json({ error: 'At least one draft file path is required' }, { status: 400 });
	try {
		const paths = [...new Set(rawPaths.map(normalizeDraftPath))];
		const credential = repository.credentialId ? await getGitCredential(repository.credentialId) : null;
		const classifications = await classifyGitFiles(root, paths, credential);
		const classificationByPath = new Map(classifications.map((entry) => [entry.path, entry]));
		const entries = paths.map((path) => {
			const content = readDraftFile(root, path);
			const classification = classificationByPath.get(path);
			return {
				path,
				name: path.split('/').pop() ?? path,
				kind: 'compose' as const,
				content,
				language: draftFileLanguage(path),
				ownership: 'git' as const,
				tracked: classification?.tracked === true,
				ignored: classification?.ignored === true,
				revision: draftFileRevision(content)
			};
		});
		return json({ root: '', commit: undefined, entries, composeContents: Object.fromEntries(entries.map((entry) => [entry.path, entry.content])) });
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		return json({ error: message }, { status: /not found/i.test(message) ? 404 : 400 });
	}
};
