import { dockerFetch } from './docker';
import { getEdgeAgentCapabilities } from './hawser';

export const STACK_DIR_ADOPTION_CAPABILITY = 'stack-dir-adoption';

export interface HawserComposePayload {
	operation: 'up';
	projectName: string;
	composeFile: string;
	composeFileName?: string;
	composeFileNames?: string[];
	envFileName?: string;
	files: Record<string, string>;
	envVars?: Record<string, string>;
	forceRecreate?: boolean;
	build?: boolean;
	noBuildCache?: boolean;
	pullPolicy?: string;
	registries?: Array<{ url: string; username: string; password: string }>;
	streamOutput?: boolean;
}

export interface HawserStackDirAdoptionRequest {
	adoptionId: string;
	projectName: string;
	sourceDir: string;
	sourceComposeFiles: string[];
	sourceEnvPath?: string | null;
	preservedEnvRelativePath?: string;
	preserveExistingEnv: boolean;
	explicitGitEnvRelativePath?: string | null;
	compose: HawserComposePayload;
}

export interface HawserStackDirAdoptionResult {
	success: boolean;
	adoptionId?: string;
	phase?: string;
	sameDirectory?: boolean;
	managedDirectory?: string;
	managedComposeFiles?: string[];
	managedEnvRelativePath?: string;
	output?: string;
	error?: string;
	exitCode?: number;
}

function parseResult(response: Response): Promise<HawserStackDirAdoptionResult> {
	return response.json().catch(() => ({ success: false, error: `Hawser returned HTTP ${response.status}` }));
}

export async function hawserSupportsStackDirAdoption(environmentId: number): Promise<boolean> {
	const edgeCaps = getEdgeAgentCapabilities(environmentId);
	if (edgeCaps.length > 0) return edgeCaps.includes(STACK_DIR_ADOPTION_CAPABILITY);
	try {
		const response = await dockerFetch('/_hawser/info', { method: 'GET' }, environmentId);
		if (!response.ok) return false;
		const info = await response.json() as { capabilities?: unknown };
		return Array.isArray(info.capabilities) && info.capabilities.includes(STACK_DIR_ADOPTION_CAPABILITY);
	} catch {
		return false;
	}
}

async function postAdoption<T extends object>(
	environmentId: number,
	path: string,
	body: T,
	onLine?: (line: string) => void
): Promise<HawserStackDirAdoptionResult> {
	const response = await dockerFetch(path, {
		method: 'POST',
		headers: { 'Content-Type': 'application/json' },
		body: JSON.stringify(body),
		onLine
	}, environmentId);
	const result = await parseResult(response);
	if (!response.ok && !result.error) result.error = `Hawser returned HTTP ${response.status}`;
	return result;
}

export function prepareHawserStackDirAdoption(
	environmentId: number,
	request: HawserStackDirAdoptionRequest,
	onLine?: (line: string) => void
): Promise<HawserStackDirAdoptionResult> {
	return postAdoption(environmentId, '/_hawser/stack-dir-adoption/prepare', request, onLine);
}

export function finalizeHawserStackDirAdoption(environmentId: number, adoptionId: string): Promise<HawserStackDirAdoptionResult> {
	return postAdoption(environmentId, '/_hawser/stack-dir-adoption/finalize', { adoptionId });
}

export function rollbackHawserStackDirAdoption(environmentId: number, adoptionId: string): Promise<HawserStackDirAdoptionResult> {
	return postAdoption(environmentId, '/_hawser/stack-dir-adoption/rollback', { adoptionId });
}
