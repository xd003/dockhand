import type { JobLine } from '$lib/server/jobs';

/**
 * Reads a job-based response (POST returns { jobId }) and polls until complete.
 * Drop-in replacement for readSSEResponse when the endpoint has been migrated to jobs.
 *
 * Returns the job's final result (equivalent to the 'result' event data in SSE).
 * With onLine, each 'progress' line message ({type:'line', line}) is reported as it
 * arrives — callers that don't need live output can omit it.
 */
export async function readJobResponse(
	response: Response,
	onLine?: (line: string) => void
): Promise<{ success?: boolean; error?: string; [key: string]: unknown }> {
	// Fall through for non-JSON or error responses
	if (!response.ok) {
		try {
			return await response.json();
		} catch {
			return { success: false, error: `HTTP ${response.status}` };
		}
	}

	const data = await response.json();

	// If the response is a { jobId } shape, poll the job endpoint
	if (data && typeof data === 'object' && 'jobId' in data) {
		const result = await watchJob(data.jobId as string, (msg) => {
			if (!onLine) return;
			const payload = msg?.data as { type?: string; line?: string } | undefined;
			if (payload?.type === 'line' && typeof payload.line === 'string') onLine(payload.line);
		});
		return result as { success?: boolean; error?: string; [key: string]: unknown };
	}

	// Fallback: response was already the final result (e.g. application/json sync path)
	return data;
}

const POLL_INTERVAL_MS = 500;
// A single failed poll (reverse-proxy 502 while the server event loop is busy, a
// network blip) must not abandon a job that is still running server-side. Keep
// retrying transient failures until they persist this long without a success.
const TRANSIENT_FAILURE_GRACE_MS = 60_000;

/**
 * Polls /api/jobs/{jobId} every 500ms. Calls onLine for each new line as they arrive.
 * Resolves with the job's final result when status is 'done' or 'error'.
 * Transient poll failures are retried for up to TRANSIENT_FAILURE_GRACE_MS.
 */
export async function watchJob(
	jobId: string,
	onLine: (line: JobLine) => void
): Promise<unknown> {
	let cursor = 0;
	let failingSince: number | null = null;

	while (true) {
		let res: Response | null = null;
		let job: {
			id: string;
			status: 'running' | 'done' | 'error';
			lines: JobLine[];
			result: unknown;
		} | null = null;
		let failure: unknown = null;
		try {
			res = await fetch(`/api/jobs/${jobId}`);
			if (res.ok) job = await res.json();
		} catch (error) {
			failure = error;
		}
		if (!job) {
			// 5xx / 408 / 429 and network errors are retried; other statuses
			// (403, 404 = job gone, e.g. after a server restart) are final.
			const transient = !res || res.ok || res.status >= 500 || res.status === 408 || res.status === 429;
			const error = res && !res.ok ? new Error(`Job poll failed: HTTP ${res.status}`) : failure;
			failingSince ??= Date.now();
			if (!transient || Date.now() - failingSince >= TRANSIENT_FAILURE_GRACE_MS) throw error;
			await new Promise((resolve) => setTimeout(resolve, POLL_INTERVAL_MS * 2));
			continue;
		}
		failingSince = null;

		// Deliver new lines since last poll
		const newLines = job.lines.slice(cursor);
		cursor = job.lines.length;
		for (const line of newLines) {
			onLine(line);
		}

		if (job.status !== 'running') {
			return job.result;
		}

		await new Promise((resolve) => setTimeout(resolve, POLL_INTERVAL_MS));
	}
}
