import type { BarResult, ChartInterval, ExpectedBarResult } from "./chart-data";

export type ChartRequest = ExpectedBarResult & {
  interval: ChartInterval;
  metadataVersion: number;
  session: "regular" | "exchange";
  adjustment: "unadjusted";
  audience: "public" | "member";
  from: string;
  to: string;
};
export type InitialChart = { request: ChartRequest; result?: BarResult; error?: string };
type Validator = (value: unknown, expected: ExpectedBarResult) => BarResult;

export function chartBarsPath(request: ChartRequest, cursor?: string): string {
  const query = new URLSearchParams({ interval: request.interval, session: request.session, from: request.from, to: request.to, limit: "10000" });
  if (cursor !== undefined) query.set("cursor", cursor);
  return `/instruments/${encodeURIComponent(request.instrumentId)}/bars?${query}`;
}

export function chartFailure(status?: number): string {
  if (status === 401) return "Your session has expired. Sign in again to load permitted chart history.";
  if (status === 403) return "Chart history is unavailable under the current display or retention permissions.";
  if (status === 404) return "The selected chart instrument is unavailable.";
  if (status === 429) return "Chart requests are temporarily limited. Wait a minute, then retry.";
  if (status === 400) return "This chart request is unsupported. Check the contract, interval and session, then retry.";
  return "Chart data is temporarily unavailable. Retry to request a new history snapshot.";
}

/** One request scope owns every page. No partial history is silently presented as complete. */
export async function loadChartHistory(request: ChartRequest, options: {
  signal: AbortSignal;
  validate: Validator;
  fetcher?: typeof fetch;
  initial?: BarResult;
  onProgress?: (count: number) => void;
}): Promise<BarResult> {
  const fetcher = options.fetcher ?? fetch;
  const seen = new Set<string>();
  let cursor: string | undefined;
  let result: BarResult | undefined;
  let previousTime = -Infinity;
  for (let page = 0; page < 100; page += 1) {
    options.signal.throwIfAborted();
    let next: BarResult;
    if (page === 0 && options.initial) next = options.validate(options.initial, request);
    else {
      const timeout = new AbortController();
      const abort = () => timeout.abort(options.signal.reason);
      options.signal.addEventListener("abort", abort, { once: true });
      const timer = setTimeout(() => timeout.abort(new Error("Chart request timed out")), 20_000);
      try {
        const response = await fetcher(`/api/v1${chartBarsPath(request, cursor)}`, { credentials: "same-origin", cache: "no-store", headers: { Accept: "application/json" }, signal: timeout.signal, redirect: "error" });
        if (!response.ok) throw new Error(chartFailure(response.status));
        next = options.validate(await response.json(), request);
      } finally {
        clearTimeout(timer);
        options.signal.removeEventListener("abort", abort);
      }
    }
    options.signal.throwIfAborted();
    if (result && (result.meta.provider !== next.meta.provider || result.meta.providerReference !== next.meta.providerReference || result.meta.demo !== next.meta.demo || result.meta.delaySeconds !== next.meta.delaySeconds || Object.keys(result.meta.capabilities).some(key => result!.meta.capabilities[key as keyof BarResult["meta"]["capabilities"]] !== next.meta.capabilities[key as keyof BarResult["meta"]["capabilities"]]))) {
      throw new Error("Chart source or permissions changed while loading. Retry the complete snapshot.");
    }
    for (const bar of next.bars) {
      const time = Date.parse(bar.time);
      if (time <= previousTime) throw new Error("Chart pages overlap or are out of order. No candles were substituted.");
      previousTime = time;
    }
    if (next.meta.freshness === "unavailable") {
      if (result?.bars.length || next.nextCursor) throw new Error("The provider became unavailable while loading. Retry the complete history snapshot.");
      return next;
    }
    if ((result?.bars.length ?? 0) + next.bars.length > 200_000) throw new Error("Chart history exceeded the bounded observation limit. No partial chart was presented as complete.");
    const bars = [...(result?.bars ?? []), ...next.bars];
    const stale = result?.meta.freshness === "stale" || next.meta.freshness === "stale";
    const asOf = result?.meta.asOf && (!next.meta.asOf || Date.parse(result.meta.asOf) > Date.parse(next.meta.asOf)) ? result.meta.asOf : next.meta.asOf;
    const freshness = stale ? "stale" : bars.length && next.meta.freshness === "missing" ? result?.meta.freshness ?? "missing" : next.meta.freshness;
    result = { ...next, bars, meta: { ...next.meta, asOf, freshness } };
    options.onProgress?.(bars.length);
    if (next.nextCursor === null) return result;
    if (seen.has(next.nextCursor) || next.nextCursor === cursor) throw new Error("Chart pagination did not advance. Retry the history snapshot.");
    seen.add(next.nextCursor);
    cursor = next.nextCursor;
  }
  throw new Error("Chart history exceeded the bounded page limit. No partial chart was presented as complete.");
}
