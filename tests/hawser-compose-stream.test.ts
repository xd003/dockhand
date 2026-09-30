import { describe, expect, test } from 'bun:test';
import { decodeHawserComposeStream } from '../src/lib/server/hawser-compose-stream.js';

/** A response whose NDJSON body arrives in the given raw chunks. */
function ndjson(chunks: string[]): Response {
	const encoder = new TextEncoder();
	const body = new ReadableStream<Uint8Array>({
		start(controller) {
			for (const chunk of chunks) controller.enqueue(encoder.encode(chunk));
			controller.close();
		}
	});
	return new Response(body, { headers: { 'Content-Type': 'application/x-ndjson' } });
}

describe('decodeHawserComposeStream', () => {
	test('forwards lines split across chunks and returns the final result with its status', async () => {
		const lines: string[] = [];
		const response = await decodeHawserComposeStream(ndjson([
			'{"type":"line","line":"#1 [build 1/2] FR',
			'OM alpine"}\n{"type":"line"}\n{"type":"line","line":"ok"}\n',
			'{"type":"result","status":500,"result":{"success":false,"error":"build failed"}}\n'
		]), (line) => lines.push(line));
		expect(lines).toEqual(['#1 [build 1/2] FROM alpine', '', 'ok']);
		expect(response.status).toBe(500);
		expect(await response.json()).toEqual({ success: false, error: 'build failed' });
	});

	test('passes an older agent\'s single JSON body through untouched', async () => {
		const original = new Response('{"success":true}', { headers: { 'Content-Type': 'application/json' } });
		const lines: string[] = [];
		expect(await decodeHawserComposeStream(original, (line) => lines.push(line))).toBe(original);
		expect(lines).toEqual([]);
	});

	test('rejects a stream cut off before the result frame', async () => {
		await expect(decodeHawserComposeStream(ndjson(['{"type":"line","line":"x"}\n']), () => {})).rejects.toThrow('without a result');
	});
});
