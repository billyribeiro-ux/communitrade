import assert from 'node:assert/strict';
import test from 'node:test';
import { billingModeLabel, billingPastDueMessage, billingPortalUnavailableMessage, billingRequestIdentity, billingStatusLabel, formatBillingDate, formatBillingTimestamp, trustedBillingRedirect, trustedInvoiceUrl } from '../src/lib/billing.ts';

test('billing status labels keep payment failure and canceled states distinct', () => {
  assert.equal(billingStatusLabel('past_due'), 'Payment past due');
  assert.equal(billingStatusLabel('unpaid'), 'Unpaid');
  assert.equal(billingStatusLabel('canceled'), 'Canceled');
  assert.equal(billingStatusLabel('incomplete'), 'Checkout pending');
});

test('billing mode visibly identifies synthetic and live providers', () => {
  assert.match(billingModeLabel('fake', 'test', true), /Synthetic demo billing/);
  assert.equal(billingModeLabel('stripe', 'test'), 'Stripe · test mode');
  assert.equal(billingModeLabel('stripe', 'live'), 'Stripe · live');
});

test('past-due and portal copy reflects the account billing state', () => {
  assert.match(billingPastDueMessage('pro'), /Existing Pro access remains available during the grace period/);
  assert.equal(billingPastDueMessage('free'), 'The payment grace period has ended. Free access applies; saved records remain available.');
  assert.equal(billingPortalUnavailableMessage({ status: 'free', invoices: [], pendingOperation: null }), 'Upgrade to Pro to create a billing account.');
  assert.match(billingPortalUnavailableMessage({ status: 'past_due', invoices: [], pendingOperation: null }), /temporarily unavailable/);
  assert.match(billingPortalUnavailableMessage({ status: 'free', invoices: [{ id: 'invoice' }], pendingOperation: null }), /temporarily unavailable/);
  assert.match(billingPortalUnavailableMessage({ status: 'free', invoices: [], pendingOperation: { id: 'op', status: 'uncertain', kind: 'checkout' } }), /temporarily unavailable/);
});

test('billing dates are stable UTC dates and invalid values stay unavailable', () => {
  assert.equal(formatBillingDate('2026-10-20T23:30:00-04:00'), 'Oct 21, 2026');
  assert.equal(formatBillingDate('invalid'), 'Not available');
  assert.equal(formatBillingDate(null), 'Not available');
});

test('demo expiry preserves the timestamp and clearly labels UTC', () => {
  assert.equal(formatBillingTimestamp('2026-10-20T23:30:00Z'), 'Oct 20, 2026, 11:30 PM UTC');
  assert.equal(formatBillingTimestamp(null), 'Not available');
  assert.equal(formatBillingTimestamp('invalid'), 'Not available');
});

test('billing request retries reuse one key until their payload changes', () => {
  let sequence = 0;
  const createKey = () => `billing-key-${++sequence}`;
  const first = billingRequestIdentity(null, '{"action":"refund","amount":"12.00"}', createKey);
  const retry = billingRequestIdentity(first, '{"action":"refund","amount":"12.00"}', createKey);
  const changed = billingRequestIdentity(retry, '{"action":"refund","amount":"13.00"}', createKey);
  assert.equal(retry.key, first.key);
  assert.notEqual(changed.key, first.key);
  assert.equal(sequence, 2);
});

test('billing redirects and invoice URLs accept only the application or provider hosts', () => {
  const origin = 'https://trade.example';
  assert.equal(trustedBillingRedirect('/subscribe/demo?session=abc', origin, ['checkout.stripe.com'], '/subscribe/demo'), 'https://trade.example/subscribe/demo?session=abc');
  assert.equal(trustedBillingRedirect('https://checkout.stripe.com/c/pay/cs_test', origin, ['checkout.stripe.com'], '/subscribe/demo'), 'https://checkout.stripe.com/c/pay/cs_test');
  assert.equal(trustedBillingRedirect('https://evil.example/checkout', origin, ['checkout.stripe.com'], '/subscribe/demo'), null);
  assert.equal(trustedBillingRedirect('https://trade.example/other', origin, ['checkout.stripe.com'], '/subscribe/demo'), null);
  assert.equal(trustedInvoiceUrl('https://invoice.stripe.com/i/acct_test/in_demo'), 'https://invoice.stripe.com/i/acct_test/in_demo');
  assert.equal(trustedInvoiceUrl('https://attacker.example/redirect'), null);
  assert.equal(trustedInvoiceUrl('javascript:alert(1)'), null);
});
