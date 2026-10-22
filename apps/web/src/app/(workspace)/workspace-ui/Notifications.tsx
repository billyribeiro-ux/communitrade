"use client";

import Link from "next/link";
import { useState } from "react";
import { Bell, Check, CheckCircle, Funnel } from "@phosphor-icons/react";
import { safeNotificationHref } from "@/lib/notification-path";
import styles from "./notifications.module.css";

export type NotificationItem = {
  id: string;
  kind: "reply" | "mention" | "followed_publication" | "bookmark_update" | "moderation" | "account" | "billing" | "security";
  text: string;
  url: string;
  sourceId: string | null;
  createdAt: string;
  eventCount: number;
  readAt: string | null;
};
export type NotificationPageData = { items: NotificationItem[]; nextCursor: string | null; unreadCount: number };

function stamp(value: string) {
  return new Intl.DateTimeFormat(undefined, { dateStyle: "medium", timeStyle: "short" }).format(new Date(value));
}

export function Notifications({ csrfToken, initial, initialUnreadOnly = false }: { csrfToken: string; initial: NotificationPageData; initialUnreadOnly?: boolean }) {
  const [page, setPage] = useState(initial);
  const [unreadOnly, setUnreadOnly] = useState(initialUnreadOnly);
  const [cursor, setCursor] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  async function load(filter: boolean, nextCursor?: string | null) {
    setBusy(true); setError("");
    const params = new URLSearchParams({ limit: "20", ...(filter ? { unreadOnly: "true" } : {}), ...(nextCursor ? { cursor: nextCursor } : {}) });
    try {
      const response = await fetch(`/api/v1/notifications?${params}`, { credentials: "same-origin", cache: "no-store" });
      if (response.status === 401) { window.location.assign("/login?returnTo=%2Fapp%2Fnotifications"); return; }
      if (!response.ok) throw new Error("Notifications could not be loaded. Refresh to try again.");
      const data = await response.json() as NotificationPageData;
      setPage(current => nextCursor ? { ...data, items: [...current.items, ...data.items] } : data);
      setCursor(data.nextCursor);
    } catch (cause) { setError(cause instanceof Error ? cause.message : "Notifications could not be loaded."); }
    finally { setBusy(false); }
  }
  async function markRead(id: string) {
    setBusy(true); setError("");
    try {
      const response = await fetch(`/api/v1/notifications/${encodeURIComponent(id)}/read`, { method: "PUT", credentials: "same-origin", cache: "no-store", headers: { "X-CSRF-Token": csrfToken } });
      if (response.status === 401) { window.location.assign("/login?returnTo=%2Fapp%2Fnotifications"); return; }
      if (!response.ok && response.status !== 204) throw new Error("This notification could not be marked read.");
      const now = new Date().toISOString();
      setPage(current => ({ ...current, unreadCount: Math.max(0, current.unreadCount - 1), items: current.items.map(item => item.id === id ? { ...item, readAt: now } : item) }));
    } catch (cause) { setError(cause instanceof Error ? cause.message : "This notification could not be marked read."); }
    finally { setBusy(false); }
  }
  async function markAllRead() {
    setBusy(true); setError("");
    try {
      const response = await fetch("/api/v1/notifications/read-all", { method: "POST", credentials: "same-origin", cache: "no-store", headers: { "X-CSRF-Token": csrfToken } });
      if (response.status === 401) { window.location.assign("/login?returnTo=%2Fapp%2Fnotifications"); return; }
      if (!response.ok && response.status !== 204) throw new Error("Notifications could not be marked read.");
      const now = new Date().toISOString();
      setPage(current => ({ ...current, unreadCount: 0, items: current.items.map(item => ({ ...item, readAt: item.readAt ?? now })) }));
    } catch (cause) { setError(cause instanceof Error ? cause.message : "Notifications could not be marked read."); }
    finally { setBusy(false); }
  }

  return <section className={styles.panel}>
    <header className={styles.header}><div><p className={styles.kicker}>YOUR ACTIVITY</p><h2>{page.unreadCount} unread</h2><p>Updates are grouped by source. Private journal notes are never included.</p></div>
      <div className={styles.actions}><button type="button" aria-pressed={unreadOnly} disabled={busy} onClick={() => { const next = !unreadOnly; setUnreadOnly(next); void load(next, null); }}><Funnel size={17}/> {unreadOnly ? "Showing unread" : "Filter unread"}</button><button type="button" disabled={busy || page.unreadCount === 0} onClick={() => void markAllRead()}><CheckCircle size={17}/> Mark all read</button></div>
    </header>
    {error && <p className={styles.error} role="alert">{error}</p>}
    {page.items.length === 0 ? <div className={styles.empty}><Bell size={26}/><h3>{unreadOnly ? "No unread notifications" : "You’re all caught up"}</h3><p>Replies, mentions, followed publications and account updates will appear here.</p><Link href="/app/settings/preferences">Review notification preferences</Link></div> : <ul className={styles.list}>{page.items.map(item => <li className={item.readAt ? styles.read : styles.unread} key={item.id}>
      <div className={styles.status} aria-label={item.readAt ? "Read" : "Unread"}>{item.readAt ? <Check size={17}/> : <span/>}</div><div className={styles.content}><div className={styles.titleRow}><Link href={safeNotificationHref(item.url)}>{item.text}</Link>{item.eventCount > 1 && <span className={styles.count}>{item.eventCount} updates</span>}</div><p>{item.kind.replaceAll("_", " ")} · {stamp(item.createdAt)}</p></div>{!item.readAt && <button className={styles.readButton} type="button" aria-label={`Mark as read: ${item.text}`} disabled={busy} onClick={() => void markRead(item.id)}>Mark read</button>}
    </li>)}</ul>}
    {cursor && <button className={styles.more} type="button" disabled={busy} onClick={() => void load(unreadOnly, cursor)}>{busy ? "Loading…" : "Load more"}</button>}
    <p className={styles.preferences}><Link href="/app/settings/preferences">Manage notification and digest settings</Link></p>
  </section>;
}
