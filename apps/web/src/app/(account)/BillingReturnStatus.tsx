"use client";
import Link from "next/link";
import { useCallback, useState } from "react";
import { ArrowClockwise, CheckCircle, CircleNotch, Clock, WarningCircle } from "@phosphor-icons/react";
import type { BillingSummary } from "@/lib/billing";
import { billingStatusLabel, formatBillingDate } from "@/lib/billing";
import styles from "./billing.module.css";

export function BillingReturnStatus({ signedIn, initial }: { signedIn: boolean; initial: BillingSummary | null }) {
  const [summary, setSummary] = useState(initial);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const refresh = useCallback(async () => {
    setBusy(true); setError("");
    try {
      const response = await fetch("/api/v1/billing/subscription", { credentials: "same-origin", cache: "no-store", headers: { Accept: "application/json" } });
      if (!response.ok) throw new Error("Current billing status could not be loaded. Retry shortly.");
      setSummary(await response.json() as BillingSummary);
    } catch (cause) { setError(cause instanceof Error ? cause.message : "Current billing status could not be loaded."); }
    finally { setBusy(false); }
  }, []);
  if (!signedIn) return <section><div className={styles.notice}><Clock size={20} aria-hidden="true"/><div><strong>Sign in to check your subscription</strong><p>Checkout return details do not establish payment or activate Pro.</p></div></div><Link href="/login?returnTo=%2Fsubscribe%2Freturn">Sign in</Link></section>;
  const pro = summary?.plan === "pro";
  const pending = Boolean(summary?.pendingOperation) || summary?.status === "incomplete";
  return <section>
    <div className={styles.notice} role="status">{pro ? <CheckCircle size={20} aria-hidden="true"/> : pending ? <Clock size={20} aria-hidden="true"/> : <WarningCircle size={20} aria-hidden="true"/>}<div><strong>{pro ? "Pro is active on this account" : pending ? "Payment confirmation is still processing" : "No active Pro subscription is recorded"}</strong><p>The page URL cannot change your plan. This status comes from your account’s current server billing record.</p>{summary && <p>Plan: {summary.plan === "pro" ? "Pro" : "Free"} · {billingStatusLabel(summary.status)}{summary.paidThrough ? ` · Paid through ${formatBillingDate(summary.paidThrough)}` : ""}</p>}</div></div>
    {error && <p className={styles.error} role="alert"><WarningCircle size={18} aria-hidden="true"/>{error}</p>}
    <div className={styles.entryAction}><button className={styles.primary} type="button" onClick={refresh} disabled={busy}>{busy ? <><CircleNotch className={styles.spin} size={18} aria-hidden="true"/> Checking account…</> : <><ArrowClockwise size={18} aria-hidden="true"/> Refresh account status</>}</button> <Link href="/app/billing">Open billing</Link></div>
    {!pro && !pending && <p className={styles.subtle}>If checkout was interrupted, you can safely return to plan selection and try again. No payment is assumed here.</p>}
  </section>;
}
