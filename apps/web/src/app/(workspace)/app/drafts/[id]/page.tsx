import Link from "next/link";
import { notFound } from "next/navigation";
import { apiFetch } from "@/lib/server-api";
import { parseChartDocument, type Draft, type ChartDocument } from "@/lib/draft-client";
import type { Instrument } from "@/lib/instruments";
import { DraftChartEditor } from "@/components/charts/DraftChartEditor";
import type { components } from "@trading/contracts";

export default async function DraftPage({params,searchParams}: {params: Promise<{id: string}>;searchParams:Promise<{layout?:string}>}) {
  const [{id},{layout:layoutId}] = await Promise.all([params,searchParams]);
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(id)) notFound();
  const [draft, chart, me, template, usage] = await Promise.all([apiFetch<Draft>(`/drafts/${id}`), apiFetch<ChartDocument>(`/drafts/${id}/chart`), apiFetch<{csrfToken: string; timezone: string}>("/me"), layoutId && /^[0-9a-f-]{36}$/i.test(layoutId) ? apiFetch<components["schemas"]["Layout"]>(`/layouts/${layoutId}`) : Promise.resolve(null), apiFetch<{layouts:number;layoutCount:number}>("/workspace-usage")]);
  if (!draft.ok && draft.response?.status === 404) notFound();
  if (!draft.ok || !me.ok || (!chart.ok && chart.response?.status !== 404)) return <section><h1>Draft unavailable</h1><p role="alert">The private draft service is unavailable. Reload to try again.</p><Link href="/app/drafts">All drafts</Link></section>;
  let saved: ChartDocument | null = null;
  try { if (chart.ok) saved = parseChartDocument(chart.data); }
  catch { return <section><h1>Saved chart unavailable</h1><p role="alert">The saved chart failed validation. No changes have been made.</p><Link href="/app/drafts">All drafts</Link></section>; }
  const instrumentId = saved ? saved.state.instrumentId : draft.data.plan?.instrumentId;
  if (!instrumentId) return <section><h1>Chart reference needed</h1><p>This draft does not have a chart instrument yet.</p><Link href="/app/publish">Start a chart draft</Link></section>;
  const instrument = await apiFetch<Instrument>(`/instruments/${encodeURIComponent(instrumentId)}`);
  if (!instrument.ok) return <section><h1>{draft.data.title || "Chart reference unavailable"}</h1><p role="alert">The instrument reference is unavailable. Saved text and drawing values remain below; editing requires the reference to return.</p><p>{draft.data.thesis}</p>{saved && <ul>{saved.state.drawings.map(drawing => <li key={drawing.id}><strong>{drawing.type}</strong> {drawing.text} · {drawing.anchors.map(anchor => `${anchor.time}: ${anchor.price}`).join(" / ")}</li>)}</ul>}<Link href="/app/drafts">All drafts</Link></section>;
  if (layoutId && template?.ok) {
    if (["processing","published"].includes(draft.data.publicationStatus??"")) return <section><h1>Choose a mutable draft</h1><p role="alert">This chart is already publishing or published. Apply the layout to another private draft.</p><Link href="/app/drafts">Choose another draft</Link></section>;
    if (template.data.state.instrumentId !== instrument.data.id || template.data.state.metadataVersion !== instrument.data.metadataVersion) return <section><h1>Layout cannot be applied</h1><p role="alert">“{template.data.name}” uses a different instrument or metadata version. Choose a compatible chart draft.</p><Link href={`/app/drafts?layout=${encodeURIComponent(template.data.id)}`}>Choose another draft</Link></section>;
    saved = { revision: saved?.revision ?? 0, state: template.data.state };
  }
  const canCreateLayout=!usage.ok||usage.data.layoutCount<usage.data.layouts;
  return <DraftChartEditor key={`${id}-${layoutId??""}`} initialDraft={draft.data} initialDocument={saved} instrument={instrument.data} csrfToken={me.data.csrfToken} defaultTimezone={me.data.timezone} applyTemplateState={!!layoutId && !!template?.ok} template={layoutId&&template?.ok?template.data:null} canCreateLayout={canCreateLayout}/>;
}
