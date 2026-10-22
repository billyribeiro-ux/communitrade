import type { Transaction } from '../persistence/transactions.js';
import { requireUuid } from '../persistence/transactions.js';
import { billingEntitlementPredicate, billingEntitlementScope } from '@trading/config';

/** Serialize additions without upgrading the actor transaction's shared user lock. */
export async function serializeUser(tx: Transaction, userId: string) {
  requireUuid(userId);
  await tx.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))', [`private-workspace:${userId}`]);
}

/** Limits are product constants; arbitrary persisted JSON cannot raise allowances. */
export async function effectivePlan(tx: Transaction, userId: string, now?: Date) {
  requireUuid(userId);
  const [account, mode, allowLegacy] = billingEntitlementScope(process.env);
  const result = await tx.query<{ plan: string }>(`SELECT plan FROM subscription_entitlement
    WHERE user_id=$1 AND ${billingEntitlementPredicate('',3)}
    AND valid_from<=COALESCE($2::timestamptz,CURRENT_TIMESTAMP)
    AND (valid_until IS NULL OR valid_until>COALESCE($2::timestamptz,CURRENT_TIMESTAMP))`, [userId, now ?? null, account, mode, allowLegacy]);
  const plan = result.rows[0]?.plan === 'pro' ? 'pro' as const : 'free' as const;
  return { plan, journalMonthly: plan === 'pro' ? 1000 : 30, watchlists: plan === 'pro' ? 10 : 1,
    watchlistItems: plan === 'pro' ? 100 : 25, layouts: plan === 'pro' ? 10 : 1 };
}
