import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import test from 'node:test';
import { createBillingProviderConfig, safeBillingUrl } from '../dist/billing/provider-config.js';
import { BillingProviderError, StripeBillingProvider } from '../dist/billing/stripe-provider.js';
import { FakeBillingProvider } from '../dist/billing/fake-provider.js';

const sessionSecret = 'local-session-secret-with-at-least-32-characters';
const localEnv = { APP_ORIGIN: 'http://localhost:3000', SESSION_SECRET: sessionSecret };

test('billing configuration defaults only to scoped synthetic test billing locally', () => {
  const config = createBillingProviderConfig(localEnv);
  assert.equal(config.provider, 'fake');
  assert.equal(config.providerAccountId, 'local-fake-account');
  assert.equal(config.mode, 'test');
  assert.equal(config.allowScenarioControls, true);
  assert.equal(config.fakeWebhookSecret.length, 64);
  assert.notEqual(config.fakeWebhookSecret, sessionSecret);
  assert.throws(() => createBillingProviderConfig({ ...localEnv, BILLING_PROVIDER: 'fake', RELEASE_MODE: 'public' }), /Synthetic billing is disabled/);
  assert.throws(() => createBillingProviderConfig({ ...localEnv, BILLING_PROVIDER: 'fake', BILLING_MODE: 'live' }), /Fake billing only supports test mode/);
});

test('live Stripe release requires the explicit approval, automatic tax, and portal configuration gates', () => {
  const live = {
    APP_ORIGIN: 'https://app.example.test', RELEASE_MODE: 'production', BILLING_PROVIDER: 'stripe', BILLING_MODE: 'live', BILLING_PROVIDER_ACCOUNT_ID: 'acct_live_scope',
    STRIPE_SECRET_KEY: 'sk_live_private_placeholder', STRIPE_WEBHOOK_SECRET: 'whsec_live_private_placeholder', STRIPE_PRICE_PRO_MONTH: 'price_month', STRIPE_PRICE_PRO_YEAR: 'price_year', STRIPE_TAX_CONFIGURED: 'true'
  };
  assert.throws(() => createBillingProviderConfig(live), /BILLING_LIVE_APPROVED=true/);
  assert.throws(() => createBillingProviderConfig({ ...live, BILLING_LIVE_APPROVED: 'true' }), /STRIPE_BILLING_PORTAL_CONFIGURATION_ID/);
  const configured = createBillingProviderConfig({ ...live, BILLING_LIVE_APPROVED: 'true', STRIPE_BILLING_PORTAL_CONFIGURATION_ID: 'bpc_liveapproved1' });
  assert.equal(configured.liveApproved, true);
  assert.equal(configured.stripePortalConfigurationId, 'bpc_liveapproved1');
});

test('Stripe mode is bound to the key, exact account scope and distinct server price IDs', () => {
  const stripeEnv = {
    ...localEnv,
    BILLING_PROVIDER: 'stripe',
    BILLING_PROVIDER_ACCOUNT_ID: 'acct_test_scope',
    BILLING_MODE: 'test',
    STRIPE_SECRET_KEY: 'sk_test_private_placeholder',
    STRIPE_WEBHOOK_SECRET: 'whsec_private_placeholder',
    STRIPE_TAX_CONFIGURED: 'true',
    STRIPE_PRICE_PRO_MONTH: 'price_month',
    STRIPE_PRICE_PRO_YEAR: 'price_year'
  };
  const config = createBillingProviderConfig(stripeEnv);
  assert.equal(config.providerAccountId, 'acct_test_scope');
  assert.equal(config.apiVersion, '2025-06-30.basil');
  assert.equal(config.stripePriceProMonth, 'price_month');
  assert.throws(() => createBillingProviderConfig({ ...stripeEnv, BILLING_MODE: 'live' }), /must match the Stripe secret key mode/);
  assert.throws(() => createBillingProviderConfig({ ...stripeEnv, STRIPE_PRICE_PRO_YEAR: 'price_month' }), /distinct/);
  assert.throws(() => createBillingProviderConfig({ ...stripeEnv, RELEASE_MODE: 'production', APP_ORIGIN: 'http://localhost:3000' }), /HTTPS/);
});

