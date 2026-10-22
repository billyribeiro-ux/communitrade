import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import test from 'node:test';
import pg from 'pg';
import { createDatabase } from '../dist/database.js';
import { createBillingProvider } from '../dist/billing/provider-config.js';
import { BillingService } from '../dist/billing/service.js';

const databaseUrl = process.env.TEST_DATABASE_URL;
const integration = { skip: databaseUrl ? false : 'Set TEST_DATABASE_URL with migration 019 applied for billing core PostgreSQL acceptance.' };

test('billing core reconciles owned fake checkout, dedupes webhooks, preserves paid-through, refunds only once, and expires grace', integration, async () => {
  const pool = new pg.Pool({ connectionString: databaseUrl, max: 8, connectionTimeoutMillis: 3000, query_timeout: 15000 });
  pool.on('error', () => {});
  const db = createDatabase(databaseUrl);
  const suffix = randomUUID();
  const owner = randomUUID(), admin = randomUUID();
  const issuer = `https://p12.core.${suffix}.invalid`;
  const providerAccount = `local-fake-core-${suffix}`;
  const env = {
    APP_ORIGIN: 'http://localhost:3000',
    SESSION_SECRET: 'p12-core-integration-session-secret-long-enough-for-signing',
    BILLING_PROVIDER_ACCOUNT_ID: providerAccount,
  };
  const previousAccount = process.env.BILLING_PROVIDER_ACCOUNT_ID;
  const previousProvider = process.env.BILLING_PROVIDER;
  const previousMode = process.env.BILLING_MODE;
  const previousRelease = process.env.RELEASE_MODE;
  process.env.BILLING_PROVIDER_ACCOUNT_ID = providerAccount;
  process.env.BILLING_PROVIDER = 'fake';
  process.env.BILLING_MODE = 'test';
  process.env.RELEASE_MODE = 'local';
  const provider = await createBillingProvider(env, db);
  const service = new BillingService(pool, provider, (await import('../dist/billing/provider-config.js')).createBillingProviderConfig(env));
  const account = `fake:${providerAccount}`;
  const userIds = [owner, admin];
  try {
    for (const [id, name] of [[owner, 'owner'], [admin, 'admin']]) {
      await pool.query(`INSERT INTO user_account(id,oidc_issuer,oidc_subject,email,email_verified,status,created_at,updated_at)
        VALUES($1::uuid,$2,$3,$4,true,'active',now(),now())`, [id, issuer, id, `${name}-${suffix}@example.invalid`]);
    }
    await pool.query(`INSERT INTO role_grant(id,user_id,role,grantor_user_id,reason,granted_at)
      VALUES($1,$2,'admin',$2,'Synthetic P12 billing test administrator',now())`, [randomUUID(), admin]);
    await pool.query(`INSERT INTO policy_acceptance(id,user_id,policy_slug,version,accepted_at) VALUES($1,$2,'terms','2026-10-20.v1',now())`, [randomUUID(), owner]);
    await pool.query(`INSERT INTO preference(id,user_id,settings,updated_at) VALUES($1,$2,$3::jsonb,now())`, [randomUUID(), owner,
      JSON.stringify({ analyticsConsent: true, analyticsConsentVersion: '2026-10-20.v1', billingNotices: true })]);

    assert.equal(service.listPlans().items[1].monthlyUsd, '29.00');
    assert.equal(service.listPlans().items[1].annualUsd, '290.00');
    const attempts = await Promise.allSettled([
      service.createCheckout(owner, { plan: 'pro', interval: 'monthly', termsVersion: '2026-10-20.v1' }, `p12:${suffix}:checkout-a`),
      service.createCheckout(owner, { plan: 'pro', interval: 'annual', termsVersion: '2026-10-20.v1' }, `p12:${suffix}:checkout-b`),
    ]);
    const checkout = attempts.find(item => item.status === 'fulfilled');
    const rejected = attempts.find(item => item.status === 'rejected');
    assert.ok(checkout, JSON.stringify(attempts.map(item => item.status === 'rejected' ? { status:item.status,code:item.reason?.code,message:item.reason?.message } : { status:item.status })));
    assert.equal(rejected.reason.code, 'CHECKOUT_ALREADY_PENDING');
    const checkoutUrl = new URL(checkout.value.url);
    const sessionId = checkoutUrl.searchParams.get('session');
    assert.ok(sessionId);
    assert.equal((await service.getDemoSession(owner, sessionId)).status, 'open');
    await assert.rejects(service.getDemoSession(admin, sessionId), { code: 'DEMO_SESSION_NOT_FOUND' });
    await assert.rejects(service.applyDemoAction(admin, sessionId, 'complete', `p12:${suffix}:wrong-owner`), { code: 'DEMO_SESSION_NOT_FOUND' });

    const completeKey = `p12:${suffix}:complete`;
    const returned = await service.applyDemoAction(owner, sessionId, 'complete', completeKey);
    assert.match(returned.url, /\/subscribe\/return$/);
    const active = await service.getSubscription(owner);
    assert.equal(active.plan, 'pro');
    assert.equal(active.status, 'active');
    assert.equal(active.invoices.length, 1);
    assert.ok([2900, 29000].includes(active.invoices[0].amountMinor));
    const duplicateDelivery = await provider.getEventDelivery({ eventId: (await provider.applyDemoAction({ userId: owner, sessionId, action: 'complete', idempotencyKey: completeKey })).eventId });
    const duplicateResult = await service.receiveWebhook(duplicateDelivery.rawBody, duplicateDelivery.signature);
    assert.equal(duplicateResult.duplicate, true);
    const eventCount = await pool.query('SELECT count(*)::int n FROM billing_event WHERE provider_account=$1 AND mode=$2', [account, 'test']);
    assert.equal(eventCount.rows[0].n, 1);

    const localSubscription = await pool.query('SELECT id,provider_subscription_id,paid_through,provider_customer_id FROM subscription WHERE user_id=$1 AND provider_account=$2 AND mode=$3', [owner, account, 'test']);
    assert.equal(localSubscription.rowCount, 1);
    const paymentId = active.invoices[0].paymentId;
    assert.ok(paymentId);
    const refundKey = `p12:${suffix}:refund`;
    const refundAction = { action: 'refund', reason: 'Synthetic billing acceptance refund', paymentId, amount: '10.00', cancelSubscription: false };
    const firstRefund = await service.adminBillingAction(admin, localSubscription.rows[0].id, refundAction, refundKey);
    const repeatedRefund = await service.adminBillingAction(admin, localSubscription.rows[0].id, refundAction, refundKey);
    assert.equal(firstRefund.id, repeatedRefund.id);
    assert.equal((await pool.query('SELECT count(*)::int n FROM billing_refund WHERE user_id=$1 AND provider_account=$2 AND mode=$3', [owner, account, 'test'])).rows[0].n, 1);
    assert.equal((await service.getSubscription(owner)).cancelAtPeriodEnd, false, 'a refund does not cancel the subscription');

    // Simulate a provider commit with a lost acknowledgement. Recovery must identify that exact
    // refund using the durable operation id and return the same support audit receipt on replay.
    let dropRefundAck = true;
    const uncertainPort = new Proxy(provider, { get(target, property) {
      if (property === 'refund') return async input => {
        const result = await target.refund(input);
        if (dropRefundAck) { dropRefundAck = false; throw new Error('synthetic lost provider acknowledgement'); }
        return result;
      };
      const value = Reflect.get(target, property, target);
      return typeof value === 'function' ? value.bind(target) : value;
    } });
    const uncertainService = new BillingService(pool, uncertainPort, (await import('../dist/billing/provider-config.js')).createBillingProviderConfig(env));
    const uncertainKey = `p12:${suffix}:lost-refund-ack`;
    const uncertainInput = { action: 'refund', reason: 'Lost acknowledgement acceptance', paymentId, amount: '1.00', cancelSubscription: false };
    await assert.rejects(uncertainService.adminBillingAction(admin, localSubscription.rows[0].id, uncertainInput, uncertainKey), { code: 'BILLING_OPERATION_UNCERTAIN' });
    const uncertainOperation = await pool.query(`SELECT id FROM billing_operation WHERE user_id=$1 AND provider_account=$2 AND mode='test' AND kind='refund' AND status='uncertain'
      ORDER BY updated_at DESC LIMIT 1`, [owner, account]);
    assert.equal(uncertainOperation.rowCount, 1);
    await pool.query('UPDATE billing_operation SET next_attempt_at=now() WHERE id=$1', [uncertainOperation.rows[0].id]);
    await service.reconcilePendingOperations(5);
    const recoveredOperation = await pool.query('SELECT status,result FROM billing_operation WHERE id=$1', [uncertainOperation.rows[0].id]);
    assert.equal(recoveredOperation.rows[0].status, 'succeeded');
    assert.equal((await pool.query('SELECT count(*)::int n FROM fake_billing_refund WHERE provider_account_id=$1 AND mode=$2 AND operation_id=$3', [providerAccount, 'test', uncertainOperation.rows[0].id])).rows[0].n, 1);
    const replayReceipt = await uncertainService.adminBillingAction(admin, localSubscription.rows[0].id, uncertainInput, uncertainKey);
    assert.equal(replayReceipt.id, recoveredOperation.rows[0].result.id);
    assert.equal((await pool.query("SELECT count(*)::int n FROM audit_event WHERE actor=$1 AND resource_id=$2 AND action='billing_refund' AND reason=$3", [admin, localSubscription.rows[0].id, uncertainInput.reason])).rows[0].n, 1);

    let precommitRefundCalls = 0;
    const precommitFailurePort = new Proxy(provider, { get(target, property) {
      if (property === 'refund') return async () => { precommitRefundCalls++; throw new Error('synthetic provider failure before commit'); };
      const value = Reflect.get(target, property, target);
      return typeof value === 'function' ? value.bind(target) : value;
    } });
    const precommitService = new BillingService(pool, precommitFailurePort, (await import('../dist/billing/provider-config.js')).createBillingProviderConfig(env));
    const precommitKey = `p12:${suffix}:before-refund-commit`;
    const precommitInput = { action: 'refund', reason: 'Before commit recovery acceptance', paymentId, amount: '0.75', cancelSubscription: false };
    await assert.rejects(precommitService.adminBillingAction(admin, localSubscription.rows[0].id, precommitInput, precommitKey), { code: 'BILLING_OPERATION_UNCERTAIN' });
    const precommitOperation = await pool.query(`SELECT id,result FROM billing_operation WHERE user_id=$1 AND provider_account=$2 AND mode='test' AND kind='refund' AND status='uncertain'
      ORDER BY updated_at DESC LIMIT 1`, [owner, account]);
    assert.equal(precommitOperation.rowCount, 1);
    assert.equal(precommitOperation.rows[0].result.amountMinor, 75, 'the exact resolved refund amount is durable before the provider write');
    await pool.query('UPDATE billing_operation SET next_attempt_at=now() WHERE id=$1', [precommitOperation.rows[0].id]);
    let recoveryRefundInput;
    const trackingRecoveryPort = new Proxy(provider, { get(target, property) {
      if (property === 'refund') return async input => { recoveryRefundInput = input; return target.refund(input); };
      const value = Reflect.get(target, property, target);
      return typeof value === 'function' ? value.bind(target) : value;
    } });
    const recoveryService = new BillingService(pool, trackingRecoveryPort, (await import('../dist/billing/provider-config.js')).createBillingProviderConfig(env));
    await recoveryService.reconcilePendingOperations(5);
    const precommitRecovered = await pool.query('SELECT status,result FROM billing_operation WHERE id=$1', [precommitOperation.rows[0].id]);
    assert.equal(precommitRecovered.rows[0].status, 'succeeded');
    const committedRefund = await pool.query('SELECT amount,idempotency_key FROM fake_billing_refund WHERE provider_account_id=$1 AND mode=$2 AND operation_id=$3', [providerAccount, 'test', precommitOperation.rows[0].id]);
    assert.equal(committedRefund.rowCount, 1, 'recovery wrote exactly one provider refund');
    assert.equal(committedRefund.rows[0].amount, 75);
    assert.equal(recoveryRefundInput.idempotencyKey, `${precommitKey}:refund`, 'recovery reuses the original provider idempotency key');
    assert.equal(recoveryRefundInput.operationId, precommitOperation.rows[0].id);
    assert.equal((await precommitService.adminBillingAction(admin, localSubscription.rows[0].id, precommitInput, precommitKey)).id, precommitRecovered.rows[0].result.id);

    let agedRefundCalls = 0;
    const agedFailurePort = new Proxy(provider, { get(target, property) {
      if (property === 'refund') return async () => { agedRefundCalls++; throw new Error('synthetic precommit failure for aged operation'); };
      const value = Reflect.get(target, property, target);
      return typeof value === 'function' ? value.bind(target) : value;
    } });
    const agedService = new BillingService(pool, agedFailurePort, (await import('../dist/billing/provider-config.js')).createBillingProviderConfig(env));
    const agedKey = `p12:${suffix}:aged-refund-write`;
    const agedInput = { action: 'refund', reason: 'Aged uncertain refund acceptance', paymentId, amount: '0.50', cancelSubscription: false };
    await assert.rejects(agedService.adminBillingAction(admin, localSubscription.rows[0].id, agedInput, agedKey), { code: 'BILLING_OPERATION_UNCERTAIN' });
    const agedOperation = await pool.query(`SELECT id FROM billing_operation WHERE user_id=$1 AND provider_account=$2 AND mode='test' AND kind='refund' AND status='uncertain'
      ORDER BY updated_at DESC LIMIT 1`, [owner, account]);
    await pool.query("UPDATE billing_operation SET created_at=now()-interval '25 hours',next_attempt_at=now(),attempts=0 WHERE id=$1", [agedOperation.rows[0].id]);
    await service.reconcilePendingOperations(5);
    assert.equal((await pool.query('SELECT status FROM billing_operation WHERE id=$1', [agedOperation.rows[0].id])).rows[0].status, 'uncertain');
    assert.equal((await pool.query('SELECT count(*)::int n FROM fake_billing_refund WHERE provider_account_id=$1 AND mode=$2 AND operation_id=$3', [providerAccount, 'test', agedOperation.rows[0].id])).rows[0].n, 0);
    await assert.rejects(agedService.adminBillingAction(admin, localSubscription.rows[0].id, agedInput, agedKey), { code: 'BILLING_OPERATION_UNCERTAIN' });
    assert.equal(agedRefundCalls, 1, 'old same-key retries remain evidence-only and never post another refund');

    let dropCancelAck = true;
    const uncertainCancelPort = new Proxy(provider, { get(target, property) {
      if (property === 'cancelSubscription') return async input => {
        const result = await target.cancelSubscription(input);
        if (dropCancelAck) { dropCancelAck = false; throw new Error('synthetic lost cancellation acknowledgement'); }
        return result;
      };
      const value = Reflect.get(target, property, target);
      return typeof value === 'function' ? value.bind(target) : value;
    } });
    const uncertainCancelService = new BillingService(pool, uncertainCancelPort, (await import('../dist/billing/provider-config.js')).createBillingProviderConfig(env));
    const cancelKey = `p12:${suffix}:lost-cancel-ack`;
    const cancelInput = { action: 'cancel', reason: 'Lost cancellation acknowledgement' };
    await assert.rejects(uncertainCancelService.adminBillingAction(admin, localSubscription.rows[0].id, cancelInput, cancelKey), { code: 'BILLING_OPERATION_UNCERTAIN' });
    const uncertainCancel = await pool.query(`SELECT id FROM billing_operation WHERE user_id=$1 AND provider_account=$2 AND mode='test' AND kind='cancel' AND status='uncertain'
      ORDER BY updated_at DESC LIMIT 1`, [owner, account]);
    assert.equal(uncertainCancel.rowCount, 1);
    await pool.query('UPDATE billing_operation SET next_attempt_at=now() WHERE id=$1', [uncertainCancel.rows[0].id]);
    await service.reconcilePendingOperations(5);
    const recoveredCancel = await pool.query('SELECT status,result FROM billing_operation WHERE id=$1', [uncertainCancel.rows[0].id]);
    assert.equal(recoveredCancel.rows[0].status, 'succeeded');
    const cancelReplayReceipt = await uncertainCancelService.adminBillingAction(admin, localSubscription.rows[0].id, cancelInput, cancelKey);
    assert.equal(cancelReplayReceipt.id, recoveredCancel.rows[0].result.id);
    assert.equal((await service.getSubscription(owner)).cancelAtPeriodEnd, true);

    const failed = await provider.applyScenario({ userId: owner, scenario: 'payment_failed' });
    const delivery = await provider.getEventDelivery({ eventId: failed.eventId });
    await service.receiveWebhook(delivery.rawBody, delivery.signature);
    const pastDue = await service.getSubscription(owner);
    assert.equal(pastDue.status, 'past_due');
    assert.ok(pastDue.graceUntil);
    assert.equal(new Date(pastDue.graceUntil).getTime() - Date.now() <= 72 * 60 * 60 * 1000, true);
    const paidThrough = new Date(pastDue.paidThrough);
    assert.ok(paidThrough > new Date(), 'failed renewal retains the previous paid-through period');

    await db.fakeBillingSubscription.updateMany({ where: { providerAccountId: providerAccount, mode: 'test', userId: owner }, data: { firstFailureAt: new Date(Date.now() - 72 * 60 * 60 * 1000 - 5000) } });
    await pool.query('UPDATE billing_customer SET last_reconciled_at=now()-interval \'10 minutes\' WHERE user_id=$1 AND provider_account=$2 AND mode=$3', [owner, account, 'test']);
    await service.reconcilePendingOperations(5);
    const expiredGrace = await service.getSubscription(owner);
    assert.equal(expiredGrace.plan, 'free');
    assert.equal(expiredGrace.status, 'past_due');
    assert.equal(new Date(expiredGrace.paidThrough).toISOString(), paidThrough.toISOString());

    const history = await pool.query(`SELECT count(*)::int n FROM product_event WHERE owner_user_id=$1 AND event_name IN ('conversion','churn')`, [owner]);
    assert.ok(history.rows[0].n >= 2, 'actual plan transitions are recorded after reconciliation, including deadline expiry');
  } finally {
    const { cleanupP08Fixtures } = await import('../scripts/p08-fixture-cleanup.mjs');
    await cleanupP08Fixtures(pool, userIds);
    await db.$disconnect();
    await pool.end();
    if (previousAccount === undefined) delete process.env.BILLING_PROVIDER_ACCOUNT_ID; else process.env.BILLING_PROVIDER_ACCOUNT_ID = previousAccount;
    if (previousProvider === undefined) delete process.env.BILLING_PROVIDER; else process.env.BILLING_PROVIDER = previousProvider;
    if (previousMode === undefined) delete process.env.BILLING_MODE; else process.env.BILLING_MODE = previousMode;
    if (previousRelease === undefined) delete process.env.RELEASE_MODE; else process.env.RELEASE_MODE = previousRelease;
  }
});
