import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import test from 'node:test';
import pg from 'pg';
import { createDatabase } from '../dist/database.js';
import { createBillingProvider } from '../dist/billing/provider-config.js';

const databaseUrl = process.env.TEST_DATABASE_URL;
test('PostgreSQL persists fake provider truth, idempotency, signed events, renewals, refunds, and disputes', {
  skip: databaseUrl ? false : 'Set TEST_DATABASE_URL with migration 019 applied for persistent fake provider acceptance.'
}, async () => {
  const db = createDatabase(databaseUrl);
  const pool = new pg.Pool({ connectionString: databaseUrl, max: 2 });
  const userId = randomUUID();
  const suffix = randomUUID();
  const account = `local-fake-provider-test-${suffix}`;
  const env = { APP_ORIGIN: 'http://localhost:3000', SESSION_SECRET: 'billing-provider-postgres-test-session-secret-at-least-32-chars', BILLING_PROVIDER_ACCOUNT_ID: account };
  const scope = { providerAccountId: account, mode: 'test' };
  try {
    await pool.query(`INSERT INTO user_account(id,oidc_issuer,oidc_subject,email,email_verified,status,onboarding_version,created_at,updated_at)
      VALUES($1::uuid,$2,$1::text,$3,true,'active','p12-test',now(),now())`, [userId, `https://p12.billing.${suffix}.invalid`, `${userId}@example.invalid`]);
    const provider = await createBillingProvider(env, db);
    const customer = await provider.ensureCustomer({ userId, email: 'synthetic@example.invalid', idempotencyKey: `customer:${userId}:first` });
    const checkout = await provider.createCheckout({ userId, customerId: customer.customerId, plan: 'pro_month', successUrl: '/subscribe/return', cancelUrl: '/subscribe/return', idempotencyKey: `checkout:${userId}:first` });
    assert.match(checkout.url, /^http:\/\/localhost:3000\/subscribe\/demo\?session=/);
    assert.equal((await provider.getFakeSession({ userId, sessionId: checkout.sessionId })).status, 'open');

    const completed = await provider.applyDemoAction({ userId, sessionId: checkout.sessionId, action: 'complete', idempotencyKey: `demo:${userId}:complete` });
    const delivery = await provider.getEventDelivery({ eventId: completed.eventId });
    const event = await provider.verifyWebhook(delivery.rawBody, delivery.signature);
    assert.equal(event.eventId, completed.eventId);
    assert.equal(event.checkoutSessionId, checkout.sessionId);
    assert.equal(event.subscriptionId, completed.subscriptionId);

    // A fresh adapter over the same real database must see the same customer, session, and event truth.
    const restarted = await createBillingProvider(env, db);
    const sameCustomer = await restarted.ensureCustomer({ userId, existingCustomerId: customer.customerId, idempotencyKey: `customer:${userId}:restart` });
    assert.equal(sameCustomer.customerId, customer.customerId);
    assert.equal((await restarted.getFakeSession({ userId, sessionId: checkout.sessionId })).status, 'complete');
    const repeated = await restarted.applyDemoAction({ userId, sessionId: checkout.sessionId, action: 'complete', idempotencyKey: `demo:${userId}:complete` });
    assert.equal(repeated.eventId, completed.eventId);
    let state = await restarted.getCustomerState({ customerId: customer.customerId });
    assert.equal(state.subscriptions[0].status, 'active');
    assert.equal(state.invoices[0].amountPaid, 2900);
    const initialPaidThrough = state.subscriptions[0].paidThrough;
    const initialPaymentId = state.subscriptions[0].latestPaymentId;

    const failed = await restarted.applyScenario({ userId, scenario: 'payment_failed' });
    const failedDelivery = await restarted.getEventDelivery({ eventId: failed.eventId });
    await restarted.verifyWebhook(failedDelivery.rawBody, failedDelivery.signature);
    state = await restarted.getCustomerState({ customerId: customer.customerId });
    assert.equal(state.subscriptions[0].status, 'past_due');
    assert.equal(state.subscriptions[0].firstFailureAt instanceof Date, true);
    assert.equal(state.subscriptions[0].paidThrough.toISOString(), initialPaidThrough.toISOString(), 'failed invoice must not extend paid-through');

    const refund = await restarted.refund({ customerId: customer.customerId, subscriptionId: completed.subscriptionId, paymentId: initialPaymentId, operationId: `operation-${userId}`, amountMinor: 1000, reason: 'requested_by_customer', idempotencyKey: `refund:${userId}:partial` });
    assert.equal(refund.status, 'succeeded');
    state = await restarted.getCustomerState({ customerId: customer.customerId });
    assert.equal(state.refunds.find(item => item.refundId === refund.refundId)?.operationId, `operation-${userId}`);
    const competingRefunds = await Promise.allSettled([
      restarted.refund({ customerId: customer.customerId, subscriptionId: completed.subscriptionId, paymentId: initialPaymentId, amountMinor: 1500, reason: 'requested_by_customer', operationId: `operation-${userId}-race-a`, idempotencyKey: `refund:${userId}:race-a` }),
      restarted.refund({ customerId: customer.customerId, subscriptionId: completed.subscriptionId, paymentId: initialPaymentId, amountMinor: 1500, reason: 'requested_by_customer', operationId: `operation-${userId}-race-b`, idempotencyKey: `refund:${userId}:race-b` })
    ]);
    assert.equal(competingRefunds.filter(result => result.status === 'fulfilled').length, 1, 'only one $15 refund may consume the $19 remainder');
    assert.equal(competingRefunds.filter(result => result.status === 'rejected').length, 1);
    state = await restarted.getCustomerState({ customerId: customer.customerId });
    assert.ok(state.refunds.filter(item => item.paymentId === initialPaymentId && ['pending', 'succeeded'].includes(item.status)).reduce((sum, item) => sum + item.amountMinor, 0) <= 2900);
    await assert.rejects(() => restarted.refund({ customerId: customer.customerId, subscriptionId: completed.subscriptionId, paymentId: initialPaymentId, amountMinor: 2000, reason: 'requested_by_customer', idempotencyKey: `refund:${userId}:too-much` }), /remaining synthetic refundable amount/);

    await restarted.applyScenario({ userId, scenario: 'renew' });
    state = await restarted.getCustomerState({ customerId: customer.customerId });
    assert.equal(state.subscriptions[0].status, 'active');
    assert.ok(state.subscriptions[0].paidThrough > initialPaidThrough);
    await restarted.applyScenario({ userId, scenario: 'dispute' });
    state = await restarted.getCustomerState({ customerId: customer.customerId });
    assert.equal(state.disputes.some(item => item.status === 'needs_response'), true);
    await restarted.applyScenario({ userId, scenario: 'resolve_dispute' });
    state = await restarted.getCustomerState({ customerId: customer.customerId });
    assert.equal(state.disputes.some(item => item.status === 'won' && item.resolvedAt instanceof Date), true);
  } finally {
    // Scope is unique to this run, so this cleanup cannot touch local-fake-account acceptance data.
    await db.fakeBillingEvent.deleteMany({ where: scope });
    await db.fakeBillingDispute.deleteMany({ where: scope });
    await db.fakeBillingRefund.deleteMany({ where: scope });
    await db.fakeBillingInvoice.deleteMany({ where: scope });
    await db.fakeBillingSubscription.deleteMany({ where: scope });
    await db.fakeBillingCheckout.deleteMany({ where: scope });
    await db.fakeBillingOperation.deleteMany({ where: scope });
    await db.fakeBillingCustomer.deleteMany({ where: scope });
    await pool.query('DELETE FROM user_account WHERE id=$1::uuid', [userId]);
    await db.$disconnect();
    await pool.end();
  }
});