test('billing return URLs reject external origins and credentials', () => {
  assert.equal(safeBillingUrl('/subscribe/return?state=ok', 'https://app.example.test'), 'https://app.example.test/subscribe/return?state=ok');
  assert.throws(() => safeBillingUrl('https://evil.example/return', 'https://app.example.test'), /configured application origin/);
  assert.throws(() => safeBillingUrl('https://user:pass@app.example.test/path', 'https://app.example.test'), /configured application origin/);
});

function stripeConfig() {
  return createBillingProviderConfig({
    ...localEnv,
    BILLING_PROVIDER: 'stripe',
    BILLING_PROVIDER_ACCOUNT_ID: 'acct_test_scope',
    BILLING_MODE: 'test',
    STRIPE_SECRET_KEY: 'sk_test_private_placeholder',
    STRIPE_WEBHOOK_SECRET: 'whsec_test_secret_for_signatures',
    STRIPE_TAX_CONFIGURED: 'true',
    STRIPE_PRICE_PRO_MONTH: 'price_month',
    STRIPE_PRICE_PRO_YEAR: 'price_year'
  });
}

test('Stripe checkout maps fixed plan price server-side and sends API version and idempotency key', async () => {
  const calls = [];
  let unsafeCheckout = false;
  const provider = new StripeBillingProvider(stripeConfig(), async (url, init) => {
    calls.push({ url: String(url), init });
    if (String(url).endsWith('/account')) return new Response(JSON.stringify({ id: 'acct_test_scope' }), { status: 200 });
    if (String(url).endsWith('/customers/cus_test_1')) return new Response(JSON.stringify({ id: 'cus_test_1', object: 'customer', livemode: false, metadata: { app_user_id: 'user-1', billing_account_id: 'acct_test_scope', billing_mode: 'test' } }), { status: 200 });
    if (String(url).endsWith('/subscriptions?customer=cus_test_1&status=all&limit=100')) return new Response(JSON.stringify({ data: [], has_more: false }), { status: 200 });
    if (String(url).includes('/invoices?')) return new Response(JSON.stringify({ data: [], has_more: false }), { status: 200 });
    if (String(url).endsWith('/prices/price_month')) return new Response(JSON.stringify({ id: 'price_month', livemode: false, active: true, currency: 'usd', unit_amount: 2900, product: 'prod_pro', recurring: { interval: 'month', interval_count: 1 } }), { status: 200 });
    if (String(url).endsWith('/prices/price_year')) return new Response(JSON.stringify({ id: 'price_year', livemode: false, active: true, currency: 'usd', unit_amount: 29000, product: 'prod_pro', recurring: { interval: 'year', interval_count: 1 } }), { status: 200 });
    return new Response(JSON.stringify({ id: 'cs_test_1', object: 'checkout.session', livemode: false, customer: 'cus_test_1', client_reference_id: 'user-1', metadata: { billing_account_id: 'acct_test_scope', billing_mode: 'test' }, url: unsafeCheckout ? 'https://user@checkout.stripe.com/c/pay/cs_test_1' : 'https://checkout.stripe.com/c/pay/cs_test_1', expires_at: 1900000000 }), { status: 200 });
  });
  const result = await provider.createCheckout({ userId: 'user-1', customerId: 'cus_test_1', plan: 'pro_year', successUrl: '/subscribe/return?status=success', cancelUrl: '/subscribe/return?status=cancel', idempotencyKey: 'checkout:user-1:request-1' });
  assert.equal(result.sessionId, 'cs_test_1');
  assert.equal(result.url, 'https://checkout.stripe.com/c/pay/cs_test_1');
  const checkout = calls.find(call => call.url.includes('/checkout/sessions'));
  const body = new URLSearchParams(checkout.init.body);
  assert.equal(body.get('line_items[0][price]'), 'price_year');
  assert.equal(body.get('mode'), 'subscription');
  assert.equal(body.get('automatic_tax[enabled]'), 'true');
  assert.equal(body.get('billing_address_collection'), 'required');
  assert.equal(checkout.init.headers['Stripe-Version'], '2025-06-30.basil');
  assert.match(checkout.init.headers['Idempotency-Key'], /^oti_[a-f0-9]{64}$/);
  assert.notEqual(checkout.init.headers['Idempotency-Key'], 'checkout:user-1:request-1');
  assert.equal(calls.every(call => call.init.redirect === 'error'), true);
  await assert.rejects(() => provider.createCheckout({ userId: 'user-1', customerId: 'cus_test_1', plan: 'pro_month', successUrl: 'https://evil.example/ok', cancelUrl: '/return', idempotencyKey: 'another' }), /configured application origin/);
  unsafeCheckout = true;
  await assert.rejects(() => provider.createCheckout({ userId: 'user-1', customerId: 'cus_test_1', plan: 'pro_month', successUrl: '/return', cancelUrl: '/return', idempotencyKey: 'another-safe-url' }), /checkout URL outside the allowlist/);
});

