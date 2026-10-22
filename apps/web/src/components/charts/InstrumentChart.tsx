"use client";

import dynamic from "next/dynamic";
import { Component, useCallback, useEffect, useId, useMemo, useState, type ReactNode } from "react";
import { ArrowClockwise } from "@phosphor-icons/react";
import type { Instrument } from "@/lib/instruments";
import { chartHistoryRange, formatChartTime, validateBarResult, type BarResult, type ChartInterval } from "@/lib/chart-data";
import { loadChartHistory, type ChartRequest, type InitialChart } from "@/lib/chart-history";
import styles from "./InstrumentChart.module.css";

const ChartHost = dynamic(() => import("./ChartHost").then(module => module.ChartHost), { ssr: false, loading: () => <p role="status">Loading chart renderer… Text prices remain available below.</p> });
type State = { key: string; status: "loading" | "ready" | "error"; result?: BarResult; error?: string; count?: number };
const intervals: readonly [ChartInterval, string][] = [["1m", "1 minute"], ["5m", "5 minutes"], ["15m", "15 minutes"], ["1h", "1 hour"], ["1d", "Daily"]];
const periods = [20, 50, 200] as const;
class ChartRenderBoundary extends Component<{ children: ReactNode; onError: (message: string) => void }, { failed: boolean }> {
  override state = { failed: false };
  static getDerivedStateFromError() { return { failed: true }; }
  override componentDidCatch() { this.props.onError("The chart renderer could not be loaded. Retry to load the renderer and history again."); }
  override render() { return this.state.failed ? null : this.props.children; }
}
function validTimezone(value: string): string {
  try { new Intl.DateTimeFormat("en-US", { timeZone: value }).format(); return value; } catch { return "America/New_York"; }
}
function initialState(initial: InitialChart, key: string): State {
  if (initial.error) return { key, status: "error", error: initial.error };
  if (initial.result && initial.result.nextCursor === null) return { key, status: "ready", result: initial.result };
  return { key, status: "loading", count: initial.result?.bars.length ?? 0 };
}

