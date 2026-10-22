import { createHash, createHmac, timingSafeEqual } from 'node:crypto';
import type { BillingProviderConfig } from './provider-config.js';
import { safeBillingUrl } from './provider-config.js';
import type { BillingMode, BillingPlan, BillingPort, NormalizedBillingEvent, ProviderCustomer, ProviderCustomerState, ProviderDispute, ProviderInvoice, ProviderRefund, ProviderSubscription } from './provider.js';

type JsonObject = Record<string, unknown>;
export class BillingProviderError extends Error {
  constructor(message: string, readonly code: 'unavailable' | 'rejected' | 'uncertain' | 'invalid_response', readonly uncertain = false) {
    super(message);
    this.name = 'BillingProviderError';
  }
}

const obj = (value: unknown): JsonObject => value && typeof value === 'object' && !Array.isArray(value) ? value as JsonObject : {};
const str = (value: unknown): string | null => typeof value === 'string' && value.length ? value : null;
const epoch = (value: unknown): Date | null => typeof value === 'number' && Number.isFinite(value) ? new Date(value * 1000) : null;
const idOf = (value: unknown): string | null => typeof value === 'string' ? value : str(obj(value).id);
const list = (value: unknown): JsonObject[] => Array.isArray(value) ? value.map(obj) : [];
const form = (values: Record<string, string | number | boolean | undefined | null>) => {
  const body = new URLSearchParams();
  for (const [key, value] of Object.entries(values)) if (value !== undefined && value !== null) body.set(key, String(value));
  return body;
};
const enc = (id: string) => encodeURIComponent(id);
const providerIdempotencyKey = (accountId: string, mode: BillingMode, ownerScope: string, key: string) => `oti_${createHash('sha256').update(`${accountId}\0${mode}\0${ownerScope}\0${key}`).digest('hex')}`;
const CUSTOMER_STATE_DEADLINE_MS = 5000;
function trustedStripeUrl(raw: string, hosts: readonly string[], label: string): string {
  let url: URL;
  try { url = new URL(raw); } catch { throw new BillingProviderError(`The provider returned an invalid ${label} URL.`, 'invalid_response', true); }
  if (url.protocol !== 'https:' || !hosts.includes(url.hostname.toLowerCase()) || (url.port !== '' && url.port !== '443') || url.username || url.password) {
    throw new BillingProviderError(`The provider returned a ${label} URL outside the allowlist.`, 'invalid_response', true);
  }
  return url.toString();
}

export class StripeBillingProvider implements BillingPort {
  readonly provider = 'stripe' as const;
  readonly providerAccountId: string;
  readonly mode: BillingMode;
  private readonly config: BillingProviderConfig;
  private scopeVerified: Promise<void> | null = null;
  private pricesVerified: Promise<void> | null = null;

  constructor(config: BillingProviderConfig, private readonly request: typeof fetch = fetch) {
    if (config.provider !== 'stripe' || !config.stripeSecretKey || !config.stripeWebhookSecret || !config.stripePriceProMonth || !config.stripePriceProYear) throw new Error('Stripe billing configuration is incomplete.');
    this.config = config;
    this.providerAccountId = config.providerAccountId;
    this.mode = config.mode;
  }

