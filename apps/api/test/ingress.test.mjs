import assert from 'node:assert/strict';
import { test } from 'node:test';
import { register } from 'tsx/esm/api';
import { signIngress } from '@trading/config/ingress';
import { createIngressGuard } from '../dist/http/ingress.js';

register();
const { providerClientIp, trustedIngressHeaders } = await import('../../web/src/lib/server/ingress.ts');

const secret = 'a'.repeat(48);
const now = 1_800_000_000_000;
const payload = Buffer.from('{"message":"raw transport bytes"}');

function request(overrides = {}) {
  const timestamp = String(Math.floor(now / 1000));
  const input = {
    method: 'POST', path: '/api/v1/support?source=member', timestamp,
    nonce: 'nonce-1234567890abcdef', principal: 'web', clientIp: '203.0.113.42', body: payload,
  };
  const headers = {
    'x-trusted-ingress-timestamp': timestamp,
    'x-trusted-ingress-nonce': input.nonce,
    'x-trusted-ingress-principal': input.principal,
    'x-trusted-ingress-client-ip': input.clientIp,
    'x-trusted-ingress-signature': signIngress(secret, input),
    'x-forwarded-for': '198.51.100.77',
  };
  return {
    req: { method: input.method, originalUrl: input.path, headers, rawBody: payload, ip: '10.0.0.8', ...overrides },
    headers,
  };
}

function memoryNonceStore() {
  const seen = new Set();
  return async (nonce) => {
    if (seen.has(nonce)) return false;
    seen.add(nonce);
    return true;
  };
}

async function run(guard, req) {
  const result = { next: false, status: undefined, body: undefined };
  await guard(req, { status(code) { result.status = code; return this; }, json(body) { result.body = body; } }, () => { result.next = true; });
  return result;
}

test('trusted ingress signature binds method, full path, raw body and IP before replacing req.ip', async () => {
  const { req } = request();
  const result = await run(createIngressGuard({ secret, production: true, now: () => now, consumeNonce: memoryNonceStore() }), req);
  assert.equal(result.next, true);
  assert.equal(req.ip, '203.0.113.42');
  assert.equal(req.trustedIngress.principal, 'web');
  assert.equal(req.headers['x-forwarded-for'], '198.51.100.77');

  const changedBody = request({ rawBody: Buffer.from('{"message":"substituted"}') });
  assert.equal((await run(createIngressGuard({ secret, production: true, now: () => now, consumeNonce: memoryNonceStore() }), changedBody.req)).status, 403);
  const missingBody = request({ rawBody: undefined });
  assert.equal((await run(createIngressGuard({ secret, production: true, now: () => now, consumeNonce: memoryNonceStore() }), missingBody.req)).status, 403);
});

test('production requires persistent replay storage and direct API rejects missing or spoofed ingress', async () => {
  assert.throws(() => createIngressGuard({ secret, production: true }), /shared PostgreSQL nonce storage/);
  const guard = createIngressGuard({ secret, production: true, now: () => now, consumeNonce: memoryNonceStore() });
  const missing = { method: 'GET', originalUrl: '/api/v1/publications', headers: {}, ip: '10.0.0.8' };
  assert.equal((await run(guard, missing)).status, 403);
  const spoof = request();
  spoof.headers['x-trusted-ingress-signature'] = 'A'.repeat(43);
  assert.equal((await run(guard, spoof.req)).status, 403);
  for (const [method, path] of [
    ['GET', '/api/v1/health/live'], ['GET', '/api/v1/health/ready'],
    ['POST', '/api/v1/webhooks/stripe'], ['POST', '/api/v1/webhooks/resend'],
    ['POST', '/api/v1/internal/notifications/source'], ['POST', '/api/v1/internal/billing/reconcile'],
    ['POST', '/api/v1/internal/publication-snapshot-jobs/123e4567-e89b-12d3-a456-426614174000/claim'],
  ]) assert.equal((await run(guard, { method, originalUrl: path, headers: {} })).next, true, `${method} ${path}`);
  assert.equal((await run(guard, { method: 'GET', originalUrl: '/api/v1/webhooks/resend', headers: {} })).status, 403);
  assert.equal((await run(guard, { method: 'POST', originalUrl: '/api/v1/internal/notifications/source/extra', headers: {} })).status, 403);
});

