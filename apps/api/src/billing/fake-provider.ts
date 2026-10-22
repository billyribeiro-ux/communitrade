import { createHmac, createHash, randomUUID, timingSafeEqual } from 'node:crypto';
import type { Database } from '../database.js';
import { safeBillingUrl } from './provider-config.js';
import type { BillingProviderConfig } from './provider-config.js';
import { BillingProviderError } from './stripe-provider.js';
import type { BillingMode, BillingPlan, BillingPort, FakeBillingScenarioPort, NormalizedBillingEvent, ProviderCustomer, ProviderCustomerState, ProviderDispute, ProviderInvoice, ProviderRefund, ProviderSubscription } from './provider.js';

type Row = Record<string, any>;
type Delegate = {
  findUnique(args: Row): Promise<Row | null>;
  findFirst(args: Row): Promise<Row | null>;
  findMany(args: Row): Promise<Row[]>;
  create(args: Row): Promise<Row>;
  update(args: Row): Promise<Row>;
  updateMany(args: Row): Promise<{ count: number }>;
  upsert?(args: Row): Promise<Row>;
};
type FakeDb = {
  fakeBillingCustomer: Delegate;
  fakeBillingCheckout: Delegate;
  fakeBillingSubscription: Delegate;
  fakeBillingInvoice: Delegate;
  fakeBillingRefund: Delegate;
  fakeBillingDispute: Delegate;
  fakeBillingOperation: Delegate;
  fakeBillingEvent: Delegate;
  $queryRaw<T = unknown>(query: TemplateStringsArray, ...values: unknown[]): Promise<T>;
  $transaction<T>(callback: (transaction: FakeDb) => Promise<T>): Promise<T>;
};
type StoredEventPayload = { id: string; type: string; created: number; livemode: boolean; account: string; data: { object: Row } };
type OperationResult = Record<string, unknown>;

const hash = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const makeId = (prefix: string, key: string) => `${prefix}_${createHash('sha256').update(key).digest('hex').slice(0, 32)}`;
const makeUuid = (key: string) => {
  const bytes = createHash('sha256').update(key).digest().subarray(0, 16);
  bytes[6] = (bytes[6]! & 0x0f) | 0x40;
  bytes[8] = (bytes[8]! & 0x3f) | 0x80;
  const hex = bytes.toString('hex');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
};
const isUniqueViolation = (error: unknown) => (error as { code?: string })?.code === 'P2002';
const checkoutStatuses = ['open', 'complete', 'canceled', 'expired'] as const;
const dollarCents: Record<BillingPlan, number> = { pro_month: 2900, pro_year: 29000 };
function periodEnd(start: Date, plan: BillingPlan): Date {
  const end = new Date(start);
  const day = end.getUTCDate();
  if (plan === 'pro_month') {
    end.setUTCDate(1);
    end.setUTCMonth(end.getUTCMonth() + 1);
    const lastDay = new Date(Date.UTC(end.getUTCFullYear(), end.getUTCMonth() + 1, 0)).getUTCDate();
    end.setUTCDate(Math.min(day, lastDay));
  } else {
    end.setUTCFullYear(end.getUTCFullYear() + 1);
    if (end.getUTCMonth() !== start.getUTCMonth()) end.setUTCDate(0);
  }
  return end;
}
const planFrom = (value: unknown): BillingPlan | null => value === 'pro_month' || value === 'pro_year' ? value : null;
const userByCustomer = async (db: FakeDb, providerAccountId: string, mode: BillingMode, customerId: string) => db.fakeBillingCustomer.findUnique({
  where: { providerAccountId_mode_customerId: { providerAccountId, mode, customerId } }
});

export class FakeBillingProvider implements BillingPort, FakeBillingScenarioPort {
  readonly provider = 'fake' as const;
  readonly synthetic = true as const;
  readonly providerAccountId: string;
  readonly mode: BillingMode;
  private readonly db: FakeDb;
  private readonly webhookSecret: string;
  private readonly config: BillingProviderConfig;

  constructor(config: BillingProviderConfig, database: Database) {
    if (config.provider !== 'fake' || config.mode !== 'test' || !config.allowScenarioControls || !config.fakeWebhookSecret) throw new Error('Synthetic billing is disabled for this runtime.');
    this.providerAccountId = config.providerAccountId;
    this.mode = config.mode;
    this.webhookSecret = config.fakeWebhookSecret;
    this.config = config;
    this.db = database as unknown as FakeDb;
  }

  private scope() { return { providerAccountId: this.providerAccountId, mode: this.mode }; }

  private scopedKey(ownerScope: string, key: string) {
    return createHash('sha256').update(`${this.providerAccountId}\0${this.mode}\0${ownerScope}\0${key}`).digest('hex');
  }