  private async call(path: string, method: 'GET' | 'POST' | 'DELETE', values?: URLSearchParams, idempotencyKey?: string, deadlineAt?: number): Promise<JsonObject> {
    if (!this.scopeVerified) this.scopeVerified = this.verifyProviderAccount();
    try { await this.scopeVerified; } catch (error) { this.scopeVerified = null; throw error; }
    const url = new URL(`${this.config.apiBaseUrl}/${path.replace(/^\//, '')}`);
    if (method === 'GET' && values) url.search = values.toString();
    const headers: Record<string, string> = {
      Authorization: `Bearer ${this.config.stripeSecretKey}`,
      'Stripe-Version': this.config.apiVersion,
      Accept: 'application/json'
    };
    if (idempotencyKey) headers['Idempotency-Key'] = idempotencyKey;
    if (method === 'POST') headers['Content-Type'] = 'application/x-www-form-urlencoded';
    const remainingMs = deadlineAt === undefined ? this.config.timeoutMs : Math.min(this.config.timeoutMs, deadlineAt - Date.now());
    if (remainingMs <= 0) throw new BillingProviderError('The billing provider state read exceeded its bounded time limit.', 'unavailable');
    let response: Response;
    try {
      response = await this.request(url, {
        method,
        headers,
        ...(method === 'POST' ? { body: values?.toString() ?? '' } : {}),
        redirect: 'error',
        signal: AbortSignal.timeout(remainingMs)
      });
    } catch {
      // A timed-out mutation may have committed. The caller must reconcile using this stable key.
      throw new BillingProviderError('The billing provider request did not complete; provider state must be reconciled.', 'uncertain', method !== 'GET');
    }
    if (response.status >= 500 && method !== 'GET') throw new BillingProviderError('The billing provider could not confirm whether the operation completed; reconcile provider state before retrying.', 'uncertain', true);
    let payload: JsonObject;
    try {
      payload = obj(await response.json());
    } catch {
      throw new BillingProviderError('The billing provider returned an invalid response.', 'invalid_response', method !== 'GET');
    }
    if (!response.ok) {
      const rawCode = str(obj(payload.error).code);
      const code = rawCode && /^[A-Za-z0-9_]{1,80}$/.test(rawCode) ? rawCode : null;
      // Do not propagate provider bodies/messages, which can contain customer data or URLs.
      throw new BillingProviderError(`The billing provider rejected the request${code ? ` (${code})` : ''}.`, 'rejected');
    }
    return payload;
  }

  private async listAll(path: string, values: Record<string, string>, deadlineAt?: number): Promise<JsonObject[]> {
    const rows: JsonObject[] = [];
    let startingAfter: string | undefined;
    for (let page = 0; page < 20; page += 1) {
      const params = form({ ...values, limit: 100, starting_after: startingAfter });
      const response = await this.call(path, 'GET', params, undefined, deadlineAt);
      const data = obj(response).data;
      if (!Array.isArray(data) || typeof response.has_more !== 'boolean') throw new BillingProviderError('The provider list response was incomplete.', 'invalid_response');
      const pageRows = list(data);
      rows.push(...pageRows);
      if (!response.has_more) return rows;
      const lastId = pageRows.length ? str(pageRows.at(-1)?.id) : null;
      if (!lastId || lastId === startingAfter) throw new BillingProviderError('The provider list response could not be paged safely.', 'invalid_response');
      startingAfter = lastId;
    }
    throw new BillingProviderError('The provider returned too much billing history to reconcile safely.', 'unavailable');
  }

  private async listRecent(path: string, values: Record<string, string>, deadlineAt: number, limit = 100, requireComplete = false): Promise<JsonObject[]> {
    const response = await this.call(path, 'GET', form({ ...values, limit }), undefined, deadlineAt);
    if (!Array.isArray(response.data) || typeof response.has_more !== 'boolean') throw new BillingProviderError('The provider list response was incomplete.', 'invalid_response');
    if (requireComplete && response.has_more) throw new BillingProviderError('The provider returned too much payment history to reconcile safely.', 'unavailable');
    return list(response.data);
  }

  private async verifyConfiguredPrices(): Promise<void> {
    const entries = [
      { id: this.config.stripePriceProMonth!, amount: 2900, interval: 'month' },
      { id: this.config.stripePriceProYear!, amount: 29000, interval: 'year' }
    ];
    const prices = await Promise.all(entries.map(entry => this.call(`prices/${enc(entry.id)}`, 'GET')));
    let productId: string | null = null;
    prices.forEach((price, index) => {
      const expected = entries[index]!;
      const recurring = obj(price.recurring);
      const actualProduct = idOf(price.product);
      this.checkMode(price.livemode);
      if (price.id !== expected.id || price.active !== true || price.currency !== 'usd' || price.unit_amount !== expected.amount || recurring.interval !== expected.interval || recurring.interval_count !== 1 || !actualProduct) {
        throw new BillingProviderError('Configured Stripe prices do not match the fixed USD Pro catalog.', 'invalid_response');
      }
      if (productId && productId !== actualProduct) throw new BillingProviderError('Configured Pro prices must belong to one billing product.', 'invalid_response');
      productId = actualProduct;
    });
  }

