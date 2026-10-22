"use client";

import { useState } from "react";
import styles from "../../(workspace)/workspace-ui/digest-unsubscribe.module.css";

export default function DigestUnsubscribePage() {
  const [busy, setBusy] = useState(false);
  const [state, setState] = useState<"ready" | "done" | "error">("ready");
  async function unsubscribe() {
    const token = new URLSearchParams(window.location.search).get("token") ?? "";
    if (!token || token.length > 500) { setState("error"); return; }
    setBusy(true); setState("ready");
    try {
      const response = await fetch("/api/v1/digest/unsubscribe", { method: "POST", credentials: "omit", cache: "no-store", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ token }) });
      if (!response.ok && response.status !== 204) throw new Error("unsubscribe failed");
      setState("done");
      window.history.replaceState(null, "", "/digest/unsubscribe");
    } catch { setState("error"); }
    finally { setBusy(false); }
  }
  return <main className={styles.page}><section className={styles.card}><p className={styles.kicker}>EMAIL PREFERENCES</p><h1>Unsubscribe from the daily digest</h1>{state === "done" ? <p role="status">The email digest has been turned off for this address.</p> : <><p>Confirm to stop optional daily digest email. Security and billing messages are managed separately.</p>{state === "error" && <p className={styles.error} role="alert">This unsubscribe link is invalid or expired. You can manage digest settings from your account.</p>}<button type="button" disabled={busy} onClick={() => void unsubscribe()}>{busy ? "Updating…" : "Unsubscribe"}</button></>}</section></main>;
}