  private async idempotent<T extends OperationResult>(key: string, operation: string, request: unknown, work: (db: FakeDb) => Promise<T>, ownerScope = 'provider'): Promise<T> {
    if (!key || key.length > 255) throw new BillingProviderError('A bounded billing idempotency key is required.', 'rejected');
    const providerKey = this.scopedKey(ownerScope, key);
    const requestHash = hash({ operation, request });
    try {
      return await this.db.$transaction(async tx => {
        const where = { providerAccountId_mode_idempotencyKey: { ...this.scope(), idempotencyKey: providerKey } };
        const found = await tx.fakeBillingOperation.findUnique({ where });
        if (found) {
          if (found.operation !== operation || found.requestHash !== requestHash) throw new BillingProviderError('This billing idempotency key was already used for a different request.', 'rejected');
          if (found.status !== 'complete' || !found.result) throw new BillingProviderError('The billing operation is still being reconciled.', 'uncertain', true);
          return found.result as T;
        }
        await tx.fakeBillingOperation.create({ data: { ...this.scope(), idempotencyKey: providerKey, operation, requestHash, status: 'pending' } });
        const result = await work(tx);
        await tx.fakeBillingOperation.update({ where, data: { status: 'complete', result: result as any } });
        return result;
      });
    } catch (error) {
      if (isUniqueViolation(error)) {
        const found = await this.db.fakeBillingOperation.findUnique({ where: { providerAccountId_mode_idempotencyKey: { ...this.scope(), idempotencyKey: providerKey } } });
        if (found?.operation === operation && found.requestHash === requestHash && found.status === 'complete' && found.result) return found.result as T;
        if (found && (found.operation !== operation || found.requestHash !== requestHash)) throw new BillingProviderError('This billing idempotency key was already used for a different request.', 'rejected');
        throw new BillingProviderError('The billing operation is still being reconciled.', 'uncertain', true);
      }
      throw error;
    }
  }

  async ensureCustomer(input: { userId: string; email?: string; existingCustomerId?: string | null; idempotencyKey: string }): Promise<ProviderCustomer> {
    const row = await this.db.fakeBillingCustomer.upsert?.({
      where: { providerAccountId_mode_userId: { ...this.scope(), userId: input.userId } },
      create: { ...this.scope(), userId: input.userId, customerId: makeId('cus_demo', `${this.providerAccountId}:${this.mode}:${input.userId}`), ...(input.email ? { email: input.email } : {}) },
      update: input.email ? { email: input.email } : {}
    });
    if (!row) {
      const found = await this.db.fakeBillingCustomer.findUnique({ where: { providerAccountId_mode_userId: { ...this.scope(), userId: input.userId } } });
      if (!found) throw new BillingProviderError('Synthetic customer could not be created.', 'unavailable');
      if (input.existingCustomerId && found.customerId !== input.existingCustomerId) throw new BillingProviderError('The saved provider customer does not match this account.', 'invalid_response');
      return { ...this.scope(), userId: input.userId, customerId: String(found.customerId) };
    }
    if (input.existingCustomerId && row.customerId !== input.existingCustomerId) throw new BillingProviderError('The saved provider customer does not match this account.', 'invalid_response');
    return { ...this.scope(), userId: input.userId, customerId: String(row.customerId) };
  }

  async createCheckout(input: { userId: string; customerId: string; plan: BillingPlan; successUrl: string; cancelUrl: string; idempotencyKey: string }): Promise<{ sessionId: string; url: string; expiresAt: Date }> {
    const customer = await userByCustomer(this.db, this.providerAccountId, this.mode, input.customerId);
    if (!customer || customer.userId !== input.userId) throw new BillingProviderError('The synthetic customer does not belong to this account.', 'rejected');
    const active = await this.db.fakeBillingSubscription.findFirst({ where: { ...this.scope(), userId: input.userId, OR: [{ status: { in: ['active', 'trialing', 'past_due'] } }, { status: 'canceled', currentPeriodEnd: { gt: new Date() } }] } });
    if (active) throw new BillingProviderError('An existing synthetic subscription prevents a new checkout.', 'rejected');
    const successUrl = safeBillingUrl(input.successUrl, this.config.appOrigin);
    const cancelUrl = safeBillingUrl(input.cancelUrl, this.config.appOrigin);
    const result = await this.idempotent<{ sessionId: string; url: string; expiresAt: string | Date }>(input.idempotencyKey, 'checkout.create', { userId: input.userId, customerId: input.customerId, plan: input.plan, successUrl, cancelUrl }, async tx => {
      const sessionId = makeUuid(`checkout:${this.providerAccountId}:${this.mode}:${input.userId}:${input.idempotencyKey}`);
      const expiresAt = new Date(Date.now() + 30 * 60_000);
      const url = `${this.config.appOrigin}/subscribe/demo?session=${encodeURIComponent(sessionId)}`;
      await tx.fakeBillingCheckout.create({ data: { ...this.scope(), kind: 'checkout', sessionId, userId: input.userId, customerId: input.customerId, plan: input.plan, status: 'open', url, successUrl, cancelUrl, expiresAt, idempotencyKey: this.scopedKey(input.userId, input.idempotencyKey) } });
      return { sessionId, url, expiresAt: expiresAt.toISOString() };
    }, input.userId);
    return { ...result, expiresAt: result.expiresAt instanceof Date ? result.expiresAt : new Date(result.expiresAt) };
  }

