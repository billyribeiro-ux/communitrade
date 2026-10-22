/** Stable server-only boundary between billing domain logic and a processor. */
export type BillingMode = 'test' | 'live';
export type BillingPlan = 'pro_month' | 'pro_year';

export interface ProviderScope {
  providerAccountId: string;
  mode: BillingMode;
}

export interface ProviderCustomer extends ProviderScope {
  customerId: string;
  userId: string;
}

export interface ProviderSubscription extends ProviderScope {
  subscriptionId: string;
  customerId: string;
  userId?: string;
  plan: BillingPlan | null;
  /** Preserve processor status strings verbatim for support and reconciliation. */
  status: string;
  currentPeriodStart: Date | null;
  currentPeriodEnd: Date | null;
  /** Last confirmed paid-through boundary, derived from paid invoice periods. */
  paidThrough: Date | null;
  cancelAtPeriodEnd: boolean;
  canceledAt: Date | null;
  latestPaymentId: string | null;
  reason: string | null;
  /** First durable evidence of the current failed-payment episode, when known. */
  firstFailureAt: Date | null;
}

export interface ProviderInvoice extends ProviderScope {
  invoiceId: string;
  customerId: string;
  subscriptionId: string | null;
  status: string;
  amountDue: number;
  amountPaid: number;
  currency: string;
  createdAt: Date;
  periodStart: Date | null;
  periodEnd: Date | null;
  hostedInvoiceUrl: string | null;
  paymentId: string | null;
}

export interface ProviderCustomerState extends ProviderScope {
  customerId: string;
  subscriptions: ProviderSubscription[];
  invoices: ProviderInvoice[];
  refunds: ProviderRefund[];
  disputes: ProviderDispute[];
}

export interface ProviderRefund extends ProviderScope {
  refundId: string;
  operationId: string | null;
  paymentId: string;
  amountMinor: number;
  status: string;
  reason: string | null;
  createdAt: Date;
}

export interface ProviderDispute extends ProviderScope {
  disputeId: string;
  paymentId: string;
  amountMinor: number;
  status: string;
  reason: string | null;
  createdAt: Date;
  resolvedAt: Date | null;
}

export interface NormalizedBillingEvent extends ProviderScope {
  eventId: string;
  type: string;
  createdAt: Date;
  customerId: string | null;
  subscriptionId: string | null;
  paymentId: string | null;
  invoiceId: string | null;
  checkoutSessionId: string | null;
  /** Provider object status/reason are evidence; entitlements are still domain-derived. */
  objectStatus: string | null;
  reason: string | null;
}

export interface BillingPort {
  readonly provider: 'stripe' | 'fake';
  readonly providerAccountId: string;
  readonly mode: BillingMode;
  ensureCustomer(input: {
    userId: string;
    email?: string;
    existingCustomerId?: string | null;
    idempotencyKey: string;
  }): Promise<ProviderCustomer>;
  createCheckout(input: {
    userId: string;
    customerId: string;
    plan: BillingPlan;
    successUrl: string;
    cancelUrl: string;
    idempotencyKey: string;
  }): Promise<{ sessionId: string; url: string; expiresAt: Date }>;
  createPortal(input: {
    customerId: string;
    returnUrl: string;
    idempotencyKey: string;
  }): Promise<{ url: string }>;
  getCustomerState(input: { customerId: string }): Promise<ProviderCustomerState>;
  verifyWebhook(rawBody: Uint8Array, signatureHeader?: string): Promise<NormalizedBillingEvent>;
  refund(input: {
    customerId: string;
    subscriptionId: string;
    paymentId: string;
    operationId?: string;
    amountMinor?: number;
    reason: 'duplicate' | 'fraudulent' | 'requested_by_customer';
    idempotencyKey: string;
  }): Promise<{ refundId: string; status: string }>;
  cancelSubscription(input: {
    subscriptionId: string;
    atPeriodEnd: boolean;
    idempotencyKey: string;
  }): Promise<ProviderSubscription>;
}

export interface FakeBillingScenarioPort {
  readonly synthetic: true;
  getFakeSession(input: { userId: string; sessionId: string }): Promise<{ sessionId: string; kind: 'checkout' | 'portal'; status: 'open' | 'complete' | 'canceled' | 'expired'; plan: BillingPlan | null; expiresAt: Date | null; customerId: string; amountMinor: number | null; currency: 'usd' }>;
  applyDemoAction(input: { userId: string; sessionId: string; action: 'complete' | 'cancel_checkout' | 'cancel' | 'resume'; idempotencyKey: string }): Promise<{ eventId: string; customerId: string; subscriptionId: string | null }>;
  applyScenario(input: {
    userId: string;
    scenario: 'payment_failed' | 'unpaid' | 'refund' | 'renew' | 'dispute' | 'resolve_dispute';
  }): Promise<{ eventId: string; customerId: string; subscriptionId: string | null }>;
  getEventDelivery(input: { eventId: string }): Promise<{ rawBody: Uint8Array; signature: string }>;
}

export type BillingRuntime = BillingPort & Partial<FakeBillingScenarioPort>;
