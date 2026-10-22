import { test } from 'node:test';
import assert from 'node:assert/strict';
import { signPublicationRenderToken, verifyPublicationRenderToken } from '../src/snapshot-token.ts';

const secret = 'worker-and-route-shared-secret-at-least-32-bytes';
const now = Date.parse('2026-10-20T12:00:00.000Z');
const claims = {
  jobId: '00000000-0000-4000-8000-000000000001',
  publicationVersionId: '00000000-0000-4000-8000-000000000002',
  nonce: '00000000-0000-4000-8000-000000000003',
  expiresAt: '2026-10-20T12:01:00.000Z',
};

test('signs canonical job/version/nonce claims and verifies them within the short TTL', () => {
  const token = signPublicationRenderToken(secret, claims, now);
  assert.deepEqual(verifyPublicationRenderToken(secret, token, now), claims);
  assert.throws(() => verifyPublicationRenderToken(secret, token, now + 60_000), /expired|lifetime/i);
  assert.throws(() => verifyPublicationRenderToken('wrong-secret-is-also-at-least-32-bytes', token, now), /signature/i);
});

test('rejects altered binding claims, malformed payloads, long tokens and weak secrets', () => {
  const token = signPublicationRenderToken(secret, claims, now);
  const [encoded, signature] = token.split('.');
  const changed = Buffer.from(JSON.stringify({ ...claims, jobId: '00000000-0000-4000-8000-000000000004' })).toString('base64url');
  assert.throws(() => verifyPublicationRenderToken(secret, `${changed}.${signature}`, now), /signature/i);
  assert.throws(() => verifyPublicationRenderToken(secret, `${encoded}.00`, now), /invalid/i);
  assert.throws(() => signPublicationRenderToken('too-short', claims, now), /32 bytes/i);
  assert.throws(() => signPublicationRenderToken(secret, { ...claims, expiresAt: '2026-10-20T12:03:00.000Z' }, now), /lifetime/i);
  assert.throws(() => verifyPublicationRenderToken(secret, 'x'.repeat(2049), now), /invalid/i);
});
