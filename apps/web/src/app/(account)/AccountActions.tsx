"use client";

import { useState } from "react";
import styles from "./[...account]/page.module.css";

type Props = { screen: "login" | "signup" | "recover"; returnTo: string; intent: string; verified?: boolean };
export function AccountActions({ screen, returnTo, intent, verified }: Props) {
  function start(screenOverride?: string) {
    const query = new URLSearchParams({ screen: screenOverride ?? screen, returnTo, ...(intent ? { intent } : {}) });
    window.location.assign(`/api/v1/auth/login?${query.toString()}`);
  }
  return <div className={styles.providerActions}>
    {verified === false && <div role="status" className={styles.notice}>Verify your email from the message sent by our sign-in provider before publishing or saving private records. Check your inbox and spam folder.</div>}
    {verified === true && <div role="status" className={styles.notice}>Your email is verified. Continue to your workspace.</div>}
    {screen === "recover" ? <button type="button" onClick={() => start("recover")}>Continue to the sign-in provider</button> : <button type="button" onClick={() => start(screen)}>{screen === "signup" ? "Continue to secure registration" : "Continue to secure sign in"}</button>}
    <p className={styles.providerNote}>{screen === "recover" ? "On the provider sign-in page, choose its “Forgot password?” link. Recovery details stay with the identity provider; Trading Community never asks for your password." : "Passwords, recovery answers, MFA challenges, and provider tokens are handled by the identity provider. Trading Community never asks you to enter them here."}</p>
  </div>;
}

export function SignOutButton({ csrfToken, all = false }: { csrfToken: string; all?: boolean }) {
  const [error, setError] = useState("");
  async function signOut() {
    setError("");
    try {
      const response = await fetch(`/api/v1/auth/${all ? "logout-all" : "logout"}`, { method: "POST", credentials: "same-origin", cache: "no-store", headers: { "X-CSRF-Token": csrfToken } });
      if (response.status === 401) { window.location.assign("/login"); return; }
      if (response.ok || response.status === 204) window.location.assign("/");
      else setError("We could not end the session. Refresh the page and try again.");
    } catch { setError("We could not reach the account service. Your current session is still active."); }
  }
  return <><button type="button" onClick={signOut}>{all ? "Sign out all sessions" : "Sign out"}</button>{error && <p role="alert">{error}</p>}</>;
}
