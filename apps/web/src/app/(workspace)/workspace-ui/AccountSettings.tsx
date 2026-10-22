"use client";

import { useState } from "react";
import { SignOutButton } from "@/app/(account)/AccountActions";
import { setThemeChoice } from "@/components/ThemeToggle";
import styles from "./profile-settings.module.css";

type Preference = { theme?: "system" | "dark" | "light"; timezone?: string; digestEnabled?: boolean; digestHour?: 8; digestSuppressed?: boolean; quietFrom?: string; quietUntil?: string; publicationNotices?: boolean; replyNotices?: boolean; mentionNotices?: boolean; bookmarkNotices?: boolean; moderationNotices?: boolean; accountNotices?: boolean; billingNotices?: boolean; analyticsConsent?: boolean; analyticsConsentVersion?: string | null };
type Session = { id: string; createdAt: string; lastSeenAt: string; current: boolean; expiresAt: string };
function date(value: string) { return new Intl.DateTimeFormat(undefined, { dateStyle: "medium", timeStyle: "short" }).format(new Date(value)); }

export function PreferencesForm({ csrfToken, initial }: { csrfToken: string; initial: Preference }) {
  const [error, setError] = useState(""); const [saved, setSaved] = useState(""); const [busy, setBusy] = useState(false);
  async function save(form: FormData) {
    setBusy(true); setError(""); setSaved("");
    const body = { theme: String(form.get("theme")) as "system" | "dark" | "light", timezone: String(form.get("timezone")), digestEnabled: form.get("digestEnabled") === "on", quietFrom: String(form.get("quietFrom")), quietUntil: String(form.get("quietUntil")), publicationNotices: form.get("publicationNotices") === "on", replyNotices: form.get("replyNotices") === "on", mentionNotices: form.get("mentionNotices") === "on", bookmarkNotices: form.get("bookmarkNotices") === "on", moderationNotices: form.get("moderationNotices") === "on", analyticsConsent: form.get("analyticsConsent") === "on" };
    try { const response = await fetch("/api/v1/me/preferences", { method: "PATCH", credentials: "same-origin", cache: "no-store", headers: { "Content-Type": "application/json", "X-CSRF-Token": csrfToken }, body: JSON.stringify(body) }); if (response.status === 401) { window.location.assign("/login?returnTo=%2Fapp%2Fsettings%2Fpreferences"); return; } if (!response.ok) throw new Error("Preferences could not be saved. Your previous settings remain active."); setThemeChoice(body.theme); setSaved("Preferences saved."); }
    catch (cause) { setError(cause instanceof Error ? cause.message : "Preferences could not be saved."); }
    finally { setBusy(false); }
  }
  return <form className={styles.card} action={save}><h2>Workspace preferences</h2><p>Preferences apply to this account across your signed-in devices.</p>
    <label>Theme<select name="theme" defaultValue={initial.theme ?? "system"}><option value="system">Use device setting</option><option value="dark">Dark</option><option value="light">Light</option></select></label>
    <label>Timezone<select name="timezone" defaultValue={initial.timezone ?? "America/New_York"}><option>America/New_York</option><option>America/Chicago</option><option>America/Denver</option><option>America/Los_Angeles</option><option>UTC</option></select></label>
    <fieldset><legend>In-app activity</legend>
      <label className={styles.check}><input type="checkbox" name="publicationNotices" defaultChecked={initial.publicationNotices ?? true}/>Followed publication activity</label>
      <label className={styles.check}><input type="checkbox" name="replyNotices" defaultChecked={initial.replyNotices ?? true}/>Replies to my publications</label>
      <label className={styles.check}><input type="checkbox" name="mentionNotices" defaultChecked={initial.mentionNotices ?? true}/>Mentions</label>
      <label className={styles.check}><input type="checkbox" name="bookmarkNotices" defaultChecked={initial.bookmarkNotices ?? true}/>Updates to bookmarked ideas</label>
      <label className={styles.check}><input type="checkbox" name="moderationNotices" defaultChecked={initial.moderationNotices ?? true}/>Moderation updates</label>
    </fieldset>
    <p>Security, billing, and essential account notices remain enabled.</p>
    <fieldset><legend>Email digest</legend><label className={styles.check}><input type="checkbox" name="digestEnabled" defaultChecked={initial.digestEnabled ?? false}/>Send an optional daily digest</label><p>Free members can receive followed-idea activity; Pro members can include up to five saved public searches. The digest is sent at 08:00 in your timezone. Quiet hours delay delivery when needed. {initial.digestSuppressed ? "Email delivery is suppressed until you opt in again." : ""}</p></fieldset>
    <label>Quiet hours start<input type="time" name="quietFrom" defaultValue={initial.quietFrom ?? "22:00"}/></label><label>Quiet hours end<input type="time" name="quietUntil" defaultValue={initial.quietUntil ?? "08:00"}/></label>
    <fieldset><legend>Product measurement</legend><label className={styles.check}><input type="checkbox" name="analyticsConsent" defaultChecked={initial.analyticsConsent ?? false}/>Allow first-party product measurement</label><p>This optional setting permits bounded, pseudonymous product events. No third-party tracking is used. You can change this choice at any time.</p></fieldset>
    {error && <p role="alert" className={styles.error}>{error}</p>}{saved && <p role="status" className={styles.success}>{saved}</p>}<button disabled={busy}>{busy ? "Saving…" : "Save preferences"}</button>
  </form>;
}

export function SessionManager({ csrfToken, sessions }: { csrfToken: string; sessions: Session[] }) {
  const [items, setItems] = useState(sessions); const [error, setError] = useState("");
  async function revoke(id: string) { setError(""); const response = await fetch(`/api/v1/me/sessions/${id}`, { method: "DELETE", credentials: "same-origin", cache: "no-store", headers: { "X-CSRF-Token": csrfToken } }).catch(() => null); if (response?.status === 401) { window.location.assign("/login?returnTo=%2Fapp%2Fsettings%2Fsecurity"); return; } if (!response || (!response.ok && response.status !== 204)) { setError("This session could not be revoked. Refresh and try again."); return; } setItems(current => current.filter(item => item.id !== id)); if (sessions.find(item => item.id === id)?.current) window.location.assign("/"); }
  return <section className={styles.card}><h2>Signed-in sessions</h2><p>Sign out sessions you no longer use. The identity provider owns your password and MFA settings.</p>{items.length ? <ul className={styles.sessions}>{items.map(item=><li key={item.id}><div><strong>{item.current ? "This session" : "Other session"}</strong><span>Last active {date(item.lastSeenAt)} · expires {date(item.expiresAt)}</span></div>{!item.current && <button type="button" onClick={() => revoke(item.id)}>Sign out</button>}</li>)}</ul> : <p>No active sessions were returned.</p>}{error && <p role="alert" className={styles.error}>{error}</p>}<SignOutButton csrfToken={csrfToken} all/></section>;
}
