import type { components } from "@trading/contracts";

export type BillingSummary = components["schemas"]["BillingSummary"];
export type BillingPlan = BillingSummary["plan"];
export type BillingInterval = Exclude<BillingSummary["interval"], null>;
export type BillingStatus = BillingSummary["status"];
export type BillingUsage = components["schemas"]["BillingUsage"];
export type BillingInvoice = components["schemas"]["BillingInvoice"];

export type BillingSubscriptionResponse = BillingSummary;
export type BillingAdminItem = components["schemas"]["AdminSubscription"];

export function formatBillingDate(value: string | null | undefined): string {
  if (!value) return "Not available";
  const date = new Date(value);
  if (!Number.isFinite(date.getTime())) return "Not available";
  return new Intl.DateTimeFormat("en-US", { dateStyle: "medium", timeZone: "UTC" }).format(date);
}

export function formatBillingTimestamp(value: string | null | undefined): string {
  if (!value) return "Not available";
  const date = new Date(value);
  if (!Number.isFinite(date.getTime())) return "Not available";
  return `${new Intl.DateTimeFormat("en-US", { dateStyle: "medium", timeStyle: "short", timeZone: "UTC" }).format(date)} UTC`;
}

export function billingStatusLabel(status: BillingStatus): string {
  return ({ free: "Free", active: "Active", trialing: "Trial", past_due: "Payment past due", unpaid: "Unpaid", canceled: "Canceled", incomplete: "Checkout pending", incomplete_expired: "Checkout expired" })[status];
}

export function billingPastDueMessage(plan: BillingPlan): string {
  return plan === "pro"
    ? "A renewal needs attention. Existing Pro access remains available during the grace period shown above."
    : "The payment grace period has ended. Free access applies; saved records remain available.";
}

export function billingPortalUnavailableMessage(summary: Pick<BillingSummary, "status" | "invoices" | "pendingOperation">): string {
  if (summary.status === "free" && summary.invoices.length === 0 && summary.pendingOperation === null) {
    return "Upgrade to Pro to create a billing account.";
  }
  return "Billing management is temporarily unavailable. Refresh after the provider is available.";
}

export function billingModeLabel(provider: string, mode?: string, demo = false): string {
  if (demo || provider === "fake") return "Synthetic demo billing";
  const providerName = provider === "stripe" ? "Stripe" : "Provider";
  return mode === "live" ? `${providerName} · live` : mode === "test" ? `${providerName} · test mode` : "Provider mode unavailable";
}

export type BillingRequestIdentity = { fingerprint: string; key: string };

export function billingRequestIdentity(
  current: BillingRequestIdentity | null,
  fingerprint: string,
  createKey: () => string = () => crypto.randomUUID(),
): BillingRequestIdentity {
  if (current?.fingerprint === fingerprint) return current;
  return { fingerprint, key: createKey() };
}

export function trustedBillingRedirect(value: string, origin: string, providerHosts: readonly string[], sameOriginPath: string): string | null {
  try {
    const target = new URL(value, origin);
    const appOrigin = new URL(origin).origin;
    if (target.username || target.password || target.protocol !== "https:" && target.origin !== appOrigin) return null;
    if (target.origin === appOrigin && target.pathname === sameOriginPath || target.protocol === "https:" && providerHosts.includes(target.hostname) && target.port === "") return target.toString();
    return null;
  } catch {
    return null;
  }
}

export function trustedInvoiceUrl(value: string | null): string | null {
  if (!value) return null;
  try {
    const target = new URL(value);
    if (target.username || target.password || target.protocol !== "https:" || target.port !== "" || !["invoice.stripe.com", "pay.stripe.com", "billing.stripe.com"].includes(target.hostname)) return null;
    return target.toString();
  } catch {
    return null;
  }
}