test('provider idempotency keys are stable per owner and isolated across owners', async () => {
  const keys = [];
  const provider = new StripeBillingProvider(stripeConfig(), async (url, init) => {
    if (String(url).endsWith('/account')) return new Response(JSON.stringify({ id: 'acct_test_scope' }), { status: 200 });
    keys.push(init.headers['Idempotency-Key']);
    const userId = new URLSearchParams(init.body).get('metadata[app_user_id]');
    return new Response(JSON.stringify({ id: `cus_${userId}`, livemode: false, metadata: { app_user_id: userId, billing_account_id: 'acct_test_scope', billing_mode: 'test' } }), { status: 200 });
  });
  await provider.ensureCustomer({ userId: 'user-1', idempotencyKey: 'caller-chosen-key' });
  await provider.ensureCustomer({ userId: 'user-2', idempotencyKey: 'caller-chosen-key' });
  await provider.ensureCustomer({ userId: 'user-1', idempotencyKey: 'caller-chosen-key' });
  assert.match(keys[0], /^oti_[a-f0-9]{64}$/);
  assert.notEqual(keys[0], keys[1]);
  assert.equal(keys[0], keys[2]);
});

test('Stripe API credentials are verified against the configured account without assuming Account has livemode', async () => {
  const provider = new StripeBillingProvider(stripeConfig(), async () => new Response(JSON.stringify({ id: 'acct_other_scope' }), { status: 200 }));
  await assert.rejects(() => provider.ensureCustomer({ userId: 'user-1', idempotencyKey: 'customer:user-1:1' }), /configured Stripe account or mode/);
});

test('transient account verification failures are retried and provider 5xx mutations stay uncertain', async () => {
  let accountCalls = 0;
  const retrying = new StripeBillingProvider(stripeConfig(), async url => {
    if (String(url).endsWith('/account')) {
      accountCalls += 1;
      if (accountCalls === 1) throw new Error('network');
      return new Response(JSON.stringify({ id: 'acct_test_scope' }), { status: 200 });
    }
    return new Response(JSON.stringify({ id: 'cus_test', livemode: false, metadata: { app_user_id: 'user-1', billing_account_id: 'acct_test_scope', billing_mode: 'test' } }), { status: 200 });
  });
  await assert.rejects(() => retrying.ensureCustomer({ userId: 'user-1', idempotencyKey: 'customer:retry:1' }), error => error.code === 'unavailable');
  const created = await retrying.ensureCustomer({ userId: 'user-1', idempotencyKey: 'customer:retry:1' });
  assert.equal(created.customerId, 'cus_test');
  assert.equal(accountCalls, 2);

  const failingMutation = new StripeBillingProvider(stripeConfig(), async url => {
    if (String(url).endsWith('/account')) return new Response(JSON.stringify({ id: 'acct_test_scope' }), { status: 200 });
    return new Response('provider failure', { status: 503 });
  });
  await assert.rejects(() => failingMutation.ensureCustomer({ userId: 'user-1', idempotencyKey: 'customer:uncertain:1' }), error => error.code === 'uncertain' && error.uncertain === true);
});

