import { createHmac, randomUUID } from 'node:crypto';

/** Requests bounded, idempotent reconciliation; never sends owner IDs or entitlement claims. */
export function createBillingReconciler(apiOrigin: string, secret: string, transport: typeof fetch = fetch) {
  const base = new URL(apiOrigin);
  if (!['http:', 'https:'].includes(base.protocol) || base.username || base.password
      || base.pathname !== '/' || base.search || base.hash || secret.length < 32) throw new Error('BILLING_RECONCILE_CONFIGURATION_INVALID');
  if (process.env.NODE_ENV === 'production' && base.protocol !== 'https:') throw new Error('BILLING_RECONCILE_HTTPS_REQUIRED');
  let running = false;
  return async () => {
    if (running) return;
    running = true;
    try {
      const seconds = Math.floor(Date.now() / 1000), nonce = randomUUID();
      const signature = createHmac('sha256', secret).update(`billing-reconcile:v1:${seconds}:${nonce}`).digest('base64url');
      const response = await transport(new URL('/api/v1/internal/billing/reconcile', base), {
        method: 'POST', redirect: 'error', credentials: 'omit', signal: AbortSignal.timeout(45_000),
        headers: { 'X-Billing-Authorization': `${seconds}.${nonce}.${signature}` },
      });
      if (response.status !== 204) throw new Error('BILLING_RECONCILE_UNAVAILABLE');
    } catch {
      // SDK/network errors can contain credentials or internal URLs.
      throw new Error('BILLING_RECONCILE_UNAVAILABLE');
    } finally { running = false; }
  };
}