  private async ensurePricesVerified(): Promise<void> {
    if (!this.pricesVerified) this.pricesVerified = this.verifyConfiguredPrices();
    try { await this.pricesVerified; } catch (error) { this.pricesVerified = null; throw error; }
  }

  private async verifyProviderAccount(): Promise<void> {
    let response: Response;
    try {
      response = await this.request(`${this.config.apiBaseUrl}/account`, {
        method: 'GET',
        headers: { Authorization: `Bearer ${this.config.stripeSecretKey}`, 'Stripe-Version': this.config.apiVersion, Accept: 'application/json' },
        redirect: 'error',
        signal: AbortSignal.timeout(this.config.timeoutMs)
      });
      const account = obj(await response.json());
      // Stripe Account objects have no `livemode`; bind account by returned ID and mode by
      // secret-key prefix (configuration), then require livemode on every actual billing resource.
      if (!response.ok || account.id !== this.providerAccountId) {
        throw new BillingProviderError('The configured Stripe account or mode does not match the API key.', 'invalid_response');
      }
    } catch (error) {
      if (error instanceof BillingProviderError) throw error;
      throw new BillingProviderError('The configured Stripe account could not be verified.', 'unavailable');
    }
  }

  private assertCustomer(customer: JsonObject, customerId: string, userId?: string): void {
    this.checkMode(customer.livemode);
    const metadata = obj(customer.metadata);
    if (str(customer.id) !== customerId || str(metadata.billing_account_id) !== this.providerAccountId || str(metadata.billing_mode) !== this.mode || (userId && str(metadata.app_user_id) !== userId)) {
      throw new BillingProviderError('The provider customer does not match this user and billing scope.', 'invalid_response');
    }
  }

  private checkMode(value: unknown): void {
    if (typeof value !== 'boolean' || value !== (this.mode === 'live')) throw new BillingProviderError('The provider object is missing the configured billing mode or belongs to a different mode.', 'invalid_response');
  }

  private subscription(value: unknown, customerId?: string): ProviderSubscription {
    const row = obj(value);
    this.checkMode(row.livemode);
    const actualCustomer = idOf(row.customer);
    const customer = actualCustomer ?? customerId;
    const metadata = obj(row.metadata);
    if (!str(row.id) || !customer) throw new BillingProviderError('The provider subscription response was incomplete.', 'invalid_response');
    if (!actualCustomer || (customerId && actualCustomer !== customerId) || metadata.billing_account_id !== this.providerAccountId || metadata.billing_mode !== this.mode) {
      throw new BillingProviderError('The provider subscription does not match this customer and billing scope.', 'invalid_response');
    }
    const item = obj(list(obj(row.items).data)[0]);
    const priceId = idOf(item.price);
    const items = list(obj(row.items).data);
    const recognizedPlan = items.length === 1 && item.quantity === 1
      ? priceId === this.config.stripePriceProMonth ? 'pro_month' : priceId === this.config.stripePriceProYear ? 'pro_year' : null
      : null;
    const currentPeriodStart = items.map(value => epoch(value.current_period_start)).filter((value): value is Date => !!value).sort((a, b) => a.getTime() - b.getTime())[0] ?? null;
    const currentPeriodEnd = items.map(value => epoch(value.current_period_end)).filter((value): value is Date => !!value).sort((a, b) => a.getTime() - b.getTime()).at(-1) ?? null;
    const latestInvoice = obj(row.latest_invoice);
    return {
      providerAccountId: this.providerAccountId,
      mode: this.mode,
      subscriptionId: String(row.id),
      customerId: customer,
      ...(str(metadata.app_user_id) ? { userId: str(metadata.app_user_id)! } : {}),
      plan: recognizedPlan,
      status: str(row.status) ?? 'unknown',
      currentPeriodStart,
      currentPeriodEnd,
      paidThrough: null,
      cancelAtPeriodEnd: row.cancel_at_period_end === true,
      canceledAt: epoch(row.canceled_at),
      latestPaymentId: this.paymentFromInvoice(latestInvoice),
      reason: str(obj(row.cancellation_details).reason),
      // Stripe does not expose the first failed-at timestamp in a subscription snapshot.
      // Use its stable current period boundary as a conservative episode anchor; webhook
      // invoice.payment_failed timestamps remain the precise evidence when delivered.
      firstFailureAt: str(row.status) === 'past_due' ? currentPeriodStart : null
    };
  }

