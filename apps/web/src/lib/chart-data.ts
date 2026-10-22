import type { components } from "@trading/contracts";
import type { Instrument } from "@/lib/instruments";

export type Bar = components["schemas"]["Bar"];
export type BarResult = components["schemas"]["BarResult"];
export type ChartInterval = BarResult["interval"];
export type ChartSession = BarResult["session"];
export type ChartAdjustment = BarResult["adjustment"];

/** Values converted to IEEE-754 numbers only at the chart-rendering boundary. */
export type RenderBar = {
  time: number;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
  original: Bar;
};

const DECIMAL = /^-?[0-9]{1,18}(?:\.[0-9]{1,10})?$/;
const UTC_TIMESTAMP = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.(\d+))?Z$/;
const INTERVAL_SECONDS: Record<ChartInterval, number> = {
  "1m": 60,
  "5m": 300,
  "15m": 900,
  "1h": 3600,
  "1d": 86400,
};
const MAX_BARS = 10_000;
const MAX_NORMALIZED_BARS = 200_000;
const FUTURE_CLOCK_TOLERANCE_SECONDS = 5 * 60;
const DECIMAL_SCALE = 10_000_000_000n;
const MAX_SAFE_DECIMAL = BigInt(Number.MAX_SAFE_INTEGER) * DECIMAL_SCALE;

function scaledDecimal(value: string): bigint {
  if (typeof value !== "string" || !DECIMAL.test(value)) throw new TypeError("Invalid chart decimal");
  const negative = value.startsWith("-");
  const unsigned = negative ? value.slice(1) : value;
  const [integer, fraction = ""] = unsigned.split(".");
  const magnitude = BigInt(integer!) * DECIMAL_SCALE + BigInt((fraction + "0000000000").slice(0, 10));
  return negative ? -magnitude : magnitude;
}

function decimalNumber(value: string): number {
  const exact = scaledDecimal(value);
  if (exact > MAX_SAFE_DECIMAL || exact < -MAX_SAFE_DECIMAL) {
    throw new RangeError("Chart price or volume exceeds the exact numeric rendering range; source decimals remain available in the text table");
  }
  const result = Number(value);
  if (!Number.isFinite(result)) throw new RangeError("Chart decimal is outside the numeric rendering range");
  return result;
}

/** Converts validated decimal bar values for canvas use and retains each wire bar unchanged. */
export function normalizeRenderBars(bars: readonly Bar[]): RenderBar[] {
  if (!Array.isArray(bars) || bars.length > MAX_NORMALIZED_BARS) throw new RangeError("Chart history exceeds the supported limit");
  let previous = -Infinity;
  return bars.map((bar) => {
    if (!isUtcTimestamp(bar.time)) throw new TypeError("Bar time must be a canonical UTC timestamp");
    const timestamp = Date.parse(bar.time);
    const time = Math.floor(timestamp / 1000);
    if (time <= previous) throw new TypeError("Bars must be strictly chronological without duplicates");
    previous = time;
    const openExact = scaledDecimal(bar.open);
    const highExact = scaledDecimal(bar.high);
    const lowExact = scaledDecimal(bar.low);
    const closeExact = scaledDecimal(bar.close);
    const volumeExact = scaledDecimal(bar.volume);
    if (volumeExact < 0n || highExact < (openExact > closeExact ? openExact : closeExact) || lowExact > (openExact < closeExact ? openExact : closeExact) || highExact < lowExact) {
      throw new TypeError("Bar OHLC or volume values are inconsistent");
    }
    const open = decimalNumber(bar.open);
    const high = decimalNumber(bar.high);
    const low = decimalNumber(bar.low);
    const close = decimalNumber(bar.close);
    const volume = decimalNumber(bar.volume);
    return { time, open, high, low, close, volume, original: bar };
  });
}

