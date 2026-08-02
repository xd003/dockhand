import crypto from 'node:crypto';

/**
 * Verify a git webhook signature against the configured secret.
 *
 * Two provider families share these two wire formats:
 * - GitHub / Gitea / Forgejo send `X-Hub-Signature-256: sha256=<hmac>` where the
 *   hmac is HMAC-SHA256 of the raw request body keyed by the secret.
 * - GitLab sends `X-Gitlab-Token: <secret>` as a plain token compared for equality.
 *
 * The caller passes whichever header value is present as `signature`.
 */
export function verifyWebhookSignature(payload: string, signature: string | null, secret: string): boolean {
	if (!signature) return false;

	if (signature.startsWith('sha256=')) {
		const expectedSignature = 'sha256=' + crypto
			.createHmac('sha256', secret)
			.update(payload)
			.digest('hex');
		const sigBuf = Buffer.from(signature);
		const expectedBuf = Buffer.from(expectedSignature);
		if (sigBuf.length !== expectedBuf.length) return false;
		return crypto.timingSafeEqual(sigBuf, expectedBuf);
	}

	// GitLab token: exact match, constant-time.
	const sigBuf = Buffer.from(signature);
	const secretBuf = Buffer.from(secret);
	if (sigBuf.length !== secretBuf.length) return false;
	return crypto.timingSafeEqual(sigBuf, secretBuf);
}

/**
 * Verify a time-windowed HMAC signature for GET webhook triggers.
 * Signature is hex HMAC-SHA256 of the unix-seconds timestamp keyed by the
 * secret, so the secret never travels in the URL (replaces ?secret=).
 */
export function verifyQuerySignature(secret: string, ts: string, sig: string | null): boolean {
	if (!sig) return false;

	const tsNum = Number(ts);
	if (!Number.isFinite(tsNum) || !/^\d+$/.test(ts)) return false;
	const ageSec = Math.abs(Date.now() / 1000 - tsNum);
	if (ageSec > 300) return false; // reject stale/replayed signatures

	const expected = crypto.createHmac('sha256', secret).update(ts).digest('hex');
	const sigBuf = Buffer.from(sig);
	const expectedBuf = Buffer.from(expected);
	if (sigBuf.length !== expectedBuf.length) return false;
	return crypto.timingSafeEqual(sigBuf, expectedBuf);
}