  async createPortal(input: { customerId: string; returnUrl: string; idempotencyKey: string }): Promise<{ url: string }> {
    const customer = await userByCustomer(this.db, this.providerAccountId, this.mode, input.customerId);
    if (!customer) throw new BillingProviderError('The synthetic customer does not exist in this provider scope.', 'rejected');
    const returnUrl = safeBillingUrl(input.returnUrl, this.config.appOrigin);
    return this.idempotent(input.idempotencyKey, 'portal.create', { customerId: input.customerId, returnUrl }, async tx => {
      const existing = await tx.fakeBillingSubscription.findFirst({ where: { ...this.scope(), userId: customer.userId }, orderBy: { createdAt: 'desc' } });
      const plan = planFrom(existing?.plan);
      const sessionId = makeUuid(`portal:${this.providerAccountId}:${this.mode}:${customer.userId}:${input.idempotencyKey}`);
      const expiresAt = new Date(Date.now() + 30 * 60_000);
      const url = `${this.config.appOrigin}/app/billing/demo?session=${encodeURIComponent(sessionId)}`;
      await tx.fakeBillingCheckout.create({ data: { ...this.scope(), kind: 'portal', sessionId, userId: customer.userId, customerId: input.customerId, plan, status: 'open', url, successUrl: returnUrl, cancelUrl: returnUrl, expiresAt, idempotencyKey: this.scopedKey(customer.userId, input.idempotencyKey) } });
      return { url };
    }, customer.userId);
  }

  async getCustomerState(input: { customerId: string }): Promise<ProviderCustomerState> {
    const customer = await userByCustomer(this.db, this.providerAccountId, this.mode, input.customerId);
    if (!customer) throw new BillingProviderError('The synthetic customer does not exist in this provider scope.', 'rejected');
    const [subscriptions, invoices] = await Promise.all([
      this.db.fakeBillingSubscription.findMany({ where: { ...this.scope(), customerId: input.customerId }, orderBy: { createdAt: 'desc' } }),
      this.db.fakeBillingInvoice.findMany({ where: { ...this.scope(), customerId: input.customerId }, orderBy: { createdAt: 'desc' } })
    ]);
    const paymentIds = new Set(invoices.map(row => row.paymentId).filter(Boolean));
    const [refunds, disputes] = await Promise.all([
      paymentIds.size ? this.db.fakeBillingRefund.findMany({ where: { ...this.scope(), paymentId: { in: [...paymentIds] } } }) : Promise.resolve([]),
      paymentIds.size ? this.db.fakeBillingDispute.findMany({ where: { ...this.scope(), paymentId: { in: [...paymentIds] } } }) : Promise.resolve([])
    ]);
    const providerRefunds: ProviderRefund[] = refunds.filter(row => paymentIds.has(row.paymentId)).map(row => ({ ...this.scope(), refundId: String(row.refundId), operationId: typeof row.operationId === 'string' ? row.operationId : null, paymentId: String(row.paymentId), amountMinor: Number(row.amount), status: String(row.status), reason: row.reason ?? null, createdAt: row.createdAt ?? new Date(0) }));
    const providerDisputes: ProviderDispute[] = disputes.map(row => ({ ...this.scope(), disputeId: String(row.disputeId), paymentId: String(row.paymentId), amountMinor: Number(row.amount), status: String(row.status), reason: row.reason ?? null, createdAt: row.createdAt, resolvedAt: row.resolvedAt ?? null }));
    return { ...this.scope(), customerId: input.customerId, subscriptions: subscriptions.map(row => {
      const paidThrough = invoices.filter(invoice => invoice.subscriptionId === row.subscriptionId && invoice.status === 'paid' && Number(invoice.amountPaid) > 0 && invoice.periodEnd).map(invoice => invoice.periodEnd as Date).sort((a, b) => b.getTime() - a.getTime())[0] ?? null;
      return { ...this.toSubscription(row), paidThrough };
    }), invoices: invoices.map(row => this.toInvoice(row)), refunds: providerRefunds, disputes: providerDisputes };
  }

  private toSubscription(row: Row): ProviderSubscription {
    return { ...this.scope(), subscriptionId: String(row.subscriptionId), customerId: String(row.customerId), userId: String(row.userId), plan: planFrom(row.plan), status: String(row.status), currentPeriodStart: row.currentPeriodStart ?? null, currentPeriodEnd: row.currentPeriodEnd ?? null, paidThrough: null, cancelAtPeriodEnd: row.cancelAtPeriodEnd === true, canceledAt: row.canceledAt ?? null, latestPaymentId: row.latestPaymentId ?? null, reason: row.reason ?? null, firstFailureAt: row.firstFailureAt ?? null };
  }

