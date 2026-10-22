import type { Metadata } from "next";
import Link from "next/link";
import { redirect } from "next/navigation";
import type { components } from "@trading/contracts";
import { apiFetch } from "@/lib/server-api";
import styles from "../../workspace-ui/workspace.module.css";

type DraftPageData = components["schemas"]["DraftPage"];
type Props = { searchParams: Promise<{ cursor?: string; layout?: string }> };

export const metadata: Metadata = { title: "Your drafts", robots: { index: false, follow: false } };

function updatedAt(value: string): string {
  const date = new Date(value);
  return Number.isNaN(date.valueOf()) ? "Update time unavailable" : date.toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" });
}

export default async function DraftsPage({ searchParams }: Props) {
  const { cursor, layout } = await searchParams;
  const params = new URLSearchParams({ limit: "50" });
  if (cursor) params.set("cursor", cursor.slice(0, 500));
  const [result, template] = await Promise.all([apiFetch<DraftPageData>(`/drafts?${params.toString()}`), layout && /^[0-9a-f-]{36}$/i.test(layout) ? apiFetch<components["schemas"]["Layout"]>(`/layouts/${layout}`) : Promise.resolve(null)]);
  if (!result.ok && (result.reason === "missing-session" || result.response?.status === 401)) redirect(`/login?returnTo=${encodeURIComponent("/app/drafts")}`);
  return <main className={styles.main}>
    <p className={styles.eyebrow}>PRIVATE · YOUR ACCOUNT</p>
    <h1>Your drafts</h1>
    <p className={styles.intro}>These are private drafts returned for your signed-in account. Set up a draft to choose its instrument and open the chart editor.</p>
    <p><Link href="/app/publish">Start a draft</Link></p>
    {layout && template?.ok && <section className={styles.notice}><div><h2>Choose a draft for “{template.data.name}”</h2><p>The saved template can be applied only to a draft using the same instrument and metadata version.</p></div></section>}
    {!result.ok ? <section className={styles.notice} role="alert"><div><h2>Drafts are unavailable</h2><p>The member draft service did not return your records. Refresh to try again; no sample drafts are shown.</p></div></section> : result.data.items.length === 0 ? <section className={styles.empty}><h2>No drafts yet</h2><p>Your private drafts will appear here after you create one.</p><Link href="/app/publish">Create your first draft</Link></section> : <div className={styles.cards}>
      {result.data.items.map(draft => <article className={styles.card} key={draft.id}>
        <p className={styles.eyebrow}>{draft.kind === "trade" ? "Trade idea" : "Educational post"} · {draft.publicationStatus??"draft"} · revision {draft.revision}</p><h2>{draft.title || "Untitled draft"}</h2>
        <p>{draft.plan?.asset ? `${draft.plan.asset}${draft.plan.instrumentId ? ` · ${draft.plan.instrumentId}` : ""}` : "Instrument not selected"}</p>
        <p>Updated {updatedAt(draft.updatedAt)}</p>
        <div className={styles.actions}><Link href={`/app/drafts/${encodeURIComponent(draft.id)}${layout && template?.ok ? `?layout=${encodeURIComponent(template.data.id)}` : ""}`}>{layout && template?.ok ? "Apply layout and edit chart" : "Edit chart"}</Link><Link href={`/app/drafts/${encodeURIComponent(draft.id)}/compose`}>{draft.publicationStatus==="processing"?"Check publication status":draft.publicationStatus==="published"?"Open publication": "Complete plan and publish"}</Link></div>
      </article>)}
      {result.data.nextCursor && <p><Link href={`/app/drafts?${new URLSearchParams({ cursor: result.data.nextCursor }).toString()}`}>Load more drafts</Link></p>}
    </div>}
  </main>;
}