  private invoice(value: unknown): ProviderInvoice {
    const row = obj(value);
    this.checkMode(row.livemode);
    const customerId = idOf(row.customer);
    if (!str(row.id) || !customerId) throw new BillingProviderError('The provider invoice response was incomplete.', 'invalid_response');
    const amountDue = row.amount_due;
    const amountPaid = row.amount_paid;
    if (typeof amountDue !== 'number' || !Number.isSafeInteger(amountDue) || typeof amountPaid !== 'number' || !Number.isSafeInteger(amountPaid)) throw new BillingProviderError('The provider invoice amount was invalid.', 'invalid_response');
    const parent = obj(row.parent);
    const subscriptionDetails = obj(parent.subscription_details);
    const paymentEntries = list(obj(row.payments).data);
    const payment = obj(paymentEntries[0]?.payment);
    const paymentRef = payment.type === 'payment_intent' ? payment.payment_intent : payment.type === 'charge' ? payment.charge : null;
    const linePeriods = list(obj(row.lines).data).map(line => obj(line.period));
    const periodStart = linePeriods.map(period => epoch(period.start)).filter((date): date is Date => !!date).sort((a, b) => a.getTime() - b.getTime())[0] ?? epoch(row.period_start);
    const periodEnd = linePeriods.map(period => epoch(period.end)).filter((date): date is Date => !!date).sort((a, b) => a.getTime() - b.getTime()).at(-1) ?? epoch(row.period_end);
    return {
      providerAccountId: this.providerAccountId,
      mode: this.mode,
      invoiceId: String(row.id),
      customerId,
      subscriptionId: idOf(subscriptionDetails.subscription),
      status: str(row.status) ?? 'unknown',
      amountDue,
      amountPaid,
      currency: str(row.currency) ?? 'usd',
      createdAt: epoch(row.created) ?? new Date(0),
      periodStart,
      periodEnd,
      hostedInvoiceUrl: str(row.hosted_invoice_url) ? trustedStripeUrl(str(row.hosted_invoice_url)!, ['invoice.stripe.com', 'pay.stripe.com', 'billing.stripe.com'], 'invoice') : null,
      paymentId: idOf(paymentRef)
    };
  }

  private paymentFromInvoice(invoice: JsonObject): string | null {
    const entries = list(obj(invoice.payments).data);
    for (const entry of entries) {
      const payment = obj(entry.payment);
      const id = payment.type === 'payment_intent' ? idOf(payment.payment_intent) : payment.type === 'charge' ? idOf(payment.charge) : null;
      if (id) return id;
    }
    // Expanded invoice objects from older stored webhook versions may contain this legacy shape.
    return idOf(invoice.payment_intent);
  }

  async ensureCustomer(input: { userId: string; email?: string; existingCustomerId?: string | null; idempotencyKey: string }): Promise<ProviderCustomer> {
    if (input.existingCustomerId) {
      const customer = await this.call(`customers/${enc(input.existingCustomerId)}`, 'GET');
      this.assertCustomer(customer, input.existingCustomerId, input.userId);
      return { providerAccountId: this.providerAccountId, mode: this.mode, customerId: String(customer.id), userId: input.userId };
    }
    const created = await this.call('customers', 'POST', form({
      email: input.email,
      'metadata[app_user_id]': input.userId,
      'metadata[billing_account_id]': this.providerAccountId,
      'metadata[billing_mode]': this.mode
    }), providerIdempotencyKey(this.providerAccountId, this.mode, input.userId, input.idempotencyKey));
    this.checkMode(created.livemode);
    if (!str(created.id)) throw new BillingProviderError('The provider customer response was incomplete.', 'invalid_response', true);
    this.assertCustomer(created, String(created.id), input.userId);
    return { providerAccountId: this.providerAccountId, mode: this.mode, customerId: String(created.id), userId: input.userId };
  }

