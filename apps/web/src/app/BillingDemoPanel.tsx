"use client";
import Link from "next/link";
import { useRef, useState } from "react";
import { CircleNotch, CreditCard, WarningCircle } from "@phosphor-icons/react";
import { billingRequestIdentity, formatBillingTimestamp, type BillingInterval, type BillingRequestIdentity } from "@/lib/billing";
import styles from "./BillingDemo.module.css";

export type BillingDemoSession = { id: string; kind: "checkout" | "portal"; status: "open" | "complete" | "canceled" | "expired"; interval: BillingInterval | null; amountMinor: number | null; currency: "usd"; expiresAt: string };

export function BillingDemoPanel({ session, csrfToken }: { session: BillingDemoSession; csrfToken: string }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const requestIdentity = useRef<BillingRequestIdentity | null>(null);
  const checkout = session.kind === "checkout";
  const open = session.status === "open";
  async function act(action: "complete" | "cancel_checkout" | "cancel" | "resume") {
    if (action === "cancel" && !window.confirm("Cancel this plan at the end of its paid period? Pro access remains through the paid-through date.")) return;
    setBusy(true); setError("");
    try {
      const payload = { action };
      const identity = billingRequestIdentity(requestIdentity.current, JSON.stringify({ sessionId: session.id, ...payload }));
      requestIdentity.current = identity;
      const response = await fetch(`/api/v1/billing/demo/${encodeURIComponent(session.id)}/actions`, { method: "POST", credentials: "same-origin", cache: "no-store", redirect: "error", headers: { Accept: "application/json", "Content-Type": "application/json", "X-CSRF-Token": csrfToken, "Idempotency-Key": identity.key }, body: JSON.stringify(payload) });
      if (response.status < 500) requestIdentity.current = null;
      const body = await response.json().catch(() => null) as { url?: unknown; message?: unknown } | null;
      if (!response.ok || !body || typeof body.url !== "string") throw new Error(typeof body?.message === "string" ? body.message : "The demo action could not be confirmed. Reload the current account state before retrying.");
      const target = new URL(body.url, window.location.origin);
      if (target.origin !== window.location.origin || target.pathname !== (checkout ? "/subscribe/return" : "/app/billing")) throw new Error("The return destination was not accepted.");
      window.location.assign(target.toString());
    } catch (cause) { setError(cause instanceof Error ? cause.message : "The billing service is unavailable."); setBusy(false); }
  }
  return <div className={styles.wrap}>
    <div className={styles.banner}><strong>Demo billing</strong><span>This is synthetic provider activity in a local environment. No real payment is made and this screen does not grant access.</span></div>
    <section className={styles.card}>
      <p className={styles.kicker}>{checkout ? "SECURE CHECKOUT SIMULATION" : "CUSTOMER PORTAL SIMULATION"}</p>
      <h1>{checkout ? "Review demo checkout" : "Manage demo subscription"}</h1>
      <p>{checkout ? "Confirming this action sends a synthetic provider event. Pro access appears only after the server reconciles that event." : "Cancellation takes effect at the paid-through date. You can resume before the date if the provider permits."}</p>
      <dl className={styles.details}><div><dt>Session</dt><dd>{session.id}</dd></div><div><dt>Status</dt><dd>{session.status}</dd></div>{session.interval && <div><dt>Interval</dt><dd>{session.interval === "annual" ? "Annual" : "Monthly"}</dd></div>}{session.amountMinor !== null && <div><dt>Amount</dt><dd>{new Intl.NumberFormat("en-US", { style: "currency", currency: session.currency.toUpperCase() }).format(session.amountMinor / 100)}</dd></div>}<div><dt>Session expires</dt><dd>{formatBillingTimestamp(session.expiresAt)}</dd></div></dl>
      {error && <p className={styles.error} role="alert"><WarningCircle size={18} aria-hidden="true"/>{error}</p>}
      {open ? checkout ? <div className={styles.actions}><button type="button" className={styles.primary} disabled={busy} onClick={() => act("complete")}>{busy ? <><CircleNotch className={styles.spin} size={18} aria-hidden="true"/> Confirming…</> : <><CreditCard size={18} aria-hidden="true"/> Confirm synthetic payment</>}</button><button type="button" className={styles.secondary} disabled={busy} onClick={() => act("cancel_checkout")}>Cancel checkout</button></div> : <div className={styles.actions}><button type="button" className={styles.primary} disabled={busy} onClick={() => act("cancel")}>{busy ? <><CircleNotch className={styles.spin} size={18} aria-hidden="true"/> Updating…</> : "Cancel at period end"}</button><button type="button" className={styles.secondary} disabled={busy} onClick={() => act("resume")}>Resume plan</button></div> : <p className={styles.result} role="status">This demo session is {session.status}. Refresh billing to see the server’s current account state.</p>}
      <p className={styles.back}><Link href={checkout ? "/subscribe/return" : "/app/billing"}>{checkout ? "Return to subscription status" : "Return to billing"}</Link></p>
    </section>
  </div>;
}
