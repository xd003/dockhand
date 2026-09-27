import { randomUUID } from 'node:crypto';
import { rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { getEnvironment } from './db';
import { runContainerWithStreaming } from './docker';
import { ensureHelperImage } from './backups/restic';
import { INSTANCE_LABEL } from './backups/reap-core';
import { getInstanceId } from './backups/identity';

/**
 * In-place deployment on a direct (TCP) Docker host is valid only when the daemon resolves
 * the selected directory to the same files Dockhand sees. Proves it by writing a one-off
 * marker from Dockhand and reading it back through a helper container bind-mounting the
 * same path on the Docker host. Returns an explanation when the requirement is not met.
 */
export async function checkDockerHostSharesProjectDir(projectDir: string, envId: number | null | undefined): Promise<string | null> {
	if (envId == null) return null;
	const environment = await getEnvironment(envId);
	if (environment?.connectionType !== 'direct') return null;
	const requirement = `In-place deployment on the remote Docker host "${environment.name}" requires ${projectDir} to be accessible to Dockhand and to resolve to the same files on the Docker host (for example, the same shared mount at the identical path). Dockhand does not copy the project to the Docker host`;
	const token = randomUUID();
	const marker = `.dockhand-host-check-${token}`;
	const markerPath = join(projectDir, marker);
	try {
		writeFileSync(markerPath, token, { flag: 'wx', mode: 0o644 });
	} catch (error) {
		return `${requirement}; Dockhand cannot write to the selected directory (${error instanceof Error ? error.message : String(error)}).`;
	}
	try {
		const stdout = await runContainerWithStreaming({
			image: await ensureHelperImage(envId),
			cmd: ['sh', '-c', `cat '/probe/${marker}' 2>/dev/null || true`],
			binds: [`${projectDir}:/probe:ro`],
			name: `dockhand-host-check-${Date.now()}`,
			labels: { [INSTANCE_LABEL]: await getInstanceId() },
			envId,
			timeout: 60_000
		});
		return stdout.trim() === token ? null : `${requirement}; the Docker host does not see Dockhand's check file there.`;
	} catch (error) {
		return `${requirement}; the Docker host check could not run (${error instanceof Error ? error.message : String(error)}).`;
	} finally {
		rmSync(markerPath, { force: true });
	}
}