  private toInvoice(row: Row): ProviderInvoice {
    return { ...this.scope(), invoiceId: String(row.invoiceId), customerId: String(row.customerId), subscriptionId: row.subscriptionId ?? null, status: String(row.status), amountDue: Number(row.amountDue), amountPaid: Number(row.amountPaid), currency: String(row.currency), createdAt: row.createdAt, periodStart: row.periodStart ?? null, periodEnd: row.periodEnd ?? null, hostedInvoiceUrl: row.hostedInvoiceUrl ?? null, paymentId: row.paymentId ?? null };
  }

  async getFakeSession(input: { userId: string; sessionId: string }): Promise<{ sessionId: string; kind: 'checkout' | 'portal'; status: 'open' | 'complete' | 'canceled' | 'expired'; plan: BillingPlan | null; expiresAt: Date | null; customerId: string; amountMinor: number | null; currency: 'usd' }> {
    const row = await this.db.fakeBillingCheckout.findUnique({ where: { providerAccountId_mode_sessionId: { ...this.scope(), sessionId: input.sessionId } } });
    if (!row || row.userId !== input.userId) throw new BillingProviderError('The synthetic billing session is unavailable.', 'rejected');
    const status = row.status === 'open' && row.expiresAt <= new Date() ? 'expired' : row.status;
    if (!(checkoutStatuses as readonly string[]).includes(status)) throw new BillingProviderError('The synthetic billing session is invalid.', 'invalid_response');
    return { sessionId: String(row.sessionId), kind: row.kind, status: status as 'open' | 'complete' | 'canceled' | 'expired', plan: planFrom(row.plan), expiresAt: row.expiresAt ?? null, customerId: String(row.customerId), amountMinor: planFrom(row.plan) ? dollarCents[row.plan as BillingPlan] : null, currency: 'usd' };
  }

  private async emitEvent(tx: FakeDb, eventType: string, customerId: string, subscriptionId: string | null, paymentId: string | null, object: Row): Promise<{ eventId: string }> {
    const eventId = `evt_demo_${randomUUID().replaceAll('-', '')}`;
    const created = Math.floor(Date.now() / 1000);
    const payload: StoredEventPayload = { id: eventId, type: eventType, created, livemode: false, account: this.providerAccountId, data: { object } };
    const raw = Buffer.from(JSON.stringify(payload));
    const signature = this.signature(raw, created);
    await tx.fakeBillingEvent.create({ data: { ...this.scope(), eventId, eventType, createdAt: new Date(created * 1000), customerId, subscriptionId, paymentId, payload: payload as any, signature } });
    return { eventId };
  }

  private signature(raw: Uint8Array, timestamp: number): string {
    const digest = createHmac('sha256', this.webhookSecret).update(`${timestamp}.`).update(Buffer.from(raw)).digest('hex');
    return `t=${timestamp},v1=${digest}`;
  }

