/**
 * Production wiring for the Hawser stack-file cutover (see the -core module
 * for the journaled remote-wins algorithm).
 */
import { dockerFetch, listContainers } from './docker.js';
import { getEnvironment, getStackSource, getStackSources, updateStackSource } from './db.js';
import { hawserStackFiles } from './hawser-stack-files.js';
import { getEdgeAgentCapabilities, getEdgeConnectionInfo } from './hawser.js';
import {
	ensureHawserStackFilesReady as ensureWith, findJournals, migrateHawserStackFiles as migrateWith,
	type HawserMigrationResult, type HawserMigrationServices
} from './hawser-stack-file-migration-core.js';

export type { HawserMigrationResult, HawserMigrationServices } from './hawser-stack-file-migration-core.js';

async function composeLabels(environmentId: number, stackName: string): Promise<{ root: string; files: string[] } | null> {
	const containers = await listContainers(true, environmentId);
	const labels = containers.find(c => c.labels?.['com.docker.compose.project'] === stackName)?.labels;
	const root = labels?.['com.docker.compose.project.working_dir'];
	const raw = labels?.['com.docker.compose.project.config_files'];
	return root && raw ? { root, files: raw.split(',').map(f => f.trim()) } : null;
}

export async function agentStacksDir(environmentId: number, edge: boolean): Promise<string> {
	if (edge) {
		const root = getEdgeConnectionInfo(environmentId)?.stacksDir;
		if (!root) throw new Error('Hawser Edge did not advertise STACKS_DIR; upgrade the agent');
		return root;
	}
	const response = await dockerFetch('/_hawser/info', {}, environmentId);
	if (!response.ok) throw new Error(`Hawser info unavailable (${response.status})`);
	const info = await response.json() as { stacksDir?: string };
	if (!info.stacksDir) throw new Error('Hawser did not advertise STACKS_DIR; upgrade the agent');
	return info.stacksDir;
}
export const productionServices: HawserMigrationServices = {
	environment: getEnvironment,
	source: getStackSource,
	update: updateStackSource,
	client: hawserStackFiles,
	labels: composeLabels,
	stacksDir: agentStacksDir
};


export function migrateHawserStackFiles(environmentId: number, stackName: string, services: HawserMigrationServices = productionServices): Promise<HawserMigrationResult | null> {
	return migrateWith(environmentId, stackName, services);
}

/** Shared per-stack barrier for migration, file operations and deployment. */
export function ensureHawserStackFilesReady(stackName: string, environmentId: number, services: HawserMigrationServices = productionServices): Promise<void> {
	return ensureWith(stackName, environmentId, services);
}

/** Best-effort reconnection pass; blocked stacks remain pending and retry on operation/probe. */
export function scheduleHawserStackFileMigrations(environmentId: number): void {
	void (async () => {
		const environment = await getEnvironment(environmentId);
		if (environment?.connectionType !== 'hawser-edge' && environment?.connectionType !== 'hawser-standard') return;
		if (environment.connectionType === 'hawser-edge' && !getEdgeAgentCapabilities(environmentId).includes('stack-files-v1')) return;
		for (const source of await getStackSources(environmentId)) {
			if (source.fileLocation !== 'dockhand' && findJournals(environmentId, source.stackName).length === 0) continue;
			try { await ensureHawserStackFilesReady(source.stackName, environmentId); }
			catch (error) { console.warn(`[Hawser migration] ${source.stackName} env=${environmentId}: ${error instanceof Error ? error.message : String(error)}`); }
		}
	})().catch(error => console.warn(`[Hawser migration] env=${environmentId}: ${error instanceof Error ? error.message : String(error)}`));
}
