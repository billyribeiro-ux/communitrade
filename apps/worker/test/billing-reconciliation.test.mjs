import test from 'node:test';
import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import { createBillingReconciler } from '../dist/billing-reconciliation.js';

const secret = 'p12-worker-test-secret-'.repeat(3);

test('billing scheduler authenticates a bounded bodyless sweep without member credentials', async () => {
  let calls = 0;
  const reconcile = createBillingReconciler('http://api:3001', secret, async (url, request) => {
    calls++;
    assert.equal(url.pathname, '/api/v1/internal/billing/reconcile');
    assert.equal(request.method, 'POST');
    assert.equal(request.redirect, 'error');
    assert.equal(request.credentials, 'omit');
    assert.equal(request.body, undefined);
    assert.deepEqual(Object.keys(request.headers), ['X-Billing-Authorization']);
    const [seconds, nonce, signature] = request.headers['X-Billing-Authorization'].split('.');
    assert.ok(Math.abs(Date.now() / 1000 - Number(seconds)) < 2);
    assert.match(nonce, /^[0-9a-f-]{36}$/);
    assert.equal(signature, createHmac('sha256', secret).update(`billing-reconcile:v1:${seconds}:${nonce}`).digest('base64url'));
    return new Response(null, { status: 204 });
  });
  await reconcile();
  assert.equal(calls, 1);
});

test('billing scheduler skips overlap, releases its guard after failure and sanitizes transport details', async () => {
  let release, calls = 0;
  const barrier = new Promise(resolve => { release = resolve; });
  const reconcile = createBillingReconciler('http://api:3001', secret, async () => {
    calls++;
    await barrier;
    throw new Error('private provider credential or customer state');
  });
  const first = reconcile();
  await reconcile();
  assert.equal(calls, 1);
  release();
  await assert.rejects(first, { message: 'BILLING_RECONCILE_UNAVAILABLE' });
  await assert.rejects(reconcile(), { message: 'BILLING_RECONCILE_UNAVAILABLE' });
  assert.equal(calls, 2);
});

test('billing scheduler refuses invalid configuration and non-204 results', async () => {
  for (const origin of ['http://user:pass@api', 'http://api/private', 'http://api/?token=x', 'file:///api']) {
    assert.throws(() => createBillingReconciler(origin, secret));
  }
  assert.throws(() => createBillingReconciler('http://api:3001', 'short'));
  for (const status of [200, 401, 503]) {
    const reconcile = createBillingReconciler('http://api:3001', secret, async () => new Response(null, { status }));
    await assert.rejects(reconcile(), { message: 'BILLING_RECONCILE_UNAVAILABLE' });
  }
});
