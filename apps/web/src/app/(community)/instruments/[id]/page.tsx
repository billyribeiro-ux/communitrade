import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { apiFetch, optionalApiFetch, publicApiFetch } from "@/lib/server-api";
import type { Viewer } from "@/lib/community";
import { instrumentFailure, type InstrumentDetail, type Instrument, type Quote } from "@/lib/instruments";
import { InstrumentDetailView } from "../../../instrument-ui/InstrumentDetail";
import { InstrumentChart } from "@/components/charts/InstrumentChart";
import { chartInstrument, chartHistoryRange, validateBarResult } from "@/lib/chart-data";
import { chartBarsPath, chartFailure, type InitialChart, type ChartRequest } from "@/lib/chart-history";
import styles from "../../../instruments.module.css";

export async function generateMetadata({ params }: { params: Promise<{ id: string }> }): Promise<Metadata> {
  const { id } = await params;
  if (!/^[0-9a-f-]{36}$/i.test(id)) return { title: "Instrument unavailable · Trading Community", robots: { index: false, follow: false } };
  const result = await publicApiFetch<InstrumentDetail>(`/instruments/${encodeURIComponent(id)}`);
  return { title: result.ok ? `${result.data.symbol} · Instrument reference · Trading Community` : "Instrument reference · Trading Community", robots: { index: false, follow: false } };
}
export default async function InstrumentPage({ params, searchParams }: { params: Promise<{ id: string }>; searchParams: Promise<{ metadataVersion?: string }> }) {
  const [{ id }, query] = await Promise.all([params, searchParams]);
  if (!/^[0-9a-f-]{36}$/i.test(id)) notFound();
  if (query.metadataVersion !== undefined && (!/^[1-9]\d*$/.test(query.metadataVersion) || !Number.isSafeInteger(Number(query.metadataVersion)))) {
    return <div className={styles.page}><p className={styles.eyebrow}>INSTRUMENT REFERENCE</p><h1>Invalid metadata version</h1><p className={`${styles.notice} ${styles.warning}`} role="alert">Choose a positive, whole metadata version number. The current instrument metadata remains available.</p><p><Link href={`/instruments/${encodeURIComponent(id)}`}>View current instrument metadata</Link></p></div>;
  }
  const requestedVersion = query.metadataVersion ? Number(query.metadataVersion) : undefined;
  const detailQuery = requestedVersion ? `?metadataVersion=${requestedVersion}` : "";
  const meResult = await apiFetch<{ user: Viewer; csrfToken: string; timezone: string }>("/me");
  const instrumentResult = meResult.ok
    ? await apiFetch<InstrumentDetail>(`/instruments/${encodeURIComponent(id)}${detailQuery}`)
    : await publicApiFetch<InstrumentDetail>(`/instruments/${encodeURIComponent(id)}${detailQuery}`);
  if (!instrumentResult.ok) {
    if (instrumentResult.response?.status === 404) notFound();
    const failure = instrumentFailure(instrumentResult.response?.status, "Instrument reference");
    return <div className={styles.page}><p className={styles.eyebrow}>INSTRUMENT REFERENCE</p><h1>{failure.title}</h1><p className={`${styles.notice} ${styles.warning}`} role="alert">{failure.message}</p></div>;
  }
  const instrument = instrumentResult.data;
  const followState = await optionalApiFetch<{ following: boolean }>(`/instruments/${encodeURIComponent(id)}/follow`);
  const viewer: Viewer | null = meResult.ok ? { ...meResult.data.user, csrfToken: meResult.data.csrfToken } : null;
  const fetchForAudience = <T,>(path: string, options?: { signal: AbortSignal }) => meResult.ok ? apiFetch<T>(path, options) : publicApiFetch<T>(path, options);
  const [quoteResult, underlyingResult] = await Promise.all([
    fetchForAudience<Quote>(`/instruments/${encodeURIComponent(id)}/quote`),
    instrument.asset === "option" && instrument.underlyingId ? fetchForAudience<Instrument>(`/instruments/${encodeURIComponent(instrument.underlyingId)}`) : Promise.resolve(undefined)
  ]);
  const quoteFailure = quoteResult.ok ? undefined : instrumentFailure(quoteResult.response?.status, "Quote snapshot").message;
  const underlyingFailure = underlyingResult && !underlyingResult.ok ? instrumentFailure(underlyingResult.response?.status, "Underlying reference").message : undefined;
  let chart;
  try {
    const currentResult = requestedVersion && instrument.asset !== "option" ? await fetchForAudience<Instrument>(`/instruments/${encodeURIComponent(id)}`) : undefined;
    if (currentResult && !currentResult.ok) throw new Error("Current chart reference is unavailable. Historical metadata remains visible above.");
    const chartTarget = chartInstrument(currentResult?.ok ? currentResult.data : instrument, underlyingResult?.ok ? underlyingResult.data : undefined);
    const now = new Date(Math.min(Date.now(), chartTarget.expiration ? Date.parse(chartTarget.expiration) : Infinity));
    const request: ChartRequest = { instrumentId: chartTarget.id, metadataVersion: chartTarget.metadataVersion, interval: "15m", session: chartTarget.asset === "future" ? "exchange" : "regular", adjustment: "unadjusted", audience: meResult.ok ? "member" : "public", ...chartHistoryRange("15m", now) };
    const initial: InitialChart = { request };
    const response = await fetchForAudience<unknown>(chartBarsPath(request), { signal: AbortSignal.timeout(20_000) });
    if (response.ok) {
      try { initial.result = validateBarResult(response.data, request); }
      catch { initial.error = "The chart provider returned invalid history or mismatched reference metadata. Retry to request a complete snapshot."; }
    } else initial.error = chartFailure(response.response?.status);
    chart = <InstrumentChart key={chartTarget.id} instrument={chartTarget} sourceInstrument={instrument} initial={initial} defaultTimezone={meResult.ok ? meResult.data.timezone : "America/New_York"}/>;
  } catch (error) {
    chart = <section className={styles.card} role="status"><h2>Price chart unavailable</h2><p>{error instanceof Error ? error.message : "Chart reference is unavailable."} No alternate instrument or fabricated candles were substituted.</p></section>;
  }
  return <InstrumentDetailView instrument={instrument} quote={quoteResult.ok ? quoteResult.data : undefined} quoteFailure={quoteFailure} csrfToken={meResult.ok ? meResult.data.csrfToken : null} viewer={viewer} following={followState.ok ? followState.data.following : null} underlying={underlyingResult?.ok ? underlyingResult.data : undefined} underlyingFailure={underlyingFailure} chart={chart}/>;
}
