"use client";

import { useState } from "react";
import { ArrowClockwise, Gauge } from "@phosphor-icons/react";
import styles from "./jobs.module.css";

export type AdminJob = { id: string; kind: "email" | "notification" | "media" | "publication" | "export" | "outbox"; status: string; attempts: number; maxAttempts: number; nextAttemptAt: string | null; lastErrorCode: string | null; createdAt: string; updatedAt: string; canRetry: boolean };
export type AdminJobPage = { items: AdminJob[]; nextCursor: string | null; telemetry: { pending: number; queued: number; processing: number; failed: number; uncertain: number; oldestPendingSeconds: number } };
const kinds = ["email", "notification", "media", "publication", "export", "outbox"] as const;
function age(seconds: number) { if (seconds < 60) return `${seconds}s`; if (seconds < 3600) return `${Math.floor(seconds / 60)}m`; return `${Math.floor(seconds / 3600)}h ${Math.floor(seconds % 3600 / 60)}m`; }

export function AdminJobs({ csrfToken, data, mfaRecent, kindFilter = "", statusFilter = "" }: { csrfToken: string; data: AdminJobPage; mfaRecent: boolean; kindFilter?: string; statusFilter?: string }) {
  const [reasons, setReasons] = useState<Record<string, string>>({}); const [attempts, setAttempts] = useState<Record<string, { fingerprint: string; key: string }>>({}); const [busy, setBusy] = useState(""); const [error, setError] = useState(""); const [notice, setNotice] = useState("");
  async function retry(job: AdminJob) {
    const reason = reasons[job.id]?.trim() ?? "";
    if (!reason) { setError("Add a reason before requesting a retry."); return; }
    if (!job.canRetry || !mfaRecent) return;
    setBusy(job.id); setError(""); setNotice("");
    try {
      const fingerprint = JSON.stringify({ action: "retry", reason, kind: job.kind });
      const key = attempts[job.id]?.fingerprint === fingerprint ? attempts[job.id]!.key : crypto.randomUUID();
      setAttempts(current => ({ ...current, [job.id]: { fingerprint, key } }));
      const response = await fetch(`/api/v1/admin/jobs/${encodeURIComponent(job.id)}/actions`, { method: "POST", credentials: "same-origin", cache: "no-store", headers: { "Content-Type": "application/json", "X-CSRF-Token": csrfToken, "Idempotency-Key": key }, body: fingerprint });
      if (response.status === 401) { window.location.assign("/login?returnTo=%2Fadmin%2Fjobs"); return; }
      if (response.status === 403) throw new Error("Retry denied. Confirm administrator role and complete a recent MFA check.");
      if (!response.ok) throw new Error("The retry request was not accepted. Refresh the job list and review its current status.");
      setAttempts(current => { const next = { ...current }; delete next[job.id]; return next; });
      setNotice("Retry request recorded in the staff audit log.");
      window.location.reload();
    } catch (cause) { setError(cause instanceof Error ? cause.message : "The retry request failed."); }
    finally { setBusy(""); }
  }
  const telemetry = data.telemetry;
  return <div className={styles.page}><section className={styles.telemetry} aria-label="Job backlog telemetry">
    {[["Pending", telemetry.pending], ["Queued", telemetry.queued], ["Processing", telemetry.processing], ["Failed", telemetry.failed], ["Uncertain", telemetry.uncertain]].map(([label, value]) => <div key={label as string}><span>{label}</span><strong>{value}</strong></div>)}
    <div><span>Oldest pending</span><strong><Gauge size={16}/>{age(telemetry.oldestPendingSeconds)}</strong></div>
  </section>
    {!mfaRecent && <p className={styles.stepUp} role="status">Recent MFA verification is required before retrying jobs. <a href="/api/v1/auth/step-up">Verify now</a>.</p>}
    {error && <p className={styles.error} role="alert">{error}</p>}{notice && <p className={styles.notice} role="status">{notice}</p>}
    <form className={styles.filters} action="/admin/jobs" method="get"><label>Job kind<select name="kind" defaultValue={kindFilter}><option value="">All kinds</option>{kinds.map(value => <option key={value} value={value}>{value}</option>)}</select></label><label>Status<input name="status" maxLength={24} defaultValue={statusFilter} placeholder="failed, pending…"/></label><button type="submit">Filter jobs</button></form>
    {data.items.length ? <div className={styles.jobs}>{data.items.map(job => <article className={styles.job} key={job.id}><div className={styles.jobHeader}><div><p className={styles.kicker}>{job.kind} · {job.status}</p><h2>Job {job.id.slice(0, 8)}</h2></div><span>{job.attempts}/{job.maxAttempts} attempts</span></div><dl><dt>Created</dt><dd>{new Date(job.createdAt).toLocaleString()}</dd><dt>Updated</dt><dd>{new Date(job.updatedAt).toLocaleString()}</dd>{job.nextAttemptAt && <><dt>Next attempt</dt><dd>{new Date(job.nextAttemptAt).toLocaleString()}</dd></>}{job.lastErrorCode && <><dt>Last error code</dt><dd><code>{job.lastErrorCode}</code></dd></>}</dl>
      {job.canRetry && <div className={styles.retry}><label>Retry reason<input maxLength={500} value={reasons[job.id] ?? ""} onChange={event => setReasons(current => ({ ...current, [job.id]: event.target.value }))} placeholder="Describe the operational reason"/></label><button type="button" disabled={busy !== "" || !mfaRecent || !reasons[job.id]?.trim()} onClick={() => void retry(job)}><ArrowClockwise size={17}/>{busy === job.id ? "Requesting…" : "Retry job"}</button></div>}
    </article>)}</div> : <section className={styles.empty}><h2>No jobs match this view</h2><p>Try another kind or status filter.</p></section>}
    {data.nextCursor && <a className={styles.next} href={`/admin/jobs?${new URLSearchParams({ ...(kindFilter ? { kind: kindFilter } : {}), ...(statusFilter ? { status: statusFilter } : {}), cursor: data.nextCursor })}`}>Next page</a>}
  </div>;
}