/** EMA uses the first complete period's SMA as its seed; earlier values are absent. */
export function computeEMA(bars: readonly RenderBar[], period: 20 | 50 | 200): { time: number; value: number }[] {
  if (![20, 50, 200].includes(period)) throw new RangeError("Unsupported EMA period");
  if (bars.length < period) return [];
  const alpha = 2 / (period + 1);
  const output: { time: number; value: number }[] = [];
  let seedSum = 0;
  let previousTime = -Infinity;
  for (let index = 0; index < bars.length; index += 1) {
    const bar = bars[index]!;
    if (!Number.isFinite(bar.time) || bar.time <= previousTime || !Number.isFinite(bar.close)) {
      throw new TypeError("EMA bars must have finite closes and chronological times");
    }
    previousTime = bar.time;
    if (index < period) seedSum += bar.close;
    if (index === period - 1) output.push({ time: bar.time, value: seedSum / period });
    else if (index >= period) {
      const value = bar.close * alpha + output[output.length - 1]!.value * (1 - alpha);
      output.push({ time: bar.time, value });
    }
  }
  return output;
}

/** Formats an epoch second in an explicit IANA timezone, including DST-aware local labels. */
export function formatChartTime(epochSeconds: number, timezone: string, daily = false): string {
  if (!Number.isFinite(epochSeconds)) throw new TypeError("Chart time must be finite epoch seconds");
  const date = new Date(epochSeconds * 1000);
  if (!Number.isFinite(date.valueOf())) throw new RangeError("Chart time is outside the supported date range");
  const options: Intl.DateTimeFormatOptions = daily
    ? { timeZone: timezone, year: "numeric", month: "short", day: "numeric" }
    : { timeZone: timezone, year: "numeric", month: "short", day: "numeric", hour: "numeric", minute: "2-digit", timeZoneName: "short" };
  return new Intl.DateTimeFormat("en-US", options).format(date);
}

/** History requests are calendar based so weekends, holidays, and overnight sessions remain real gaps. */
export function chartHistoryRange(interval: ChartInterval, now = new Date()): { from: string; to: string } {
  if (!Object.hasOwn(INTERVAL_SECONDS, interval) || !Number.isFinite(now.valueOf())) throw new TypeError("Invalid chart history range");
  const to = new Date(now);
  const from = new Date(now);
  if (interval === "1d") from.setUTCFullYear(from.getUTCFullYear() - 1);
  else from.setUTCDate(from.getUTCDate() - 90);
  return { from: from.toISOString(), to: to.toISOString() };
}

/** Options use their catalogued underlying; listed futures retain their selected dated contract. */
export function chartInstrument(source: Instrument, underlying?: Instrument): Instrument {
  if (source.asset === "option") {
    if (!source.underlyingId || !underlying || underlying.id !== source.underlyingId || underlying.asset !== "stock") {
      throw new TypeError("The option's actual underlying instrument is unavailable");
    }
    return underlying;
  }
  if (source.asset === "future" && (!source.root || !source.contractMonth || !/^\d{4}-(0[1-9]|1[0-2])$/.test(source.contractMonth))) {
    throw new TypeError("A dated listed futures contract is required for charting");
  }
  return source;
}

