"use client";
import { useRef, useState } from "react";
import type { FormEvent } from "react";
import { CircleNotch, WarningCircle } from "@phosphor-icons/react";
import type { BillingAdminItem } from "@/lib/billing";
import { billingModeLabel, billingRequestIdentity, billingStatusLabel, formatBillingDate, type BillingRequestIdentity } from "@/lib/billing";
import styles from "./billing.module.css";

export type AdminBillingPage = { items: ReadonlyArray<BillingAdminItem>; nextCursor: string | null };

function toMinorUnits(value: string): number | null {
  const match = /^(0|[1-9]\d*)(?:\.(\d{1,2}))?$/.exec(value);
  if (!match) return null;
  return Number(match[1]) * 100 + Number((match[2] ?? "").padEnd(2, "0"));
}

function AdminBillingItemCard({ item, csrfToken, mfaRecent }: { item: BillingAdminItem; csrfToken: string; mfaRecent: boolean }) {
  const [action, setAction] = useState<"reconcile" | "refund" | "cancel">("reconcile");
  const [paymentId, setPaymentId] = useState(item.payments.find(payment => payment.remainingMinor > 0)?.paymentId ?? "");
  const [amount, setAmount] = useState("");
  const [reason, setReason] = useState("");
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState("");
  const [failure, setFailure] = useState("");
  const requestIdentity = useRef<BillingRequestIdentity | null>(null);
  const payment = item.payments.find(candidate => candidate.paymentId === paymentId);
  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault(); setFailure(""); setMessage("");
    const normalizedReason = reason.trim();
    if (!normalizedReason) { setFailure("Enter a support reason for the audit record."); return; }
    const requestedMinor = toMinorUnits(amount);
    if (action === "refund" && (!payment || requestedMinor === null || requestedMinor <= 0 || requestedMinor > payment.remainingMinor)) { setFailure("Choose an eligible payment and enter a refund amount within its remaining balance."); return; }
    if (action === "cancel" && !window.confirm("Confirm subscription cancellation? The account will keep paid access through its paid-through date.")) return;
    setBusy(true);
    try {
      const body = { action, reason: normalizedReason, ...(action === "refund" ? { paymentId, amount } : {}), ...(action === "cancel" ? { cancelSubscription: true } : {}) };
      const identity = billingRequestIdentity(requestIdentity.current, JSON.stringify({ subscriptionId: item.id, ...body }));
      requestIdentity.current = identity;
      const response = await fetch(`/api/v1/admin/billing/${encodeURIComponent(item.id)}/actions`, { method: "POST", credentials: "same-origin", cache: "no-store", redirect: "error", headers: { Accept: "application/json", "Content-Type": "application/json", "X-CSRF-Token": csrfToken, "Idempotency-Key": identity.key }, body: JSON.stringify(body) });
      if (response.status < 500) requestIdentity.current = null;
      const result = await response.json().catch(() => null) as { message?: unknown } | null;
      if (!response.ok) throw new Error(response.status === 403 ? "The action was denied. Confirm your administrator role and recent MFA." : typeof result?.message === "string" ? result.message : "The billing action could not be confirmed. Refresh the subscription before retrying.");
      setMessage("Action accepted. Refresh the billing list to inspect reconciled provider state."); setReason(""); setAmount("");
    } catch (cause) { setFailure(cause instanceof Error ? cause.message : "The billing service is unavailable."); }
    finally { setBusy(false); }
  }
  return <article className={styles.adminCard}>
    <div className={styles.adminHeading}><div><h2>{item.user.displayName} <span>@{item.user.handle}</span></h2><p>Account {item.user.id} · subscription {item.id}</p></div><span className={styles.status}>{item.entitlement.plan} · {billingStatusLabel(item.entitlement.status)}</span></div>
    <dl className={styles.adminFacts}><div><dt>Provider</dt><dd>{billingModeLabel(item.provider, item.mode, item.demo)}</dd></div><div><dt>Interval</dt><dd>{item.interval ?? "None"}</dd></div><div><dt>Paid through</dt><dd>{formatBillingDate(item.entitlement.paidThrough)}</dd></div><div><dt>Grace through</dt><dd>{formatBillingDate(item.entitlement.graceUntil)}</dd></div><div><dt>Cancel at period end</dt><dd>{item.cancelAtPeriodEnd ? "Yes" : "No"}</dd></div><div><dt>Last reconciled</dt><dd>{formatBillingDate(item.lastReconciledAt)}</dd></div></dl>
    {item.demo && <p className={styles.demoLabel}><strong>Demo billing</strong><span>Synthetic provider state; no real payment has been processed.</span></p>}
    {item.payments.length > 0 && <details className={styles.paymentDetails}><summary>Eligible payments for this subscription</summary><ul>{item.payments.map(payment => <li key={payment.paymentId}>{payment.paymentId} · remaining refundable balance ${(payment.remainingMinor / 100).toFixed(2)}</li>)}</ul></details>}
    <form className={styles.adminForm} onSubmit={submit}>
      <label>Support action<select value={action} onChange={event => setAction(event.target.value as typeof action)}><option value="reconcile">Reconcile provider state</option><option value="refund">Refund payment</option><option value="cancel">Cancel subscription</option></select></label>
      {action === "refund" && <div className={styles.refundFields}><label>Payment<select value={paymentId} onChange={event => setPaymentId(event.target.value)} required><option value="">Choose payment</option>{item.payments.filter(candidate => candidate.remainingMinor > 0).map(candidate => <option key={candidate.paymentId} value={candidate.paymentId}>{candidate.paymentId} · ${(candidate.remainingMinor / 100).toFixed(2)} remaining</option>)}</select></label><label>Refund amount (USD)<input inputMode="decimal" min="0.01" step="0.01" type="number" value={amount} onChange={event => setAmount(event.target.value)} required/></label></div>}
      {action === "cancel" && <p className={styles.subtle}>Cancellation is a separate provider action. Existing paid access remains through the recorded paid-through date.</p>}
      <label>Reason for audit<textarea maxLength={2000} onChange={event => setReason(event.target.value)} required rows={3} value={reason}/></label>
      {!mfaRecent && <p className={styles.warning}>Recent administrator MFA is required. <a href="/api/v1/auth/step-up">Complete secure verification</a>, then reload this list.</p>}
      {failure && <p className={styles.error} role="alert"><WarningCircle size={18} aria-hidden="true"/>{failure}</p>}{message && <p className={styles.success} role="status">{message}</p>}
      <button className={styles.primary} type="submit" disabled={busy || !mfaRecent || (action === "refund" && !item.payments.some(candidate => candidate.remainingMinor > 0))}>{busy ? <><CircleNotch className={styles.spin} size={18} aria-hidden="true"/> Applying…</> : action === "reconcile" ? "Reconcile current provider state" : action === "refund" ? "Submit refund request" : "Confirm subscription cancellation"}</button>
    </form>
  </article>;
}

export function AdminBilling({ data, csrfToken, mfaRecent }: { data: AdminBillingPage; csrfToken: string; mfaRecent: boolean }) {
  return <div className={styles.adminList}>{data.items.length ? data.items.map(item => <AdminBillingItemCard item={item} csrfToken={csrfToken} mfaRecent={mfaRecent} key={item.id}/>) : <section className={styles.adminCard}><h2>No recent billing records</h2><p>The server returned no subscriptions in this page.</p></section>}{data.nextCursor && <p><a href={`/admin/billing?cursor=${encodeURIComponent(data.nextCursor)}`}>Load more subscriptions</a></p>}</div>;
}
