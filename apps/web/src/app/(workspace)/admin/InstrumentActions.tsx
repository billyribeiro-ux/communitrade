"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";
import styles from "../../instruments.module.css";

export function InstrumentActions({ instrumentId, enabled, csrfToken }: { instrumentId: string; enabled: boolean; csrfToken: string }) {
  const router = useRouter(); const [reason, setReason] = useState(""); const [error, setError] = useState(""); const [message, setMessage] = useState(""); const [busy, setBusy] = useState(false);
  async function submit() {
    const normalizedReason = reason.trim();
    if (normalizedReason.length < 10) { setError("Enter a reason of at least 10 characters for the audit record."); return; }
    setError(""); setMessage(""); setBusy(true);
    try {
      const response = await fetch(`/api/v1/admin/instruments/${encodeURIComponent(instrumentId)}/actions`, { method: "POST", credentials: "same-origin", cache: "no-store", headers: { Accept: "application/json", "Content-Type": "application/json", "X-CSRF-Token": csrfToken, "Idempotency-Key": crypto.randomUUID() }, body: JSON.stringify({ action: enabled ? "disable" : "enable", reason: normalizedReason }) });
      const body = await response.json().catch(() => ({}));
      if (!response.ok) {
        if (response.status === 401 || response.status === 403) throw new Error("This action needs an administrator session with recent MFA. Complete secure step-up, then retry.");
        throw new Error(typeof body.detail === "string" ? body.detail : "The instrument setting could not be saved. Refresh and retry.");
      }
      setReason(""); setMessage(enabled ? "New publishing disabled. Existing history remains available." : "New publishing enabled. The instrument’s metadata history remains intact."); router.refresh();
    } catch (reason) { setError(reason instanceof Error ? reason.message : "The staff action failed."); }
    finally { setBusy(false); }
  }
  return <div className={styles.selector}><label>Audit reason<textarea maxLength={500} rows={3} value={reason} onChange={event => setReason(event.target.value)} placeholder="Explain the reference data or license issue"/></label><button disabled={busy || reason.trim().length < 10} onClick={submit} type="button">{busy ? "Saving…" : enabled ? "Disable new publishing" : "Enable new publishing"}</button>{error && <p role="alert">{error} {error.includes("recent MFA") && <a href="/api/v1/auth/step-up">Verify again</a>}</p>}{message && <p role="status">{message}</p>}</div>;
}
