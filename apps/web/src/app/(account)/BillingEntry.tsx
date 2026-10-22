"use client";
import { useRef, useState } from "react";
import { ArrowRight, CheckCircle, CircleNotch, LockKey, WarningCircle } from "@phosphor-icons/react";
import type { BillingInterval } from "@/lib/billing";
import { billingRequestIdentity, trustedBillingRedirect, type BillingRequestIdentity } from "@/lib/billing";
import styles from "./billing.module.css";

export function BillingEntry({ interval, csrfToken, termsVersion, verified, ready }: { interval: BillingInterval; csrfToken: string; termsVersion: string; verified: boolean; ready: boolean }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const requestIdentity = useRef<BillingRequestIdentity | null>(null);
  async function startCheckout() {
    setBusy(true); setError("");
    try {
      const payload = { plan: "pro", interval, termsVersion };
      const identity = billingRequestIdentity(requestIdentity.current, JSON.stringify(payload));
      requestIdentity.current = identity;
      const response = await fetch("/api/v1/billing/checkout", { method: "POST", credentials: "same-origin", cache: "no-store", redirect: "error", headers: { Accept: "application/json", "Content-Type": "application/json", "X-CSRF-Token": csrfToken, "Idempotency-Key": identity.key }, body: JSON.stringify(payload) });
      if (response.status < 500) requestIdentity.current = null;
      const body = await response.json().catch(() => null) as { url?: unknown; message?: unknown } | null;
      if (!response.ok || !body || typeof body.url !== "string") throw new Error(response.status === 409 ? "A Pro subscription is already associated with this account. Open billing to manage it." : typeof body?.message === "string" ? body.message : "Checkout could not be started. Your plan has not changed.");
      const target = trustedBillingRedirect(body.url, window.location.origin, ["checkout.stripe.com"], "/subscribe/demo");
      if (!target) throw new Error("The checkout destination was not accepted. Retry from billing.");
      window.location.assign(target);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "The billing service is unavailable. Retry in a moment.");
      setBusy(false);
    }
  }
  if (!verified) return <div className={styles.notice}><LockKey size={20} aria-hidden="true"/><div><strong>Verify your email first</strong><p>Paid checkout is available after email verification and acceptance of the current terms.</p></div></div>;
  if (!ready) return <div className={styles.notice}><CheckCircle size={20} aria-hidden="true"/><div><strong>Finish account setup</strong><p>Complete your profile and review the terms before continuing to checkout.</p></div></div>;
  return <div className={styles.entryAction}>{error && <p className={styles.error} role="alert"><WarningCircle size={18} aria-hidden="true"/>{error}</p>}<button className={styles.primary} type="button" onClick={startCheckout} disabled={busy}>{busy ? <><CircleNotch className={styles.spin} size={18} aria-hidden="true"/> Connecting to secure checkout…</> : <>Continue to secure checkout <ArrowRight size={18} aria-hidden="true"/></>}</button><p>Payment details stay with the billing provider. This selection does not activate Pro.</p></div>;
}