  async createCheckout(input: { userId: string; customerId: string; plan: BillingPlan; successUrl: string; cancelUrl: string; idempotencyKey: string }): Promise<{ sessionId: string; url: string; expiresAt: Date }> {
    const successUrl = safeBillingUrl(input.successUrl, this.config.appOrigin);
    const cancelUrl = safeBillingUrl(input.cancelUrl, this.config.appOrigin);
    const customer = await this.call(`customers/${enc(input.customerId)}`, 'GET');
    this.assertCustomer(customer, input.customerId, input.userId);
    const existing = await this.getCustomerState({ customerId: input.customerId });
    const now = new Date();
    if (existing.subscriptions.some(subscription =>
      (['active', 'trialing', 'past_due'].includes(subscription.status) && (subscription.paidThrough ?? subscription.currentPeriodEnd ?? now) > now) ||
      (subscription.paidThrough !== null && subscription.paidThrough > now)
    )) throw new BillingProviderError('An existing provider subscription prevents a new checkout.', 'rejected');
    await this.ensurePricesVerified();
    const price = input.plan === 'pro_month' ? this.config.stripePriceProMonth! : this.config.stripePriceProYear!;
    const row = await this.call('checkout/sessions', 'POST', form({
      mode: 'subscription',
      customer: input.customerId,
      client_reference_id: input.userId,
      success_url: successUrl,
      cancel_url: cancelUrl,
      'line_items[0][price]': price,
      'line_items[0][quantity]': 1,
      'automatic_tax[enabled]': true,
      billing_address_collection: 'required',
      'metadata[app_user_id]': input.userId,
      'metadata[billing_account_id]': this.providerAccountId,
      'metadata[billing_mode]': this.mode,
      'subscription_data[metadata][app_user_id]': input.userId,
      'subscription_data[metadata][billing_account_id]': this.providerAccountId,
      'subscription_data[metadata][billing_mode]': this.mode
    }), providerIdempotencyKey(this.providerAccountId, this.mode, input.userId, input.idempotencyKey));
    this.checkMode(row.livemode);
    const id = str(row.id);
    const url = str(row.url);
    const expiresAt = epoch(row.expires_at);
    if (!id || !url || !expiresAt || idOf(row.customer) !== input.customerId || str(row.client_reference_id) !== input.userId || str(obj(row.metadata).billing_account_id) !== this.providerAccountId || str(obj(row.metadata).billing_mode) !== this.mode) throw new BillingProviderError('The provider checkout response was incomplete or outside the requested billing scope.', 'invalid_response', true);
    return { sessionId: id, url: trustedStripeUrl(url, ['checkout.stripe.com'], 'checkout'), expiresAt };
  }

  async createPortal(input: { customerId: string; returnUrl: string; idempotencyKey: string }): Promise<{ url: string }> {
    const customer = await this.call(`customers/${enc(input.customerId)}`, 'GET');
    this.assertCustomer(customer, input.customerId);
    const returnUrl = safeBillingUrl(input.returnUrl, this.config.appOrigin);
    const row = await this.call('billing_portal/sessions', 'POST', form({ customer: input.customerId, return_url: returnUrl, configuration: this.config.stripePortalConfigurationId }), providerIdempotencyKey(this.providerAccountId, this.mode, input.customerId, input.idempotencyKey));
    this.checkMode(row.livemode);
    const url = str(row.url);
    if (!url || idOf(row.customer) !== input.customerId || str(row.return_url) !== returnUrl) throw new BillingProviderError('The provider portal response was incomplete or outside the requested billing scope.', 'invalid_response', true);
    return { url: trustedStripeUrl(url, ['billing.stripe.com'], 'portal') };
  }