  async applyDemoAction(input: { userId: string; sessionId: string; action: 'complete' | 'cancel_checkout' | 'cancel' | 'resume'; idempotencyKey: string }): Promise<{ eventId: string; customerId: string; subscriptionId: string | null }> {
    const session = await this.getFakeSession({ userId: input.userId, sessionId: input.sessionId });
    const operation = `demo.${session.kind}.${input.action}`;
    return this.idempotent(input.idempotencyKey, operation, { userId: input.userId, sessionId: input.sessionId, action: input.action }, async tx => {
      const row = await tx.fakeBillingCheckout.findUnique({ where: { providerAccountId_mode_sessionId: { ...this.scope(), sessionId: input.sessionId } } });
      if (!row || row.userId !== input.userId || row.kind !== session.kind) throw new BillingProviderError('The synthetic billing session is unavailable.', 'rejected');
      if (input.action === 'cancel_checkout') {
        if (row.kind !== 'checkout' || row.status !== 'open') throw new BillingProviderError('Only an open checkout can be canceled.', 'rejected');
        await tx.fakeBillingCheckout.update({ where: { providerAccountId_mode_sessionId: { ...this.scope(), sessionId: input.sessionId } }, data: { status: 'canceled' } });
        const { eventId } = await this.emitEvent(tx, 'checkout.session.expired', row.customerId, null, null, { id: row.sessionId, object: 'checkout.session', customer: row.customerId, status: 'expired', client_reference_id: row.userId, metadata: { plan: row.plan } });
        return { eventId, customerId: row.customerId, subscriptionId: null };
      }
      if (input.action === 'complete') {
        if (row.kind !== 'checkout' || row.status !== 'open' || row.expiresAt <= new Date()) throw new BillingProviderError('Only an open checkout can be completed.', 'rejected');
        const plan = planFrom(row.plan);
        if (!plan) throw new BillingProviderError('The synthetic checkout plan was invalid.', 'invalid_response');
        const existing = await tx.fakeBillingSubscription.findFirst({ where: { ...this.scope(), userId: input.userId, status: { in: ['active', 'trialing', 'past_due'] } } });
        if (existing) throw new BillingProviderError('An active subscription already exists for this account.', 'rejected');
        const now = new Date();
        const currentPeriodEnd = periodEnd(now, plan);
        const subscriptionId = makeId('sub_demo', `${this.providerAccountId}:${this.mode}:${row.sessionId}`);
        const paymentId = makeId('pi_demo', `${this.providerAccountId}:${this.mode}:${row.sessionId}`);
        const invoiceId = makeId('in_demo', `${this.providerAccountId}:${this.mode}:${row.sessionId}`);
        await tx.fakeBillingSubscription.create({ data: { ...this.scope(), subscriptionId, customerId: row.customerId, userId: input.userId, plan, status: 'active', currentPeriodStart: now, currentPeriodEnd, cancelAtPeriodEnd: false, latestPaymentId: paymentId, reason: null, firstFailureAt: null } });
        await tx.fakeBillingInvoice.create({ data: { ...this.scope(), invoiceId, customerId: row.customerId, subscriptionId, status: 'paid', amountDue: dollarCents[plan], amountPaid: dollarCents[plan], currency: 'usd', createdAt: now, periodStart: now, periodEnd: currentPeriodEnd, hostedInvoiceUrl: null, paymentId } });
        await tx.fakeBillingCheckout.update({ where: { providerAccountId_mode_sessionId: { ...this.scope(), sessionId: input.sessionId } }, data: { status: 'complete' } });
        const { eventId } = await this.emitEvent(tx, 'checkout.session.completed', row.customerId, subscriptionId, paymentId, { id: row.sessionId, object: 'checkout.session', customer: row.customerId, subscription: subscriptionId, payment_intent: paymentId, status: 'complete', client_reference_id: input.userId, metadata: { plan, billing_account_id: this.providerAccountId }, livemode: false });
        return { eventId, customerId: row.customerId, subscriptionId };
      }
      if (row.kind !== 'portal' || row.status !== 'open') throw new BillingProviderError('Only an open portal demo can be changed.', 'rejected');
      const subscription = await tx.fakeBillingSubscription.findFirst({ where: { ...this.scope(), customerId: row.customerId, userId: input.userId }, orderBy: { createdAt: 'desc' } });
      if (!subscription) throw new BillingProviderError('There is no provider subscription to manage.', 'rejected');
      if (input.action === 'cancel' && subscription.status !== 'active' && subscription.status !== 'trialing' && subscription.status !== 'past_due') throw new BillingProviderError('This subscription cannot be canceled in its current state.', 'rejected');
      if (input.action === 'resume' && subscription.cancelAtPeriodEnd !== true) throw new BillingProviderError('This subscription is not scheduled to cancel.', 'rejected');
      const updated = await tx.fakeBillingSubscription.update({ where: { id: subscription.id }, data: input.action === 'cancel' ? { cancelAtPeriodEnd: true, reason: 'customer_requested' } : { cancelAtPeriodEnd: false, reason: null } });
      await tx.fakeBillingCheckout.update({ where: { providerAccountId_mode_sessionId: { ...this.scope(), sessionId: input.sessionId } }, data: { status: 'complete' } });
      const normalized = this.toSubscription(updated);
      const { eventId } = await this.emitEvent(tx, 'customer.subscription.updated', row.customerId, subscription.subscriptionId, subscription.latestPaymentId, { ...normalized, id: subscription.subscriptionId, object: 'subscription', customer: row.customerId, status: subscription.status, current_period_end: Math.floor((subscription.currentPeriodEnd?.getTime() ?? Date.now()) / 1000), cancel_at_period_end: normalized.cancelAtPeriodEnd, canceled_at: null, metadata: { app_user_id: input.userId, billing_account_id: this.providerAccountId } });
      return { eventId, customerId: row.customerId, subscriptionId: subscription.subscriptionId };
    }, input.userId);
  }