test('Stripe Basil customer truth reads item billing periods and invoice payment parent collections', async () => {
  const calls = [];
  let unsafeInvoiceUrl = false;
  const provider = new StripeBillingProvider(stripeConfig(), async url => {
    const parsed = new URL(String(url));
    calls.push(parsed);
    const body = parsed.pathname.endsWith('/account') ? { id: 'acct_test_scope' }
      : parsed.pathname.endsWith('/customers/cus_test_1') ? { id: 'cus_test_1', livemode: false, metadata: { app_user_id: 'user-1', billing_account_id: 'acct_test_scope', billing_mode: 'test' } }
      : parsed.pathname.endsWith('/subscriptions') ? { data: [{ id: 'sub_test_1', customer: 'cus_test_1', status: 'active', cancel_at_period_end: false, livemode: false, metadata: { billing_account_id: 'acct_test_scope', billing_mode: 'test' }, items: { data: [{ price: 'price_month', quantity: 1, current_period_start: 1800000000, current_period_end: 1802592000 }] } }], has_more: false }
      : parsed.pathname.endsWith('/invoices') ? { data: [{ id: 'in_test_1', customer: 'cus_test_1', livemode: false, status: 'paid', amount_due: 2900, amount_paid: 2900, currency: 'usd', created: 1800000000, period_start: 1800000000, period_end: 1802592000, hosted_invoice_url: unsafeInvoiceUrl ? 'https://evil.example/invoice' : 'https://invoice.stripe.com/i/test-invoice', parent: { subscription_details: { subscription: 'sub_test_1' } }, payments: { data: [{ payment: { type: 'payment_intent', payment_intent: 'pi_test_1' } }] } }], has_more: false }
      : parsed.pathname.endsWith('/refunds') ? { data: [{ id: 're_test_1', livemode: false, payment_intent: 'pi_test_1', amount: 500, status: 'succeeded', reason: 'requested_by_customer', created: 1800000010 }], has_more: false }
      : parsed.pathname.endsWith('/disputes') ? { data: [{ id: 'dp_test_1', livemode: false, payment_intent: 'pi_test_1', amount: 2900, status: 'needs_response', reason: 'customer_initiated', created: 1800000020 }], has_more: false }
      : {};
    return new Response(JSON.stringify(body), { status: 200 });
  });
  const state = await provider.getCustomerState({ customerId: 'cus_test_1' });
  assert.equal(state.subscriptions[0].currentPeriodStart.toISOString(), '2027-01-15T08:00:00.000Z');
  assert.equal(state.subscriptions[0].currentPeriodEnd.toISOString(), '2027-02-14T08:00:00.000Z');
  assert.equal(state.invoices[0].subscriptionId, 'sub_test_1');
  assert.equal(state.invoices[0].paymentId, 'pi_test_1');
  assert.equal(state.invoices[0].periodEnd.toISOString(), '2027-02-14T08:00:00.000Z');
  assert.equal(state.invoices[0].hostedInvoiceUrl, 'https://invoice.stripe.com/i/test-invoice');
  assert.equal(state.subscriptions[0].latestPaymentId, 'pi_test_1');
  assert.equal(state.subscriptions[0].paidThrough.toISOString(), '2027-02-14T08:00:00.000Z');
  assert.equal(state.refunds[0].amountMinor, 500);
  assert.equal(state.disputes[0].status, 'needs_response');
  assert.equal(calls.find(call => call.pathname.endsWith('/invoices')).searchParams.get('expand[]'), 'data.payments');
  unsafeInvoiceUrl = true;
  await assert.rejects(() => provider.getCustomerState({ customerId: 'cus_test_1' }), /invoice URL outside the allowlist/);
});

