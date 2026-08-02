import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import crypto from 'node:crypto';
import {
	WEBHOOK_SECRET_REQUIRED_ERROR,
	ensureWebhookSecret,
	generateWebhookSecret,
	webhookSecretValidationError
} from '../src/lib/utils/webhook-secret';
import { verifyQuerySignature } from '../src/lib/server/webhook-signature';

const sign = (secret: string, ts: string): string =>
	crypto.createHmac('sha256', secret).update(ts).digest('hex');

describe('generateWebhookSecret', () => {
	it('generates a hex secret of 2 * byteLength characters', () => {
		const secret = generateWebhookSecret();
		assert.match(secret, /^[0-9a-f]+$/);
		assert.equal(secret.length, 64);
	});

	it('honors a custom byte length', () => {
		assert.equal(generateWebhookSecret(16).length, 32);
	});

	it('generates a different secret on every call', () => {
		assert.notEqual(generateWebhookSecret(), generateWebhookSecret());
	});
});

describe('webhookSecretValidationError', () => {
	it('returns an error when the webhook is enabled without a secret', () => {
		assert.equal(webhookSecretValidationError(true, null), WEBHOOK_SECRET_REQUIRED_ERROR);
		assert.equal(webhookSecretValidationError(true, ''), WEBHOOK_SECRET_REQUIRED_ERROR);
		assert.equal(webhookSecretValidationError(true, '   '), WEBHOOK_SECRET_REQUIRED_ERROR);
	});

	it('accepts a configured secret', () => {
		assert.equal(webhookSecretValidationError(true, 's3cret'), undefined);
	});

	it('does not require a secret when the webhook is disabled', () => {
		assert.equal(webhookSecretValidationError(false, null), undefined);
	});
});

describe('ensureWebhookSecret', () => {
	it('generates a secret when the webhook is enabled without one', () => {
		const secret = ensureWebhookSecret(true, '');
		assert.match(secret, /^[0-9a-f]{64}$/);
	});

	it('keeps an existing secret untouched', () => {
		assert.equal(ensureWebhookSecret(true, 'existing'), 'existing');
	});

	it('does nothing when the webhook is disabled', () => {
		assert.equal(ensureWebhookSecret(false, ''), '');
		assert.equal(ensureWebhookSecret(false, 'existing'), 'existing');
	});
});

describe('verifyQuerySignature (GET webhook auth)', () => {
	const secret = generateWebhookSecret();
	const now = String(Math.floor(Date.now() / 1000));

	it('accepts a valid signature for the current timestamp', () => {
		assert.equal(verifyQuerySignature(secret, now, sign(secret, now)), true);
	});

	it('rejects a signature made with the wrong secret', () => {
		const wrong = generateWebhookSecret();
		assert.equal(verifyQuerySignature(secret, now, sign(wrong, now)), false);
	});

	it('rejects a stale timestamp outside the 5-minute window', () => {
		const old = String(Math.floor(Date.now() / 1000) - 600);
		assert.equal(verifyQuerySignature(secret, old, sign(secret, old)), false);
	});

	it('rejects a replayed signature for an expired timestamp', () => {
		const old = String(Math.floor(Date.now() / 1000) - 3600);
		const sig = sign(secret, old);
		assert.equal(verifyQuerySignature(secret, old, sig), false);
	});

	it('rejects a non-numeric or missing timestamp', () => {
		assert.equal(verifyQuerySignature(secret, 'abc', sign(secret, 'abc')), false);
		assert.equal(verifyQuerySignature(secret, now, null), false);
		assert.equal(verifyQuerySignature(secret, '', ''), false);
	});
});
