import type { BillingMode, BillingPlan, ProviderSubscription } from './provider.js';

export const BILLING_PLANS = Object.freeze([
  { id: 'pro_month' as const, label: 'Pro monthly', amountMinor: 2900, currency: 'usd' as const, interval: 'monthly' as const, intervalCount: 1 },
  { id: 'pro_year' as const, label: 'Pro annual', amountMinor: 29000, currency: 'usd' as const, interval: 'annual' as const, intervalCount: 1 }
]);

export const planFor = (plan: unknown): BillingPlan | null => plan === 'pro_month' || plan === 'pro_year' ? plan : null;
export const intervalFor = (plan: BillingPlan | null): 'monthly' | 'annual' | null => plan === 'pro_month' ? 'monthly' : plan === 'pro_year' ? 'annual' : null;
const statusForEntitlement = (status: string) => status.toLowerCase().replaceAll('-', '_');

export interface EntitlementDecision {
  plan: 'free' | 'pro';
  validUntil: Date | null;
  graceUntil: Date | null;
  providerStatus: string;
}

/** Provider state is evidence. Entitlements use bounded windows and fail closed on absent dates. */
export function entitlementFor(provider: ProviderSubscription, previousGrace: Date | null, actualPaidThrough: Date | null, now = new Date(), firstFailureAt: Date | null = null): EntitlementDecision {
  const status = statusForEntitlement(provider.status);
  if (provider.plan !== 'pro_month' && provider.plan !== 'pro_year') return { plan: 'free', validUntil: null, graceUntil: status === 'past_due' ? previousGrace : null, providerStatus: provider.status };
  const periodEnd = provider.currentPeriodEnd && provider.currentPeriodEnd > now ? provider.currentPeriodEnd : null;
  if ((status === 'active' || status === 'trialing') && periodEnd) {
    return { plan: 'pro', validUntil: periodEnd, graceUntil: null, providerStatus: provider.status };
  }
  if (status === 'past_due') {
    const failure = firstFailureAt ?? provider.firstFailureAt;
    const evidenceGrace = failure ? new Date(failure.getTime() + 72 * 60 * 60 * 1000) : null;
    const graceUntil = previousGrace && evidenceGrace
      ? (previousGrace < evidenceGrace ? previousGrace : evidenceGrace)
      : evidenceGrace ?? previousGrace;
    if (graceUntil && graceUntil > now) return { plan: 'pro', validUntil: graceUntil, graceUntil, providerStatus: provider.status };
  }
  if ((status === 'canceled' || status === 'cancelled') && actualPaidThrough && actualPaidThrough > now) {
    return { plan: 'pro', validUntil: actualPaidThrough, graceUntil: null, providerStatus: provider.status };
  }
  return { plan: 'free', validUntil: null, graceUntil: status === 'past_due' ? previousGrace : null, providerStatus: provider.status };
}

export function scopeMatches(provider: { providerAccountId: string; mode: BillingMode }, scope: { providerAccountId: string; mode: BillingMode }) {
  return provider.providerAccountId === scope.providerAccountId && provider.mode === scope.mode;
}

export function normalizeCurrency(value: string) { return value.toLowerCase() === 'usd' ? 'usd' : 'usd'; }