test('shared replay storage rejects duplicate nonces and signatures bind timestamp, method and path', async () => {
  const consumeNonce = memoryNonceStore();
  const guard = createIngressGuard({ secret, production: true, now: () => now, consumeNonce });
  const first = request();
  assert.equal((await run(guard, first.req)).next, true);
  assert.equal((await run(guard, request().req)).status, 403);
  const alteredPath = request({ originalUrl: '/api/v1/other?source=member' });
  assert.equal((await run(createIngressGuard({ secret, production: true, now: () => now, consumeNonce: memoryNonceStore() }), alteredPath.req)).status, 403);
  const alteredMethod = request({ method: 'GET' });
  assert.equal((await run(createIngressGuard({ secret, production: true, now: () => now, consumeNonce: memoryNonceStore() }), alteredMethod.req)).status, 403);
  const stale = request();
  stale.headers['x-trusted-ingress-timestamp'] = String(Math.floor(now / 1000) - 61);
  assert.equal((await run(createIngressGuard({ secret, production: true, now: () => now, consumeNonce: memoryNonceStore() }), stale.req)).status, 403);
  const noTimestamp = request();
  delete noTimestamp.headers['x-trusted-ingress-timestamp'];
  assert.equal((await run(guard, noTimestamp.req)).status, 403);
  const local = request();
  local.headers['x-trusted-ingress-signature'] = '0'.repeat(43);
  assert.equal((await run(createIngressGuard({ secret, production: false, now: () => now }), local.req)).next, true);
  assert.equal(local.req.ip, '10.0.0.8');
});

test('web ingress accepts only the Vercel-overwritten client IP header and signs body on fresh headers', () => {
  assert.equal(providerClientIp(new Headers({ 'x-vercel-forwarded-for': '203.0.113.9', 'x-forwarded-for': '198.51.100.1' }), 'vercel', true, '1'), '203.0.113.9');
  assert.throws(() => providerClientIp(new Headers({ 'x-forwarded-for': '198.51.100.1' }), 'vercel', true, '1'));
  assert.throws(() => providerClientIp(new Headers({ 'x-real-ip': '2001:db8::9' }), 'vercel', true, '1'));
  assert.throws(() => providerClientIp(new Headers({ 'x-vercel-forwarded-for': '203.0.113.1, 198.51.100.1' }), 'vercel', true, '1'));
  assert.throws(() => providerClientIp(new Headers({ 'x-vercel-forwarded-for': '203.0.113.1' }), 'vercel', true, '0'));
  assert.equal(providerClientIp(new Headers({ 'x-forwarded-for': '198.51.100.1' }), undefined, false), undefined);
  const headers = trustedIngressHeaders({ secret, method: 'POST', path: '/api/v1/publications', principal: 'web', clientIp: '203.0.113.9', body: payload, now, nonce: 'webnonce1234567890' });
  assert.equal(headers.get('x-trusted-ingress-principal'), 'web');
  assert.equal(headers.get('x-trusted-ingress-client-ip'), '203.0.113.9');
  assert.equal(headers.get('x-trusted-ingress-signature')?.length, 43);
  const independent = trustedIngressHeaders({ secret, method: 'POST', path: '/api/v1/publications', principal: 'web', clientIp: '203.0.113.9', body: Buffer.from('different'), now, nonce: 'webnonce1234567891' });
  assert.notEqual(headers.get('x-trusted-ingress-signature'), independent.get('x-trusted-ingress-signature'));
  assert.notEqual(headers, independent);
});
