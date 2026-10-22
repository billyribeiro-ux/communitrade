import Link from "next/link";
import { notFound } from "next/navigation";
import { apiFetch } from "@/lib/server-api";
import { getExpirationStatus, type Instrument, type InstrumentPage } from "@/lib/instruments";
import { InstrumentActions } from "../InstrumentActions";
import { AdminJobs, type AdminJobPage } from "../AdminJobs";
import { AdminBilling, type AdminBillingPage } from "../AdminBilling";
import { AdminOperations } from "../AdminOperations";
import { AdminSupport } from "../AdminSupport";
import styles from "../../workspace-ui/workspace.module.css";
import instrumentStyles from "@/app/instruments.module.css";

const pages = new Set(["", "reports", "appeals", "corrections", "users", "instruments", "data", "billing", "editorial", "support", "jobs", "audit", "privacy"]);
type Props = { params: Promise<{ segments?: string[] }>; searchParams: Promise<{ q?: string; cursor?: string; kind?: string; status?: string }> };
type Me = { roles:string[]; csrfToken: string; security?: { mfaRecent: boolean } };
type AdminInstrument = Instrument;
type DataStatus = { provider?: { mode?: string; configured?: boolean; source?: string }; capabilities?: Array<{ supplier?: string; agreementId?: string; dataset?: string; audience?: string; purpose?: string; effectiveAt?: string; revokedAt?: string | null; flags?: Record<string, boolean> }>; productionReady?: boolean };
function unavailable(title: string, status?: number) { const message = status === 400 ? "The staff request was not accepted. Check the search fields and retry." : status === 401 ? "Your staff session expired. Sign in and retry." : status === 403 ? "This staff request was denied. Confirm your administrator role and security step-up." : status === 503 ? "The staff data service is temporarily unavailable. Retry when it resumes." : status ? `The staff service returned HTTP ${status}. Retry after checking the request.` : "The staff service did not return this information. Retry after it is available."; return <section className={styles.card} role="alert"><h2>{title}</h2><p>{message}</p><Link href="/admin">Retry</Link></section>; }
function dataTag(name: string, value: unknown) { return <span className={instrumentStyles.tag} key={name}>{name}: {typeof value === "boolean" ? value ? "yes" : "no" : String(value)}</span>; }