test('Stripe cancellation verifies subscription account, mode, and customer before mutation', async () => {
  const calls = [];
  let omitScope = true;
  const provider = new StripeBillingProvider(stripeConfig(), async (url, init) => {
    const parsed = new URL(String(url));
    calls.push({ path: parsed.pathname, method: init.method });
    if (parsed.pathname.endsWith('/account')) return new Response(JSON.stringify({ id: 'acct_test_scope' }), { status: 200 });
    if (parsed.pathname.endsWith('/sub_test_1') && init.method === 'GET') {
      return new Response(JSON.stringify({ id: 'sub_test_1', customer: 'cus_test_1', status: 'active', livemode: false, metadata: omitScope ? {} : { billing_account_id: 'acct_test_scope', billing_mode: 'test' }, items: { data: [{ price: 'price_month', quantity: 1, current_period_start: 1800000000, current_period_end: 1802592000 }] } }), { status: 200 });
    }
    return new Response(JSON.stringify({ id: 'sub_test_1', customer: 'cus_test_1', status: 'canceled', livemode: false, metadata: { billing_account_id: 'acct_test_scope', billing_mode: 'test' }, items: { data: [{ price: 'price_month', quantity: 1, current_period_start: 1800000000, current_period_end: 1802592000 }] } }), { status: 200 });
  });
  await assert.rejects(() => provider.cancelSubscription({ subscriptionId: 'sub_test_1', atPeriodEnd: false, idempotencyKey: 'cancel:1' }), /does not match this customer and billing scope/);
  assert.equal(calls.some(call => call.path.endsWith('/sub_test_1') && call.method === 'DELETE'), false);
  omitScope = false;
  const result = await provider.cancelSubscription({ subscriptionId: 'sub_test_1', atPeriodEnd: false, idempotencyKey: 'cancel:2' });
  assert.equal(result.status, 'canceled');
  assert.deepEqual(calls.slice(-2).map(call => call.method), ['GET', 'DELETE']);
});

test('Stripe customer truth bounds invoice and payment history while limiting concurrent lookups', async () => {
  let currentPaymentLookups = 0;
  let maxPaymentLookups = 0;
  const paymentLookupCalls = [];
  let invoiceLimit;
  const invoices = Array.from({ length: 100 }, (_, index) => ({
    id: `in_${index}`, customer: 'cus_test_1', livemode: false, status: 'paid', amount_due: 2900, amount_paid: 2900,
    currency: 'usd', created: 1900000000 - index, period_end: 1900001000 - index,
    parent: { subscription_details: { subscription: `sub_${index}` } },
    payments: { data: [{ payment: { type: 'payment_intent', payment_intent: `pi_${index}` } }] }
  }));
  const provider = new StripeBillingProvider(stripeConfig(), async url => {
    const parsed = new URL(String(url));
    if (parsed.pathname.endsWith('/account')) return new Response(JSON.stringify({ id: 'acct_test_scope' }), { status: 200 });
    if (parsed.pathname.endsWith('/customers/cus_test_1')) return new Response(JSON.stringify({ id: 'cus_test_1', livemode: false, metadata: { billing_account_id: 'acct_test_scope', billing_mode: 'test' } }), { status: 200 });
    if (parsed.pathname.endsWith('/subscriptions')) return new Response(JSON.stringify({ data: [], has_more: false }), { status: 200 });
    if (parsed.pathname.endsWith('/invoices')) {
      invoiceLimit = parsed.searchParams.get('limit');
      return new Response(JSON.stringify({ data: invoices, has_more: true }), { status: 200 });
    }
    if (parsed.pathname.endsWith('/refunds') || parsed.pathname.endsWith('/disputes')) {
      currentPaymentLookups += 1;
      maxPaymentLookups = Math.max(maxPaymentLookups, currentPaymentLookups);
      paymentLookupCalls.push(parsed.pathname);
      await new Promise(resolve => setTimeout(resolve, 1));
      currentPaymentLookups -= 1;
      return new Response(JSON.stringify({ data: [], has_more: false }), { status: 200 });
    }
    return new Response('{}', { status: 200 });
  });
  const state = await provider.getCustomerState({ customerId: 'cus_test_1' });
  assert.equal(state.invoices.length, 100);
  assert.equal(invoiceLimit, '100');
  assert.equal(paymentLookupCalls.length, 48, 'only the 24 most recent payment references are expanded');
  assert.ok(maxPaymentLookups <= 8);
});