export function InstrumentChart({ instrument, sourceInstrument, initial, defaultTimezone = "America/New_York" }: {
  instrument: Instrument;
  sourceInstrument: Instrument;
  initial: InitialChart;
  defaultTimezone?: string;
}) {
  const id = useId();
  const [interval, setInterval] = useState<ChartInterval>(initial.request.interval);
  const [anchor, setAnchor] = useState(initial.request.to);
  const [refresh, setRefresh] = useState(0);
  const [timezone, setTimezone] = useState(() => validTimezone(defaultTimezone));
  const [indicators, setIndicators] = useState<readonly (20 | 50 | 200)[]>([]);
  const [renderError, setRenderError] = useState("");
  const [tablePage, setTablePage] = useState(0);
  const request = useMemo<ChartRequest>(() => ({ ...initial.request, interval, ...chartHistoryRange(interval, new Date(anchor)) }), [initial.request, interval, anchor]);
  const key = JSON.stringify([request, refresh]);
  const firstKey = JSON.stringify([initial.request, 0]);
  const [state, setState] = useState<State>(() => initialState(initial, firstKey));
  const onRenderError = useCallback((message: string) => setRenderError(message), []);
  useEffect(() => {
    const controller = new AbortController();
    setRenderError("");
    setTablePage(0);
    if (key === firstKey && initial.error) {
      setState({ key, status: "error", error: initial.error });
      return () => controller.abort();
    }
    if (key === firstKey && initial.result && initial.result.nextCursor === null) {
      setState({ key, status: "ready", result: initial.result });
      return () => controller.abort();
    }
    setState({ key, status: "loading", count: 0 });
    loadChartHistory(request, {
      signal: controller.signal,
      validate: validateBarResult,
      ...(key === firstKey && initial.result ? { initial: initial.result } : {}),
      onProgress: count => { if (!controller.signal.aborted) setState({ key, status: "loading", count }); },
    }).then(result => { if (!controller.signal.aborted) setState({ key, status: "ready", result }); })
      .catch(reason => { if (!controller.signal.aborted) setState({ key, status: "error", error: reason instanceof Error ? reason.message : "Chart data could not be loaded." }); });
    return () => controller.abort();
  }, [key, firstKey, initial, request]);
  const result = state.key === key && state.status === "ready" ? state.result : undefined;
  const bars = result?.bars ?? [];
  const pageCount = Math.max(1, Math.ceil(bars.length / 20));
  const page = Math.min(tablePage, pageCount - 1);
  const tableBars = bars.slice(Math.max(0, bars.length - (page + 1) * 20), bars.length - page * 20).toReversed();
  const timezones = Array.from(new Set([validTimezone(defaultTimezone), "America/New_York", "UTC", "America/Chicago", "America/Los_Angeles", "Europe/London", "Asia/Tokyo"]));
  const snapshotMissing = result?.meta.freshness === "missing" || result?.meta.freshness === "unavailable";
  const currentState = state.key === key ? state : { status: "loading" as const };
  function retry() { setAnchor(new Date(Math.min(Date.now(), instrument.expiration ? Date.parse(instrument.expiration) : Infinity)).toISOString()); setRefresh(value => value + 1); }
  return <section className={styles.panel} aria-labelledby={`${id}-title`}>
    <div className={styles.heading}><div><p className={styles.eyebrow}>PRICE HISTORY</p><h2 id={`${id}-title`}>{sourceInstrument.asset === "option" ? "Underlying price chart" : "Price chart"} · {instrument.symbol}</h2><p>{sourceInstrument.asset === "option" ? "Underlying stock prices only. Option premiums and net spread prices are separate values." : instrument.asset === "future" ? `Listed ${instrument.root} contract · ${instrument.contractMonth}. Changing months selects a different instrument; contracts are not rolled automatically.` : "Stock prices from the permitted history snapshot."}</p></div><button type="button" onClick={retry} disabled={currentState.status === "loading"}><ArrowClockwise size={17} aria-hidden="true"/> Refresh history</button></div>
    <div className={styles.controls}>
      <label>Interval<select value={interval} onChange={event => setInterval(event.target.value as ChartInterval)}>{intervals.map(([value, label]) => <option value={value} key={value}>{label}</option>)}</select></label>
      <label>Display timezone<select value={timezone} onChange={event => setTimezone(event.target.value)}>{timezones.map(value => <option value={value} key={value}>{value.replaceAll("_", " ")}</option>)}</select></label>
      <fieldset><legend>Exponential moving averages</legend>{periods.map(period => <label className={styles.indicator} key={period}><input type="checkbox" checked={indicators.includes(period)} onChange={event => setIndicators(values => event.target.checked ? [...values, period] : values.filter(value => value !== period))}/><span className={period === 20 ? styles.ema20 : period === 50 ? styles.ema50 : styles.ema200}>EMA {period}</span></label>)}</fieldset>
    </div>
    <p className={styles.context}>{request.session === "regular" ? "Regular stock session" : "Exchange futures session, including overnight trading"} · {timezone} · unadjusted · chart metadata v{instrument.metadataVersion} · prices in {instrument.currency}. Daily candles represent the session opening timestamp; crosshair times use the selected timezone.</p>
    {sourceInstrument.metadataVersion !== instrument.metadataVersion && sourceInstrument.id === instrument.id && <p className={styles.notice}>The reference above is historical metadata v{sourceInstrument.metadataVersion}. This chart is current market context using metadata v{instrument.metadataVersion}.</p>}
    {initial.request.to !== initial.request.from && <p className={styles.context}>Requested coverage: {request.from.slice(0, 10)} through {request.to.slice(0, 10)} UTC · {interval === "1d" ? "one calendar year" : "90 calendar days"}. Newly listed contracts and supplier gaps may provide shorter history. Closed sessions and missing bars are left as gaps.</p>}
    {currentState.status === "loading" && <p role="status" className={styles.notice}>Loading permitted chart history… {"count" in currentState && currentState.count ? `${currentState.count.toLocaleString()} bars received.` : ""}</p>}
    {currentState.status === "error" && <div role="alert" className={styles.error}><strong>Chart unavailable.</strong> {"error" in currentState && currentState.error} <button type="button" onClick={retry}>Retry chart data</button></div>}
    {result && <><p className={`${styles.notice} ${result.meta.demo || result.meta.freshness === "stale" ? styles.warning : ""}`} role="status"><strong>{result.meta.demo ? "Demo data · synthetic. " : ""}</strong>{result.meta.providerReference} · {result.meta.freshness} · {result.meta.delaySeconds} second delay · as of {result.meta.asOf ? formatChartTime(Date.parse(result.meta.asOf) / 1000, timezone) : "not supplied"}. This is a history snapshot; refresh to request updated data.</p>
      {snapshotMissing || bars.length === 0 ? <p className={styles.notice}>No chart bars were returned for this instrument and requested period. The provider reports {result.meta.freshness}. No candles have been generated to fill the missing history.</p> : <>
        {renderError ? <div className={styles.error} role="alert">{renderError} Text prices below remain available. <button type="button" onClick={retry}>Retry renderer and data</button></div> : <ChartRenderBoundary key={key} onError={onRenderError}><ChartHost bars={bars} interval={interval} timezone={timezone} tickSize={instrument.tickSize} indicators={indicators} label={`${instrument.symbol} ${request.session} unadjusted price history`} onError={onRenderError}/></ChartRenderBoundary>}
        {indicators.some(period => bars.length < period) && <p className={styles.notice}>An EMA appears only after its full period of observed candles. There are {bars.length} bars in this history; missing warmup values are not invented.</p>}
        <details className={styles.prices} open><summary>Text price history · {bars.length.toLocaleString()} observed bars</summary><p>Exact source prices are shown below. Canvas prices and indicators use numeric rendering; these table values preserve the source decimals. No trade plan has been entered on this reference chart.</p><div className={styles.tableScroll} tabIndex={0} role="region" aria-label="Chart price history table"><table><caption>Observed OHLC and volume · {instrument.symbol} · {timezone}</caption><thead><tr><th scope="col">Session opening / bar time</th><th scope="col">Open</th><th scope="col">High</th><th scope="col">Low</th><th scope="col">Close</th><th scope="col">Volume</th></tr></thead><tbody>{tableBars.map(bar => <tr key={bar.time}><th scope="row"><time dateTime={bar.time}>{formatChartTime(Date.parse(bar.time) / 1000, timezone)}</time></th><td>{bar.open}</td><td>{bar.high}</td><td>{bar.low}</td><td>{bar.close}</td><td>{bar.volume}</td></tr>)}</tbody></table></div><div className={styles.pagination}><button type="button" disabled={page === 0} onClick={() => setTablePage(page - 1)}>Newer prices</button><span role="status">Page {page + 1} of {pageCount}</span><button type="button" disabled={page + 1 >= pageCount} onClick={() => setTablePage(page + 1)}>Older prices</button></div></details>
      </>}
    </>}
    <noscript><p>JavaScript is required for the interactive chart. Any server-rendered text prices remain available.</p></noscript>
  </section>;
}