  async getCustomerState(input: { customerId: string }): Promise<ProviderCustomerState> {
    const deadlineAt = Date.now() + CUSTOMER_STATE_DEADLINE_MS;
    const [customer, subscriptions, invoiceRows] = await Promise.all([
      this.call(`customers/${enc(input.customerId)}`, 'GET', undefined, undefined, deadlineAt),
      this.listAll('subscriptions', { customer: input.customerId, status: 'all' }, deadlineAt),
      this.listRecent('invoices', { customer: input.customerId, 'expand[]': 'data.payments' }, deadlineAt)
    ]);
    this.assertCustomer(customer, input.customerId);
    const normalizedInvoices = invoiceRows.map(value => this.invoice(value));
    // Current UI/provider reconciliation needs only recent payment-linked truth. Older
    // invoice snapshots remain persisted by the billing domain and are never removed here.
    const paymentIds = [...new Set(normalizedInvoices.slice(0, 24).map(invoice => invoice.paymentId).filter((id): id is string => !!id))];
    const refunds: ProviderRefund[] = [];
    const disputes: ProviderDispute[] = [];
    let nextPayment = 0;
    const readPaymentTruth = async () => {
      while (nextPayment < paymentIds.length) {
        const paymentId = paymentIds[nextPayment++]!;
        const paymentFilter = paymentId.startsWith('pi_') ? { payment_intent: paymentId } : { charge: paymentId };
        const [refundResult, disputeResult] = await Promise.all([
          this.listRecent('refunds', paymentFilter, deadlineAt, 100, true),
          this.listRecent('disputes', paymentFilter, deadlineAt, 100, true)
        ]);
      for (const row of refundResult) {
        this.checkMode(row.livemode);
        if (typeof row.amount !== 'number' || !Number.isSafeInteger(row.amount) || !str(row.id) || (idOf(row.payment_intent) !== paymentId && idOf(row.charge) !== paymentId)) throw new BillingProviderError('The provider refund response was invalid or outside its payment scope.', 'invalid_response');
        refunds.push({ providerAccountId: this.providerAccountId, mode: this.mode, refundId: String(row.id), operationId: str(obj(row.metadata).app_billing_operation), paymentId, amountMinor: row.amount, status: str(row.status) ?? 'unknown', reason: str(row.reason), createdAt: epoch(row.created) ?? new Date(0) });
      }
      for (const row of disputeResult) {
        this.checkMode(row.livemode);
        if (typeof row.amount !== 'number' || !Number.isSafeInteger(row.amount) || !str(row.id) || (idOf(row.payment_intent) !== paymentId && idOf(row.charge) !== paymentId)) throw new BillingProviderError('The provider dispute response was invalid or outside its payment scope.', 'invalid_response');
        disputes.push({ providerAccountId: this.providerAccountId, mode: this.mode, disputeId: String(row.id), paymentId, amountMinor: row.amount, status: str(row.status) ?? 'unknown', reason: str(row.reason), createdAt: epoch(row.created) ?? new Date(0), resolvedAt: epoch(row.closed_at) });
      }
      }
    };
    // Two bounded list requests per worker: cap in-flight provider calls at eight.
    await Promise.all(Array.from({ length: Math.min(4, paymentIds.length) }, () => readPaymentTruth()));
    return {
      providerAccountId: this.providerAccountId,
      mode: this.mode,
      customerId: input.customerId,
      subscriptions: subscriptions.map(value => {
        const sub = this.subscription(value, input.customerId);
        const related = normalizedInvoices.filter(invoice => invoice.subscriptionId === sub.subscriptionId);
        const latestInvoice = related.sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime())[0];
        const paidThrough = related.filter(invoice => invoice.status === 'paid' && invoice.amountPaid > 0).map(invoice => invoice.periodEnd).filter((date): date is Date => !!date).sort((a, b) => b.getTime() - a.getTime())[0] ?? null;
        return { ...sub, paidThrough, ...(latestInvoice?.paymentId ? { latestPaymentId: latestInvoice.paymentId } : {}) };
      }),
      invoices: normalizedInvoices,
      refunds,
      disputes
    };
  }

  async verifyWebhook(rawBody: Uint8Array, signatureHeader?: string): Promise<NormalizedBillingEvent> {
    const secret = this.config.stripeWebhookSecret!;
    const values = (signatureHeader ?? '').split(',').map(part => part.trim().split('=', 2) as [string, string]);
    const timestampText = values.find(([key]) => key === 't')?.[1];
    const timestamp = Number(timestampText);
    const candidates = values.filter(([key]) => key === 'v1').map(([, value]) => value).filter(value => /^[a-f0-9]{64}$/i.test(value));
    if (!Number.isSafeInteger(timestamp) || !candidates.length || Math.abs(Date.now() / 1000 - timestamp) > this.config.webhookToleranceSeconds) throw new BillingProviderError('Webhook signature verification failed.', 'rejected');
    const raw = Buffer.from(rawBody).toString('utf8');
    const expected = createHmac('sha256', secret).update(`${timestamp}.`).update(Buffer.from(rawBody)).digest();
    const valid = candidates.some(candidate => {
      const supplied = Buffer.from(candidate, 'hex');
      return supplied.length === expected.length && timingSafeEqual(supplied, expected);
    });
    if (!valid) throw new BillingProviderError('Webhook signature verification failed.', 'rejected');
    let event: JsonObject;
    try {
      event = obj(JSON.parse(raw));
    } catch {
      throw new BillingProviderError('The signed webhook payload was invalid.', 'invalid_response');
    }
    const livemode = event.livemode;
    if (typeof livemode !== 'boolean' || (livemode ? 'live' : 'test') !== this.mode) throw new BillingProviderError('The webhook belongs to a different billing mode.', 'rejected');
    const eventAccount = str(event.account);
    if (eventAccount && eventAccount !== this.providerAccountId) throw new BillingProviderError('The webhook belongs to a different billing account.', 'rejected');
    const created = epoch(event.created);
    const eventId = str(event.id);
    const type = str(event.type);
    if (!created || !eventId || !type) throw new BillingProviderError('The signed webhook payload was incomplete.', 'invalid_response');
    const data = obj(obj(event.data).object);
    const metadata = obj(data.metadata);
    if (str(metadata.billing_account_id) && metadata.billing_account_id !== this.providerAccountId) throw new BillingProviderError('The webhook object belongs to a different billing account.', 'rejected');
    if (str(metadata.billing_mode) && metadata.billing_mode !== this.mode) throw new BillingProviderError('The webhook object belongs to a different billing mode.', 'rejected');
    const object = str(data.object);
    this.checkMode(data.livemode);
    const subscriptionId = object === 'subscription' ? str(data.id) : idOf(data.subscription) ?? idOf(obj(obj(data.parent).subscription_details).subscription);
    let customerId = idOf(data.customer);
    const paymentId = idOf(data.payment_intent) ?? (object === 'dispute' ? idOf(data.charge) : null) ?? idOf(data.charge) ?? idOf(data.latest_charge);
    if (!customerId && paymentId && (object === 'dispute' || object === 'refund' || object === 'charge')) {
      const payment = await this.call(`${paymentId.startsWith('pi_') ? 'payment_intents' : 'charges'}/${enc(paymentId)}`, 'GET');
      this.checkMode(payment.livemode);
      customerId = idOf(payment.customer);
    }
    const checkoutSessionId = object === 'checkout.session' ? str(data.id) : null;
    return {
      providerAccountId: this.providerAccountId,
      mode: this.mode,
      eventId,
      type,
      createdAt: created,
      customerId,
      subscriptionId,
      paymentId,
      invoiceId: object === 'invoice' ? str(data.id) : idOf(obj(obj(data.parent).subscription_details).invoice),
      checkoutSessionId,
      objectStatus: str(data.status),
      reason: str(data.cancellation_reason) ?? str(data.failure_message) ?? str(obj(data.cancellation_details).reason)
    };
  }

  async refund(input: { customerId: string; subscriptionId: string; paymentId: string; operationId?: string; amountMinor?: number; reason: 'duplicate' | 'fraudulent' | 'requested_by_customer'; idempotencyKey: string }): Promise<{ refundId: string; status: string }> {
    if (!/^(pi|ch)_/.test(input.paymentId)) throw new BillingProviderError('A recognized provider payment ID is required.', 'rejected');
    if (input.operationId !== undefined && (!input.operationId || input.operationId.length > 255)) throw new BillingProviderError('The billing operation reference is invalid.', 'rejected');
    if (input.amountMinor !== undefined && (!Number.isSafeInteger(input.amountMinor) || input.amountMinor <= 0)) throw new BillingProviderError('Refund amount must be a positive integer in the smallest currency unit.', 'rejected');
    const state = await this.getCustomerState({ customerId: input.customerId });
    const subscription = state.subscriptions.find(value => value.subscriptionId === input.subscriptionId && value.customerId === input.customerId);
    const invoice = state.invoices.find(value => value.subscriptionId === input.subscriptionId && value.paymentId === input.paymentId && value.customerId === input.customerId);
    if (!subscription || !invoice) throw new BillingProviderError('The payment does not belong to the requested customer subscription.', 'rejected');
    const payment = await this.call(`${input.paymentId.startsWith('pi_') ? 'payment_intents' : 'charges'}/${enc(input.paymentId)}`, 'GET');
    this.checkMode(payment.livemode);
    if (idOf(payment.customer) !== input.customerId) throw new BillingProviderError('The payment belongs to another provider customer.', 'rejected');
    const matchingRecentInvoice = state.invoices.slice().sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime()).slice(0, 24).some(row => row.paymentId === input.paymentId);
    const deadlineAt = Date.now() + CUSTOMER_STATE_DEADLINE_MS;
    const paymentRefunds = matchingRecentInvoice
      ? state.refunds.filter(refund => refund.paymentId === input.paymentId)
      : (await this.listRecent('refunds', input.paymentId.startsWith('pi_') ? { payment_intent: input.paymentId } : { charge: input.paymentId }, deadlineAt, 100, true)).map(row => ({
          refundId: str(row.id) ?? '', paymentId: input.paymentId, operationId: str(obj(row.metadata).app_billing_operation),
          amountMinor: typeof row.amount === 'number' ? row.amount : 0, status: str(row.status) ?? 'unknown'
        }));
    if (input.operationId) {
      const prior = paymentRefunds.find(refund => refund.operationId === input.operationId);
      if (prior) return { refundId: prior.refundId, status: prior.status };
    }
    const paymentAmount = input.paymentId.startsWith('pi_') ? payment.amount_received : payment.amount;
    if (typeof paymentAmount !== 'number' || !Number.isSafeInteger(paymentAmount) || paymentAmount < 0) throw new BillingProviderError('The provider payment amount is unavailable for refund validation.', 'invalid_response');
    const alreadyRefunded = paymentRefunds.filter(refund => ['pending', 'succeeded'].includes(refund.status)).reduce((sum, refund) => sum + refund.amountMinor, 0);
    const requested = input.amountMinor ?? paymentAmount;
    if (requested > paymentAmount - alreadyRefunded) throw new BillingProviderError('The requested refund exceeds the remaining refundable provider amount.', 'rejected');
    const row = await this.call('refunds', 'POST', form({
      [input.paymentId.startsWith('pi_') ? 'payment_intent' : 'charge']: input.paymentId,
      amount: input.amountMinor,
      reason: input.reason,
      ...(input.operationId ? { 'metadata[app_billing_operation]': input.operationId } : {})
    }), providerIdempotencyKey(this.providerAccountId, this.mode, `${input.customerId}:${input.subscriptionId}:${input.paymentId}`, input.idempotencyKey));
    this.checkMode(row.livemode);
    if (idOf(row.payment_intent) !== input.paymentId && idOf(row.charge) !== input.paymentId) throw new BillingProviderError('The provider refund response did not match the requested payment.', 'invalid_response', true);
    const refundId = str(row.id);
    const status = str(row.status);
    if (!refundId || !status || (input.operationId && str(obj(row.metadata).app_billing_operation) !== input.operationId)) throw new BillingProviderError('The provider refund response was incomplete.', 'invalid_response', true);
    return { refundId, status };
  }

  async cancelSubscription(input: { subscriptionId: string; atPeriodEnd: boolean; idempotencyKey: string }): Promise<ProviderSubscription> {
    const current = await this.call(`subscriptions/${enc(input.subscriptionId)}`, 'GET');
    const verified = this.subscription(current);
    if (verified.subscriptionId !== input.subscriptionId) throw new BillingProviderError('The provider subscription does not match the requested cancellation.', 'invalid_response');
    const row = input.atPeriodEnd
      ? await this.call(`subscriptions/${enc(input.subscriptionId)}`, 'POST', form({ cancel_at_period_end: true }), providerIdempotencyKey(this.providerAccountId, this.mode, input.subscriptionId, input.idempotencyKey))
      : await this.call(`subscriptions/${enc(input.subscriptionId)}`, 'DELETE', undefined, providerIdempotencyKey(this.providerAccountId, this.mode, input.subscriptionId, input.idempotencyKey));
    return this.subscription(row);
  }
}