test('Stripe customer truth filters refunds and disputes by Charge IDs when Basil invoice payments use charges', async () => {
  const observed = [];
  const provider = new StripeBillingProvider(stripeConfig(), async url => {
    const parsed = new URL(String(url));
    observed.push(parsed);
    if (parsed.pathname.endsWith('/account')) return new Response(JSON.stringify({ id: 'acct_test_scope' }), { status: 200 });
    if (parsed.pathname.endsWith('/customers/cus_test_1')) return new Response(JSON.stringify({ id: 'cus_test_1', livemode: false, metadata: { billing_account_id: 'acct_test_scope', billing_mode: 'test' } }), { status: 200 });
    if (parsed.pathname.endsWith('/subscriptions')) return new Response(JSON.stringify({ data: [], has_more: false }), { status: 200 });
    if (parsed.pathname.endsWith('/invoices')) return new Response(JSON.stringify({ data: [{ id: 'in_charge', customer: 'cus_test_1', livemode: false, status: 'paid', amount_due: 2900, amount_paid: 2900, currency: 'usd', created: 1900000000, parent: { subscription_details: { subscription: 'sub_test' } }, payments: { data: [{ payment: { type: 'charge', charge: 'ch_test_1' } }] } }], has_more: false }), { status: 200 });
    if (parsed.pathname.endsWith('/refunds')) return new Response(JSON.stringify({ data: [{ id: 're_charge', charge: 'ch_test_1', livemode: false, amount: 300, status: 'succeeded', created: 1900000010 }], has_more: false }), { status: 200 });
    if (parsed.pathname.endsWith('/disputes')) return new Response(JSON.stringify({ data: [{ id: 'dp_charge', charge: 'ch_test_1', livemode: false, amount: 2900, status: 'needs_response', reason: 'customer_initiated', created: 1900000020 }], has_more: false }), { status: 200 });
    return new Response('{}', { status: 200 });
  });
  const state = await provider.getCustomerState({ customerId: 'cus_test_1' });
  assert.equal(state.invoices[0].paymentId, 'ch_test_1');
  assert.equal(state.refunds[0].paymentId, 'ch_test_1');
  assert.equal(state.disputes[0].paymentId, 'ch_test_1');
  const refundQuery = observed.find(url => url.pathname.endsWith('/refunds'));
  const disputeQuery = observed.find(url => url.pathname.endsWith('/disputes'));
  assert.equal(refundQuery.searchParams.get('charge'), 'ch_test_1');
  assert.equal(disputeQuery.searchParams.get('charge'), 'ch_test_1');
});

