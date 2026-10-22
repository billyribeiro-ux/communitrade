import test from 'node:test';
import assert from 'node:assert/strict';
import { createHmac, randomUUID } from 'node:crypto';
import { createApp } from '../dist/app.js';
import { CommandError } from '../dist/http/problem.js';
import { createBillingProviderConfig } from '../dist/billing/provider-config.js';
import { FakeBillingProvider } from '../dist/billing/fake-provider.js';

const bodyHeaders = (csrf, idempotencyKey = randomUUID()) => ({
  Accept: 'application/json',
  'Content-Type': 'application/json',
  'X-CSRF-Token': csrf,
  'Idempotency-Key': idempotencyKey,
});

test('P12 HTTP billing routes enforce real transport, session, CSRF, staff and provider boundaries', async () => {
  const owner = randomUUID();
  const otherUser = randomUUID();
  const subscriptionId = randomUUID();
  const sessionId = randomUUID();
  const csrf = 'synthetic-p12-csrf';
  const reconcileSecret = 'synthetic-p12-scheduler-purpose-secret-with-32-chars';
  const previousSessionSecret = process.env.SESSION_SECRET;
  process.env.SESSION_SECRET = reconcileSecret;

  let authenticated = true;
  let emailVerified = true;
  let onboarded = true;
  let mfaRecent = true;
  let roles = ['admin'];
  const authCalls = [];
  const calls = [];
  const webhookCalls = [];
  const providerConfig = createBillingProviderConfig({ APP_ORIGIN: 'http://localhost:3000', SESSION_SECRET: reconcileSecret });
  const fakeProvider = new FakeBillingProvider(providerConfig, {});
  const auth = {
    authenticate: async (_request, options) => {
      authCalls.push(options);
      if (!authenticated) throw new CommandError(401, 'SESSION_REQUIRED');
      if (options?.verified && !emailVerified) throw new CommandError(403, 'EMAIL_VERIFICATION_REQUIRED');
      if (options?.onboarded && !onboarded) throw new CommandError(403, 'ONBOARDING_REQUIRED');
      if (options?.stepUp && !mfaRecent) throw new CommandError(403, 'RECENT_MFA_REQUIRED');
      return { userId: owner, roles };
    },
    assertCsrf: async request => {
      if (request.headers['x-csrf-token'] !== csrf) throw new CommandError(403, 'CSRF_FAILED');
    },
  };
  const billing = {
    getSubscription: async userId => { calls.push(['subscription', userId]); return { plan: 'free', status: 'free' }; },
    createCheckout: async (...args) => { calls.push(['checkout', ...args]); return { url: 'https://billing.example.test/session', pendingWebhook: true }; },
    createPortal: async (...args) => { calls.push(['portal', ...args]); return { url: 'https://billing.example.test/portal' }; },
    receiveWebhook: async (raw, signature) => {
      webhookCalls.push({ raw: Buffer.from(raw), signature });
      try { const event = await fakeProvider.verifyWebhook(raw, signature); return { received: true, eventId: event.eventId }; }
      catch { throw new CommandError(400, 'INVALID_PROVIDER_SIGNATURE'); }
    },
    getDemoSession: async (...args) => { calls.push(['demoGet', ...args]); return { id: sessionId, kind: 'checkout', status: 'open' }; },
    applyDemoAction: async (...args) => { calls.push(['demoAction', ...args]); return { url: '/subscribe/return' }; },
    adminListSubscriptions: async (...args) => { calls.push(['adminList', ...args]); return { items: [], nextCursor: null }; },
    adminBillingAction: async (...args) => { calls.push(['adminAction', ...args]); return { id: randomUUID(), action: 'reconcile' }; },
    reconcilePendingOperations: async (...args) => { calls.push(['reconcileSweep', ...args]); return { reconciled: 0 }; },
  };
  let app;
  let listening = false;

  try {
    app = await createApp({ $queryRaw: async () => [] }, null, { auth, billing });
    await app.listen(0, '127.0.0.1');
    listening = true;
    const origin = `http://127.0.0.1:${app.getHttpServer().address().port}/api/v1`;

    const subscription = await fetch(`${origin}/billing/subscription`);
    assert.equal(subscription.status, 200);
    assert.deepEqual(authCalls.at(-1), { verified: true, onboarded: true });
    assert.deepEqual(calls.find(call => call[0] === 'subscription'), ['subscription', owner]);

    authenticated = false;
    const signedOut = await fetch(`${origin}/billing/subscription`);
    assert.equal(signedOut.status, 401);
    authenticated = true;
    emailVerified = false;
    const unverified = await fetch(`${origin}/billing/subscription`);
    assert.equal(unverified.status, 403);
    emailVerified = true;
    onboarded = false;
    const incomplete = await fetch(`${origin}/billing/subscription`);
    assert.equal(incomplete.status, 403);
    onboarded = true;

    const checkoutKey = randomUUID();
    const checkoutBody = { plan: 'pro', interval: 'annual', termsVersion: '2026-10-20.v1' };
    const noCsrf = await fetch(`${origin}/billing/checkout`, { method: 'POST', headers: { Accept: 'application/json', 'Content-Type': 'application/json', 'Idempotency-Key': randomUUID() }, body: JSON.stringify(checkoutBody) });
    assert.equal(noCsrf.status, 403);
    const badContentType = await fetch(`${origin}/billing/checkout`, { method: 'POST', headers: { ...bodyHeaders(csrf, randomUUID()), 'Content-Type': 'text/plain' }, body: JSON.stringify(checkoutBody) });
    assert.equal(badContentType.status, 400);
    const checkout = await fetch(`${origin}/billing/checkout`, { method: 'POST', headers: bodyHeaders(csrf, checkoutKey), body: JSON.stringify(checkoutBody) });
    assert.equal(checkout.status, 201, JSON.stringify(await checkout.clone().json()));
    assert.deepEqual(calls.find(call => call[0] === 'checkout'), ['checkout', owner, checkoutBody, checkoutKey]);

    const portalKey = randomUUID();
    const portal = await fetch(`${origin}/billing/portal`, { method: 'POST', headers: { Accept: 'application/json', 'X-CSRF-Token': csrf, 'Idempotency-Key': portalKey } });
    assert.equal(portal.status, 201, JSON.stringify(await portal.clone().json()));
    assert.deepEqual(calls.find(call => call[0] === 'portal'), ['portal', owner, portalKey]);

    const demo = await fetch(`${origin}/billing/demo/${sessionId}`);
    assert.equal(demo.status, 200);
    assert.deepEqual(calls.find(call => call[0] === 'demoGet'), ['demoGet', owner, sessionId]);
    const demoActionKey = randomUUID();
    const forgedOwnerBody = await fetch(`${origin}/billing/demo/${sessionId}/actions`, { method: 'POST', headers: bodyHeaders(csrf, randomUUID()), body: JSON.stringify({ action: 'complete', userId: otherUser }) });
    assert.equal(forgedOwnerBody.status, 400);
    assert.equal(calls.some(call => call[0] === 'demoAction'), false);
    const demoAction = await fetch(`${origin}/billing/demo/${sessionId}/actions`, { method: 'POST', headers: bodyHeaders(csrf, demoActionKey), body: JSON.stringify({ action: 'complete' }) });
    assert.equal(demoAction.status, 201);
    assert.deepEqual(calls.find(call => call[0] === 'demoAction'), ['demoAction', owner, sessionId, 'complete', demoActionKey]);

    const eventTimestamp = Math.floor(Date.now() / 1000);
    const prettyJson = Buffer.from(`{\n  "id": "evt_p12_transport",\n  "type": "invoice.paid",\n  "created": ${eventTimestamp},\n  "livemode": false,\n  "account": "${providerConfig.providerAccountId}",\n  "data": { "object": { "id": "in_demo", "object": "invoice", "customer": "cus_demo", "status": "paid", "metadata": { "billing_account_id": "${providerConfig.providerAccountId}", "billing_mode": "test" } } }\n}\n`);
    const validSignature = createHmac('sha256', providerConfig.fakeWebhookSecret).update(`${eventTimestamp}.`).update(prettyJson).digest('hex');
    const webhook = await fetch(`${origin}/webhooks/stripe`, { method: 'POST', headers: { 'Content-Type': 'application/json', 'Stripe-Signature': `t=${eventTimestamp},v1=${validSignature}` }, body: prettyJson });
    assert.equal(webhook.status, 204);
    assert.equal(webhookCalls.length, 1);
    assert.deepEqual(webhookCalls[0].raw, prettyJson, 'the exact signed pretty-printed JSON bytes must reach the domain service');
    assert.equal(webhookCalls[0].signature, `t=${eventTimestamp},v1=${validSignature}`);

    const missingSignature = await fetch(`${origin}/webhooks/stripe`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: prettyJson });
    assert.equal(missingSignature.status, 400);
    const forgedSignature = await fetch(`${origin}/webhooks/stripe`, { method: 'POST', headers: { 'Content-Type': 'application/json', 'Stripe-Signature': `t=${eventTimestamp},v1=${'0'.repeat(64)}` }, body: prettyJson });
    assert.equal(forgedSignature.status, 400);
    const wrongContentType = await fetch(`${origin}/webhooks/stripe`, { method: 'POST', headers: { 'Content-Type': 'text/plain', 'Stripe-Signature': `t=${eventTimestamp},v1=${validSignature}` }, body: prettyJson });
    assert.equal(wrongContentType.status, 400);
    const oversize = Buffer.from(JSON.stringify({ payload: 'x'.repeat(1024 * 1024 + 32) }));
    const tooLarge = await fetch(`${origin}/webhooks/stripe`, { method: 'POST', headers: { 'Content-Type': 'application/json', 'Stripe-Signature': `t=${eventTimestamp},v1=${validSignature}` }, body: oversize });
    assert.equal(tooLarge.status, 400);
    assert.equal(webhookCalls.length, 2, 'missing signature and transport-invalid bodies stop before service; forged reaches fake verifier');

    roles = ['admin'];
    const staffList = await fetch(`${origin}/admin/billing?limit=7&cursor=cursor-token`);
    assert.equal(staffList.status, 200);
    assert.deepEqual(authCalls.at(-1), { verified: true, onboarded: true, staff: true, stepUp: true });
    assert.deepEqual(calls.find(call => call[0] === 'adminList'), ['adminList', owner, 'cursor-token', '7', undefined]);
    const actionKey = randomUUID();
    const adminAction = await fetch(`${origin}/admin/billing/${subscriptionId}/actions`, { method: 'POST', headers: bodyHeaders(csrf, actionKey), body: JSON.stringify({ action: 'reconcile', reason: 'Member reports a delayed renewal update.' }) });
    assert.equal(adminAction.status, 201);
    assert.deepEqual(authCalls.at(-1), { verified: true, onboarded: true, staff: true, stepUp: true });
    assert.deepEqual(calls.find(call => call[0] === 'adminAction'), ['adminAction', owner, subscriptionId, { action: 'reconcile', reason: 'Member reports a delayed renewal update.' }, actionKey]);

    mfaRecent = false;
    const staleMfa = await fetch(`${origin}/admin/billing`);
    assert.equal(staleMfa.status, 403);
    mfaRecent = true;
    roles = ['moderator'];
    const nonAdmin = await fetch(`${origin}/admin/billing`);
    assert.equal(nonAdmin.status, 403);

    roles = ['admin'];
    const previousCallCount = calls.length;
    const badCallerLimit = await fetch(`${origin}/internal/billing/reconcile?limit=100`, { method: 'POST', headers: { Accept: 'application/json' } });
    assert.equal(badCallerLimit.status, 401, 'internal reconcile rejects callers without a purpose-bound service signature');
    assert.equal(calls.length, previousCallCount);

    const serviceSecret = reconcileSecret;
    const seconds = Math.floor(Date.now() / 1000);
    const nonce = randomUUID();
    const expected = createHmac('sha256', serviceSecret).update(`billing-reconcile:v1:${seconds}:${nonce}`).digest('base64url');
    const authorization = `${seconds}.${nonce}.${expected}`;
    const goodSweep = await fetch(`${origin}/internal/billing/reconcile`, { method: 'POST', headers: { Accept: 'application/json', 'X-Billing-Authorization': authorization } });
    assert.equal(goodSweep.status, 204);
    assert.deepEqual(calls.filter(call => call[0] === 'reconcileSweep'), [['reconcileSweep', 5]]);
    const wrongPurposeSignature = createHmac('sha256', serviceSecret).update(`other-purpose:${seconds}:${nonce}`).digest('base64url');
    const wrongPurpose = await fetch(`${origin}/internal/billing/reconcile`, { method: 'POST', headers: { 'X-Billing-Authorization': `${seconds}.${nonce}.${wrongPurposeSignature}` } });
    assert.equal(wrongPurpose.status, 401);
    const forged = await fetch(`${origin}/internal/billing/reconcile`, { method: 'POST', headers: { 'X-Billing-Authorization': `${seconds}.${nonce}.${'A'.repeat(43)}` } });
    assert.equal(forged.status, 401);
    const staleSeconds = seconds - 31;
    const staleSignature = createHmac('sha256', serviceSecret).update(`billing-reconcile:v1:${staleSeconds}:${nonce}`).digest('base64url');
    const stale = await fetch(`${origin}/internal/billing/reconcile`, { method: 'POST', headers: { 'X-Billing-Authorization': `${staleSeconds}.${nonce}.${staleSignature}` } });
    assert.equal(stale.status, 401);
    assert.equal(calls.filter(call => call[0] === 'reconcileSweep').length, 1, 'invalid purpose, forged, and stale credentials do not enter the sweep');

    const bodyLimitCalls = calls.length;
    const callerLimitQuery = await fetch(`${origin}/internal/billing/reconcile?limit=100`, { method: 'POST', headers: { Accept: 'application/json', 'X-Billing-Authorization': authorization } });
    assert.equal(callerLimitQuery.status, 400);
    assert.equal(calls.length, bodyLimitCalls, 'caller-selected query limits are rejected');
    const callerLimitBody = await fetch(`${origin}/internal/billing/reconcile`, { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Billing-Authorization': authorization }, body: JSON.stringify({ limit: 100 }) });
    assert.equal(callerLimitBody.status, 400);
    assert.equal(calls.length, bodyLimitCalls, 'caller-supplied limits never reach reconciliation');
    assert.equal(webhookCalls[0].raw.byteLength, prettyJson.byteLength);
  } finally {
    if (listening) await app.close();
    if (previousSessionSecret === undefined) delete process.env.SESSION_SECRET;
    else process.env.SESSION_SECRET = previousSessionSecret;
  }
});
