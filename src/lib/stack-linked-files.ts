import { createHash } from 'node:crypto';

export const LINKED_FILES_VERSION = 1;
export const MAX_LINKED_FILE_SIZE = 10 * 1024 * 1024;

export type LinkedFileOwnership = 'local' | 'git';
export type LinkedFileAction = 'none' | 'restart' | 'ordered' | 'recreate';
export type LinkedFileTarget = 'stack' | 'services';

export interface LinkedFilePostChange {
	action: LinkedFileAction;
	target: LinkedFileTarget;
	services: string[];
}

export interface LinkedStackFile {
	path: string;
	ownership: LinkedFileOwnership;
	postChange: LinkedFilePostChange;
}

export interface LinkedFilesDocument {
	version: typeof LINKED_FILES_VERSION;
	files: LinkedStackFile[];
}

export function defaultLinkedFilePostChange(): LinkedFilePostChange {
	return { action: 'none', target: 'stack', services: [] };
}

/** Normalize a client path without ever resolving it against a host path. */
export function normalizeLinkedPath(value: unknown): string {
	if (typeof value !== 'string' || value.length === 0 || value.includes('\0')) {
		throw new Error('Linked file path must be a non-empty relative path');
	}
	if (value.startsWith('/') || /^[A-Za-z]:[\\/]/.test(value) || value.includes('\\')) {
		throw new Error('Linked file path must use a relative POSIX path');
	}

	const segments = value.split('/');
	if (segments.some((segment) => segment === '' || segment === '.' || segment === '..')) {
		throw new Error('Linked file path cannot contain empty, ".", or ".." segments');
	}
	return segments.join('/');
}

function normalizeServices(value: unknown): string[] {
	if (!Array.isArray(value) || value.some((service) => typeof service !== 'string')) {
		throw new Error('Selected services must be an array of names');
	}
	const services = value.map((service) => service.trim());
	if (services.some((service) => !service || service.includes('\0') || /[\s/]/.test(service))) {
		throw new Error('Selected services must contain non-empty service names');
	}
	const unique = [...new Set(services)];
	if (unique.length !== services.length) throw new Error('Selected services must be unique');
	return unique.sort();
}

export function normalizePostChangePolicy(value: unknown): LinkedFilePostChange {
	if (!value || typeof value !== 'object') throw new Error('Post-change policy is required');
	const policy = value as Record<string, unknown>;
	const action = policy.action;
	const target = policy.target;
	if (!['none', 'restart', 'ordered', 'recreate'].includes(String(action))) {
		throw new Error('Invalid linked file post-change action');
	}
	if (target !== 'stack' && target !== 'services') throw new Error('Invalid linked file post-change target');
	const services = normalizeServices(policy.services ?? []);

	if (target === 'stack' && services.length > 0) {
		throw new Error('Whole-stack actions cannot specify services');
	}
	if (target === 'services' && (action === 'none' || action === 'ordered' || services.length === 0)) {
		throw new Error('Selected-service actions require restart or recreate and at least one service');
	}
	return { action: action as LinkedFileAction, target, services };
}

export function normalizeLinkedFile(value: unknown): LinkedStackFile {
	if (!value || typeof value !== 'object') throw new Error('Linked file metadata is required');
	const file = value as Record<string, unknown>;
	const ownership = file.ownership;
	if (ownership !== 'local' && ownership !== 'git') throw new Error('Invalid linked file ownership');
	return {
		path: normalizeLinkedPath(file.path),
		ownership,
		postChange: normalizePostChangePolicy(file.postChange)
	};
}

/** Validate and canonicalize an ordered linked-file set. */
export function normalizeLinkedFiles(
	value: unknown,
	options: { reservedPaths?: Iterable<string>; forceLocalOwnership?: boolean } = {}
): LinkedStackFile[] {
	if (!Array.isArray(value)) throw new Error('Linked files must be an array');
	const reserved = new Set<string>();
	for (const path of options.reservedPaths ?? []) reserved.add(normalizeLinkedPath(path));
	const seen = new Set<string>();
	const folded = new Set<string>();
	return value.map((entry) => {
		const file = normalizeLinkedFile(entry);
		const foldedPath = file.path.toLocaleLowerCase();
		if (reserved.has(file.path)) throw new Error(`Linked file duplicates a configured Compose or environment file: ${file.path}`);
		if (seen.has(file.path)) throw new Error(`Duplicate linked file: ${file.path}`);
		if (folded.has(foldedPath)) throw new Error(`Case-colliding linked file: ${file.path}`);
		seen.add(file.path);
		folded.add(foldedPath);
		if (options.forceLocalOwnership) file.ownership = 'local';
		return file;
	});
}

export function serializeLinkedFiles(files: LinkedStackFile[]): string {
	return JSON.stringify({ version: LINKED_FILES_VERSION, files: normalizeLinkedFiles(files) });
}

/** Reads tolerate null, legacy arrays, and corrupt old rows; client writes use strict parsing. */
export function parseLinkedFiles(value: string | null | undefined): LinkedStackFile[] {
	if (!value) return [];
	try {
		const parsed: unknown = JSON.parse(value);
		const entries = Array.isArray(parsed)
			? parsed
			: parsed && typeof parsed === 'object' && (parsed as Record<string, unknown>).version === LINKED_FILES_VERSION
				? (parsed as Record<string, unknown>).files
				: undefined;
		return entries === undefined ? [] : normalizeLinkedFiles(entries);
	} catch {
		return [];
	}
}

export function parseLinkedFilesUpdate(value: unknown): LinkedStackFile[] {
	return normalizeLinkedFiles(value);
}

export function linkedFileRevision(content: string): string {
	return createHash('sha256').update(content, 'utf8').digest('hex');
}

export function linkedFileLanguage(path: string): string {
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