test('Stripe refund checks customer/subscription ownership and provider-side refundable remainder', async () => {
  const calls = [];
  let recoveredRefund = null;
  const provider = new StripeBillingProvider(stripeConfig(), async (url, init) => {
    const parsed = new URL(String(url));
    calls.push({ parsed, init });
    let body;
    if (parsed.pathname.endsWith('/account')) body = { id: 'acct_test_scope' };
    else if (parsed.pathname.endsWith('/customers/cus_other')) body = { id: 'cus_other', livemode: false, metadata: { billing_account_id: 'acct_test_scope', billing_mode: 'test' } };
    else if (parsed.pathname.endsWith('/customers/cus_test_1')) body = { id: 'cus_test_1', livemode: false, metadata: { billing_account_id: 'acct_test_scope', billing_mode: 'test' } };
    else if (parsed.pathname.endsWith('/subscriptions')) body = { data: [{ id: 'sub_test_1', customer: 'cus_test_1', status: 'active', livemode: false, metadata: { billing_account_id: 'acct_test_scope', billing_mode: 'test' }, items: { data: [{ price: 'price_month', quantity: 1, current_period_start: 1800000000, current_period_end: 1802592000 }] } }], has_more: false };
    else if (parsed.pathname.endsWith('/invoices')) body = { data: [{ id: 'in_test_1', customer: 'cus_test_1', livemode: false, status: 'paid', amount_due: 2900, amount_paid: 2900, currency: 'usd', created: 1800000000, parent: { subscription_details: { subscription: 'sub_test_1' } }, payments: { data: [{ payment: { type: 'payment_intent', payment_intent: 'pi_test_1' } }] } }], has_more: false };
    else if (parsed.pathname.endsWith('/refunds') && init.method === 'GET') body = { data: [
      { id: 're_existing', livemode: false, payment_intent: 'pi_test_1', amount: 500, status: 'succeeded', created: 1800000010 },
      ...(recoveredRefund ? [{ id: 're_new', livemode: false, payment_intent: 'pi_test_1', amount: 2400, status: 'succeeded', created: 1800000020, metadata: { app_billing_operation: 'op_refund_1' } }] : [])
    ], has_more: false };
    else if (parsed.pathname.endsWith('/disputes')) body = { data: [], has_more: false };
    else if (parsed.pathname.endsWith('/payment_intents/pi_test_1')) body = { id: 'pi_test_1', customer: 'cus_test_1', livemode: false, amount_received: 2900 };
    else if (parsed.pathname.endsWith('/refunds') && init.method === 'POST') {
      recoveredRefund = true;
      body = { id: 're_new', livemode: false, payment_intent: 'pi_test_1', status: 'succeeded', metadata: { app_billing_operation: 'op_refund_1' } };
    }
    else body = {};
    return new Response(JSON.stringify(body), { status: 200 });
  });
  await assert.rejects(() => provider.refund({ customerId: 'cus_test_1', subscriptionId: 'sub_test_1', paymentId: 'pi_test_1', amountMinor: 2401, reason: 'requested_by_customer', idempotencyKey: 'refund:user-1:too-large' }), /remaining refundable provider amount/);
  assert.equal(calls.some(({ parsed, init }) => parsed.pathname.endsWith('/refunds') && init.method === 'POST'), false);
  await assert.rejects(() => provider.refund({ customerId: 'cus_other', subscriptionId: 'sub_test_1', paymentId: 'pi_test_1', amountMinor: 100, reason: 'requested_by_customer', idempotencyKey: 'refund:user-1:wrong-customer' }), /does not match this customer and billing scope|does not belong to the requested customer subscription/);
  const result = await provider.refund({ customerId: 'cus_test_1', subscriptionId: 'sub_test_1', paymentId: 'pi_test_1', operationId: 'op_refund_1', amountMinor: 2400, reason: 'requested_by_customer', idempotencyKey: 'refund:user-1:valid' });
  assert.equal(result.refundId, 're_new');
  const postCall = calls.find(({ parsed, init }) => parsed.pathname.endsWith('/refunds') && init.method === 'POST');
  const body = new URLSearchParams(postCall.init.body);
  assert.equal(body.get('amount'), '2400');
  assert.equal(body.get('metadata[app_billing_operation]'), 'op_refund_1');
  const replay = await provider.refund({ customerId: 'cus_test_1', subscriptionId: 'sub_test_1', paymentId: 'pi_test_1', operationId: 'op_refund_1', amountMinor: 2400, reason: 'requested_by_customer', idempotencyKey: 'refund:user-1:valid' });
  assert.deepEqual(replay, { refundId: 're_new', status: 'succeeded' });
  assert.equal(calls.filter(({ parsed, init }) => parsed.pathname.endsWith('/refunds') && init.method === 'POST').length, 1);
});

