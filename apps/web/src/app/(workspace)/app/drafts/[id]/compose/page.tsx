import Link from "next/link";
import { notFound } from "next/navigation";
import { apiFetch } from "@/lib/server-api";
import { parseChartDocument, type ChartDocument, type Draft } from "@/lib/draft-client";
import type { Instrument } from "@/lib/instruments";
import { Composer } from "@/components/publications/Composer";
export default async function ComposePage({params}:{params:Promise<{id:string}>}){
  const {id}=await params;if(!/^[0-9a-f-]{36}$/i.test(id))notFound();
  const [draft,chart,me]=await Promise.all([apiFetch<Draft>(`/drafts/${id}`),apiFetch<ChartDocument>(`/drafts/${id}/chart`),apiFetch<{csrfToken:string}>("/me")]);
  if(!draft.ok&&draft.response?.status===404)notFound();
  if(!draft.ok||!me.ok||(!chart.ok&&chart.response?.status!==404))return <section><h1>Composer unavailable</h1><p role="alert">The private draft service could not load this draft. Retry later.</p><Link href="/app/drafts">All drafts</Link></section>;
  const instrumentId=draft.data.plan?.instrumentId??(chart.ok?chart.data.state.instrumentId:undefined);
  if(!instrumentId)return <section><h1>Choose an instrument first</h1><Link href="/app/publish">Set up a draft</Link></section>;
  const instrument=await apiFetch<Instrument>(`/instruments/${instrumentId}`);
  if(!instrument.ok)return <section><h1>Reference unavailable</h1><p role="alert">The saved draft is preserved. Its current reference is needed to complete the composer.</p><Link href={`/app/drafts/${id}`}>Read saved chart values</Link></section>;
  let saved:ChartDocument|null=null;try{if(chart.ok)saved=parseChartDocument(chart.data);}catch{return <section><h1>Chart failed validation</h1><p>No changes were made. Reload the saved chart before continuing.</p></section>;}
  return <Composer initialDraft={draft.data} initialChart={saved} instrument={instrument.data} csrfToken={me.data.csrfToken}/>;
}