  async applyScenario(input: { userId: string; scenario: 'payment_failed' | 'unpaid' | 'refund' | 'renew' | 'dispute' | 'resolve_dispute' }): Promise<{ eventId: string; customerId: string; subscriptionId: string | null }> {
    const subscription = await this.db.fakeBillingSubscription.findFirst({ where: { ...this.scope(), userId: input.userId }, orderBy: { createdAt: 'desc' } });
    if (!subscription) throw new BillingProviderError('No synthetic subscription exists for this account.', 'rejected');
    const eventKey = `scenario:${input.userId}:${input.scenario}:${Date.now()}:${randomUUID()}`;
    return this.idempotent(eventKey, `scenario.${input.scenario}`, input, async tx => {
      if (input.scenario === 'refund') {
        if (!subscription.latestPaymentId) throw new BillingProviderError('The synthetic subscription has no payment to refund.', 'rejected');
        const refundId = makeId('re_demo', eventKey);
        await tx.fakeBillingRefund.create({ data: { ...this.scope(), refundId, paymentId: subscription.latestPaymentId, amount: dollarCents[planFrom(subscription.plan) ?? 'pro_month'], status: 'succeeded', reason: 'requested_by_customer', idempotencyKey: this.scopedKey(input.userId, eventKey) } });
        const { eventId } = await this.emitEvent(tx, 'charge.refunded', subscription.customerId, subscription.subscriptionId, subscription.latestPaymentId, { id: subscription.latestPaymentId, object: 'charge', customer: subscription.customerId, payment_intent: subscription.latestPaymentId, refunded: true, status: 'succeeded', amount_refunded: dollarCents[planFrom(subscription.plan) ?? 'pro_month'], metadata: { app_user_id: input.userId, billing_account_id: this.providerAccountId } });
        return { eventId, customerId: subscription.customerId, subscriptionId: subscription.subscriptionId };
      }
      if (input.scenario === 'renew') {
        const now = new Date();
        const plan = planFrom(subscription.plan) ?? 'pro_month';
        const currentPeriodEnd = periodEnd(subscription.currentPeriodEnd ?? now, plan);
        const paymentId = makeId('pi_demo', `${eventKey}:renewal`);
        const invoiceId = makeId('in_demo', `${eventKey}:renewal`);
        const updated = await tx.fakeBillingSubscription.update({ where: { id: subscription.id }, data: { status: 'active', currentPeriodStart: subscription.currentPeriodEnd ?? now, currentPeriodEnd, latestPaymentId: paymentId, firstFailureAt: null, reason: null } });
        await tx.fakeBillingInvoice.create({ data: { ...this.scope(), invoiceId, customerId: subscription.customerId, subscriptionId: subscription.subscriptionId, status: 'paid', amountDue: dollarCents[plan], amountPaid: dollarCents[plan], currency: 'usd', createdAt: now, periodStart: subscription.currentPeriodEnd ?? now, periodEnd: currentPeriodEnd, hostedInvoiceUrl: null, paymentId } });
        const { eventId } = await this.emitEvent(tx, 'invoice.payment_succeeded', subscription.customerId, subscription.subscriptionId, paymentId, { id: invoiceId, object: 'invoice', customer: subscription.customerId, parent: { subscription_details: { subscription: subscription.subscriptionId } }, payments: { data: [{ payment: { type: 'payment_intent', payment_intent: paymentId } }] }, amount_due: dollarCents[plan], amount_paid: dollarCents[plan], currency: 'usd', status: 'paid', status_transitions: { paid_at: Math.floor(now.getTime() / 1000) }, metadata: { app_user_id: input.userId, billing_account_id: this.providerAccountId } });
        void updated;
        return { eventId, customerId: subscription.customerId, subscriptionId: subscription.subscriptionId };
      }
      if (input.scenario === 'dispute' || input.scenario === 'resolve_dispute') {
        if (!subscription.latestPaymentId) throw new BillingProviderError('The synthetic subscription has no payment to dispute.', 'rejected');
        const paymentId = subscription.latestPaymentId;
        let dispute = await tx.fakeBillingDispute.findFirst({ where: { ...this.scope(), paymentId }, orderBy: { createdAt: 'desc' } });
        if (input.scenario === 'dispute') {
          const disputeId = makeId('dp_demo', eventKey);
          dispute = await tx.fakeBillingDispute.create({ data: { ...this.scope(), disputeId, subscriptionId: subscription.subscriptionId, paymentId, amount: dollarCents[planFrom(subscription.plan) ?? 'pro_month'], status: 'needs_response', reason: 'customer_initiated', createdAt: new Date(), resolvedAt: null } });
          const { eventId } = await this.emitEvent(tx, 'charge.dispute.created', subscription.customerId, subscription.subscriptionId, paymentId, { id: disputeId, object: 'dispute', customer: subscription.customerId, charge: paymentId, payment_intent: paymentId, amount: dispute.amount, status: dispute.status, reason: dispute.reason, created: Math.floor(dispute.createdAt.getTime() / 1000), livemode: false, metadata: { app_user_id: input.userId, billing_account_id: this.providerAccountId } });
          return { eventId, customerId: subscription.customerId, subscriptionId: subscription.subscriptionId };
        }
        if (!dispute || !['needs_response', 'under_review', 'warning_needs_response', 'warning_under_review'].includes(dispute.status)) throw new BillingProviderError('No open synthetic dispute exists to resolve.', 'rejected');
        const resolved = await tx.fakeBillingDispute.update({ where: { id: dispute.id }, data: { status: 'won', resolvedAt: new Date() } });
        const { eventId } = await this.emitEvent(tx, 'charge.dispute.closed', subscription.customerId, subscription.subscriptionId, paymentId, { id: resolved.disputeId, object: 'dispute', customer: subscription.customerId, charge: paymentId, payment_intent: paymentId, amount: resolved.amount, status: resolved.status, reason: resolved.reason, created: Math.floor(resolved.createdAt.getTime() / 1000), livemode: false, metadata: { app_user_id: input.userId, billing_account_id: this.providerAccountId } });
        return { eventId, customerId: subscription.customerId, subscriptionId: subscription.subscriptionId };
      }
      const status = input.scenario === 'payment_failed' ? 'past_due' : 'unpaid';
      const failedAt = subscription.firstFailureAt ?? new Date();
      const failedPaymentId = makeId('pi_demo', `${eventKey}:failed-payment`);
      const updated = await tx.fakeBillingSubscription.update({ where: { id: subscription.id }, data: { status, latestPaymentId: failedPaymentId, firstFailureAt: failedAt, reason: input.scenario === 'payment_failed' ? 'invoice_payment_failed' : 'subscription_unpaid' } });
      const invoiceId = makeId('in_demo', `${eventKey}:${status}`);
      await tx.fakeBillingInvoice.create({ data: { ...this.scope(), invoiceId, customerId: subscription.customerId, subscriptionId: subscription.subscriptionId, status: 'open', amountDue: dollarCents[planFrom(subscription.plan) ?? 'pro_month'], amountPaid: 0, currency: 'usd', createdAt: failedAt, periodStart: subscription.currentPeriodEnd ?? subscription.currentPeriodStart ?? null, periodEnd: subscription.currentPeriodEnd ? periodEnd(subscription.currentPeriodEnd, planFrom(subscription.plan) ?? 'pro_month') : null, hostedInvoiceUrl: null, paymentId: failedPaymentId } });
      const type = input.scenario === 'payment_failed' ? 'invoice.payment_failed' : 'customer.subscription.updated';
      const { eventId } = await this.emitEvent(tx, type, subscription.customerId, subscription.subscriptionId, failedPaymentId, { id: invoiceId, object: input.scenario === 'payment_failed' ? 'invoice' : 'subscription', customer: subscription.customerId, parent: { subscription_details: { subscription: subscription.subscriptionId } }, payments: { data: [{ payment: { type: 'payment_intent', payment_intent: failedPaymentId } }] }, status, attempt_count: 1, status_transitions: { finalized_at: Math.floor(failedAt.getTime() / 1000) }, livemode: false, metadata: { app_user_id: input.userId, billing_account_id: this.providerAccountId }, ...(input.scenario === 'unpaid' ? { cancel_at_period_end: updated.cancelAtPeriodEnd } : {}) });
      return { eventId, customerId: subscription.customerId, subscriptionId: subscription.subscriptionId };
    }, input.userId);
  }

