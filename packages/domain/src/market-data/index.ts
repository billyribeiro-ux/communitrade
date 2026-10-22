import { decimal, formatDecimal, validateTradePlan, type AssetClass, type DecimalInput, type Strategy } from "../index.js";
const newYorkDateTimeFormatter = new Intl.DateTimeFormat("en-US", {
  timeZone: "America/New_York",
  weekday: "short",
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
  hour: "2-digit",
  minute: "2-digit",
  hourCycle: "h23"
});
export type Freshness = "fresh" | "stale" | "missing" | "unavailable";
export type MarketAudience = "public" | "member";
export type MarketPurpose = "display" | "chart" | "snapshot" | "export" | "personal_record" | "publishing";
export interface MarketCapabilities {
  displayPublic: boolean;
  displayMember: boolean;
  retainBars: boolean;
  retainSnapshot: boolean;
  exportImage: boolean;
  exportPersonalRecord: boolean;
  newPublishing: boolean;
}
export interface MarketDataEnvelope<T> {
  data: T;
  providerReference: string;
  asOf: string | null;
  delaySeconds: number;
  freshness: Freshness;
  metadataVersion: number;
  capabilities: MarketCapabilities;
  demo: boolean;
}
export interface Instrument {
  id: string;
  symbol: string;
  name: string;
  assetClass: AssetClass;
  exchange: string;
  currency: string;
  isEnabledForNewPublishing: boolean;
  metadataVersion: number;
  source: string;
  multiplier?: DecimalInput;
  tickSize?: DecimalInput;
  session?: string;
  root?: "ES" | "MES" | "NQ" | "MNQ";
  contractMonth?: string;
  expiration?: string;
  lastTradingDate?: string;
  adjusted?: boolean;
}
export interface InstrumentSearch {
  query: string;
  assetClass?: AssetClass;
  cursor?: string;
  limit?: number;
}
export interface OptionContract {
  id: string;
  symbol: string;
  underlyingId: string;
  expiration: string;
  strike: DecimalInput;
  right: "call" | "put";
  multiplier: DecimalInput;
  adjusted: boolean;
  metadataVersion: number;
  source: string;
}
export interface OptionSearch {
  underlyingId: string;
  expiration?: string;
  optionType?: "call" | "put";
  cursor?: string;
  limit?: number;
}
export interface FuturesContract {
  id: string;
  symbol: string;
  root: "ES" | "MES" | "NQ" | "MNQ";
  contractMonth: string;
  expiration: string;
  lastTradingDate: string;
  listed: boolean;
  multiplier: DecimalInput;
  tickSize: DecimalInput;
  tickValue: DecimalInput;
  metadataVersion: number;
  source: string;
}
export interface FuturesSearch {
  root?: "ES" | "MES" | "NQ" | "MNQ";
  cursor?: string;
  limit?: number;
}
export type BarInterval = "1m" | "5m" | "15m" | "1h" | "1d";
export interface Bar {
  time: string;
  open: DecimalInput;
  high: DecimalInput;
  low: DecimalInput;
  close: DecimalInput;
  volume: string;
}
export interface BarsQuery {
  instrumentId: string;
  interval: BarInterval;
  from: string;
  to: string;
  venue?: string;
  session?: "regular" | "all";
  adjustment?: "raw" | "split_adjusted";
  cursor?: string;
  limit?: number;
}
export interface QuoteSnapshot {
  instrumentId: string;
  bid: DecimalInput | null;
  ask: DecimalInput | null;
  last: DecimalInput | null;
  bidSize: string | null;
  askSize: string | null;
  marketSession: "open" | "closed" | "unknown";
}
export interface CalendarSession {
  tradingDate: string;
  open: string;
  close: string;
  timezone: string;
  status: "open" | "closed" | "early_close";
  reason?: string; /** Demo schedules are illustrative; an approved exchange calendar must replace them in production. */
  authoritative: boolean;
}
export interface CalendarQuery {
  venue: string;
  from: string;
  to: string;
  cursor?: string;
  limit?: number;
}
export interface MarketDataPort {
  searchInstruments(query: InstrumentSearch): Promise<MarketDataEnvelope<{
    items: Instrument[];
    nextCursor: string | null;
  }>>;
  getInstrument(id: string, metadataVersion?: number): Promise<MarketDataEnvelope<Instrument>>;
  listOptionContracts(query: OptionSearch): Promise<MarketDataEnvelope<{
    items: OptionContract[];
    nextCursor: string | null;
  }>>;
  listFuturesContracts(query: FuturesSearch): Promise<MarketDataEnvelope<{
    items: FuturesContract[];
    nextCursor: string | null;
  }>>;
  getBars(query: BarsQuery): Promise<MarketDataEnvelope<{
    items: Bar[];
    nextCursor: string | null;
  }>>;
  getQuoteSnapshot(instrumentId: string): Promise<MarketDataEnvelope<QuoteSnapshot>>;
  getCalendar(query: CalendarQuery): Promise<MarketDataEnvelope<{
    items: CalendarSession[];
    nextCursor: string | null;
  }>>;
  getCapabilities(instrumentId: string, audience: MarketAudience, purpose: MarketPurpose): Promise<MarketDataEnvelope<MarketCapabilities>>;
}
const FUTURE_ROOTS = ["ES", "MES", "NQ", "MNQ"] as const;
const DEFAULT_CAPS: MarketCapabilities = Object.freeze({
  displayPublic: true,
  displayMember: true,
  retainBars: true,
  retainSnapshot: true,
  exportImage: true,
  exportPersonalRecord: true,
  newPublishing: true
});
const NO_CAPS: MarketCapabilities = Object.freeze({
  displayPublic: false,
  displayMember: false,
  retainBars: false,
  retainSnapshot: false,
  exportImage: false,
  exportPersonalRecord: false,
  newPublishing: false
});
const STOCKS: Instrument[] = [{
  id: "00000000-0000-4000-8000-000000000201",
  symbol: "SYN-XYZ",
  name: "Synthetic Example Equity",
  assetClass: "stock",
  exchange: "SYNTHETIC",
  currency: "USD",
  isEnabledForNewPublishing: true,
  metadataVersion: 1,
  source: "Demo data",
  tickSize: "0.01",
  session: "US_EQUITY"
}];
const FUTURE_META = {
  ES: {
    multiplier: "50",
    tickSize: "0.25",
    tickValue: "12.50"
  },
  MES: {
    multiplier: "5",
    tickSize: "0.25",
    tickValue: "1.25"
  },
  NQ: {
    multiplier: "20",
    tickSize: "0.25",
    tickValue: "5.00"
  },
  MNQ: {
    multiplier: "2",
    tickSize: "0.25",
    tickValue: "0.50"
  }
} as const;
const MONTH_CODE: Record<number, string> = {
  3: "H",
  6: "M",
  9: "U",
  12: "Z"
};
const demoAsOf = (now: Date) => now.toISOString();
const providerTime = (value: unknown): string | null => {
  if (typeof value === "string") return Number.isFinite(Date.parse(value)) ? new Date(value).toISOString() : null;
  if (typeof value === "number" && Number.isFinite(value)) return new Date(value / 1e6).toISOString();
  return null;
};
const providerPrice = (value: unknown): string | null => typeof value === "string" && /^-?\d+(?:\.\d+)?$/.test(value) ? value : null;
const providerVolume = (value: unknown): string | null => {
  if (typeof value === "number" && Number.isSafeInteger(value) && value >= 0) return String(value);
  if (typeof value === "string" && /^\d+$/.test(value)) return value;
  return null;
};
const safeLimit = (limit?: number) => {
  if (limit === undefined) return 50;
  if (!Number.isInteger(limit) || limit < 1 || limit > 100) throw new RangeError("Page size must be an integer from 1 through 100");
  return limit;
};
const safeBarsLimit = (limit?: number) => {
  if (limit === undefined) return 100;
  if (!Number.isInteger(limit) || limit < 1 || limit > 10_000) throw new RangeError("Bar page size must be an integer from 1 through 10000");
  return limit;
};
const page = <T,>(items: T[], cursor: string | undefined, limit: number): {
  items: T[];
  nextCursor: string | null;
} => {
  const offset = cursor === undefined ? 0 : Number(cursor);
  if (!Number.isSafeInteger(offset) || offset < 0) throw new RangeError("Invalid pagination cursor");
  const part = items.slice(offset, offset + limit);
  return {
    items: part,
    nextCursor: offset + part.length < items.length ? String(offset + part.length) : null
  };
};
function aggregateBars(source: Bar[], minutes: number): Bar[] {
  const width = minutes * 60_000,
    out: Bar[] = [];
  for (const bar of source) {
    const bucket = Math.floor(Date.parse(bar.time) / width) * width,
      last = out.at(-1);
    if (last && Date.parse(last.time) === bucket) {
      const high = decimal(last.high) > decimal(bar.high) ? last.high : bar.high,
        low = decimal(last.low) < decimal(bar.low) ? last.low : bar.low;
      out[out.length - 1] = {
        ...last,
        high,
        low,
        close: bar.close,
        volume: String(BigInt(last.volume) + BigInt(bar.volume))
      };
    } else out.push({
      ...bar,
      time: new Date(bucket).toISOString()
    });
  }
  return out;
}
interface SessionBar {
  bar: Bar;
  end: number;
}
function aggregateSessionBars(source: Bar[], sessions: CalendarSession[], interval: "1h" | "1d", asset: AssetClass, session: "regular" | "all"): SessionBar[] {
  const output: SessionBar[] = [];
  for (const calendar of sessions) {
    if (calendar.status === "closed") continue;
    const sessionOpen = Date.parse(calendar.open),
      sessionClose = Date.parse(calendar.close);
    if (!Number.isFinite(sessionOpen) || !Number.isFinite(sessionClose) || sessionClose <= sessionOpen) continue;
    if (asset === "future" && session === "regular") continue;
    const width = interval === "1h" ? 3_600_000 : sessionClose - sessionOpen;
    for (let start = sessionOpen; start < sessionClose; start += width) {
      const end = Math.min(start + width, sessionClose),
        rows = source.filter(bar => {
          const time = Date.parse(bar.time);
          if (time < start || time >= end) return false;
          if (asset === "future") {
            const parts = new Intl.DateTimeFormat("en-US", {
                timeZone: "America/New_York",
                hour: "2-digit",
                minute: "2-digit",
                hourCycle: "h23"
              }).formatToParts(new Date(time)),
              p = Object.fromEntries(parts.map(x => [x.type, x.value])),
              minutes = Number(p.hour) * 60 + Number(p.minute);
            if (session === "all" && minutes >= 1020 && minutes < 1080) return false;
          }
          return true;
        });
      if (!rows.length) continue;
      let high = rows[0]!.high,
        low = rows[0]!.low,
        volume = 0n;
      for (const bar of rows) {
        if (decimal(bar.high) > decimal(high)) high = bar.high;
        if (decimal(bar.low) < decimal(low)) low = bar.low;
        volume += BigInt(bar.volume);
      }
      output.push({
        bar: {
          time: new Date(start).toISOString(),
          open: rows[0]!.open,
          high,
          low,
          close: rows.at(-1)!.close,
          volume: String(volume)
        },
        end
      });
    }
  }
  return output.sort((a, b) => Date.parse(a.bar.time) - Date.parse(b.bar.time));
}
const isoDay = (s: string) => /^\d{4}-\d{2}-\d{2}$/.test(s) && new Date(`${s}T00:00:00.000Z`).toISOString().slice(0, 10) === s;
function currentQuarterContracts(now: Date, instrumentIds: Record<string, string> = {}): FuturesContract[] {
  const out: FuturesContract[] = [];
  const start = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1);
  for (let n = 0; n < 30; n++) {
    const d = new Date(start);
    d.setUTCMonth(d.getUTCMonth() + n);
    const month = d.getUTCMonth() + 1;
    if (!(month in MONTH_CODE)) continue;
    const year = d.getUTCFullYear(),
      mm = String(month).padStart(2, "0"),
      settlement = new Date(Date.UTC(year, month - 1, 15));
    while (settlement.getUTCDay() !== 5) settlement.setUTCDate(settlement.getUTCDate() + 1);
    const lastTrading = settlement;
    for (const root of FUTURE_ROOTS) {
      const meta = FUTURE_META[root],
        contractMonth = `${year}-${mm}`,
        symbol = `SYN-${root}${MONTH_CODE[month]}${String(year).slice(-2)}`,
        fixtureId = instrumentIds[symbol] ?? (year === 2026 && month === 12 ? `00000000-0000-4000-8000-000000000${root === "ES" ? "202" : root === "MES" ? "203" : root === "NQ" ? "204" : "205"}` : `fut:${root}:${contractMonth}`);
      out.push({
        id: fixtureId,
        symbol,
        root,
        contractMonth,
        expiration: zonedInstant(settlement.toISOString().slice(0, 10), 9, 30, "America/New_York"),
        lastTradingDate: lastTrading.toISOString().slice(0, 10),
        listed: true,
        multiplier: meta.multiplier,
        tickSize: meta.tickSize,
        tickValue: meta.tickValue,
        metadataVersion: 1,
        source: "Demo data"
      });
    }
  }
  return out;
}
function nextFridays(from: Date, n = 12): string[] {
  const d = new Date(Date.UTC(from.getUTCFullYear(), from.getUTCMonth(), from.getUTCDate()));
  const out: string[] = [];
  while (out.length < n) {
    if (d.getUTCDay() === 5 && d >= new Date(Date.UTC(from.getUTCFullYear(), from.getUTCMonth(), from.getUTCDate()))) out.push(d.toISOString().slice(0, 10));
    d.setUTCDate(d.getUTCDate() + 1);
  }
  return out;
}
function offsetAt(date: Date, timeZone: string): number {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone,
    hour12: false,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit"
  }).formatToParts(date);
  const p = Object.fromEntries(parts.map(x => [x.type, x.value]));
  const asUtc = Date.UTC(Number(p.year), Number(p.month) - 1, Number(p.day), Number(p.hour) % 24, Number(p.minute), Number(p.second));
  return asUtc - date.getTime();
}
function zonedInstant(day: string, hour: number, minute: number, timeZone: string): string {
  const base = Date.parse(`${day}T${String(hour).padStart(2, "0")}:${String(minute).padStart(2, "0")}:00.000Z`);
  let utc = base;
  for (let i = 0; i < 3; i++) utc = base - offsetAt(new Date(utc), timeZone);
  return new Date(utc).toISOString();
}
function nthWeekday(year: number, month: number, weekday: number, n: number): number {
  const first = new Date(Date.UTC(year, month - 1, 1)).getUTCDay();
  return 1 + (weekday - first + 7) % 7 + (n - 1) * 7;
}
function lastWeekday(year: number, month: number, weekday: number): number {
  const day = new Date(Date.UTC(year, month, 0)).getUTCDate();
  const dow = new Date(Date.UTC(year, month - 1, day)).getUTCDay();
  return day - (dow - weekday + 7) % 7;
}
function observedFixed(year: number, month: number, day: number): string {
  const d = new Date(Date.UTC(year, month - 1, day));
  if (d.getUTCDay() === 6) d.setUTCDate(d.getUTCDate() - 1);else if (d.getUTCDay() === 0) d.setUTCDate(d.getUTCDate() + 1);
  return d.toISOString().slice(0, 10);
}
function easterSunday(year: number): Date {
  const a = year % 19,
    b = Math.floor(year / 100),
    c = year % 100,
    d = Math.floor(b / 4),
    e = b % 4,
    f = Math.floor((b + 8) / 25),
    g = Math.floor((b - f + 1) / 3),
    h = (19 * a + b - d - g + 15) % 30,
    i = Math.floor(c / 4),
    k = c % 4,
    l = (32 + 2 * e + 2 * i - h - k) % 7,
    m = Math.floor((a + 11 * h + 22 * l) / 451),
    month = Math.floor((h + l - 7 * m + 114) / 31),
    day = (h + l - 7 * m + 114) % 31 + 1;
  return new Date(Date.UTC(year, month - 1, day));
}
function usMarketHolidays(year: number): Map<string, string> {
  const dates = new Map<string, string>();
  const add = (s: string, r: string) => dates.set(s, r);
  add(observedFixed(year, 1, 1), "New Year's Day");
  add(`${year}-01-${String(nthWeekday(year, 1, 1, 3)).padStart(2, "0")}`, "Martin Luther King Jr. Day");
  add(`${year}-02-${String(nthWeekday(year, 2, 1, 3)).padStart(2, "0")}`, "Washington's Birthday");
  const e = easterSunday(year);
  e.setUTCDate(e.getUTCDate() - 2);
  add(e.toISOString().slice(0, 10), "Good Friday");
  add(`${year}-05-${String(lastWeekday(year, 5, 1)).padStart(2, "0")}`, "Memorial Day");
  add(observedFixed(year, 6, 19), "Juneteenth");
  add(observedFixed(year, 7, 4), "Independence Day");
  add(`${year}-09-${String(nthWeekday(year, 9, 1, 1)).padStart(2, "0")}`, "Labor Day");
  add(`${year}-11-${String(nthWeekday(year, 11, 4, 4)).padStart(2, "0")}`, "Thanksgiving Day");
  add(observedFixed(year, 12, 25), "Christmas Day");
  return dates;
}
export interface SyntheticMarketDataOptions {
  now?: () => Date;
  capabilities?: Partial<MarketCapabilities>;
  staleAfterSeconds?: number;
  disabledInstrumentIds?: string[];
  /** Maps fixture symbols to canonical database IDs for API composition. */
  instrumentIds?: Record<string, string>;
  /** Complete current synthetic instrument metadata loaded from the canonical fixture catalog. */
  instrumentFixtures?: Instrument[];
  /** Optional complete synthetic chain supplied from the canonical fixture catalog. */
  optionContracts?: OptionContract[];
  failNext?: Partial<Record<"searchInstruments" | "getInstrument" | "listOptionContracts" | "listFuturesContracts" | "getBars" | "getQuoteSnapshot" | "getCalendar" | "getCapabilities", Error>>;
}
/** Deterministic local reference and price fixtures. All values are synthetic and carry explicit Demo data provenance. */
export class SyntheticMarketDataAdapter implements MarketDataPort {
  readonly source = "Demo data";
  private readonly now: () => Date;
  private readonly caps: MarketCapabilities;
  private readonly staleAfter: number;
  private readonly disabled: Set<string>;
  private readonly failures: NonNullable<SyntheticMarketDataOptions["failNext"]>;
  private readonly optionFixtures: OptionContract[];
  private readonly instruments: Instrument[];
  private readonly futures: FuturesContract[];
  constructor(options: SyntheticMarketDataOptions = {}) {
    this.now = options.now ?? (() => new Date());
    this.caps = {
      ...DEFAULT_CAPS,
      ...options.capabilities
    };
    this.staleAfter = options.staleAfterSeconds ?? 1800;
    this.disabled = new Set(options.disabledInstrumentIds ?? []);
    this.failures = {
      ...options.failNext
    };
    const futures = currentQuarterContracts(this.now(), options.instrumentIds);
    this.optionFixtures = options.optionContracts ?? [];
    const generatedInstruments = [...STOCKS.map(x => ({
      ...x,
      id: options.instrumentIds?.[x.symbol] ?? x.id
    })), ...futures.map(f => ({
      id: f.id,
      symbol: f.symbol,
      name: `${f.root} ${f.contractMonth} E-mini/Micro E-mini`,
      assetClass: "future" as const,
      exchange: "CME",
      currency: "USD",
      isEnabledForNewPublishing: true,
      metadataVersion: f.metadataVersion,
      source: this.source,
      multiplier: f.multiplier,
      tickSize: f.tickSize,
      session: "CME_GLOBEX",
      root: f.root,
      contractMonth: f.contractMonth,
      expiration: f.expiration,
      lastTradingDate: f.lastTradingDate
    }))];
    const fixtures = options.instrumentFixtures ?? [];
    const fixtureById = new Map(fixtures.map(instrument => [instrument.id, instrument]));
    this.instruments = generatedInstruments.map(instrument => fixtureById.get(instrument.id) ?? instrument);
    for (const fixture of fixtures) if (!this.instruments.some(instrument => instrument.id === fixture.id)) this.instruments.push(fixture);
    const generatedFutures = new Map(futures.map(contract => [contract.id, contract]));
    const fixtureFutures = fixtures.filter(instrument => instrument.assetClass === "future").map(instrument => {
      const generated = generatedFutures.get(instrument.id);
      const root = instrument.root;
      const contractMonth = instrument.contractMonth;
      const expiration = instrument.expiration;
      if (!root || !contractMonth || !expiration || instrument.multiplier === undefined || instrument.tickSize === undefined) return generated;
      return {
        id: instrument.id,
        symbol: instrument.symbol,
        root,
        contractMonth,
        expiration,
        lastTradingDate: instrument.lastTradingDate ?? expiration.slice(0, 10),
        listed: instrument.isEnabledForNewPublishing,
        multiplier: String(instrument.multiplier),
        tickSize: String(instrument.tickSize),
        tickValue: formatDecimal(decimal(String(instrument.multiplier)) * decimal(String(instrument.tickSize)) / (10n ** 20n)),
        metadataVersion: instrument.metadataVersion,
        source: instrument.source
      } satisfies FuturesContract;
    }).filter((contract): contract is FuturesContract => contract !== undefined);
    const fixtureFutureIds = new Set(fixtureFutures.map(contract => contract.id));
    this.futures = [...futures.filter(contract => !fixtureFutureIds.has(contract.id)), ...fixtureFutures];
  }
  private envelope<T>(data: T, ref: string, version = 1, asOf: string | null = demoAsOf(this.now())): MarketDataEnvelope<T> {
    const age = asOf === null ? Infinity : (this.now().getTime() - Date.parse(asOf)) / 1000;
    return {
      data,
      providerReference: ref,
      asOf,
      delaySeconds: 0,
      freshness: asOf === null ? "missing" : age > this.staleAfter ? "stale" : "fresh",
      metadataVersion: version,
      capabilities: {
        ...this.caps
      },
      demo: true
    };
  }
  private check(method: keyof NonNullable<SyntheticMarketDataOptions["failNext"]>) {
    const error = this.failures[method];
    if (error) {
      delete this.failures[method];
      throw error;
    }
  }
  private instrument(id: string): Instrument {
    const i = this.instruments.find(x => x.id === id);
    if (!i) throw new Error("Instrument not found");
    return {
      ...i,
      isEnabledForNewPublishing: i.isEnabledForNewPublishing && !this.disabled.has(i.id)
    };
  }
  private option(id: string): OptionContract | undefined {
    const configured = this.optionFixtures.find(x => x.id === id);
    if (configured) return configured;
    const uuidMap: Record<string, {
      strike: string;
      right: "call" | "put";
    }> = {
      "00000000-0000-4000-8000-000000000221": {
        strike: "100",
        right: "call"
      },
      "00000000-0000-4000-8000-000000000222": {
        strike: "105",
        right: "call"
      },
      "00000000-0000-4000-8000-000000000223": {
        strike: "100",
        right: "put"
      },
      "00000000-0000-4000-8000-000000000224": {
        strike: "105",
        right: "put"
      }
    };
    const parts = id.split(":"),
      uuid = uuidMap[id];
    if (!uuid && !id.startsWith("opt:")) return undefined;
    const under = uuid ? this.instruments.find(x => x.symbol === "SYN-XYZ") : this.instruments.find(x => x.id === parts[1]);
    if (!under) return undefined;
    const date = uuid ? "20261120" : parts[2] ?? "",
      right = uuid ? uuid.right : parts[3] === "C" ? "call" : "put",
      strike = uuid ? uuid.strike : parts[4] ?? "";
    if (!/^\d{8}$/.test(date) || !strike) return undefined;
    const day = `${date.slice(0, 4)}-${date.slice(4, 6)}-${date.slice(6, 8)}`;
    return {
      id,
      symbol: `SYN-XYZ-${day.replaceAll("-", "")}-${right}${strike}`,
      underlyingId: under.id,
      expiration: zonedInstant(day, 16, 0, "America/New_York"),
      strike,
      right,
      multiplier: "100",
      adjusted: false,
      metadataVersion: 1,
      source: this.source
    };
  }
  async searchInstruments(q: InstrumentSearch) {
    this.check("searchInstruments");
    const limit = safeLimit(q.limit),
      query = q.query.trim().toLocaleLowerCase();
    const list = this.instruments.filter(i => (!q.assetClass || i.assetClass === q.assetClass) && (!query || `${i.symbol} ${i.name}`.toLocaleLowerCase().includes(query))).sort((a, b) => a.symbol.localeCompare(b.symbol));
    return this.envelope(page(list, q.cursor, limit), `${this.source}:instrument-catalog`);
  }
  async getInstrument(id: string, metadataVersion?: number) {
    this.check("getInstrument");
    const option = this.option(id),
      i = option ? {
        id: option.id,
        symbol: option.symbol,
        name: `${option.symbol} option`,
        assetClass: "option" as const,
        exchange: "OPRA",
        currency: "USD",
        isEnabledForNewPublishing: true,
        metadataVersion: option.metadataVersion,
        source: this.source,
        multiplier: option.multiplier,
        tickSize: "0.01",
        session: "US_EQUITY",
        adjusted: option.adjusted
      } : this.instrument(id);
    if (metadataVersion !== undefined && metadataVersion !== i.metadataVersion) throw new Error("Requested metadata version is unavailable");
    return this.envelope(i, `${this.source}:${id}`, i.metadataVersion);
  }
  async listOptionContracts(q: OptionSearch) {
    this.check("listOptionContracts");
    const underlying = this.instrument(q.underlyingId);
    if (underlying.assetClass !== "stock") throw new Error("Options require a stock or ETF underlying");
    if (this.optionFixtures.length) {
      const items = this.optionFixtures.filter(c => c.underlyingId === q.underlyingId && (!q.expiration || c.expiration.slice(0, 10) === q.expiration.slice(0, 10)) && (!q.optionType || c.right === q.optionType));
      return this.envelope(page(items, q.cursor, safeLimit(q.limit)), `${this.source}:options:${q.underlyingId}`);
    }
    const expirations = nextFridays(this.now()),
      requested = q.expiration?.slice(0, 10),
      selected = requested ? [requested] : expirations,
      contracts: OptionContract[] = [];
    for (const expiration of selected) for (const [strike, right, uuid] of [["100", "call", "221"], ["105", "call", "222"], ["100", "put", "223"], ["105", "put", "224"]] as const) {
      if (q.optionType && q.optionType !== right) continue;
      if (requested && !expirations.includes(expiration)) continue;
      const stamp = expiration.replaceAll("-", "");
      const type = right === "call" ? "C" : "P";
      const id = expiration === "2026-11-20" && underlying.id === "00000000-0000-4000-8000-000000000201" ? `00000000-0000-4000-8000-000000000${uuid}` : `opt:${underlying.id}:${stamp}:${type}:${strike}`;
      contracts.push({
        id,
        symbol: `SYN-XYZ-${stamp}-${right}${strike}`,
        underlyingId: underlying.id,
        expiration: zonedInstant(expiration, 16, 0, "America/New_York"),
        strike,
        right,
        multiplier: "100",
        adjusted: false,
        metadataVersion: 1,
        source: this.source
      });
    }
    contracts.sort((a, b) => a.expiration.localeCompare(b.expiration) || (decimal(a.strike) < decimal(b.strike) ? -1 : decimal(a.strike) > decimal(b.strike) ? 1 : 0));
    return this.envelope(page(contracts, q.cursor, safeLimit(q.limit)), `${this.source}:options:${q.underlyingId}`);
  }
  async listFuturesContracts(q: FuturesSearch) {
    this.check("listFuturesContracts");
    const list = this.futures.filter(f => !q.root || f.root === q.root);
    return this.envelope(page(list, q.cursor, safeLimit(q.limit)), `${this.source}:futures-catalog`);
  }
  async getBars(q: BarsQuery) {
    this.check("getBars");
    if (q.adjustment !== undefined && q.adjustment !== "raw") throw new Error("Synthetic split-adjusted bars are not available");
    if (this.option(q.instrumentId)) throw new Error("Historical option-premium bars are outside Phase 1");
    const i = this.instrument(q.instrumentId);
    if (!Number.isFinite(Date.parse(q.from)) || !Number.isFinite(Date.parse(q.to)) || Date.parse(q.to) <= Date.parse(q.from)) throw new RangeError("Bars require a valid increasing date range");
    const rangeEnd = new Date(Date.parse(q.from));
    if (q.interval === "1d") rangeEnd.setUTCFullYear(rangeEnd.getUTCFullYear() + 1);
    else rangeEnd.setUTCDate(rangeEnd.getUTCDate() + 90);
    if (Date.parse(q.to) > rangeEnd.getTime()) throw new RangeError(q.interval === "1d" ? "Daily history exceeds one calendar year" : "Intraday history exceeds 90 calendar days");
    const end = Math.min(Date.parse(q.to), this.now().getTime()),
      step = {
        "1m": 60000,
        "5m": 300000,
        "15m": 900000,
        "1h": 3600000,
        "1d": 86400000
      }[q.interval],
      limit = safeBarsLimit(q.limit),
      offset = q.cursor === undefined ? 0 : Number(q.cursor);
    if (!Number.isSafeInteger(offset) || offset < 0) throw new RangeError("Invalid pagination cursor");
    const start = Math.ceil(Date.parse(q.from) / step) * step;
    const base = i.assetClass === "future" ? 5000 : 100,
      tick = Number(i.tickSize ?? "0.01"),
      items: Bar[] = [],
      daily = q.interval === "1d",
      hourly = q.interval === "1h",
      candidateTimes: number[] = [],
      hourSessionEnds = new Map<number, number>();
    if (daily) {
      const dailyStart = Date.parse(`${new Date(Date.parse(q.from)).toISOString().slice(0, 10)}T00:00:00.000Z`) - 86_400_000;
      for (let t = dailyStart; t < end; t += step) candidateTimes.push(t);
    } else if (hourly) {
      const firstDate = Date.parse(`${new Date(Date.parse(q.from)).toISOString().slice(0, 10)}T00:00:00.000Z`) - 86_400_000;
      // A futures session is keyed by its trading date but opens on the prior
      // calendar day. Include the trading date containing `to` and let the
      // session-open/end bounds below clip bars to the requested range.
      for (let dayStart = firstDate; dayStart < end + 86_400_000; dayStart += 86_400_000) {
        const day = new Date(dayStart).toISOString().slice(0, 10);
        if (!this.inSession(dayStart, i, q.session ?? "regular", "1d")) continue;
        const open = i.assetClass === "future"
            ? zonedInstant(new Date(dayStart - 86_400_000).toISOString().slice(0, 10), 18, 0, "America/New_York")
            : zonedInstant(day, 9, 30, "America/New_York"),
          close = zonedInstant(day, i.assetClass === "future" ? 17 : syntheticEquityCloseHour(day), 0, "America/New_York");
        for (let t = Date.parse(open); t < Date.parse(close); t += step) {
          const barEnd = Math.min(t + step, Date.parse(close));
          if (t >= Date.parse(q.from) && barEnd <= end) {
            candidateTimes.push(t);
            hourSessionEnds.set(t, barEnd);
          }
        }
      }
    } else {
      for (let t = start; t + step <= end && t < Date.parse(q.to); t += step) candidateTimes.push(t);
    }
    let ordinal = 0,
      more = false,
      lastBarEnd: string | null = null;
    for (const t of candidateTimes) {
      const day = new Date(t).toISOString().slice(0, 10);
      if (daily && !this.inSession(t, i, q.session ?? "regular", q.interval)) continue;
      if (!daily && !hourly && !this.inSession(t, i, q.session ?? "regular", q.interval)) continue;
      const barTime = daily ? zonedInstant(i.assetClass === "future" ? new Date(Date.parse(`${day}T00:00:00.000Z`) - 86_400_000).toISOString().slice(0, 10) : day, i.assetClass === "future" ? 18 : 9, i.assetClass === "future" ? 0 : 30, "America/New_York") : new Date(t).toISOString();
      const closeTime = daily ? zonedInstant(day, i.assetClass === "future" ? 17 : syntheticEquityCloseHour(day), 0, "America/New_York") : new Date(hourSessionEnds.get(t) ?? t + step).toISOString();
      if (daily && (Date.parse(barTime) < Date.parse(q.from) || Date.parse(closeTime) > end)) continue;
      if (ordinal++ < offset) continue;
      if (items.length >= limit) {
        more = true;
        break;
      }
      const index = Math.floor(t / step),
        center = base + (index * 17 % 29 - 14) * tick,
        open = center - 2 * tick,
        close = center + (index % 7 - 3) * tick,
        high = Math.max(open, close) + tick,
        low = Math.min(open, close) - tick;
      items.push({
        time: barTime,
        open: open.toFixed(2),
        high: high.toFixed(2),
        low: low.toFixed(2),
        close: close.toFixed(2),
        volume: String(1000 + index * 97 % 50000)
      });
      lastBarEnd = closeTime;
    }
    const asOf = items.length ? lastBarEnd : null;
    return this.envelope({
      items,
      nextCursor: more ? String(offset + items.length) : null
    }, `${this.source}:bars:${q.instrumentId}`, i.metadataVersion, asOf);
  }
  private inSession(time: number, instrument: Instrument, session: "regular" | "all", interval: BarInterval): boolean {
    const date = new Date(time),
      utcDate = date.toISOString().slice(0, 10),
      parts = newYorkDateTimeFormatter.formatToParts(date),
      p = Object.fromEntries(parts.map(x => [x.type, x.value])),
      day = {
        Sun: 0,
        Mon: 1,
        Tue: 2,
        Wed: 3,
        Thu: 4,
        Fri: 5,
        Sat: 6
      }[p.weekday ?? "Sun"] ?? 0,
      hour = Number(p.hour),
      minute = Number(p.minute),
      key = `${p.year}-${p.month}-${p.day}`,
      mins = hour * 60 + minute;
    if (interval === "1d") {
      const utcDay = new Date(`${utcDate}T00:00:00Z`).getUTCDay();
      return utcDay !== 0 && utcDay !== 6 && !usMarketHolidays(Number(utcDate.slice(0, 4))).has(utcDate);
    }
    if (instrument.assetClass === "future") {
      const nextDate = new Date(Date.parse(`${key}T00:00:00.000Z`) + 86400000).toISOString().slice(0, 10);
      let tradingDate: string | null = null;
      if (day === 0 && mins >= 18 * 60) tradingDate = nextDate;
      else if (day >= 1 && day <= 4) {
        if (mins < 17 * 60) tradingDate = key;
        else if (mins >= 18 * 60) tradingDate = nextDate;
      } else if (day === 5 && mins < 17 * 60) tradingDate = key;
      if (!tradingDate || usMarketHolidays(Number(tradingDate.slice(0, 4))).has(tradingDate)) return false;
      return session === "all" || mins >= 570 && mins < 960;
    }
    if (day === 0 || day === 6 || usMarketHolidays(Number(p.year)).has(key)) return false;
    const regularClose = syntheticEquityCloseHour(key) * 60;
    return session === "all" ? mins >= 4 * 60 && mins < 20 * 60 : mins >= 9 * 60 + 30 && mins < regularClose;
  }
  async getQuoteSnapshot(id: string): Promise<MarketDataEnvelope<QuoteSnapshot>> {
    this.check("getQuoteSnapshot");
    const option = this.option(id);
    if (option) {
      const offset = option.right === "call" ? 100 - Number(option.strike) : Number(option.strike) - 100,
        last = Math.max(.5, 5 + offset * .2);
      return this.envelope({
        instrumentId: id,
        bid: (last - .05).toFixed(2),
        ask: (last + .05).toFixed(2),
        last: last.toFixed(2),
        bidSize: "20",
        askSize: "24",
        marketSession: "unknown"
      }, `${this.source}:quote:${id}`);
    }
    const i = this.instrument(id),
      last = i.assetClass === "future" ? 5000 : 100,
      tick = Number(i.tickSize ?? "0.01");
    return this.envelope({
      instrumentId: id,
      bid: (last - tick).toFixed(2),
      ask: (last + tick).toFixed(2),
      last: last.toFixed(2),
      bidSize: "100",
      askSize: "120",
      marketSession: "unknown"
    }, `${this.source}:quote:${id}`);
  }
  async getCalendar(q: CalendarQuery) {
    this.check("getCalendar");
    const limit = safeLimit(q.limit);
    if (!isoDay(q.from) || !isoDay(q.to) || q.to < q.from) throw new RangeError("Calendar requires an inclusive ISO date range");
    if (Date.parse(`${q.to}T00:00Z`) - Date.parse(`${q.from}T00:00Z`) > 366 * 86400000) throw new RangeError("Calendar range is limited to 366 days");
    const venue = q.venue.toUpperCase();
    const cme = venue === "CME" || venue === "CME_GLOBEX" || venue === "GLOBEX",
      equity = ["NYSE", "NASDAQ", "NYSE ARCA", "US_EQUITY"].includes(venue);
    if (!cme && !equity) throw new Error("No synthetic calendar fixture exists for this venue");
    const tz = "America/New_York",
      holidays = new Map<string, string>(),
      items: CalendarSession[] = [];
    for (let y = Number(q.from.slice(0, 4)); y <= Number(q.to.slice(0, 4)); y++) for (const [d, r] of usMarketHolidays(y)) holidays.set(d, r);
    for (let t = Date.parse(`${q.from}T00:00:00Z`); t <= Date.parse(`${q.to}T00:00:00Z`); t += 86400000) {
      const d = new Date(t),
        day = d.getUTCDay(),
        date = d.toISOString().slice(0, 10),
        reason = holidays.get(date);
      let session: CalendarSession;
      if (day === 0 || day === 6 || reason) session = {
        tradingDate: date,
        open: zonedInstant(date, 9, 30, tz),
        close: zonedInstant(date, 16, 0, tz),
        timezone: tz,
        status: "closed",
        reason: reason ?? "Weekend",
        authoritative: false
      };else if (cme) {
        const prior = new Date(t - 86400000).toISOString().slice(0, 10);
        session = {
          tradingDate: date,
          open: zonedInstant(prior, 18, 0, tz),
          close: zonedInstant(date, 17, 0, tz),
          timezone: tz,
          status: "open",
          authoritative: false
        };
      } else {
        const thanksgiving = Number(date.slice(5, 7)) === 11 && day === 5 && new Date(`${date}T12:00Z`).getUTCDate() === nthWeekday(Number(date.slice(0, 4)), 11, 4, 4) + 1;
        const early = (monthDay(date) === "12-24" || thanksgiving) && day !== 0 && day !== 6 && !reason;
        session = {
          tradingDate: date,
          open: zonedInstant(date, 9, 30, tz),
          close: zonedInstant(date, early ? 13 : 16, 0, tz),
          timezone: tz,
          status: early ? "early_close" : "open",
          authoritative: false,
          ...(early ? {
            reason: "Early close"
          } : {})
        };
      }
      items.push(session);
    }
    return this.envelope(page(items, q.cursor, limit), `${this.source}:calendar:${venue}`);
  }
  async getCapabilities(id: string, audience: MarketAudience, purpose: MarketPurpose) {
    this.check("getCapabilities");
    if (!this.option(id)) this.instrument(id);
    const c = {
      ...this.caps
    };
    if (audience === "public" && !c.displayPublic) c.newPublishing = false;
    if (purpose === "chart" && !c.retainBars) c.exportImage = false;
    if (purpose === "snapshot" && !c.retainSnapshot) c.newPublishing = false;
    if (purpose === "export" && !c.exportImage) c.newPublishing = false;
    if (purpose === "personal_record" && !c.exportPersonalRecord) c.newPublishing = false;
    return this.envelope(c, `${this.source}:capabilities:${id}`);
  }
}
function monthDay(date: string) {
  return date.slice(5);
}
function syntheticEquityCloseHour(date: string): number {
  const year = Number(date.slice(0, 4)),
    month = Number(date.slice(5, 7)),
    day = Number(date.slice(8, 10)),
    weekday = new Date(`${date}T00:00:00Z`).getUTCDay(),
    thanksgivingFriday = month === 11 && weekday === 5 && day === nthWeekday(year, 11, 4, 4) + 1;
  return weekday !== 0 && weekday !== 6 && (month === 12 && day === 24 || thanksgivingFriday) ? 13 : 16;
}
export interface DatabentoDatasetConfig {
  dataset: string;
  schemaByInterval: Partial<Record<BarInterval, string>>;
  metadataVersion: number;
  capabilities: Partial<MarketCapabilities>;
}
export interface DatabentoInstrumentMapping {
  assetClass: AssetClass;
  rawSymbol: string;
  metadataVersion: number;
}
export interface DatabentoAdapterConfig {
  apiKey?: string;
  datasets: Partial<Record<AssetClass, DatabentoDatasetConfig>>;
  approvedCapabilities?: Partial<Record<AssetClass, Partial<MarketCapabilities>>>;
  instrumentMap?: Record<string, DatabentoInstrumentMapping>;
  delaySeconds?: number;
  timeoutMs?: number;
  maxResponseBytes?: number;
  now?: () => Date;
  fetch?: typeof fetch;
  referencePort?: Pick<MarketDataPort, "searchInstruments" | "getInstrument" | "listOptionContracts" | "listFuturesContracts">;
  calendarPort?: Pick<MarketDataPort, "getCalendar">;
}
export class ProviderUnavailableError extends Error {
  constructor(message = "Market data provider is unavailable") {
    super(message);
    this.name = "ProviderUnavailableError";
  }
}
const DATABENTO_DATASETS: Record<AssetClass, ReadonlySet<string>> = {
  stock: new Set(["EQUS.SUMMARY", "XNAS.BASIC", "XNYS.PILLAR", "XNAS.ITCH", "XNYS.PILLAR"]),
  option: new Set(["OPRA.PILLAR"]),
  future: new Set(["GLBX.MDP3"])
};
const ALLOWED_SCHEMAS = new Set(["ohlcv-1m", "ohlcv-1h", "ohlcv-1d", "ohlcv-1s", "bbo-1s", "bbo-1m", "trades", "definition"]);
const transient = (status: number) => status === 408 || status === 425 || status === 429 || status >= 500;
/** Databento Historical HTTP protocol boundary. Rights must be explicitly approved in server config; the adapter never infers them from API responses. */
export class DatabentoMarketDataAdapter implements MarketDataPort {
  private readonly fetcher: typeof fetch;
  private readonly now: () => Date;
  private readonly timeout: number;
  private readonly maxResponseBytes: number;
  constructor(private readonly config: DatabentoAdapterConfig) {
    this.fetcher = config.fetch ?? fetch;
    this.now = config.now ?? (() => new Date());
    this.timeout = config.timeoutMs ?? 5000;
    this.maxResponseBytes = config.maxResponseBytes ?? 8 * 1024 * 1024;
    if (!Number.isInteger(this.timeout) || this.timeout < 1 || this.timeout > 5000) throw new RangeError("Provider timeout must be at most 5000ms");
    if (!Number.isInteger(this.maxResponseBytes) || this.maxResponseBytes < 1024 || this.maxResponseBytes > 32 * 1024 * 1024) throw new RangeError("Provider response limit must be between 1KB and 32MB");
    if (!Number.isInteger(config.delaySeconds) || config.delaySeconds! < 0 || config.delaySeconds! > 86_400) throw new RangeError("An approved data delay from 0 to 86,400 seconds is required");
  }
  private mapped(id: string): DatabentoInstrumentMapping {
    const item = this.config.instrumentMap?.[id];
    if (!item || !item.rawSymbol.trim() || !Number.isInteger(item.metadataVersion) || item.metadataVersion < 1) throw new ProviderUnavailableError("Provider instrument mapping is unavailable");
    return item;
  }
  private schemaFor(asset: AssetClass, interval: BarInterval): {
    config: DatabentoDatasetConfig;
    schema: string;
    aggregateMinutes: number;
    sessionAware: boolean;
  } {
    const config = this.dataset(asset),
      expected: Record<BarInterval, string> = {
        "1m": "ohlcv-1m",
        "5m": "ohlcv-1m",
        "15m": "ohlcv-1m",
        "1h": "ohlcv-1h",
        "1d": "ohlcv-1d"
      },
      sessionAware = interval === "1h" || interval === "1d",
      schema = sessionAware ? "ohlcv-1m" : expected[interval],
      configured = sessionAware ? config.schemaByInterval["1m"] : config.schemaByInterval[interval],
      aggregateMinutes = interval === "5m" ? 5 : interval === "15m" ? 15 : 1;
    if (!configured || configured !== schema || !ALLOWED_SCHEMAS.has(configured)) throw new ProviderUnavailableError("Approved provider schema is unavailable or incompatible");
    return {
      config,
      schema,
      aggregateMinutes,
      sessionAware
    };
  }
  private dataset(asset: AssetClass, interval?: BarInterval): DatabentoDatasetConfig {
    const d = this.config.datasets[asset];
    if (!d || !DATABENTO_DATASETS[asset].has(d.dataset) || !Number.isInteger(d.metadataVersion) || d.metadataVersion < 1) throw new ProviderUnavailableError("Approved provider dataset is not configured");
    if (interval) {
      const schema = d.schemaByInterval[interval];
      if (!schema || !ALLOWED_SCHEMAS.has(schema)) throw new ProviderUnavailableError("Approved provider schema is unavailable");
    }
    return d;
  }
  private async approvedSessions(venue: string, asset: AssetClass, from: string, to: string): Promise<CalendarSession[]> {
    if (!this.config.calendarPort) throw new ProviderUnavailableError("Approved production exchange calendar is not configured");
    const tz = "America/New_York",
      day = (value: string) => new Intl.DateTimeFormat("en-CA", {
        timeZone: tz,
        year: "numeric",
        month: "2-digit",
        day: "2-digit"
      }).format(new Date(value)),
      fromDay = day(from),
      endDay = day(to),
      endDate = new Date(`${endDay}T00:00:00.000Z`);
    if (asset === "future") endDate.setUTCDate(endDate.getUTCDate() + 1);
    const calendarTo = endDate.toISOString().slice(0, 10);
    if (Date.parse(`${calendarTo}T00:00:00Z`) - Date.parse(`${fromDay}T00:00:00Z`) > 366 * 86400000) throw new ProviderUnavailableError("Requested bars exceed approved calendar coverage limits");
    const sessions: CalendarSession[] = [];
    let cursor: string | undefined;
    do {
      const result = await this.config.calendarPort.getCalendar({
        venue,
        from: fromDay,
        to: calendarTo,
        limit: 100,
        ...(cursor ? {
          cursor
        } : {})
      });
      if (result.demo || result.freshness !== "fresh" || result.data.items.some(item => !item.authoritative)) throw new ProviderUnavailableError("Fresh authoritative calendar coverage is required for production bars");
      sessions.push(...result.data.items);
      cursor = result.data.nextCursor ?? undefined;
    } while (cursor);
    if (sessions.length === 0) throw new ProviderUnavailableError("Approved calendar has no coverage for the requested bars");
    return sessions;
  }
  private filterProductionSession(bars: Bar[], asset: AssetClass, query: BarsQuery, sessions: CalendarSession[]): Bar[] {
    const session = query.session ?? "regular";
    if (session !== "regular" && session !== "all") throw new ProviderUnavailableError("Requested market session is unsupported");
    if (asset === "stock" && session === "all") throw new ProviderUnavailableError("Extended-hours stock bars are not supported by the approved calendar");
    return bars.filter(bar => {
      const timestamp = Date.parse(bar.time);
      if (query.interval === "1d") {
        const tradingDate = bar.time.slice(0, 10);
        return sessions.some(s => s.tradingDate === tradingDate && s.status !== "closed");
      }
      const inCalendar = sessions.some(s => s.status !== "closed" && timestamp >= Date.parse(s.open) && timestamp < Date.parse(s.close));
      if (!inCalendar) return false;
      if (asset === "stock") return true;
      const parts = newYorkDateTimeFormatter.formatToParts(new Date(timestamp)),
        p = Object.fromEntries(parts.map(x => [x.type, x.value])),
        minutes = Number(p.hour) * 60 + Number(p.minute);
      if (session === "regular") return minutes >= 570 && minutes < 960;
      return !(minutes >= 1020 && minutes < 1080);
    });
  }
  private rights(asset: AssetClass): MarketCapabilities {
    const d = this.dataset(asset);
    const approved = this.config.approvedCapabilities?.[asset];
    if (!approved) throw new ProviderUnavailableError("Provider data-use approval is missing");
    const grant = (key: keyof MarketCapabilities) => Boolean(approved[key] && d.capabilities[key]);
    if (!grant("displayPublic") && !grant("displayMember") && !grant("retainBars") && !grant("retainSnapshot") && !grant("exportImage") && !grant("exportPersonalRecord") && !grant("newPublishing")) throw new ProviderUnavailableError("No approved provider data-use capability");
    return {
      displayPublic: grant("displayPublic"),
      displayMember: grant("displayMember"),
      retainBars: grant("retainBars"),
      retainSnapshot: grant("retainSnapshot"),
      exportImage: grant("exportImage"),
      exportPersonalRecord: grant("exportPersonalRecord"),
      newPublishing: grant("newPublishing")
    };
  }
  private async reference<T>(request: Promise<MarketDataEnvelope<T>>, asset?: AssetClass): Promise<MarketDataEnvelope<T>> {
    const result = await request;
    if (result.demo) throw new ProviderUnavailableError("Demo data cannot be used by the production adapter");
    const approved = asset ? this.rights(asset) : NO_CAPS,
      caps: MarketCapabilities = {
        displayPublic: approved.displayPublic && result.capabilities.displayPublic,
        displayMember: approved.displayMember && result.capabilities.displayMember,
        retainBars: approved.retainBars && result.capabilities.retainBars,
        retainSnapshot: approved.retainSnapshot && result.capabilities.retainSnapshot,
        exportImage: approved.exportImage && result.capabilities.exportImage,
        exportPersonalRecord: approved.exportPersonalRecord && result.capabilities.exportPersonalRecord,
        newPublishing: approved.newPublishing && result.capabilities.newPublishing
      };
    return {
      ...result,
      capabilities: caps,
      demo: false
    };
  }
  private async responseText(response: Response): Promise<string> {
    if (!response.body) {
      const text = await response.text();
      if (new TextEncoder().encode(text).byteLength > this.maxResponseBytes) throw new ProviderUnavailableError("Provider response exceeded the configured byte limit");
      return text;
    }
    const reader = response.body.getReader(),
      decoder = new TextDecoder();
    let size = 0,
      text = "";
    try {
      for (;;) {
        const {
          done,
          value
        } = await reader.read();
        if (done) break;
        size += value.byteLength;
        if (size > this.maxResponseBytes) {
          await reader.cancel();
          throw new ProviderUnavailableError("Provider response exceeded the configured byte limit");
        }
        text += decoder.decode(value, {
          stream: true
        });
      }
      return text + decoder.decode();
    } finally {
      reader.releaseLock();
    }
  }
  private async request(asset: AssetClass, fields: Record<string, string>): Promise<string> {
    const cfg = this.dataset(asset);
    const rights = this.rights(asset);
    if (!rights.retainBars && !rights.displayPublic && !rights.displayMember && !rights.retainSnapshot) throw new ProviderUnavailableError("Approved use does not permit this market data request");
    if (!this.config.apiKey) throw new ProviderUnavailableError("Provider credentials are not configured");
    for (let attempt = 0; attempt < 2; attempt++) {
      const controller = new AbortController(),
        timer = setTimeout(() => controller.abort(), this.timeout);
      try {
        const body = new URLSearchParams({
          dataset: cfg.dataset,
          ...fields,
          encoding: "json",
          pretty_px: "true",
          pretty_ts: "true",
          map_symbols: "true"
        });
        const headers = new Headers({
          "content-type": "application/x-www-form-urlencoded",
          authorization: `Basic ${btoa(`${this.config.apiKey}:`)}`
        });
        const response = await this.fetcher("https://hist.databento.com/v0/timeseries.get_range", {
          method: "POST",
          headers,
          body,
          signal: controller.signal,
          redirect: "error"
        });
        if (!response.ok) {
          if (attempt === 0 && transient(response.status)) {
            continue;
          }
          throw new ProviderUnavailableError();
        }
        return await this.responseText(response);
      } catch (e) {
        if (e instanceof ProviderUnavailableError) throw e;
        if (attempt > 0) throw new ProviderUnavailableError();
      } finally {
        clearTimeout(timer);
      }
    }
    throw new ProviderUnavailableError();
  }
  private referencePort() {
    if (!this.config.referencePort) throw new ProviderUnavailableError("Approved production reference-data adapter is not configured");
    return this.config.referencePort;
  }
  async searchInstruments(q: InstrumentSearch) {
    const port = this.referencePort(),
      assets = q.assetClass ? [q.assetClass] : ["stock", "option", "future"] as AssetClass[],
      caps = assets.map(a => this.rights(a)).reduce((a, b) => ({
        displayPublic: a.displayPublic && b.displayPublic,
        displayMember: a.displayMember && b.displayMember,
        retainBars: a.retainBars && b.retainBars,
        retainSnapshot: a.retainSnapshot && b.retainSnapshot,
        exportImage: a.exportImage && b.exportImage,
        exportPersonalRecord: a.exportPersonalRecord && b.exportPersonalRecord,
        newPublishing: a.newPublishing && b.newPublishing
      }), {
        ...DEFAULT_CAPS
      }),
      result = await port.searchInstruments(q);
    if (result.demo) throw new ProviderUnavailableError("Demo data cannot be used by the production adapter");
    const items = result.data.items.filter(item => {
      const allowed = this.rights(item.assetClass);
      return allowed.displayPublic && result.capabilities.displayPublic || allowed.displayMember && result.capabilities.displayMember;
    });
    return {
      ...result,
      data: {
        ...result.data,
        items
      },
      capabilities: {
        displayPublic: caps.displayPublic && result.capabilities.displayPublic,
        displayMember: caps.displayMember && result.capabilities.displayMember,
        retainBars: caps.retainBars && result.capabilities.retainBars,
        retainSnapshot: caps.retainSnapshot && result.capabilities.retainSnapshot,
        exportImage: caps.exportImage && result.capabilities.exportImage,
        exportPersonalRecord: caps.exportPersonalRecord && result.capabilities.exportPersonalRecord,
        newPublishing: caps.newPublishing && result.capabilities.newPublishing
      },
      demo: false
    };
  }
  async getInstrument(id: string, version?: number) {
    const result = await this.referencePort().getInstrument(id, version),
      mapping = this.mapped(id);
    if (result.data.id !== id || result.data.assetClass !== mapping.assetClass || result.metadataVersion !== mapping.metadataVersion) throw new ProviderUnavailableError("Provider instrument metadata does not match its approved mapping");
    return this.reference(Promise.resolve(result), mapping.assetClass);
  }
  async listOptionContracts(q: OptionSearch) {
    this.dataset("option");
    return this.reference(this.referencePort().listOptionContracts(q), "option");
  }
  async listFuturesContracts(q: FuturesSearch) {
    this.dataset("future");
    return this.reference(this.referencePort().listFuturesContracts(q), "future");
  }
  async getBars(q: BarsQuery): Promise<MarketDataEnvelope<{
    items: Bar[];
    nextCursor: string | null;
  }>> {
    const mapping = this.mapped(q.instrumentId),
      asset = mapping.assetClass;
    if (asset === "option") throw new ProviderUnavailableError("Historical option-premium bars are outside Phase 1");
    const {
        config: cfg,
        schema,
        aggregateMinutes,
        sessionAware
      } = this.schemaFor(asset, q.interval),
      caps = this.rights(asset);
    if (!caps.retainBars && !caps.displayMember && !caps.displayPublic) throw new ProviderUnavailableError("Approved use does not permit bars");
    if (q.adjustment !== undefined && q.adjustment !== "raw") throw new ProviderUnavailableError("Split-adjusted production bars are not supported");
    const requestedSession = q.session ?? "regular";
    if (requestedSession !== "regular" && requestedSession !== "all") throw new ProviderUnavailableError("Requested market session is unsupported");
    if (asset === "stock" && requestedSession === "all") throw new ProviderUnavailableError("Extended-hours stock bars are not supported by the approved calendar");
    if (sessionAware && asset === "future" && requestedSession === "regular") throw new ProviderUnavailableError("Regular-session futures 1h and 1d bars are unsupported; request the approved exchange session");
    const venue = q.venue?.trim();
    if (!venue) throw new ProviderUnavailableError("Production bars require an instrument venue");
    if (!Number.isFinite(Date.parse(q.from)) || !Number.isFinite(Date.parse(q.to)) || Date.parse(q.to) <= Date.parse(q.from)) throw new RangeError("Invalid bars query");
    const limit = safeBarsLimit(q.limit),
      cursor = q.cursor ? Date.parse(q.cursor) : Date.parse(q.from);
    if (!Number.isFinite(cursor) || cursor < Date.parse(q.from) || cursor >= Date.parse(q.to)) throw new RangeError("Invalid time pagination cursor");
    const rangeEnd = new Date(Date.parse(q.from));
    if (q.interval === "1d") rangeEnd.setUTCFullYear(rangeEnd.getUTCFullYear() + 1);
    else rangeEnd.setUTCDate(rangeEnd.getUTCDate() + 90);
    if (Date.parse(q.to) > rangeEnd.getTime()) throw new RangeError(q.interval === "1d" ? "Daily history exceeds one calendar year" : "Intraday history exceeds 90 calendar days");
    const delay = this.config.delaySeconds ?? 0,
      effectiveEnd = Math.min(Date.parse(q.to), this.now().getTime() - delay * 1000);
    if (effectiveEnd <= cursor) return {
      data: {
        items: [],
        nextCursor: null
      },
      providerReference: `Databento:${cfg.dataset}:${schema}`,
      asOf: null,
      delaySeconds: delay,
      freshness: "missing",
      metadataVersion: mapping.metadataVersion,
      capabilities: caps,
      demo: false
    };
    const sessions = await this.approvedSessions(venue, asset, new Date(cursor).toISOString(), new Date(effectiveEnd).toISOString()),
      raw = await this.request(asset, {
        symbols: mapping.rawSymbol,
        schema,
        start: new Date(cursor).toISOString(),
        end: new Date(effectiveEnd).toISOString(),
        limit: String(10000)
      });
    let rows: unknown[];
    try {
      rows = raw.trim() ? raw.trim().split(/\r?\n/).map(line => JSON.parse(line)) : [];
    } catch {
      throw new ProviderUnavailableError("Malformed provider JSONL response");
    }
    const providerBars: Bar[] = rows.map(row => {
      if (!row || typeof row !== "object") throw new ProviderUnavailableError("Malformed bar response");
      const x = row as Record<string, unknown>,
        header = typeof x.hd === "object" && x.hd !== null ? x.hd as Record<string, unknown> : {},
        time = providerTime(x.ts_recv ?? x.ts_event ?? header.ts_event),
        open = providerPrice(x.open),
        high = providerPrice(x.high),
        low = providerPrice(x.low),
        close = providerPrice(x.close),
        volume = providerVolume(x.volume);
      if (!time || !open || !high || !low || !close || volume === null || Date.parse(time) > this.now().getTime() || decimal(low) > decimal(open) || decimal(low) > decimal(close) || decimal(high) < decimal(open) || decimal(high) < decimal(close) || decimal(high) < decimal(low)) throw new ProviderUnavailableError("Malformed or out-of-order OHLCV bar");
      return {
        time,
        open,
        high,
        low,
        close,
        volume
      };
    }).sort((a, b) => Date.parse(a.time) - Date.parse(b.time));
    const intervalMs = {
        "1m": 60_000,
        "5m": 300_000,
        "15m": 900_000,
        "1h": 3_600_000,
        "1d": 86_400_000
      }[q.interval],
      truncated = rows.length === 10000,
      lastRawTime = providerBars.at(-1)?.time;
    let aggregated: SessionBar[];
    if (sessionAware) {
      const grouped = aggregateSessionBars(providerBars, sessions, q.interval as "1h" | "1d", asset, requestedSession),
        lastRawEnd = lastRawTime ? Date.parse(lastRawTime) + 60_000 : 0;
      aggregated = grouped.filter(group => Date.parse(group.bar.time) >= Date.parse(q.from) && group.end > cursor && group.end <= effectiveEnd && group.end <= Date.parse(q.to) && (!truncated || group.end <= lastRawEnd));
    } else {
      const bars = this.filterProductionSession(providerBars, asset, q, sessions),
        all = (aggregateMinutes === 1 ? bars : aggregateBars(bars, aggregateMinutes)).filter(bar => Date.parse(bar.time) >= cursor && Date.parse(bar.time) + intervalMs <= effectiveEnd && Date.parse(bar.time) + intervalMs <= Date.parse(q.to));
      const incompleteBucket = truncated && aggregateMinutes > 1 && lastRawTime ? Math.floor(Date.parse(lastRawTime) / (aggregateMinutes * 60_000)) * (aggregateMinutes * 60_000) : null;
      aggregated = (incompleteBucket === null ? all : all.filter(bar => Date.parse(bar.time) < incompleteBucket)).map(bar => ({
        bar,
        end: Date.parse(bar.time) + intervalMs
      }));
    }
    const items = aggregated.slice(0, limit).map(group => group.bar),
      hasMore = aggregated.length > items.length || truncated && Boolean(lastRawTime) && Date.parse(lastRawTime!) + 60_000 < effectiveEnd,
      last = aggregated[Math.min(items.length, aggregated.length) - 1],
      asOf = last ? new Date(last.end).toISOString() : null,
      age = asOf ? Math.max(0, (this.now().getTime() - Date.parse(asOf)) / 1000) : 0,
      delaySeconds = this.config.delaySeconds ?? 0;
    const next = last ? new Date(last.end).toISOString() : null;
    if (truncated && hasMore && items.length === 0) {
      if (!sessionAware && aggregateMinutes > 1 && lastRawTime) {
        const width = aggregateMinutes * 60_000,
          retryAt = Math.floor(Date.parse(lastRawTime) / width) * width;
        if (retryAt > cursor) return {
          data: {
            items: [],
            nextCursor: new Date(retryAt).toISOString()
          },
          providerReference: `Databento:${cfg.dataset}:${schema}`,
          asOf: null,
          delaySeconds,
          freshness: "missing",
          metadataVersion: mapping.metadataVersion,
          capabilities: caps,
          demo: false
        };
      }
      throw new ProviderUnavailableError("Provider 1m response exceeded the bounded page before a complete output bar; narrow the requested range");
    }
    if (hasMore && next && Date.parse(next) <= cursor) throw new ProviderUnavailableError("Provider bar pagination did not advance");
    return {
      data: {
        items,
        nextCursor: hasMore ? next : null
      },
      providerReference: `Databento:${cfg.dataset}:${schema}`,
      asOf,
      delaySeconds,
      freshness: asOf === null ? "missing" : age > delaySeconds + 300 ? "stale" : "fresh",
      metadataVersion: mapping.metadataVersion,
      capabilities: caps,
      demo: false
    };
  }
  async getQuoteSnapshot(id: string): Promise<MarketDataEnvelope<QuoteSnapshot>> {
    const mapping = this.mapped(id),
      asset = mapping.assetClass,
      cfg = this.dataset(asset),
      caps = this.rights(asset);
    if (!caps.retainSnapshot && !caps.displayPublic && !caps.displayMember) throw new ProviderUnavailableError("Approved use does not permit quote snapshots");
    const now = this.now(),
      delay = this.config.delaySeconds ?? 0,
      endDate = new Date(now.getTime() - delay * 1000),
      start = new Date(endDate.getTime() - 60000).toISOString(),
      schema = asset === "option" ? "cmbp-1" : "mbp-1";
    const raw = await this.request(asset, {
      symbols: mapping.rawSymbol,
      schema,
      start,
      end: endDate.toISOString(),
      limit: "100"
    });
    let last: Record<string, unknown> | undefined;
    for (const line of raw.trim() ? raw.trim().split(/\r?\n/) : []) {
      try {
        const x = JSON.parse(line) as Record<string, unknown>;
        if (x.levels !== undefined) last = x;
      } catch {
        throw new ProviderUnavailableError("Malformed provider JSONL response");
      }
    }
    const levels = last?.levels;
    if (!Array.isArray(levels) || !levels[0] || typeof levels[0] !== "object") return {
      data: {
        instrumentId: id,
        bid: null,
        ask: null,
        last: null,
        bidSize: null,
        askSize: null,
        marketSession: "unknown"
      },
      providerReference: `Databento:${cfg.dataset}:${schema}`,
      asOf: null,
      delaySeconds: delay,
      freshness: "missing",
      metadataVersion: mapping.metadataVersion,
      capabilities: caps,
      demo: false
    };
    const top = levels[0] as Record<string, unknown>,
      bid = providerPrice(top.bid_px),
      ask = providerPrice(top.ask_px),
      bidSize = providerVolume(top.bid_sz),
      askSize = providerVolume(top.ask_sz),
      header = typeof last?.hd === "object" && last.hd !== null ? last.hd as Record<string, unknown> : {},
      asOf = providerTime(last?.ts_recv ?? header.ts_event);
    if ([top.bid_px, top.ask_px, last?.action === "T" ? last.price : null].some(value => value !== undefined && value !== null && providerPrice(value) === null)) throw new ProviderUnavailableError("Provider prices must be exact decimal strings");
    if (bid && ask && decimal(bid) > decimal(ask)) throw new ProviderUnavailableError("Malformed BBO price levels");
    if (asOf && Date.parse(asOf) > endDate.getTime() + 1000) throw new ProviderUnavailableError("Provider quote timestamp is beyond the delayed query window");
    const lastPx = last?.action === "T" ? providerPrice(last.price) : null,
      missing = bid === null || ask === null || bidSize === null || askSize === null || asOf === null,
      age = asOf ? Math.max(0, (now.getTime() - Date.parse(asOf)) / 1000) : Infinity;
    return {
      data: {
        instrumentId: id,
        bid,
        ask,
        last: lastPx,
        bidSize,
        askSize,
        marketSession: "unknown"
      },
      providerReference: `Databento:${cfg.dataset}:${schema}`,
      asOf,
      delaySeconds: delay,
      freshness: missing ? "missing" : age > delay + 300 ? "stale" : "fresh",
      metadataVersion: mapping.metadataVersion,
      capabilities: caps,
      demo: false
    };
  }
  async getCalendar(q: CalendarQuery) {
    if (!this.config.calendarPort) throw new ProviderUnavailableError("Approved production exchange calendar is not configured");
    const result = await this.config.calendarPort.getCalendar(q);
    if (result.demo || result.data.items.some(item => !item.authoritative)) throw new ProviderUnavailableError("Demo calendar cannot be used by the production adapter");
    return {
      ...result,
      demo: false
    };
  }
  async getCapabilities(id: string, audience: MarketAudience, purpose: MarketPurpose): Promise<MarketDataEnvelope<MarketCapabilities>> {
    const mapping = this.mapped(id),
      asset = mapping.assetClass,
      base = this.rights(asset),
      c = {
        ...base
      };
    if (audience === "public" && !c.displayPublic) c.newPublishing = false;
    if (purpose === "chart" && !c.retainBars) c.exportImage = false;
    if (purpose === "snapshot" && !c.retainSnapshot) c.newPublishing = false;
    if (purpose === "export" && !c.exportImage) c.newPublishing = false;
    if (purpose === "personal_record" && !c.exportPersonalRecord) c.newPublishing = false;
    const cfg = this.dataset(asset);
    return {
      data: c,
      providerReference: `Databento:${cfg.dataset}:approved-capabilities`,
      asOf: this.now().toISOString(),
      delaySeconds: this.config.delaySeconds ?? 0,
      freshness: "fresh",
      metadataVersion: mapping.metadataVersion,
      capabilities: c,
      demo: false
    };
  }
}
export interface OptionStrategyLeg {
  contract: OptionContract;
  side: "long" | "short";
  quantity: number;
  premium: DecimalInput;
}
export interface OptionStrategySelection {
  strategy: Extract<Strategy, "long_call" | "long_put" | "bull_call_debit" | "bear_put_debit" | "bull_put_credit" | "bear_call_credit">;
  underlyingId: string;
  quantity: number;
  legs: OptionStrategyLeg[];
}
export interface OptionStrategyValidation {
  valid: boolean;
  issues: {
    code: string;
    message: string;
  }[];
  netPrice: DecimalInput | null;
  netKind: "debit" | "credit" | null;
}
/** Validates actual catalog contract IDs, equal vertical units and strategy-consistent strikes, then nets premiums with fixed-point arithmetic. */
export function validateOptionStrategy(selection: OptionStrategySelection, actualContracts: OptionContract[], now: () => Date = () => new Date()): OptionStrategyValidation {
  const issues: {
      code: string;
      message: string;
    }[] = [],
    fail = (code: string, message: string) => issues.push({
      code,
      message
    });
  const single = selection.strategy === "long_call" || selection.strategy === "long_put",
    expected = single ? 1 : 2;
  if (!Number.isInteger(selection.quantity) || selection.quantity < 1) fail("quantity", "Strategy quantity must be a positive integer");
  if (selection.legs.length !== expected) fail("leg_count", `Strategy requires exactly ${expected} contract leg${expected === 1 ? "" : "s"}`);
  const legs = selection.legs.map(l => ({
    selection: l,
    contract: actualContracts.find(c => c.id === l.contract.id)
  }));
  for (const {
    selection: l,
    contract
  } of legs) {
    if (!contract) fail("contract_id", "Every option leg must use an actual listed contract ID");else if (contract.underlyingId !== selection.underlyingId || contract.symbol !== l.contract.symbol || contract.expiration !== l.contract.expiration || contract.strike !== l.contract.strike || contract.right !== l.contract.right || contract.multiplier !== l.contract.multiplier || contract.adjusted !== l.contract.adjusted || contract.metadataVersion !== l.contract.metadataVersion) fail("contract_metadata", "Option contract metadata must match the actual catalog record");
    if (!Number.isInteger(l.quantity) || l.quantity !== selection.quantity) fail("leg_quantity", "Every leg must have the planned equal contract quantity");
    if (single && l.side !== "long") fail("leg_side", "Long call/put strategies require a long leg");
    try {
      if (decimal(l.premium) <= 0n) fail("premium", "Option premiums must be positive decimals");
    } catch {
      fail("premium", "Option premium must be a valid decimal");
    }
  }
  const resolved = legs.map(x => x.contract ?? x.selection.contract);
  if (single && resolved[0] && resolved[0].right !== (selection.strategy === "long_call" ? "call" : "put")) fail("option_type", "Long option type must match strategy");
  if (!single && resolved.length === 2) {
    const [a, b] = resolved as [OptionContract, OptionContract],
      la = selection.legs[0]!,
      lb = selection.legs[1]!,
      expectedRight = selection.strategy.includes("call") ? "call" : "put";
    const sides: Record<string, ["long" | "short", "long" | "short"]> = {
        bull_call_debit: ["long", "short"],
        bear_put_debit: ["long", "short"],
        bull_put_credit: ["short", "long"],
        bear_call_credit: ["short", "long"]
      },
      direction = sides[selection.strategy];
    if (a.underlyingId !== b.underlyingId || a.expiration !== b.expiration) fail("vertical_terms", "Vertical legs must have the same underlying and expiration");
    if (a.right !== expectedRight || b.right !== expectedRight) fail("option_type", "Vertical leg type must match strategy");
    if (direction && (la.side !== direction[0] || lb.side !== direction[1])) fail("leg_side", "Leg sides must match the selected vertical");
    try {
      if (decimal(a.multiplier) !== decimal("100") || decimal(b.multiplier) !== decimal("100") || a.adjusted || b.adjusted) fail("contract_multiplier", "Only standard unadjusted 100-multiplier options are supported");
      const x = decimal(a.strike),
        y = decimal(b.strike),
        firstLower = selection.strategy === "bull_call_debit" || selection.strategy === "bear_call_credit";
      if (firstLower ? x >= y : x <= y) fail("strike_order", "Vertical strikes are reversed for the selected strategy");
    } catch {
      fail("contract_metadata", "Contract strikes and multipliers must be valid decimals");
    }
  }
  let netPrice: DecimalInput | null = null,
    netKind: "debit" | "credit" | null = null;
  try {
    const cashFlow = selection.legs.reduce((sum, l) => sum + (l.side === "long" ? -decimal(l.premium) : decimal(l.premium)), 0n),
      debit = single || selection.strategy.endsWith("debit"),
      amount = cashFlow < 0n ? -cashFlow : cashFlow;
    netKind = debit ? "debit" : "credit";
    netPrice = formatDecimal(amount);
    if (amount <= 0n) fail("net_premium", "Net debit or credit must be positive");
    if (debit && cashFlow >= 0n || !debit && cashFlow <= 0n) fail("net_direction", "Leg premiums do not produce the selected debit or credit strategy");
    if (resolved.length === 2) {
      const x = decimal(resolved[0]!.strike),
        y = decimal(resolved[1]!.strike),
        width = x > y ? x - y : y - x;
      if (amount >= width) fail("premium_bounds", "Vertical net debit or credit must be less than strike width");
    }
  } catch {
    fail("premium", "Premiums and strikes must be valid decimal values");
  }
  const testPlan = {
    asset: "option" as const,
    strategy: selection.strategy,
    quantity: selection.quantity,
    entryPrice: netPrice ?? "0",
    instrument: {
      asset: "option" as const,
      symbol: "SYN-XYZ",
      multiplier: "100",
      tickSize: "0.01",
      metadataVersion: 1,
      adjusted: false
    },
    legs: selection.legs.map((l, index) => ({
      side: l.side,
      quantity: l.quantity,
      strike: resolved[index]!.strike,
      optionType: resolved[index]!.right,
      expiration: resolved[index]!.expiration,
      underlyingId: resolved[index]!.underlyingId,
      multiplier: resolved[index]!.multiplier,
      adjusted: resolved[index]!.adjusted
    }))
  };
  for (const e of validateTradePlan(testPlan, {
    now: now().toISOString()
  })) if (!issues.some(i => i.code === e.code)) issues.push(e);
  return {
    valid: issues.length === 0,
    issues,
    netPrice: issues.length ? null : netPrice,
    netKind: issues.length ? null : netKind
  };
}