test('Stripe webhook verification uses raw bytes, compares signatures in constant time, and enforces age/account/mode', async () => {
  const config = stripeConfig();
  const provider = new StripeBillingProvider(config);
  const payload = Buffer.from(JSON.stringify({ id: 'evt_test_1', object: 'event', type: 'invoice.payment_failed', created: Math.floor(Date.now() / 1000), livemode: false, account: config.providerAccountId, data: { object: { id: 'in_test', object: 'invoice', customer: 'cus_test', subscription: 'sub_test', payment_intent: 'pi_test', status: 'open', livemode: false, metadata: { billing_account_id: config.providerAccountId, billing_mode: 'test' } } } }));
  const timestamp = Math.floor(Date.now() / 1000);
  const signed = createHmac('sha256', config.stripeWebhookSecret).update(`${timestamp}.`).update(payload).digest('hex');
  const event = await provider.verifyWebhook(payload, `t=${timestamp},v1=${signed}`);
  assert.equal(event.eventId, 'evt_test_1');
  assert.equal(event.providerAccountId, config.providerAccountId);
  assert.equal(event.mode, 'test');
  assert.equal(event.customerId, 'cus_test');
  assert.equal(event.subscriptionId, 'sub_test');
  assert.equal(event.paymentId, 'pi_test');
  assert.equal(event.invoiceId, 'in_test');
  await assert.rejects(() => provider.verifyWebhook(payload, `t=${timestamp},v1=${'0'.repeat(64)}`), BillingProviderError);
  const stale = timestamp - 600;
  const staleSig = createHmac('sha256', config.stripeWebhookSecret).update(`${stale}.`).update(payload).digest('hex');
  await assert.rejects(() => provider.verifyWebhook(payload, `t=${stale},v1=${staleSig}`), /signature verification failed/);
  const wrongAccount = Buffer.from(payload.toString().replace(config.providerAccountId, 'acct_other_scope'));
  const wrongSig = createHmac('sha256', config.stripeWebhookSecret).update(`${timestamp}.`).update(wrongAccount).digest('hex');
  await assert.rejects(() => provider.verifyWebhook(wrongAccount, `t=${timestamp},v1=${wrongSig}`), /different billing account/);
});

test('fake webhook signatures are synthetic, timestamp bounded and scoped to the configured account', async () => {
  const config = createBillingProviderConfig(localEnv);
  const provider = new FakeBillingProvider(config, {});
  const timestamp = Math.floor(Date.now() / 1000);
  const payload = Buffer.from(JSON.stringify({ id: 'evt_demo_1', type: 'customer.subscription.updated', created: timestamp, livemode: false, account: config.providerAccountId, data: { object: { id: 'sub_demo', object: 'subscription', customer: 'cus_demo', status: 'active' } } }));
  const signature = createHmac('sha256', config.fakeWebhookSecret).update(`${timestamp}.`).update(payload).digest('hex');
  const event = await provider.verifyWebhook(payload, `t=${timestamp},v1=${signature}`);
  assert.equal(event.providerAccountId, config.providerAccountId);
  assert.equal(event.mode, 'test');
  assert.equal(event.eventId, 'evt_demo_1');
  const changed = Buffer.from(payload.toString().replace(config.providerAccountId, 'other-account'));
  const changedSignature = createHmac('sha256', config.fakeWebhookSecret).update(`${timestamp}.`).update(changed).digest('hex');
  await assert.rejects(() => provider.verifyWebhook(changed, `t=${timestamp},v1=${changedSignature}`), /different provider scope/);
});