export type ExpectedBarResult = {
  instrumentId: string;
  interval: ChartInterval;
  session: ChartSession;
  adjustment: ChartAdjustment;
  audience?: "public" | "member";
  metadataVersion?: number;
  from?: string;
  to?: string;
  now?: Date;
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isUtcTimestamp(value: unknown): value is string {
  if (typeof value !== "string") return false;
  const match = UTC_TIMESTAMP.exec(value);
  if (!match) return false;
  const timestamp = Date.parse(value);
  if (!Number.isFinite(timestamp)) return false;
  const date = new Date(timestamp);
  return date.getUTCFullYear() === Number(match[1]) && date.getUTCMonth() + 1 === Number(match[2]) && date.getUTCDate() === Number(match[3]) && date.getUTCHours() === Number(match[4]) && date.getUTCMinutes() === Number(match[5]) && date.getUTCSeconds() === Number(match[6]);
}

/** Focused client boundary validation; no full runtime-contract/Ajv bundle is loaded in the browser. */
function isValidBarResult(value: unknown, expected: ExpectedBarResult, now: Date): value is BarResult {
  if (!isRecord(value) || value.instrumentId !== expected.instrumentId || value.interval !== expected.interval || value.session !== expected.session || value.adjustment !== expected.adjustment) return false;
  if (!Array.isArray(value.bars) || value.bars.length > MAX_BARS || !isRecord(value.meta)) return false;
  const meta = value.meta;
  if (typeof meta.provider !== "string" || !meta.provider.trim() || typeof meta.providerReference !== "string" || !meta.providerReference.trim()) return false;
  if (meta.asOf !== null && !isUtcTimestamp(meta.asOf)) return false;
  if (meta.asOf === null && value.bars.length !== 0) return false;
  if (!Number.isInteger(meta.delaySeconds) || (meta.delaySeconds as number) < 0 || (meta.delaySeconds as number) > 86_400) return false;
  if (!Number.isInteger(meta.metadataVersion) || (meta.metadataVersion as number) < 1 || typeof meta.demo !== "boolean") return false;
  if (expected.metadataVersion !== undefined && meta.metadataVersion !== expected.metadataVersion) return false;
  if (meta.freshness !== "fresh" && meta.freshness !== "stale" && meta.freshness !== "missing" && meta.freshness !== "unavailable") return false;
  if ((meta.freshness === "missing" || meta.freshness === "unavailable") && value.bars.length !== 0) return false;
  if ((meta.freshness === "fresh" || meta.freshness === "stale") && !isUtcTimestamp(meta.asOf)) return false;
  if (!isRecord(meta.capabilities)) return false;
  const capabilities = meta.capabilities;
  const capabilityFlags = ["displayPublic", "displayMember", "retainBars", "retainSnapshot", "exportImage", "exportPersonalRecord", "newPublishing"];
  if (capabilityFlags.some((key) => typeof capabilities[key] !== "boolean")) return false;
  if (!capabilities.displayPublic && !capabilities.displayMember) return false;
  const audience = expected.audience ?? "member";
  if (capabilities[audience === "public" ? "displayPublic" : "displayMember"] !== true || capabilities.retainBars !== true) return false;
  if (value.nextCursor !== null && (typeof value.nextCursor !== "string" || value.nextCursor.length > 500)) return false;

  const futureLimit = now.valueOf() / 1000 + FUTURE_CLOCK_TOLERANCE_SECONDS;
  const asOf = meta.asOf === null ? undefined : Date.parse(meta.asOf);
  if (asOf !== undefined && asOf / 1000 > futureLimit) return false;
  const from = expected.from === undefined ? undefined : Date.parse(expected.from);
  const to = expected.to === undefined ? undefined : Date.parse(expected.to);
  if (expected.from !== undefined && (!isUtcTimestamp(expected.from) || !Number.isFinite(from))) return false;
  if (expected.to !== undefined && (!isUtcTimestamp(expected.to) || !Number.isFinite(to))) return false;
  if (from !== undefined && to !== undefined && from > to) return false;
  let previousTime = -Infinity;
  for (const candidate of value.bars) {
    if (!isRecord(candidate) || !isUtcTimestamp(candidate.time)) return false;
    const time = Date.parse(candidate.time) / 1000;
    if (time <= previousTime || time > futureLimit || (asOf !== undefined && time > asOf / 1000 + FUTURE_CLOCK_TOLERANCE_SECONDS)) return false;
    if ((from !== undefined && time < from / 1000) || (to !== undefined && time > to / 1000)) return false;
    previousTime = time;
    const values = [candidate.open, candidate.high, candidate.low, candidate.close, candidate.volume];
    if (values.some((item) => typeof item !== "string" || !DECIMAL.test(item) || !Number.isFinite(Number(item)))) return false;
    const [open, high, low, close, volume] = values as string[];
    const openExact = scaledDecimal(open!);
    const highExact = scaledDecimal(high!);
    const lowExact = scaledDecimal(low!);
    const closeExact = scaledDecimal(close!);
    const volumeExact = scaledDecimal(volume!);
    if (volumeExact < 0n || highExact < (openExact > closeExact ? openExact : closeExact) || lowExact > (openExact < closeExact ? openExact : closeExact) || highExact < lowExact) return false;
  }
  return true;
}

/** Parses the focused public bar contract or throws a safe validation error. */
export function validateBarResult(value: unknown, expected: ExpectedBarResult, now = expected.now ?? new Date()): BarResult {
  if (!Number.isFinite(now.valueOf()) || !isValidBarResult(value, expected, now)) {
    throw new TypeError("Invalid or unavailable chart bar result");
  }
  return value;
}
