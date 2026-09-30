/**
 * Hawser Standard streams /_hawser/compose as NDJSON when asked with this header:
 * `{"type":"line","line":…}` per output line, then one
 * `{"type":"result","status":…,"result":{…}}`. An agent that predates it ignores
 * the header and answers with the single JSON body, which passes through untouched.
 */
export const HAWSER_COMPOSE_STREAM_HEADER = 'X-Hawser-Stream-Output';

type Frame = { type?: string; line?: string; status?: number; result?: unknown };

/** Forward every line frame to onLine and resolve to the equivalent non-streaming response. */
export async function decodeHawserComposeStream(response: Response, onLine: (line: string) => void): Promise<Response> {
	if (!response.headers.get('content-type')?.startsWith('application/x-ndjson') || !response.body) return response;
	const reader = response.body.pipeThrough(new TextDecoderStream()).getReader();
	let pending = '';
	let final: Frame | null = null;
	const handle = (text: string) => {
		if (!text.trim()) return;
		const frame = JSON.parse(text) as Frame;
		if (frame.type === 'line') onLine(frame.line ?? '');
		else if (frame.type === 'result') final = frame;
	};
	for (;;) {
		const { value, done } = await reader.read();
		if (done) break;
		pending += value;
		let newline: number;
		while ((newline = pending.indexOf('\n')) !== -1) {
			handle(pending.slice(0, newline));
			pending = pending.slice(newline + 1);
		}
	}
	handle(pending);
	const result = final as Frame | null;
	if (!result?.result) throw new Error('Hawser compose stream ended without a result');
	return new Response(JSON.stringify(result.result), {
		status: result.status ?? 200,
		headers: { 'Content-Type': 'application/json' }
	});
}