  async getEventDelivery(input: { eventId: string }): Promise<{ rawBody: Uint8Array; signature: string }> {
    const row = await this.db.fakeBillingEvent.findUnique({ where: { providerAccountId_mode_eventId: { ...this.scope(), eventId: input.eventId } } });
    if (!row?.signature || !row.payload) throw new BillingProviderError('The synthetic event is unavailable.', 'rejected');
    const created = Number((row.payload as StoredEventPayload).created);
    const rawBody = Buffer.from(JSON.stringify(row.payload));
    const signature = this.signature(rawBody, created);
    return { rawBody, signature };
  }

  async verifyWebhook(rawBody: Uint8Array, signatureHeader?: string): Promise<NormalizedBillingEvent> {
    const parts = (signatureHeader ?? '').split(',').map(part => part.trim().split('=', 2) as [string, string]);
    const timestamp = Number(parts.find(([key]) => key === 't')?.[1]);
    const signatures = parts.filter(([key]) => key === 'v1').map(([, value]) => value).filter(value => /^[a-f0-9]{64}$/i.test(value));
    if (!Number.isSafeInteger(timestamp) || Math.abs(Date.now() / 1000 - timestamp) > this.configToleranceSeconds() || !signatures.length) throw new BillingProviderError('Webhook signature verification failed.', 'rejected');
    const expected = createHmac('sha256', this.webhookSecret).update(`${timestamp}.`).update(Buffer.from(rawBody)).digest();
    if (!signatures.some(value => { const supplied = Buffer.from(value, 'hex'); return supplied.length === expected.length && timingSafeEqual(supplied, expected); })) throw new BillingProviderError('Webhook signature verification failed.', 'rejected');
    let event: StoredEventPayload;
    try { event = JSON.parse(Buffer.from(rawBody).toString('utf8')) as StoredEventPayload; } catch { throw new BillingProviderError('The signed synthetic event was invalid.', 'invalid_response'); }
    if (!event || typeof event.id !== 'string' || typeof event.type !== 'string' || event.livemode !== false || event.account !== this.providerAccountId || !event.data?.object) throw new BillingProviderError('The synthetic event belongs to a different provider scope.', 'rejected');
    const object = event.data.object;
    const customerId = typeof object.customer === 'string' ? object.customer : null;
    const subscriptionId = typeof object.subscription === 'string' ? object.subscription : object.object === 'subscription' && typeof object.id === 'string' ? object.id : null;
    const paymentId = typeof object.payment_intent === 'string' ? object.payment_intent : typeof object.id === 'string' && object.object === 'charge' ? object.id : null;
    return { ...this.scope(), eventId: event.id, type: event.type, createdAt: new Date(event.created * 1000), customerId, subscriptionId, paymentId, invoiceId: object.object === 'invoice' && typeof object.id === 'string' ? object.id : null, checkoutSessionId: object.object === 'checkout.session' && typeof object.id === 'string' ? object.id : null, objectStatus: typeof object.status === 'string' ? object.status : null, reason: typeof object.reason === 'string' ? object.reason : null } satisfies NormalizedBillingEvent;
  }

