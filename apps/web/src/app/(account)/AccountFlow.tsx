"use client";

import { useState } from "react";
import styles from "./[...account]/page.module.css";

export function OnboardingForm({ csrfToken, termsVersion, nextPath }: { csrfToken: string; termsVersion: string; nextPath: string }) {
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  async function submit(form: FormData) {
    setBusy(true); setError("");
    const interests = form.getAll("interests").map(String);
    const body = {
      handle: String(form.get("handle") ?? "").trim().toLowerCase(),
      displayName: String(form.get("displayName") ?? "").trim(),
      experience: String(form.get("experience") ?? ""), interests,
      timezone: String(form.get("timezone") ?? "America/New_York"),
      termsVersion, adultUSDeclaration: form.get("adultUSDeclaration") === "on"
    };
    try {
      const response = await fetch("/api/v1/me/onboarding", { method: "POST", credentials: "same-origin", cache: "no-store", headers: { "Content-Type": "application/json", "X-CSRF-Token": csrfToken }, body: JSON.stringify(body) });
      if (response.ok) { window.location.assign(nextPath); return; }
      if (response.status === 401) { window.location.assign("/login?returnTo=%2Fonboarding"); return; }
      const problem = await response.json().catch(() => null);
      setError(response.status === 409 ? "That handle is already in use or your onboarding changed in another session. Choose another handle and retry." : problem?.detail ?? "We could not save onboarding. Review each field and try again.");
    } catch { setError("We could not reach the account service. Your information has not been confirmed as saved."); }
    finally { setBusy(false); }
  }
  return <form action={submit}>
    <label>Display name<input name="displayName" minLength={2} maxLength={60} required autoComplete="name" /></label>
    <label>Public handle<input name="handle" minLength={3} maxLength={30} pattern="[a-z0-9_]{3,30}" required autoComplete="username" aria-describedby="handle-help" /></label>
    <small id="handle-help">3–30 lowercase letters, numbers, or underscores. This appears on your public profile.</small>
    <label>Experience<select name="experience" required defaultValue=""><option value="" disabled>Select your experience</option><option value="beginner">Learning the basics</option><option value="intermediate">Intermediate</option><option value="experienced">Experienced</option></select></label>
    <fieldset><legend>Interests (choose up to three)</legend>{([{value:"stock",label:"Stocks"},{value:"option",label:"Options"},{value:"future",label:"Futures"}] as const).map(({value,label})=><label className={styles.check} key={value}><input name="interests" type="checkbox" value={value}/>{label}</label>)}</fieldset>
    <label>Timezone<select name="timezone" defaultValue="America/New_York"><option>America/New_York</option><option>America/Chicago</option><option>America/Denver</option><option>America/Los_Angeles</option><option>UTC</option></select></label>
    <label className={styles.check}><input type="checkbox" name="adultUSDeclaration" required/>I confirm I am an adult participant located in the United States, and I have reviewed the linked terms draft {termsVersion}.</label>
    <p>Review the current policy drafts before continuing. Final policy approval remains a release gate.</p>
    {error && <p role="alert" className={styles.error}>{error}</p>}
    <button disabled={busy} type="submit">{busy ? "Saving…" : "Complete setup"}</button>
  </form>;
}