export default async function AdminPage({ params, searchParams }: Props) {
  const [{ segments }, query] = await Promise.all([params, searchParams]);
  const key = segments?.join("/") ?? "";
  const reportDetailId = key.startsWith("reports/") ? key.slice("reports/".length) : "";
  if (!pages.has(key) && !(reportDetailId && /^[0-9a-f-]{36}$/i.test(reportDetailId))) notFound();
  const title = key ? key.charAt(0).toUpperCase() + key.slice(1) : "Staff overview";
  if (key === "instruments" || key === "data") {
    const me = await apiFetch<Me>("/me");
    if (!me.ok) return unavailable("Staff session unavailable", me.response?.status);
    if (key === "instruments") {
      const q = query.q?.slice(0, 100) ?? "";
      const adminQuery = new URLSearchParams();
      if (q) adminQuery.set("q", q);
      if (query.cursor) adminQuery.set("cursor", query.cursor);
      adminQuery.set("limit", "20");
      const result = await apiFetch<InstrumentPage & { items: AdminInstrument[] }>(`/admin/instruments?${adminQuery.toString()}`);
      if (!result.ok) return <div className={styles.main}><p className={styles.eyebrow}>STAFF · INSTRUMENT CATALOG</p><h1>Instrument controls</h1>{unavailable("Instrument catalog unavailable", result.response?.status)}</div>;
      return <div className={styles.main}><p className={styles.eyebrow}>STAFF · ADMINISTRATOR ACTIONS</p><h1>Instrument controls</h1><p className={styles.intro}>Disable new publishing when data or licensing does not permit use. Existing publications retain their original instrument metadata and history. Every change requires a reason and is audited.</p>
        <form action="/admin/instruments" className={instrumentStyles.search} method="get"><label>Symbol or name<input autoComplete="off" maxLength={100} name="q" placeholder="Search catalog" defaultValue={q}/></label><button type="submit">Search</button></form>
        {result.data.items.length ? <div className={instrumentStyles.results}>{result.data.items.map(item => <section className={instrumentStyles.card} key={item.id}><div className={instrumentStyles.tags}><span className={instrumentStyles.tag}>{item.asset}</span><span className={instrumentStyles.tag}>metadata v{item.metadataVersion}</span><span className={instrumentStyles.tag}>{item.enabled ? "Catalog enabled" : "Catalog disabled"}</span><span className={instrumentStyles.tag}>{item.enabled && item.meta.capabilities.newPublishing && item.meta.freshness === "fresh" ? "New publishing permitted" : "New publishing held"}</span>{(item.asset === "future" || item.asset === "option") && getExpirationStatus(item.expiration) && <span className={instrumentStyles.tag}>{getExpirationStatus(item.expiration)!.expired ? "Expired · history only" : `Near expiry · ${getExpirationStatus(item.expiration)!.days} days`}</span>}</div><h2>{item.symbol} · {item.name}</h2><p>{item.venue} · {item.currency}{item.root ? ` · root ${item.root}` : ""}{item.contractMonth ? ` · contract month ${item.contractMonth}` : ""}</p><p className={instrumentStyles.intro}>Catalog source {item.meta.providerReference ?? item.meta.provider ?? "unavailable"} · freshness {item.meta.freshness} · as of {item.meta.asOf ?? "missing"} · {item.meta.delaySeconds}s delay</p><p>Metadata versions retained: {(item.versions ?? []).map(v => `v${v.metadataVersion}`).join(", ") || `v${item.metadataVersion}`}</p><InstrumentActions csrfToken={me.data.csrfToken} enabled={item.enabled} instrumentId={item.id}/></section>)}</div> : <div className={instrumentStyles.empty}>No instruments match this catalog search.</div>}
        {result.data.nextCursor && <p><Link href={`/admin/instruments?${new URLSearchParams({ ...(q ? { q } : {}), cursor: result.data.nextCursor })}`}>Load more catalog records</Link></p>}
      </div>;
    }
    const result = await apiFetch<DataStatus>("/admin/data");
    if (!result.ok) return <div className={styles.main}><p className={styles.eyebrow}>STAFF · PROVIDER STATUS</p><h1>Data and license status</h1>{unavailable("Data capability status unavailable", result.response?.status)}</div>;
    const data = result.data;
    return <div className={styles.main}><p className={styles.eyebrow}>STAFF · PROVIDER STATUS</p><h1>Data and license status</h1><p className={styles.intro}>Supplier readiness and capability flags only. This view never returns credential values, tokens, or private member records.</p>
      <section className={instrumentStyles.card}><h2>Provider connection</h2><div className={instrumentStyles.tags}>{dataTag("mode", data.provider?.mode ?? "unknown")}{dataTag("configured", data.provider?.configured ?? false)}{dataTag("source", data.provider?.source ?? "not reported")}{dataTag("production ready", data.productionReady ?? false)}</div></section>
      {data.capabilities?.length ? <div className={instrumentStyles.results}>{data.capabilities.map((capability, index) => <section className={instrumentStyles.card} key={`${capability.supplier}-${capability.dataset}-${index}`}><h2>{capability.supplier ?? "Supplier not reported"} · {capability.dataset ?? "Dataset not reported"}</h2><dl className={instrumentStyles.facts}><dt>Audience</dt><dd>{capability.audience ?? "Not reported"}</dd><dt>Purpose</dt><dd>{capability.purpose ?? "Not reported"}</dd><dt>Effective</dt><dd>{capability.effectiveAt ?? "Not reported"}</dd><dt>Revoked</dt><dd>{capability.revokedAt ?? "No revocation recorded"}</dd></dl><div className={instrumentStyles.tags}>{Object.entries(capability.flags ?? {}).map(([name, value]) => dataTag(name, value))}</div></section>)}</div> : <div className={`${instrumentStyles.notice} ${instrumentStyles.warning}`}>No supplier capability agreements are recorded. Licensed data display and production readiness remain unavailable.</div>}
    </div>;
  }
  if (key === "jobs") {
    const me = await apiFetch<Me>("/me");
    if (!me.ok) return <div className={styles.main}><p className={styles.eyebrow}>STAFF · JOB OPERATIONS</p><h1>Background jobs</h1>{unavailable("Staff session unavailable", me.response?.status)}</div>;
    const validKinds = ["email", "notification", "media", "publication", "export", "outbox"];
    const kind = validKinds.includes(query.kind ?? "") ? query.kind! : "";
    const status = query.status?.slice(0, 24) ?? "";
    const params = new URLSearchParams({ limit: "20", ...(query.cursor ? { cursor: query.cursor } : {}), ...(kind ? { kind } : {}), ...(status ? { status } : {}) });
    const result = await apiFetch<AdminJobPage>(`/admin/jobs?${params}`);
    if (!result.ok) return <div className={styles.main}><p className={styles.eyebrow}>STAFF · JOB OPERATIONS</p><h1>Background jobs</h1>{unavailable("Job operations unavailable", result.response?.status)}</div>;
    return <div className={styles.main}><p className={styles.eyebrow}>STAFF · ADMINISTRATOR ACTIONS</p><h1>Background jobs</h1><p className={styles.intro}>Review bounded queue telemetry and safe failure codes. Job payloads and member content are never shown here. Retry requests require a reason and recent MFA.</p><AdminJobs csrfToken={me.data.csrfToken} data={result.data} mfaRecent={me.data.security?.mfaRecent ?? false} kindFilter={kind} statusFilter={status}/></div>;
  }
  if (key === "billing") {
    const me = await apiFetch<Me>("/me");
    if (!me.ok) return <div className={styles.main}><p className={styles.eyebrow}>STAFF · BILLING SUPPORT</p><h1>Billing support</h1>{unavailable("Staff session unavailable", me.response?.status)}</div>;
    const params = new URLSearchParams({ limit: "20", ...(query.cursor ? { cursor: query.cursor } : {}) });
    const result = await apiFetch<AdminBillingPage>(`/admin/billing?${params}`);
    if (!result.ok) return <div className={styles.main}><p className={styles.eyebrow}>STAFF · BILLING SUPPORT</p><h1>Billing support</h1>{unavailable("Billing records unavailable", result.response?.status)}</div>;
    return <div className={styles.main}><p className={styles.eyebrow}>STAFF · ADMINISTRATOR ACTIONS</p><h1>Billing support</h1><p className={styles.intro}>Review recent provider-backed subscription state. Reconcile, refund, and cancellation actions require a support reason and recent administrator MFA. Refunds are tied to a payment on the selected subscription; a refund does not cancel service. Journal records and payment credentials are never shown.</p><AdminBilling data={result.data} csrfToken={me.data.csrfToken} mfaRecent={me.data.security?.mfaRecent === true}/></div>;
  }
  if (reportDetailId) {
    const me = await apiFetch<Me>("/me");
    if (!me.ok) return <div className={styles.main}><p className={styles.eyebrow}>STAFF · REPORT REVIEW</p><h1>Report case</h1>{unavailable("Staff session unavailable", me.response?.status)}</div>;
    const result = await apiFetch<Record<string, unknown>>(`/admin/reports/${encodeURIComponent(reportDetailId)}`);
    if (!result.ok) return <div className={styles.main}><p className={styles.eyebrow}>STAFF · REPORT REVIEW</p><h1>Report case</h1>{unavailable("Report case unavailable", result.response?.status)}</div>;
    return <AdminOperations mode="reports" csrfToken={me.data.csrfToken} items={{items:[result.data] as never[],nextCursor:null}} mfaRecent={me.data.security?.mfaRecent===true}/>;
  }
  if (key === "support") {
    const me = await apiFetch<Me>("/me");
    if (!me.ok) return <div className={styles.main}><p className={styles.eyebrow}>STAFF · SUPPORT</p><h1>Support requests</h1>{unavailable("Staff session unavailable", me.response?.status)}</div>;
    const params = new URLSearchParams({ limit: "20", ...(query.cursor ? { cursor: query.cursor } : {}), ...(query.status ? { status: query.status } : {}) });
    const result = await apiFetch<{items: Array<{id:string;reference:string;status:"open"|"pending"|"resolved";category:string;subject:string;createdAt:string;updatedAt?:string;requesterUserId:string|null;assignedStaffUserId:string|null;messages:Array<{id?:string;body:string;createdAt:string;fromStaff:boolean}>;accessRequests?:Array<{id:string;resourceType:"journal"|"draft";resourceId:string;purpose:string;status:string;expiresAt:string|null}>}>;nextCursor:string|null}>(`/admin/support?${params}`);
    if (!result.ok) return <div className={styles.main}><p className={styles.eyebrow}>STAFF · SUPPORT</p><h1>Support requests</h1>{unavailable("Support queue unavailable", result.response?.status)}</div>;
    return <AdminSupport csrfToken={me.data.csrfToken} data={result.data} mfaRecent={me.data.security?.mfaRecent===true} statusFilter={query.status??""}/>;
  }
  if (["reports", "appeals", "users", "editorial", "audit", "privacy"].includes(key)) {
    const me = await apiFetch<Me>("/me");
    if (!me.ok) return <div className={styles.main}><p className={styles.eyebrow}>STAFF · {title.toUpperCase()}</p><h1>{title}</h1>{unavailable("Staff session unavailable", me.response?.status)}</div>;
    const queryParams = new URLSearchParams({ limit: "20", ...(query.cursor ? { cursor: query.cursor } : {}) });
    if (query.q?.trim()) queryParams.set("q", query.q.trim().slice(0, 200));
    if (query.status) queryParams.set("status", query.status.slice(0, 24));
    if(key==="privacy"){queryParams.delete("limit");queryParams.delete("cursor");}
    const endpoint = key === "reports" ? "/admin/reports" : key === "appeals" ? "/admin/appeals" : key === "users" ? "/admin/users" : key === "editorial" ? "/admin/editorial" : key === "audit" ? "/admin/audit" : "/admin/privacy/requests";
    const result = await apiFetch<{ items: Array<Record<string, unknown>>; nextCursor: string | null }>(`${endpoint}?${queryParams}`);
    if (!result.ok) return <div className={styles.main}><p className={styles.eyebrow}>STAFF · {title.toUpperCase()}</p><h1>{title}</h1>{unavailable(`${title} unavailable`, result.response?.status)}</div>;
    return <AdminOperations mode={key as "reports" | "appeals" | "users" | "editorial" | "audit" | "privacy"} csrfToken={me.data.csrfToken} items={result.data as never} query={query.q ?? query.status ?? ""} mfaRecent={me.data.security?.mfaRecent === true}/>;
  }
  if (key === "") {
    const [overview, me] = await Promise.all([apiFetch<{openReports:number;openAppeals:number;pendingCorrections:number;failedJobs:number;openSupport:number}>("/admin/overview"), apiFetch<Me>("/me")]);
    if (!overview.ok) return <div className={styles.main}><p className={styles.eyebrow}>STAFF · OVERVIEW</p><h1>Operations</h1>{unavailable("Operational summary unavailable",overview.response?.status)}</div>;
    if (!me.ok) return <div className={styles.main}><p className={styles.eyebrow}>STAFF · OVERVIEW</p><h1>Operations</h1>{unavailable("Staff session unavailable",me.response?.status)}</div>;
    const counts = overview.data;
    const entries: Array<[string, number, string]> = [["Open reports",counts.openReports,"/admin/reports"],["Open appeals",counts.openAppeals,"/admin/appeals"],["Pending corrections",counts.pendingCorrections,"/admin/corrections"]];
    if (me.data.roles.includes("admin")) entries.push(["Failed jobs",counts.failedJobs,"/admin/jobs"],["Open support",counts.openSupport,"/admin/support"]);
    return <div className={styles.main}><p className={styles.eyebrow}>STAFF · OPERATIONS</p><h1>Overview</h1><p className={styles.intro}>A role-scoped summary of moderation, support, corrections, and job work. Open a queue to review each record and its permitted actions.</p><div className={styles.stats}>{entries.map(([label,count,href])=><section className={styles.card} key={label}><p>{label}</p><h2>{count}</h2><Link href={href}>Open queue</Link></section>)}</div></div>;
  }
  return <div className={styles.main}><p className={styles.eyebrow}>STAFF · AUTHORIZED ROLE REQUIRED</p><h1>{title}</h1><section className={styles.card}><h2>Staff data unavailable</h2><p>This page requires a server response scoped to your staff role. No synthetic user, moderation, billing, or audit records are displayed here.</p></section></div>;
}
