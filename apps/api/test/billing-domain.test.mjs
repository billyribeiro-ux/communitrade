import assert from 'node:assert/strict';
import test from 'node:test';
import { entitlementFor } from '../dist/billing/domain.js';

const provider = (overrides = {}) => ({
  providerAccountId: 'acct', mode: 'test', subscriptionId: 'sub', customerId: 'cus', plan: 'pro_month', status: 'active',
  currentPeriodStart: null, currentPeriodEnd: null, paidThrough: null, cancelAtPeriodEnd: false, canceledAt: null,
  latestPaymentId: null, reason: null, firstFailureAt: null, ...overrides,
});

test('a canceled or unpaid billed period cannot restore entitlement after actual paid-through expires', () => {
  const now = new Date('2026-10-20T12:00:00.000Z');
  const billedPeriodEnd = new Date('2026-11-20T12:00:00.000Z');
  const expiredPaidThrough = new Date('2026-10-19T12:00:00.000Z');
  const canceled = entitlementFor(provider({ status: 'canceled', currentPeriodEnd: billedPeriodEnd }), null, expiredPaidThrough, now);
  assert.equal(canceled.plan, 'free');
  assert.equal(canceled.validUntil, null);
  const unpaid = entitlementFor(provider({ status: 'unpaid', currentPeriodEnd: billedPeriodEnd }), null, expiredPaidThrough, now);
  assert.equal(unpaid.plan, 'free');
});

test('cancellation preserves only the confirmed future paid-through boundary', () => {
  const now = new Date('2026-10-20T12:00:00.000Z');
  const actualPaidThrough = new Date('2026-10-25T12:00:00.000Z');
  const billedPeriodEnd = new Date('2026-11-20T12:00:00.000Z');
  const result = entitlementFor(provider({ status: 'canceled', currentPeriodEnd: billedPeriodEnd }), null, actualPaidThrough, now);
  assert.equal(result.plan, 'pro');
  assert.equal(result.validUntil.toISOString(), actualPaidThrough.toISOString());
});

test('past-due grace uses first failure + 72 hours exactly and a replay cannot extend it', () => {
  const now = new Date('2026-10-20T12:00:00.000Z');
  const firstFailureAt = new Date('2026-10-19T12:00:00.000Z');
  const graceUntil = new Date(firstFailureAt.getTime() + 72 * 60 * 60 * 1000);
  const first = entitlementFor(provider({ status: 'past_due', firstFailureAt }), null, null, now);
  assert.equal(first.plan, 'pro');
  assert.equal(first.graceUntil.toISOString(), graceUntil.toISOString());
  const replay = entitlementFor(provider({ status: 'past_due', firstFailureAt }), first.graceUntil, null, new Date(now.getTime() + 30 * 60 * 1000));
  assert.equal(replay.graceUntil.toISOString(), graceUntil.toISOString());
  const expired = entitlementFor(provider({ status: 'past_due', firstFailureAt }), replay.graceUntil, null, new Date(graceUntil.getTime() + 1));
  assert.equal(expired.plan, 'free');
  assert.equal(expired.graceUntil.toISOString(), graceUntil.toISOString());
});

test('a newly evidenced failed-payment episode after recovery receives its own fixed grace window', () => {
  const now = new Date('2026-10-20T12:00:00.000Z');
  const newFailure = new Date('2026-10-20T11:00:00.000Z');
  // Recovery clears the old episode's persisted grace before the new failure is applied.
  const result = entitlementFor(provider({ status: 'past_due', firstFailureAt: newFailure }), null, null, now);
  assert.equal(result.plan, 'pro');
  assert.equal(result.graceUntil.toISOString(), new Date(newFailure.getTime() + 72 * 60 * 60 * 1000).toISOString());
});

test('unknown plan, status, and missing paid time fail closed', () => {
  const now = new Date('2026-10-20T12:00:00.000Z');
  for (const overrides of [
    { plan: null, status: 'active', currentPeriodEnd: new Date('2026-11-20T12:00:00Z') },
    { plan: 'legacy_unknown', status: 'active', currentPeriodEnd: new Date('2026-11-20T12:00:00Z') },
    { status: 'processor_unknown', currentPeriodEnd: new Date('2026-11-20T12:00:00Z') },
    { status: 'active', currentPeriodEnd: null },
    { status: 'canceled', currentPeriodEnd: new Date('2026-11-20T12:00:00Z') },
  ]) {
    const result = entitlementFor(provider(overrides), null, null, now);
    assert.equal(result.plan, 'free', JSON.stringify(overrides));
    assert.equal(result.validUntil, null);
  }
});
