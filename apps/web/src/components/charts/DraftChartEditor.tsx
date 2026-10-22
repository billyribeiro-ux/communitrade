"use client";

import dynamic from "next/dynamic";
import Link from "next/link";
import { Component, useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { validateChartState } from "@trading/contracts";
import type { components } from "@trading/contracts";
import { DrawingController } from "@/lib/drawings";
import { ChartAutosave, type AutosaveSnapshot } from "@/lib/chart-autosave";
import { DraftRequestError, draftRequest, parseChartDocument, saveChart, type ChartDocument, type ChartState, type Draft } from "@/lib/draft-client";
import { chartHistoryRange, validateBarResult, type BarResult, type ChartInterval } from "@/lib/chart-data";
import { loadChartHistory, type ChartRequest } from "@/lib/chart-history";
import type { Instrument } from "@/lib/instruments";
import { DrawingTools } from "./DrawingTools";
import { AddCurrentLayout } from "@/app/(workspace)/app/research/PrivateResearch";
import styles from "./DraftChartEditor.module.css";

const ChartHost = dynamic(() => import("./ChartHost").then(m => m.ChartHost), { ssr: false, loading: () => <p role="status">Loading chart renderer…</p> });
class RendererBoundary extends Component<{children: ReactNode}, {failed: boolean}> {
  override state = { failed: false };
  static getDerivedStateFromError() { return { failed: true }; }
  override render() { return this.state.failed ? <p role="alert">Chart rendering failed. Your drawing values remain available below. Reload this page to retry after saving.</p> : this.props.children; }
}
const periods = [20, 50, 200] as const;
const intervals = ["1m", "5m", "15m", "1h", "1d"] as const;

export function DraftChartEditor({ initialDraft, initialDocument, instrument, csrfToken, defaultTimezone, applyTemplateState = false, template = null, canCreateLayout = true }: { initialDraft: Draft; initialDocument: ChartDocument | null; instrument: Instrument; csrfToken: string; defaultTimezone: string; applyTemplateState?: boolean; template?: components["schemas"]["Layout"] | null; canCreateLayout?: boolean }) {
  const [draft, setDraft] = useState(initialDraft);
  const [controller] = useState(() => new DrawingController(initialDocument?.state.drawings ?? []));
  const [chart, setChart] = useState<ChartState | null>(initialDocument?.state ?? null);
  const chartRef = useRef(chart);
  const [interval, setInterval] = useState<ChartInterval>(initialDocument?.state.interval ?? "15m");
  const [refresh, setRefresh] = useState(0);
  const [history, setHistory] = useState<BarResult | null>(null);
  const [loading, setLoading] = useState(true);
  const [dataError, setDataError] = useState("");
  const [renderError, setRenderError] = useState("");
  const [notice, setNotice] = useState("");
  const [save, setSave] = useState<AutosaveSnapshot>({status: "saved", revision: initialDocument?.revision ?? 0, message: initialDocument ? "Saved chart loaded." : "Load permitted history to initialize this chart."});
  const autosave = useRef<ChartAutosave | null>(null);
  const initialRef = useRef(initialDocument);
  const [title, setTitle] = useState(initialDraft.title);
  const [thesis, setThesis] = useState(initialDraft.thesis);
  const [notesBusy, setNotesBusy] = useState(false);
  const [notesMessage, setNotesMessage] = useState("");
  const [notesConflict, setNotesConflict] = useState(false);
  const mounted = useRef(false);
  const restoring = useRef(false);
  const discarding = useRef(false);
  const metadataMismatch = !!chart && (chart.metadataVersion !== instrument.metadataVersion || chart.instrumentId !== instrument.id);
  const permitted = instrument.enabled && instrument.meta.capabilities.displayMember && instrument.meta.capabilities.retainBars;
  const publicationLocked = draft.publicationStatus === "processing" || draft.publicationStatus === "published";
  const disabled = publicationLocked || metadataMismatch || !permitted || save.status === "conflict" || notesConflict;
  const disabledRef = useRef(disabled);
  disabledRef.current = disabled;

  const change = useCallback((patch: Partial<ChartState>) => {
    const previous = chartRef.current;
    if (!previous || disabledRef.current || restoring.current) return;
    const next = {...previous, ...patch};
    if (JSON.stringify(previous) === JSON.stringify(next)) return;
    if (!validateChartState(next)) { setNotice("A chart field is invalid. Correct it before saving."); return; }
    chartRef.current = next; setChart(next); autosave.current?.queue(next);
  }, []);

  useEffect(() => {
    mounted.current = true;
    const tokenColor = getComputedStyle(document.documentElement).getPropertyValue("--accent").trim();
    if (/^#[0-9a-f]{6}$/i.test(tokenColor)) controller.setStyle({...controller.getSnapshot().style, color: tokenColor});
    const doc = initialRef.current;
    let owned: ChartAutosave | null = null;
    if (doc) {
      owned = new ChartAutosave(doc, (state, rev, signal) => saveChart(initialDraft.id, csrfToken, state, rev, signal), {onSaved: () => {
        void draftRequest<Draft>(initialDraft.id).then(value => { if (mounted.current) setDraft(previous => ({...previous, revision: value.revision, chartRevision: value.chartRevision, plan: value.plan, updatedAt: value.updatedAt,publicationStatus:value.publicationStatus??"draft",publicationJobId:value.publicationJobId??null,publicationId:value.publicationId??null})); }).catch(() => { if (mounted.current) setNotice("Chart saved. Draft details could not refresh; reload before saving the title or thesis."); });
      }});
      autosave.current = owned;
      if (applyTemplateState) owned.queue(doc.state, true);
    }
    const unsubscribe = owned?.subscribe(() => setSave(owned!.getSnapshot()));
    return () => { mounted.current = false; unsubscribe?.(); owned?.dispose(); autosave.current?.dispose(); autosave.current = null; };
  }, [csrfToken, initialDraft.id, controller, applyTemplateState]);

  useEffect(() => {
    let previous = controller.getCommittedDrawings();
    return controller.subscribe(() => {
      const drawings = controller.getCommittedDrawings();
      if (drawings !== previous) { previous = drawings; change({drawings}); }
    });
  }, [controller, change]);

  useEffect(() => {
    const dirty = save.status !== "saved" || title !== draft.title || thesis !== draft.thesis;
    if (!dirty) return;
    const warn = (event: BeforeUnloadEvent) => { if (!discarding.current) { event.preventDefault(); event.returnValue = ""; } };
    const leave = (event: MouseEvent) => {
      if (event.defaultPrevented || event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey || !(event.target instanceof Element)) return;
      const link = event.target.closest("a[href]");
      if (!(link instanceof HTMLAnchorElement) || link.target === "_blank" || link.hasAttribute("download")) return;
      const next = new URL(link.href, window.location.href);
      if (next.origin === window.location.origin && next.pathname === window.location.pathname && next.search === window.location.search) return;
      if (!window.confirm("Some draft changes are unsaved. Leave this editor and discard those local changes?")) { event.preventDefault(); event.stopPropagation(); }
    };
    window.addEventListener("beforeunload", warn);
    document.addEventListener("click", leave, true);
    return () => { window.removeEventListener("beforeunload", warn); document.removeEventListener("click", leave, true); };
  }, [save.status, title, thesis, draft.title, draft.thesis]);

  useEffect(() => {
    const abort = new AbortController();
    setLoading(true); setDataError(""); setRenderError(""); controller.cancel();
    if (metadataMismatch) { setLoading(false); setDataError("Saved metadata differs from the current contract. Saved drawing values remain available. Start a new draft to use the current reference."); return () => abort.abort(); }
    const current = chartRef.current;
    const anchor = current?.provenance.asOf ?? new Date(Math.min(Date.now(), instrument.expiration ? Date.parse(instrument.expiration) : Infinity)).toISOString();
    const request: ChartRequest = {instrumentId: instrument.id, metadataVersion: instrument.metadataVersion, interval, session: instrument.asset === "future" ? "exchange" : "regular", adjustment: "unadjusted", audience: "member", ...chartHistoryRange(interval, new Date(anchor))};
    loadChartHistory(request, {signal: abort.signal, validate: validateBarResult}).then(result => {
      if (abort.signal.aborted) return;
      if (!result.bars.length || !result.meta.asOf || ["missing", "unavailable"].includes(result.meta.freshness)) throw new Error("No permitted history was returned. Saved drawing values remain available below.");
      setHistory(result); setLoading(false);
      const previous = chartRef.current;
      const provenance = {provider: result.meta.provider, asOf: result.meta.asOf, delaySeconds: result.meta.delaySeconds, demo: result.meta.demo};
      if (!previous) {
        const last = result.bars.at(-1)!;
        const first = result.bars[Math.max(0, result.bars.length - 120)]!;
        let timezone = defaultTimezone;
        try { new Intl.DateTimeFormat("en", {timeZone: timezone}).format(); } catch { timezone = "America/New_York"; }
        const state: ChartState = {schemaVersion: 1, instrumentId: instrument.id, metadataVersion: instrument.metadataVersion, interval, session: request.session, adjustment: "unadjusted", timezone, viewport: {from: first.time, to: new Date(Date.parse(last.time) + 60_000).toISOString()}, indicators: [], provenance, drawings: controller.getCommittedDrawings()};
        if (!validateChartState(state)) throw new Error("The chart source could not initialize a valid saved document.");
        const doc = {revision: 0, state};
        initialRef.current = doc; chartRef.current = state; setChart(state);
        const saver = new ChartAutosave(doc, (value, rev, signal) => saveChart(initialDraft.id, csrfToken, value, rev, signal), {onSaved: () => { void draftRequest<Draft>(initialDraft.id).then(value => {if (mounted.current) setDraft(previous => ({...previous, revision: value.revision, chartRevision: value.chartRevision, plan: value.plan, updatedAt: value.updatedAt,publicationStatus:value.publicationStatus??"draft",publicationJobId:value.publicationJobId??null,publicationId:value.publicationId??null}));}).catch(() => {}); }});
        autosave.current = saver;
        saver.subscribe(() => { if (mounted.current) setSave(saver.getSnapshot()); });
        saver.queue(state, true);
      } else if (previous.interval !== interval) change({interval, provenance});
    }).catch(error => { if (!abort.signal.aborted) { setLoading(false); setDataError(error instanceof Error ? error.message : "Chart history could not be loaded."); } });
    return () => abort.abort();
  }, [instrument, interval, refresh, metadataMismatch, controller, change, defaultTimezone, csrfToken, initialDraft.id]);

  async function reload() {
    if (!window.confirm("Discard local chart and note edits and load the latest saved draft?")) return;
    try {
      const [document, latest] = await Promise.all([draftRequest<unknown>(`${draft.id}/chart`).then(parseChartDocument).catch(error => { if (error instanceof DraftRequestError && error.status === 404) return null; throw error; }), draftRequest<Draft>(draft.id)]);
      if (!document) {
        // A note conflict can occur before the first chart has ever been saved.
        // Reboot from the server reference instead of requiring a nonexistent chart.
        discarding.current = true;
        window.location.reload();
        return;
      }
      restoring.current = true; controller.replace(document.state.drawings); restoring.current = false;
      chartRef.current = document.state; setChart(document.state); setInterval(document.state.interval);
      autosave.current?.replace(document); setDraft(latest); setTitle(latest.title); setThesis(latest.thesis); setNotesConflict(false); setNotesMessage(""); setNotice("Latest saved draft loaded."); setRefresh(v => v + 1);
    } catch (error) { setNotice(error instanceof Error ? error.message : "The saved chart could not be loaded. Local changes are preserved."); }
  }
  async function saveNotes() {
    setNotesBusy(true); setNotesMessage("");
    try {
      // Settle pending chart writes before taking the draft revision used by this separate edit.
      await autosave.current?.flush();
      if (autosave.current && autosave.current.getSnapshot().status !== "saved") throw new Error("Save or recover your chart changes before saving draft notes.");
      const latest = await draftRequest<Draft>(draft.id);
      if (latest.title !== draft.title || latest.thesis !== draft.thesis) { setNotesConflict(true); throw new Error("Draft notes changed in another session. Local text is preserved; reload the latest draft to continue."); }
      const updated = await draftRequest<Draft>(draft.id, {method: "PATCH", headers: {"Content-Type": "application/json", "X-CSRF-Token": csrfToken, "If-Match": `"${latest.revision}"`}, body: JSON.stringify({title, thesis})});
      setDraft(updated); setNotesMessage("Draft title and thesis saved.");
    } catch (error) { if (typeof error === "object" && error && "status" in error && error.status === 409) setNotesConflict(true); setNotesMessage(error instanceof Error ? error.message : "Notes could not be saved."); }
    finally { setNotesBusy(false); }
  }
  const onViewport = useCallback((viewport: ChartState["viewport"]) => change({viewport}), [change]);
  const last = history?.bars.at(-1);
  const defaultAnchor = useMemo(() => last ? {time: last.time, price: last.close} : undefined, [last?.time, last?.close]);
  const colors = Object.fromEntries(chart?.indicators.map(i => [i.period, i.color]) ?? []);
  return <div className={styles.editor}>
    <header><p className={styles.eyebrow}>PRIVATE CHART DRAFT · {draft.plan?.asset ?? instrument.asset}</p><h1>{draft.title || "Untitled chart draft"}</h1><p>{instrument.symbol} · {instrument.venue}{instrument.contractMonth ? ` · ${instrument.contractMonth}` : ""} · metadata v{chart?.metadataVersion ?? instrument.metadataVersion}</p><Link href={`/app/drafts/${draft.id}/compose`}>Complete plan and publish</Link> · <Link href="/app/drafts">All drafts</Link> · <Link href="/app/publish">Start another draft</Link></header>
    <p className={styles.notice}>Chart notes and thesis may be public when you publish this idea. Keep journal-only notes in your journal. This draft is private until published.</p>
    {publicationLocked && <p className={styles.notice}>This draft is locked for publication. <Link href={`/app/drafts/${draft.id}/compose`}>Open publication status or the visible correction workflow</Link>.</p>}{draft.plan?.asset === "option" && <p className={styles.notice}>This chart shows the stock underlying. Entry, target and invalidation drawings update underlying chart levels only. Option premiums and net spread entry prices remain separate.</p>}
    <section className={styles.panel} aria-label="Draft title and thesis"><label>Title<input maxLength={120} value={title} onChange={e => setTitle(e.target.value)} disabled={disabled || notesBusy}/></label><label>Thesis and public chart context<textarea rows={4} maxLength={10000} value={thesis} onChange={e => setThesis(e.target.value)} disabled={disabled || notesBusy}/></label><button onClick={saveNotes} disabled={disabled || notesBusy}>{notesBusy ? "Saving…" : "Save title and thesis"}</button>{notesMessage && <p role="status">{notesMessage}</p>}</section>
    <section className={styles.panel} aria-label="Chart save status"><p role={save.status === "conflict" || save.status === "error" ? "alert" : "status"}><strong>{save.status.toUpperCase()}</strong> · {save.message} · chart revision {save.revision}</p>{save.status === "error" && <button onClick={() => autosave.current?.retry()}>Retry chart save</button>}{(save.status === "conflict" || notesConflict) && <button onClick={reload}>Reload latest saved draft…</button>}{notice && <p role="status">{notice}</p>}{!permitted && <p role="alert">Current catalog permissions do not allow chart editing. Saved values remain available.</p>}</section>
    <section className={styles.panel} aria-label="Chart view"><div className={styles.controls}><label>Interval<select value={interval} disabled={disabled || loading} onChange={e => setInterval(e.target.value as ChartInterval)}>{intervals.map(i => <option key={i}>{i}</option>)}</select></label><label>Display timezone<select value={chart?.timezone ?? defaultTimezone} disabled={disabled || !chart} onChange={e => change({timezone: e.target.value})}>{Array.from(new Set([defaultTimezone, chart?.timezone ?? "UTC", "UTC", "America/New_York", "America/Chicago", "Europe/London", "Asia/Tokyo"])).map(t => <option key={t}>{t}</option>)}</select></label><fieldset><legend>Exponential moving averages</legend>{periods.map(period => <label key={period}><input type="checkbox" disabled={disabled || !chart} checked={chart?.indicators.some(i => i.period === period) ?? false} onChange={e => { if (chart) { const color = getComputedStyle(document.documentElement).getPropertyValue(`--chart-ema-${period}`).trim(); const resolved = /^#[0-9a-f]{6}$/i.test(color) ? color : "#8AB4FF"; change({indicators: e.target.checked ? [...chart.indicators, {kind: "ema", period, color: resolved}] : chart.indicators.filter(i => i.period !== period)}); } }}/>{period}</label>)}</fieldset><button onClick={() => setRefresh(v => v + 1)} disabled={loading}>Retry history / renderer</button></div>
    {chart && <AddCurrentLayout csrfToken={csrfToken} state={chart} template={template} canCreate={canCreateLayout}/>}
    {loading && <p role="status">Loading complete permitted history…</p>}{dataError && <p role="alert">{dataError} View settings are saved only after history loads successfully.</p>}{renderError && <p role="alert">{renderError} Drawing values remain available below.</p>}
    {history && <p className={styles.notice}>{history.meta.demo && <strong>Demo data · synthetic. </strong>}{history.meta.providerReference} · {history.meta.freshness} · {history.meta.delaySeconds}s delay · as of {history.meta.asOf}. {chart?.session} session · {chart?.adjustment} · display {chart?.timezone}. Gaps are preserved.</p>}
    {!loading && !dataError && !renderError && history && chart && <RendererBoundary key={`${interval}-${refresh}`}><ChartHost bars={history.bars} interval={chart.interval} timezone={chart.timezone} tickSize={instrument.tickSize} indicators={chart.indicators.map(i => i.period)} indicatorColors={colors} drawingController={controller} drawingEditable={!disabled} initialViewport={chart.viewport} onViewportChange={onViewport} onError={setRenderError} label={`${instrument.symbol} private draft chart`}/></RendererBoundary>}
    {last && <p>Latest observed bar · <time dateTime={last.time}>{last.time}</time> · Open {last.open} · High {last.high} · Low {last.low} · Close {last.close} · Volume {last.volume}. Source decimals shown exactly.</p>}</section>
    <DrawingTools controller={controller} disabled={disabled || !chart} {...(defaultAnchor ? {defaultAnchor} : {})}/>
    <section className={styles.panel}><h2>Underlying plan levels</h2><p>Entry {draft.plan?.underlyingChartLevels?.entry ?? "—"} · Invalidation {draft.plan?.underlyingChartLevels?.invalidation ?? "—"} · Targets {draft.plan?.underlyingChartLevels?.targets?.join(", ") || "—"}</p><p>Trade entry price ({draft.plan?.priceKind ?? "not entered"}): {draft.plan?.entryPrice ?? "not entered"}. Complete trade terms are required before publication.</p></section>
  </div>;
}
