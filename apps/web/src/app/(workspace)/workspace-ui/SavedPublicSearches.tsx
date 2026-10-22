"use client";

import Link from "next/link";
import { useState } from "react";
import { BookmarkSimple, FloppyDisk, Trash } from "@phosphor-icons/react";
import styles from "./saved-searches.module.css";

type Filters = { q?: string; asset?: "stock" | "option" | "future"; strategy?: string; instrumentId?: string; status?: string; author?: string };
type SavedSearch = { id: string; name: string; filters: Filters; revision: number; createdAt: string; updatedAt: string };
type Page = { items: SavedSearch[] };
function searchHref(filters: Filters) { const params = new URLSearchParams(); for (const [key, value] of Object.entries(filters)) if (value) params.set(key, value); return `/app/explore${params.size ? `?${params}` : ""}`; }
function summary(filters: Filters) { const entries = Object.entries(filters).filter(([, value]) => Boolean(value)); return entries.length ? entries.map(([key, value]) => `${key}: ${value}`).join(" · ") : "All public results"; }

export function SavedPublicSearches({ csrfToken, initial, pro }: { csrfToken: string; initial: Page; pro: boolean }) {
  const [items, setItems] = useState(initial.items);
  const [name, setName] = useState(""); const [q, setQ] = useState(""); const [asset, setAsset] = useState(""); const [strategy, setStrategy] = useState(""); const [author, setAuthor] = useState(""); const [instrumentId, setInstrumentId] = useState(""); const [status, setStatus] = useState("");
  const [rename, setRename] = useState<Record<string, string>>({}); const [createAttempt, setCreateAttempt] = useState<{ fingerprint: string; key: string } | null>(null); const [busy, setBusy] = useState(false); const [error, setError] = useState(""); const [notice, setNotice] = useState("");
  async function request(path: string, method: string, body?: unknown, revision?: number, idempotencyKey?: string) {
    const response = await fetch(path, { method, credentials: "same-origin", cache: "no-store", headers: { "X-CSRF-Token": csrfToken, ...(body ? { "Content-Type": "application/json" } : {}), ...(method === "POST" ? { "Idempotency-Key": idempotencyKey ?? crypto.randomUUID() } : {}), ...(revision !== undefined ? { "If-Match": `"${revision}"` } : {}) }, ...(body ? { body: JSON.stringify(body) } : {}) });
    if (response.status === 401) { window.location.assign("/login?returnTo=%2Fapp%2Fsettings%2Fpreferences"); throw new Error("Your session expired. Sign in and try again."); }
    if (!response.ok && response.status !== 204) throw new Error(response.status === 403 ? "Saved searches are available with Pro. Your existing searches remain saved." : "The saved search could not be updated. Try again.");
    return response.status === 204 ? null : await response.json() as SavedSearch;
  }
  async function create(event: React.FormEvent) {
    event.preventDefault(); setBusy(true); setError(""); setNotice("");
    const filters: Filters = { ...(q.trim() ? { q: q.trim() } : {}), ...(asset ? { asset: asset as "stock" | "option" | "future" } : {}), ...(strategy ? { strategy } : {}), ...(author.trim() ? { author: author.trim() } : {}), ...(instrumentId.trim() ? { instrumentId: instrumentId.trim() } : {}), ...(status ? { status } : {}) };
    const command = { name: name.trim(), filters }; const fingerprint = JSON.stringify(command); const key = createAttempt?.fingerprint === fingerprint ? createAttempt.key : crypto.randomUUID(); setCreateAttempt({ fingerprint, key });
    try { const item = await request("/api/v1/me/saved-searches", "POST", command, undefined, key); if (!item) return; setItems(current => [item, ...current]); setCreateAttempt(null); setName(""); setQ(""); setAsset(""); setStrategy(""); setAuthor(""); setInstrumentId(""); setStatus(""); setNotice("Search saved."); }
    catch (cause) { setError(cause instanceof Error ? cause.message : "Search could not be saved."); }
    finally { setBusy(false); }
  }
  async function update(item: SavedSearch) {
    setBusy(true); setError(""); setNotice("");
    const nextName = (rename[item.id] ?? item.name).trim();
    try { const updated = await request(`/api/v1/me/saved-searches/${encodeURIComponent(item.id)}`, "PATCH", { name: nextName }, item.revision); if (!updated) return; setItems(current => current.map(previous => previous.id === item.id ? updated : previous)); setNotice("Search name updated."); }
    catch (cause) { setError(cause instanceof Error ? cause.message : "Search could not be updated."); }
    finally { setBusy(false); }
  }
  async function remove(item: SavedSearch) {
    setBusy(true); setError(""); setNotice("");
    try { await request(`/api/v1/me/saved-searches/${encodeURIComponent(item.id)}`, "DELETE", undefined, item.revision); setItems(current => current.filter(previous => previous.id !== item.id)); setNotice("Search removed."); }
    catch (cause) { setError(cause instanceof Error ? cause.message : "Search could not be removed."); }
    finally { setBusy(false); }
  }
  return <section className={styles.panel}><header><div><p className={styles.kicker}>PUBLIC DISCOVERY</p><h2>Saved searches</h2><p>Save public search filters for quick access. Search text is stored only in your account settings.</p></div><span>{items.length}/5</span></header>
    {items.length > 0 ? <ul className={styles.list}>{items.map(item => <li key={item.id}><div className={styles.itemText}><Link href={searchHref(item.filters)}>{item.name}</Link><small>{summary(item.filters)}</small></div>{pro && <><label className={styles.rename}>Name<input aria-label={`Rename ${item.name}`} maxLength={80} value={rename[item.id] ?? item.name} onChange={event => setRename(current => ({ ...current, [item.id]: event.target.value }))}/></label><button type="button" disabled={busy || !(rename[item.id] ?? item.name).trim()} onClick={() => void update(item)}><FloppyDisk size={17}/> Rename</button></>}<button type="button" disabled={busy} onClick={() => void remove(item)}><Trash size={17}/> Remove</button></li>)}</ul> : <p className={styles.empty}>No saved public searches yet.</p>}
    {pro ? <form className={styles.form} onSubmit={create}><h3>Save a public search</h3><label>Search name<input required maxLength={80} value={name} onChange={event => setName(event.target.value)} placeholder="My watchlist research"/></label><label>Keywords<input maxLength={100} value={q} onChange={event => setQ(event.target.value)} placeholder="Optional public search words"/></label><label>Asset class<select value={asset} onChange={event => setAsset(event.target.value)}><option value="">Any asset</option><option value="stock">Stock</option><option value="option">Option</option><option value="future">Future</option></select></label><label>Strategy<select value={strategy} onChange={event => setStrategy(event.target.value)}><option value="">Any strategy</option>{["long","short","long_call","long_put","bull_call_debit","bear_put_debit","bull_put_credit","bear_call_credit"].map(value=><option key={value} value={value}>{value.replaceAll("_"," ")}</option>)}</select></label><label>Position status<select value={status} onChange={event => setStatus(event.target.value)}><option value="">Any status</option>{["pending","entered","partially_closed","closed","unresolved","canceled","never_entered"].map(value=><option key={value} value={value}>{value.replaceAll("_"," ")}</option>)}</select></label><label>Instrument ID<input maxLength={36} value={instrumentId} onChange={event => setInstrumentId(event.target.value)} placeholder="Optional catalog UUID"/></label><label>Author handle<input maxLength={32} value={author} onChange={event => setAuthor(event.target.value.replace(/^@/, ""))} placeholder="Optional handle"/></label><button type="submit" disabled={busy || items.length >= 5}><BookmarkSimple size={17}/>{busy ? "Saving…" : items.length >= 5 ? "Maximum of 5 saved" : "Save search"}</button>{items.length >= 5 && <small>Remove a saved search before adding another.</small>}</form> : <p className={styles.locked}>Saving and editing up to five searches is included with Pro. Existing saved searches remain available and can be removed while your plan is Free.</p>}
    {error && <p className={styles.error} role="alert">{error}</p>}{notice && <p className={styles.notice} role="status">{notice}</p>}
  </section>;
}
