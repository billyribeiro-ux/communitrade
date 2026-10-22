"use client";
import Link from "next/link";
import { useRef, useState } from "react";
import { ArrowSquareOut, CircleNotch, CreditCard, WarningCircle } from "@phosphor-icons/react";
import { BillingInvoiceLink } from "@/app/BillingInvoiceLink";
import { BillingResumeCheckoutLink } from "@/app/BillingResumeCheckoutLink";
import type { BillingSummary } from "@/lib/billing";
import { billingModeLabel, billingPastDueMessage, billingPortalUnavailableMessage, billingRequestIdentity, billingStatusLabel, formatBillingDate, trustedBillingRedirect, type BillingRequestIdentity } from "@/lib/billing";
import styles from "./billing.module.css";

function money(amountMinor: number, currency: string) {
  return new Intl.NumberFormat("en-US", { style: "currency", currency: currency.toUpperCase() }).format(amountMinor / 100);
}

export function BillingPanel({ initial, csrfToken, appOrigin }: { initial: BillingSummary; csrfToken: string; appOrigin: string }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const portalRequestIdentity = useRef<BillingRequestIdentity | null>(null);
  async function openPortal() {
    setBusy(true); setError("");
    try {
      const identity = billingRequestIdentity(portalRequestIdentity.current, "portal");
      portalRequestIdentity.current = identity;
      const response = await fetch("/api/v1/billing/portal", { method: "POST", credentials: "same-origin", cache: "no-store", redirect: "error", headers: { Accept: "application/json", "X-CSRF-Token": csrfToken, "Idempotency-Key": identity.key } });
      if (response.status < 500) portalRequestIdentity.current = null;
      const body = await response.json().catch(() => null) as { url?: unknown; message?: unknown } | null;
      if (!response.ok || !body || typeof body.url !== "string") throw new Error(typeof body?.message === "string" ? body.message : "The billing portal is unavailable. Your plan has not changed.");
      const target = trustedBillingRedirect(body.url, window.location.origin, ["billing.stripe.com"], "/app/billing/demo");
      if (!target) throw new Error("The billing portal destination was not accepted.");
      window.location.assign(target);
    } catch (cause) { setError(cause instanceof Error ? cause.message : "The billing service is unavailable."); setBusy(false); }
  }
  const isPro = initial.plan === "pro";
  const statusTone = initial.status === "past_due" ? styles.warning : initial.status === "unpaid" ? styles.danger : "";
  return <div className={styles.stack}>
    {initial.demo && <div className={styles.demoLabel} role="note"><strong>Demo billing</strong><span>Synthetic provider activity is active in this local environment. It does not represent a real payment.</span></div>}
    <section className={styles.panel}>
      <div className={styles.planHeading}><div><p className={styles.kicker}>CURRENT PLAN</p><h2>{isPro ? "Pro" : "Free"}</h2></div><span className={`${styles.status} ${statusTone}`}>{billingStatusLabel(initial.status)}</span></div>
      <dl className={styles.facts}><div><dt>Billing provider</dt><dd>{billingModeLabel(initial.provider, initial.mode, initial.demo)}</dd></div><div><dt>Billing interval</dt><dd>{initial.interval === "annual" ? "Annual" : initial.interval === "monthly" ? "Monthly" : "No paid interval"}</dd></div><div><dt>Paid access through</dt><dd>{formatBillingDate(initial.paidThrough)}</dd></div>{initial.cancelAtPeriodEnd && <div><dt>Cancellation</dt><dd>Scheduled at period end</dd></div>}{initial.graceUntil && <div><dt>Payment grace ends</dt><dd>{formatBillingDate(initial.graceUntil)}</dd></div>}</dl>
      {initial.status === "past_due" && <p className={`${styles.callout} ${styles.warning}`}>{billingPastDueMessage(initial.plan)}</p>}
      {initial.pendingOperation && <p className={styles.callout} role="status">Billing update pending: {initial.pendingOperation.kind} · {initial.pendingOperation.status}. Refresh this page after provider reconciliation.</p>}
      {error && <p className={styles.error} role="alert"><WarningCircle size={18} aria-hidden="true"/>{error}</p>}
      <div className={styles.actions}>{initial.portalAvailable ? <button className={styles.primary} type="button" onClick={openPortal} disabled={busy}>{busy ? <><CircleNotch className={styles.spin} size={18} aria-hidden="true"/> Opening secure billing…</> : <><CreditCard size={18} aria-hidden="true"/> Manage plan and payment</>}</button> : <p className={styles.subtle}>{billingPortalUnavailableMessage(initial)}</p>}
        {initial.resumeCheckoutUrl ? <BillingResumeCheckoutLink className={styles.secondary} url={initial.resumeCheckoutUrl} appOrigin={appOrigin}/> : !isPro && <Link className={styles.secondary} href="/subscribe?plan=pro&interval=monthly">Upgrade to Pro · $29/month</Link>}
        <Link href="/support?topic=billing">Get billing or refund help</Link>
      </div>
    </section>
    <section className={styles.panel}><div className={styles.sectionHeading}><div><p className={styles.kicker}>PLAN USAGE</p><h2>Current allowances</h2></div></div>
      {initial.usage.length ? <div className={styles.usage}>{initial.usage.map(item => { const percentage = item.limit > 0 ? Math.min(100, Math.round(item.used / item.limit * 100)) : 0; return <article className={styles.usageItem} key={item.key}><div className={styles.usageHeading}><strong>{item.label}</strong><span>{item.used} / {item.limit}</span></div><progress aria-label={`${item.label} used`} max={Math.max(1, item.limit)} value={Math.min(item.used, item.limit)} />{percentage >= 100 && <p>Allowance reached. Existing records remain available; new additions resume when capacity is available or your plan changes.</p>}</article>; })}</div> : <p className={styles.subtle}>Usage limits are temporarily unavailable.</p>}
    </section>
    <section className={styles.panel}><div className={styles.sectionHeading}><div><p className={styles.kicker}>INVOICES</p><h2>Billing history</h2></div></div>
      {initial.invoices.length ? <div className={styles.invoiceList}>{initial.invoices.map(invoice => <article className={styles.invoice} key={invoice.id}><div><strong>{invoice.number || "Invoice"}</strong><span>{formatBillingDate(invoice.issuedAt)} · {invoice.status}</span></div><strong>{money(invoice.amountMinor, invoice.currency)}</strong><BillingInvoiceLink className={styles.invoiceLink} url={invoice.hostedInvoiceUrl}>View invoice <ArrowSquareOut size={14} aria-hidden="true"/></BillingInvoiceLink></article>)}</div> : <p className={styles.subtle}>No invoices are available for this account.</p>}
    </section>
    <p className={styles.footnote}>Public ideas and member-reported outcomes remain available independently of plan. Downgrading preserves existing records, with additions limited by Free allowances.</p>
  </div>;
}