  private configToleranceSeconds() { return this.config.webhookToleranceSeconds; }

  async refund(input: { customerId: string; subscriptionId: string; paymentId: string; operationId?: string; amountMinor?: number; reason: 'duplicate' | 'fraudulent' | 'requested_by_customer'; idempotencyKey: string }): Promise<{ refundId: string; status: string }> {
    if (input.operationId !== undefined && (!input.operationId || input.operationId.length > 255)) throw new BillingProviderError('The billing operation reference is invalid.', 'rejected');
    if (!Number.isSafeInteger(input.amountMinor ?? 1) || (input.amountMinor ?? 1) <= 0) throw new BillingProviderError('Refund amount must be a positive integer in the smallest currency unit.', 'rejected');
    return this.idempotent(input.idempotencyKey, 'refund.create', input, async tx => {
      const sub = await tx.fakeBillingSubscription.findFirst({ where: { ...this.scope(), subscriptionId: input.subscriptionId, customerId: input.customerId } });
      if (!sub) throw new BillingProviderError('The synthetic payment is unavailable in this provider scope.', 'rejected');
      // Serialize different refund operations for the same payment on its immutable invoice row.
      // The lock is held until the operation record and refund row commit together.
      await tx.$queryRaw<Array<{ id: string }>>`
        SELECT id FROM fake_billing_invoice
        WHERE provider_account_id = ${this.providerAccountId}
          AND mode = ${this.mode}
          AND customer_id = ${input.customerId}
          AND subscription_id = ${input.subscriptionId}
          AND payment_id = ${input.paymentId}
        FOR UPDATE`;
      const invoice = await tx.fakeBillingInvoice.findFirst({ where: { ...this.scope(), subscriptionId: input.subscriptionId, customerId: input.customerId, paymentId: input.paymentId } });
      if (!invoice) throw new BillingProviderError('The synthetic payment is not attached to the requested subscription.', 'rejected');
      const existing = await tx.fakeBillingRefund.findMany({ where: { ...this.scope(), paymentId: input.paymentId, status: { in: ['pending', 'succeeded'] } } });
      const remaining = input.amountMinor ?? Number(invoice.amountPaid);
      if (remaining > Number(invoice.amountPaid) - existing.reduce((sum, refund) => sum + Number(refund.amount), 0)) throw new BillingProviderError('The requested refund exceeds the remaining synthetic refundable amount.', 'rejected');
      const refundId = makeId('re_demo', `${this.providerAccountId}:${this.mode}:${input.customerId}:${input.subscriptionId}:${input.idempotencyKey}`);
      await tx.fakeBillingRefund.create({ data: { ...this.scope(), refundId, paymentId: input.paymentId, amount: remaining, status: 'succeeded', reason: input.reason, operationId: input.operationId ?? null, idempotencyKey: this.scopedKey(`${input.customerId}:${input.subscriptionId}`, input.idempotencyKey) } });
      return { refundId, status: 'succeeded' };
    }, `${input.customerId}:${input.subscriptionId}`);
  }

  async cancelSubscription(input: { subscriptionId: string; atPeriodEnd: boolean; idempotencyKey: string }): Promise<ProviderSubscription> {
    const result = await this.idempotent<ProviderSubscription & OperationResult>(input.idempotencyKey, 'subscription.cancel', input, async tx => {
      const row = await tx.fakeBillingSubscription.findUnique({ where: { providerAccountId_mode_subscriptionId: { ...this.scope(), subscriptionId: input.subscriptionId } } });
      if (!row) throw new BillingProviderError('The synthetic subscription is unavailable in this provider scope.', 'rejected');
      const updated = await tx.fakeBillingSubscription.update({ where: { id: row.id }, data: input.atPeriodEnd ? { cancelAtPeriodEnd: true, reason: 'admin_requested' } : { status: 'canceled', cancelAtPeriodEnd: false, canceledAt: new Date(), reason: 'admin_requested' } });
      return this.toSubscription(updated) as unknown as ProviderSubscription & OperationResult;
    }, input.subscriptionId);
    return { ...result, currentPeriodEnd: result.currentPeriodEnd ? new Date(result.currentPeriodEnd) : null, canceledAt: result.canceledAt ? new Date(result.canceledAt) : null };
  }
}
