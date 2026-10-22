import assert from "node:assert/strict";
import test from "node:test";
import {
  DatabentoMarketDataAdapter,
  ProviderUnavailableError,
  SyntheticMarketDataAdapter,
  validateOptionStrategy,
} from "../dist/index.js";

const fixedNow = () => new Date("2026-10-22T16:30:00.000Z");
const stockId = "00000000-0000-4000-8000-000000000201";
const sample = () => new SyntheticMarketDataAdapter({ now: fixedNow });
const config = (overrides = {}) => ({
  apiKey: "db-test-key",
  delaySeconds: 900,
  datasets: {
    stock: { dataset: "EQUS.SUMMARY", schemaByInterval: { "1m": "ohlcv-1m", "5m": "ohlcv-1m", "15m": "ohlcv-1m", "1h": "ohlcv-1h", "1d": "ohlcv-1d" }, metadataVersion: 1, capabilities: { displayPublic: true, displayMember: true, retainBars: true, retainSnapshot: true, exportImage: true, exportPersonalRecord: true, newPublishing: true } },
    option: { dataset: "OPRA.PILLAR", schemaByInterval: {}, metadataVersion: 1, capabilities: { displayPublic: true, displayMember: true, retainBars: false, retainSnapshot: true, exportImage: false, exportPersonalRecord: true, newPublishing: true } },
    future: { dataset: "GLBX.MDP3", schemaByInterval: { "1m": "ohlcv-1m", "5m": "ohlcv-1m", "15m": "ohlcv-1m", "1h": "ohlcv-1h", "1d": "ohlcv-1d" }, metadataVersion: 1, capabilities: { displayPublic: true, displayMember: true, retainBars: true, retainSnapshot: true, exportImage: true, exportPersonalRecord: true, newPublishing: true } },
  },
  approvedCapabilities: {
    stock: { displayPublic: true, displayMember: true, retainBars: true, retainSnapshot: true, exportImage: true, exportPersonalRecord: true, newPublishing: true },
    option: { displayPublic: true, displayMember: true, retainBars: false, retainSnapshot: true, exportImage: false, exportPersonalRecord: true, newPublishing: true },
    future: { displayPublic: true, displayMember: true, retainBars: true, retainSnapshot: true, exportImage: true, exportPersonalRecord: true, newPublishing: true },
  },
  instrumentMap: {
    [stockId]: { assetClass: "stock", rawSymbol: "SYN-XYZ", metadataVersion: 1 },
  },
  calendarPort: {
    getCalendar: async query => {
      const items = [];
      for (let time = Date.parse(`${query.from}T00:00:00.000Z`); time <= Date.parse(`${query.to}T00:00:00.000Z`); time += 86_400_000) {
        const date = new Date(time), day = date.getUTCDay();
        items.push({ tradingDate: date.toISOString().slice(0, 10), open: `${date.toISOString().slice(0, 10)}T13:30:00.000Z`, close: `${date.toISOString().slice(0, 10)}T20:00:00.000Z`, timezone: "America/New_York", status: day === 0 || day === 6 ? "closed" : "open", authoritative: true });
      }
      return { data: { items, nextCursor: null }, providerReference: "approved-calendar", asOf: fixedNow().toISOString(), delaySeconds: 0, freshness: "fresh", metadataVersion: 1, capabilities: { displayPublic: true, displayMember: true, retainBars: false, retainSnapshot: false, exportImage: false, exportPersonalRecord: false, newPublishing: false }, demo: false };
    },
  },
  now: fixedNow,
  ...overrides,
});

test("synthetic catalog identifies stock and actual ES/MES/NQ/MNQ contract months", async () => {
  const port = sample();
  const stocks = await port.searchInstruments({ query: "SYN-XYZ", assetClass: "stock" });
  assert.equal(stocks.demo, true);
  assert.match(stocks.providerReference, /Demo data/);
  assert.equal(stocks.data.items[0].id, stockId);
  const future = await port.listFuturesContracts({ root: "ES", limit: 100 });
  assert.ok(future.data.items.some(x => x.contractMonth === "2026-12" && x.id === "00000000-0000-4000-8000-000000000202"));
  assert.ok(future.data.items.some(x => x.contractMonth === "2027-03" && x.symbol === "SYN-ESH27"));
  assert.ok(future.data.items.every(x => x.expiration.endsWith("T14:30:00.000Z") || x.expiration.endsWith("T13:30:00.000Z")));
  for (const root of ["ES", "MES", "NQ", "MNQ"]) assert.ok((await port.listFuturesContracts({ root })).data.items.length > 0);
  const futureQuote = await port.getQuoteSnapshot("00000000-0000-4000-8000-000000000202");
  assert.equal(Number(futureQuote.data.bid) % 0.25, 0);
  assert.equal(Number(futureQuote.data.ask) % 0.25, 0);
});

test("option selector returns actual IDs and validates all six supported strategies with decimal-safe debit/credit", async () => {
  const port = sample();
  const chain = await port.listOptionContracts({ underlyingId: stockId, expiration: "2026-11-20", limit: 100 });
  assert.deepEqual(chain.data.items.map(x => x.id).sort(), [221,222,223,224].map(n => `00000000-0000-4000-8000-000000000${n}`).sort());
  const c100 = chain.data.items.find(x => x.right === "call" && x.strike === "100");
  const c105 = chain.data.items.find(x => x.right === "call" && x.strike === "105");
  const p100 = chain.data.items.find(x => x.right === "put" && x.strike === "100");
  const p105 = chain.data.items.find(x => x.right === "put" && x.strike === "105");
  const cases = [
    ["long_call", [{ contract: c100, side: "long", premium: "1.25" }], "1.25", "debit"],
    ["long_put", [{ contract: p100, side: "long", premium: "1.25" }], "1.25", "debit"],
    ["bull_call_debit", [{ contract: c100, side: "long", premium: "1.75" }, { contract: c105, side: "short", premium: "0.50" }], "1.25", "debit"],
    ["bear_put_debit", [{ contract: p105, side: "long", premium: "1.75" }, { contract: p100, side: "short", premium: "0.50" }], "1.25", "debit"],
    ["bull_put_credit", [{ contract: p105, side: "short", premium: "1.75" }, { contract: p100, side: "long", premium: "0.50" }], "1.25", "credit"],
    ["bear_call_credit", [{ contract: c100, side: "short", premium: "1.75" }, { contract: c105, side: "long", premium: "0.50" }], "1.25", "credit"],
  ];
  for (const [strategy, legs, netPrice, netKind] of cases) {
    const result = validateOptionStrategy({ strategy, underlyingId: stockId, quantity: 1, legs: legs.map(x => ({ ...x, quantity: 1 })) }, chain.data.items, fixedNow);
    assert.equal(result.valid, true, `${strategy}: ${JSON.stringify(result.issues)}`);
    assert.equal(result.netPrice, `${netPrice}0000000000`.slice(0, 12));
    assert.equal(result.netKind, netKind);
  }
  const quotedCases = [
    ["long_call", [{ contract: c100, side: "long", quote: "ask" }], "5.0500000000", "debit"],
    ["long_put", [{ contract: p100, side: "long", quote: "ask" }], "5.0500000000", "debit"],
    ["bull_call_debit", [{ contract: c100, side: "long", quote: "ask" }, { contract: c105, side: "short", quote: "bid" }], "1.1000000000", "debit"],
    ["bear_put_debit", [{ contract: p105, side: "long", quote: "ask" }, { contract: p100, side: "short", quote: "bid" }], "1.1000000000", "debit"],
    ["bull_put_credit", [{ contract: p105, side: "short", quote: "bid" }, { contract: p100, side: "long", quote: "ask" }], "0.9000000000", "credit"],
    ["bear_call_credit", [{ contract: c100, side: "short", quote: "bid" }, { contract: c105, side: "long", quote: "ask" }], "0.9000000000", "credit"],
  ];
  for (const [strategy, legs, netPrice, netKind] of quotedCases) {
    const valuedLegs = await Promise.all(legs.map(async ({ contract, side, quote }) => {
      const snapshot = await port.getQuoteSnapshot(contract.id);
      return { contract, side, quantity: 1, premium: snapshot.data[quote] };
    }));
    const result = validateOptionStrategy({ strategy, underlyingId: stockId, quantity: 1, legs: valuedLegs }, chain.data.items, fixedNow);
    assert.equal(result.valid, true, `${strategy} from quotes: ${JSON.stringify(result.issues)}`);
    assert.equal(result.netPrice, netPrice);
    assert.equal(result.netKind, netKind);
  }
  const invalid = validateOptionStrategy({ strategy: "bull_call_debit", underlyingId: stockId, quantity: 1, legs: [{ contract: c105, side: "long", quantity: 1, premium: "1" }, { contract: c100, side: "short", quantity: 1, premium: "0.25" }] }, chain.data.items, fixedNow);
  assert.equal(invalid.valid, false);
  assert.ok(invalid.issues.some(x => x.code === "strike_order"));
  const forged = { ...c100, strike: "999" };
  const tampered = validateOptionStrategy({ strategy: "long_call", underlyingId: stockId, quantity: 1, legs: [{ contract: forged, side: "long", quantity: 1, premium: "1" }] }, chain.data.items, fixedNow);
  assert.equal(tampered.valid, false);
  assert.ok(tampered.issues.some(x => x.code === "contract_metadata"));
  const staleVersion = { ...c100, metadataVersion: c100.metadataVersion + 1 };
  const staleMetadata = validateOptionStrategy({ strategy: "long_call", underlyingId: stockId, quantity: 1, legs: [{ contract: staleVersion, side: "long", quantity: 1, premium: "1" }] }, chain.data.items, fixedNow);
  assert.equal(staleMetadata.valid, false);
  assert.ok(staleMetadata.issues.some(x => x.code === "contract_metadata"));
  const malformed = validateOptionStrategy({ strategy: "bear_put_debit", underlyingId: stockId, quantity: 1, legs: [{ contract: { ...p105, strike: "not-a-decimal" }, side: "long", quantity: 1, premium: "1" }, { contract: p100, side: "short", quantity: 1, premium: "0.25" }] }, chain.data.items, fixedNow);
  assert.equal(malformed.valid, false);
});

test("synthetic bars paginate the requested interval and respect stock sessions and futures ticks", async () => {
  const port = sample();
  const q = { instrumentId: stockId, venue: "NYSE", interval: "1m", from: "2026-10-20T13:30:00.000Z", to: "2026-10-20T13:34:00.000Z", limit: 2 };
  const first = await port.getBars(q);
  const second = await port.getBars({ ...q, cursor: first.data.nextCursor });
  assert.equal(first.data.items.length, 2);
  assert.equal(second.data.items.length, 2);
  assert.equal(first.data.nextCursor, "2");
  assert.equal(second.data.nextCursor, null);
  assert.notEqual(first.data.items.at(-1).time, second.data.items[0].time);
  assert.equal(second.asOf, new Date(Date.parse(second.data.items.at(-1).time) + 60_000).toISOString());
  const future = await port.getBars({ ...q, instrumentId: "00000000-0000-4000-8000-000000000202", to: "2026-10-20T13:34:00.000Z", limit: 4 });
  for (const bar of future.data.items) for (const value of [bar.open, bar.high, bar.low, bar.close]) assert.equal(Number(value) % 0.25, 0);
  const daily = await port.getBars({ instrumentId: stockId, interval: "1d", from: "2026-10-20T00:00:00.000Z", to: "2026-10-23T00:00:00.000Z", limit: 10 });
  assert.equal(daily.data.items.length, 2);
  assert.equal(daily.data.items[0].time, "2026-10-20T13:30:00.000Z");
  assert.equal(daily.asOf, "2026-10-21T20:00:00.000Z");
  const hourly = await port.getBars({ instrumentId: stockId, interval: "1h", from: "2026-10-19T13:30:00.000Z", to: "2026-10-19T20:00:00.000Z", session: "regular", limit: 10 });
  assert.deepEqual(hourly.data.items.map(bar => bar.time), ["2026-10-19T13:30:00.000Z", "2026-10-19T14:30:00.000Z", "2026-10-19T15:30:00.000Z", "2026-10-19T16:30:00.000Z", "2026-10-19T17:30:00.000Z", "2026-10-19T18:30:00.000Z", "2026-10-19T19:30:00.000Z"]);
  assert.equal(hourly.asOf, "2026-10-19T20:00:00.000Z", "Final regular-session hour is a complete 30-minute bucket");
  const earlyClose = await new SyntheticMarketDataAdapter({ now: () => new Date("2026-11-27T19:00:00.000Z") }).getBars({ instrumentId: stockId, interval: "1h", from: "2026-11-27T14:30:00.000Z", to: "2026-11-27T18:00:00.000Z", session: "regular", limit: 10 });
  assert.deepEqual(earlyClose.data.items.map(bar => bar.time), ["2026-11-27T14:30:00.000Z", "2026-11-27T15:30:00.000Z", "2026-11-27T16:30:00.000Z", "2026-11-27T17:30:00.000Z"]);
  assert.equal(earlyClose.asOf, "2026-11-27T18:00:00.000Z", "Synthetic early-close history respects the session end");
  const earlyCloseMinute = new SyntheticMarketDataAdapter({ now: () => new Date("2026-11-27T19:00:00.000Z") });
  for (const interval of ["1m", "5m", "15m"]) {
    const closed = await earlyCloseMinute.getBars({ instrumentId: stockId, interval, from: "2026-11-27T18:00:00.000Z", to: "2026-11-27T19:00:00.000Z", session: "regular" });
    assert.deepEqual(closed.data.items, [], `${interval} stock bars stop at the synthetic 13:00 ET early close`);
  }
  const futuresHoliday = new SyntheticMarketDataAdapter({ now: () => new Date("2026-07-06T22:00:00.000Z") });
  for (const interval of ["1m", "5m", "15m", "1h"]) {
    const closed = await futuresHoliday.getBars({ instrumentId: "00000000-0000-4000-8000-000000000202", interval, from: "2026-07-02T22:00:00.000Z", to: "2026-07-03T02:00:00.000Z", session: "all" });
    assert.deepEqual(closed.data.items, [], `${interval} futures bars stop when the synthetic CME trading date is closed`);
  }
  const afterCloseDaily = await new SyntheticMarketDataAdapter({ now: () => new Date("2026-10-22T21:00:00.000Z") }).getBars({ instrumentId: stockId, interval: "1d", from: "2026-10-20T00:00:00.000Z", to: "2026-10-23T00:00:00.000Z", limit: 10 });
  assert.equal(afterCloseDaily.data.items.length, 3);
  assert.equal(afterCloseDaily.asOf, "2026-10-22T20:00:00.000Z");
  const overnight = await new SyntheticMarketDataAdapter({ now: () => new Date("2026-10-27T00:00:00.000Z") }).getBars({ instrumentId: "00000000-0000-4000-8000-000000000202", interval: "1m", from: "2026-10-25T22:00:00.000Z", to: "2026-10-25T22:03:00.000Z", session: "all" });
  assert.equal(overnight.data.items.length, 3);
  const weekdayOvernight = await new SyntheticMarketDataAdapter({ now: () => new Date("2026-10-27T00:00:00.000Z") }).getBars({ instrumentId: "00000000-0000-4000-8000-000000000202", interval: "1m", from: "2026-10-26T22:00:00.000Z", to: "2026-10-26T22:03:00.000Z", session: "all" });
  assert.equal(weekdayOvernight.data.items.length, 3);
  const midnightEndHourly = await new SyntheticMarketDataAdapter({ now: () => new Date("2026-10-27T00:00:00.000Z") }).getBars({ instrumentId: "00000000-0000-4000-8000-000000000202", interval: "1h", from: "2026-10-19T22:00:00.000Z", to: "2026-10-20T00:00:00.000Z", session: "all" });
  assert.deepEqual(midnightEndHourly.data.items.map(bar => bar.time), ["2026-10-19T22:00:00.000Z", "2026-10-19T23:00:00.000Z"], "Futures sessions include evening bars when the requested range ends at UTC midnight");
  await assert.rejects(() => port.getBars({ ...q, adjustment: "split_adjusted" }), /split-adjusted/);
  await assert.rejects(() => port.getBars({ ...q, interval: "1m", to: "2027-01-30T00:00:00.000Z" }), /90 calendar days/);
});

test("synthetic calendars cover DST, holidays, early close, overnight sessions and reject unknown venues", async () => {
  const port = sample();
  const equity = await port.getCalendar({ venue: "NYSE", from: "2026-03-06", to: "2026-03-09", limit: 100 });
  const friday = equity.data.items.find(x => x.tradingDate === "2026-03-06");
  const monday = equity.data.items.find(x => x.tradingDate === "2026-03-09");
  assert.equal(friday.open, "2026-03-06T14:30:00.000Z");
  assert.equal(monday.open, "2026-03-09T13:30:00.000Z");
  assert.equal(monday.authoritative, false);
  const july = await port.getCalendar({ venue: "NYSE", from: "2026-07-03", to: "2026-07-03" });
  assert.equal(july.data.items[0].status, "closed");
  const thanksgiving = await port.getCalendar({ venue: "NYSE", from: "2026-11-27", to: "2026-11-27" });
  assert.equal(thanksgiving.data.items[0].status, "early_close");
  assert.equal(thanksgiving.data.items[0].close, "2026-11-27T18:00:00.000Z");
  const august = await port.getCalendar({ venue: "NYSE", from: "2027-08-27", to: "2027-08-27" });
  assert.equal(august.data.items[0].status, "open");
  const cme = await port.getCalendar({ venue: "CME_GLOBEX", from: "2026-03-09", to: "2026-03-09" });
  assert.equal(cme.data.items[0].open, "2026-03-08T22:00:00.000Z");
  assert.equal(cme.data.items[0].close, "2026-03-09T21:00:00.000Z");
  await assert.rejects(() => port.getCalendar({ venue: "UNKNOWN", from: "2026-03-09", to: "2026-03-09" }), /No synthetic calendar/);
});

test("synthetic capabilities are independent and stale, missing, disabled and provider-failure states stay explicit", async () => {
  const port = new SyntheticMarketDataAdapter({ now: fixedNow, capabilities: { retainBars: false, retainSnapshot: true, exportImage: false, exportPersonalRecord: true, newPublishing: true }, staleAfterSeconds: 1 });
  const caps = await port.getCapabilities(stockId, "member", "chart");
  assert.equal(caps.data.retainBars, false);
  assert.equal(caps.data.retainSnapshot, true);
  assert.equal(caps.data.exportImage, false);
  assert.equal(caps.data.newPublishing, true);
  const missing = await port.getQuoteSnapshot("not-a-reference-id").catch(() => null);
  assert.equal(missing, null);
  const stale = await new SyntheticMarketDataAdapter({ now: () => new Date("2026-10-22T16:30:00Z"), staleAfterSeconds: 0 }).getBars({ instrumentId: stockId, interval: "1m", from: "2026-10-20T13:30:00.000Z", to: "2026-10-20T13:32:00.000Z" });
  assert.equal(stale.freshness, "stale");
  const disabled = new SyntheticMarketDataAdapter({ now: fixedNow, disabledInstrumentIds: [stockId] });
  assert.equal((await disabled.getInstrument(stockId)).data.isEnabledForNewPublishing, false);
  const failed = new SyntheticMarketDataAdapter({ now: fixedNow, failNext: { getQuoteSnapshot: new Error("fixture failure") } });
  await assert.rejects(() => failed.getQuoteSnapshot(stockId), /fixture failure/);
});

test("Databento boundary requires approved mappings/rights and parses only real BBO fields", async () => {
  assert.throws(() => new DatabentoMarketDataAdapter({ datasets: {} }), /approved data delay/);
  const deniedFetch = async () => { throw new Error("must not request without rights"); };
  const denied = new DatabentoMarketDataAdapter(config({ apiKey: undefined, fetch: deniedFetch }));
  await assert.rejects(() => denied.getQuoteSnapshot(stockId), ProviderUnavailableError);

  const calls = [];
  const fetch = async (url, init) => {
    calls.push({ url, init });
    return new Response(JSON.stringify({ ts_recv: "2026-10-22T16:14:00.000Z", action: "M", price: "125.00", levels: [{ bid_px: "124.99", ask_px: "125.01", bid_sz: 8, ask_sz: 9 }] }), { status: 200 });
  };
  const live = new DatabentoMarketDataAdapter(config({ fetch }));
  const quote = await live.getQuoteSnapshot(stockId);
  assert.equal(quote.demo, false);
  assert.equal(quote.data.bid, "124.99");
  assert.equal(quote.data.ask, "125.01");
  assert.equal(quote.data.last, null);
  assert.equal(quote.data.bidSize, "8");
  assert.equal(new URLSearchParams(calls[0].init.body).get("schema"), "mbp-1");
  assert.equal(new URL(calls[0].url).pathname, "/v0/timeseries.get_range");
  assert.equal(calls[0].init.headers.get("authorization"), `Basic ${Buffer.from("db-test-key:").toString("base64")}`);
  const empty = new DatabentoMarketDataAdapter(config({ fetch: async () => new Response("", { status: 200 }) }));
  const absent = await empty.getQuoteSnapshot(stockId);
  assert.equal(absent.freshness, "missing");
  assert.equal(absent.data.bid, null);
  const unsafePrice = new DatabentoMarketDataAdapter(config({ fetch: async () => new Response(JSON.stringify({ ts_recv: "2026-10-22T16:14:00.000Z", levels: [{ bid_px: 124.99, ask_px: "125.01", bid_sz: 8, ask_sz: 9 }] }), { status: 200 }) }));
  await assert.rejects(() => unsafePrice.getQuoteSnapshot(stockId), ProviderUnavailableError);
  const futureStamp = new DatabentoMarketDataAdapter(config({ fetch: async () => new Response(JSON.stringify({ ts_recv: "2026-10-22T16:16:00.000Z", levels: [{ bid_px: "124.99", ask_px: "125.01", bid_sz: 8, ask_sz: 9 }] }), { status: 200 }) }));
  await assert.rejects(() => futureStamp.getQuoteSnapshot(stockId), /timestamp/);

  const deniedRights = new DatabentoMarketDataAdapter(config({ approvedCapabilities: { stock: { displayPublic: false, displayMember: false, retainBars: false, retainSnapshot: false, exportImage: false, exportPersonalRecord: false, newPublishing: false } }, fetch }));
  await assert.rejects(() => deniedRights.getQuoteSnapshot(stockId), ProviderUnavailableError);
  const badDataset = new DatabentoMarketDataAdapter(config({ datasets: { stock: { dataset: "UNKNOWN.DATASET", schemaByInterval: { "1m": "ohlcv-1m" }, metadataVersion: 1, capabilities: { displayPublic: true } } }, fetch }));
  await assert.rejects(() => badDataset.getQuoteSnapshot(stockId), ProviderUnavailableError);
  const unmapped = new DatabentoMarketDataAdapter(config({ instrumentMap: {}, fetch }));
  await assert.rejects(() => unmapped.getQuoteSnapshot(stockId), ProviderUnavailableError);
  const barsBody = [
    { ts_recv: "2026-10-22T13:00:00.000Z", open: "100", high: "101", low: "99", close: "100", volume: "1" },
    { ts_recv: "2026-10-22T13:30:00.000Z", open: "100", high: "101", low: "99", close: "100", volume: "1" },
    { ts_recv: "2026-10-22T13:59:00.000Z", open: "100", high: "101", low: "99", close: "100", volume: "1" },
  ].map(x => JSON.stringify(x)).join("\n");
  const sessionAdapter = new DatabentoMarketDataAdapter(config({ fetch: async () => new Response(barsBody, { status: 200 }) }));
  const regular = await sessionAdapter.getBars({ instrumentId: stockId, venue: "NYSE", interval: "1m", from: "2026-10-22T13:00:00.000Z", to: "2026-10-22T14:00:00.000Z", session: "regular" });
  assert.deepEqual(regular.data.items.map(x => x.time), ["2026-10-22T13:30:00.000Z", "2026-10-22T13:59:00.000Z"]);
  await assert.rejects(() => sessionAdapter.getBars({ instrumentId: stockId, venue: "NYSE", interval: "1m", from: "2026-10-22T13:00:00.000Z", to: "2026-10-22T14:00:00.000Z", session: "all" }), /Extended-hours stock bars/);
  await assert.rejects(() => sessionAdapter.getBars({ instrumentId: stockId, venue: "NYSE", interval: "1m", from: "2026-10-22T13:00:00.000Z", to: "2026-10-22T14:00:00.000Z", adjustment: "split_adjusted" }), /Split-adjusted/);
  const noCalendar = new DatabentoMarketDataAdapter(config({ calendarPort: undefined, fetch: async () => new Response(barsBody, { status: 200 }) }));
  await assert.rejects(() => noCalendar.getBars({ instrumentId: stockId, venue: "NYSE", interval: "1m", from: "2026-10-22T13:00:00.000Z", to: "2026-10-22T14:00:00.000Z" }), /calendar/);

  let transientCalls = 0;
  const retry = new DatabentoMarketDataAdapter(config({ fetch: async () => ++transientCalls === 1 ? new Response("busy", { status: 503 }) : new Response("", { status: 200 }) }));
  assert.equal((await retry.getQuoteSnapshot(stockId)).freshness, "missing");
  assert.equal(transientCalls, 2);
  let authCalls = 0;
  const authFailure = new DatabentoMarketDataAdapter(config({ fetch: async () => { authCalls++; return new Response("denied", { status: 401 }); } }));
  await assert.rejects(() => authFailure.getQuoteSnapshot(stockId), ProviderUnavailableError);
  assert.equal(authCalls, 1);
  const oversized = new DatabentoMarketDataAdapter(config({ maxResponseBytes: 1024, fetch: async () => new Response("x".repeat(1025), { status: 200 }) }));
  await assert.rejects(() => oversized.getQuoteSnapshot(stockId), /byte limit/);
  const slow = new DatabentoMarketDataAdapter(config({ timeoutMs: 10, fetch: async (_url, init) => new Promise((_resolve, reject) => init.signal.addEventListener("abort", () => reject(new Error("aborted")))) }));
  await assert.rejects(() => slow.getQuoteSnapshot(stockId), ProviderUnavailableError);
  const wrongSchema = new DatabentoMarketDataAdapter(config({ datasets: { ...config().datasets, stock: { ...config().datasets.stock, schemaByInterval: { ...config().datasets.stock.schemaByInterval, "5m": "ohlcv-5m" } } }, fetch }));
  await assert.rejects(() => wrongSchema.getBars({ instrumentId: stockId, interval: "5m", from: "2026-10-22T13:30:00.000Z", to: "2026-10-22T13:40:00.000Z" }), ProviderUnavailableError);
});

test("Databento 1h and 1d bars aggregate approved sessions from 1m without mixing extended hours", async () => {
  const query = { instrumentId: stockId, venue: "NYSE", interval: "1h", from: "2026-10-22T13:30:00.000Z", to: "2026-10-22T14:30:00.000Z", session: "regular" };
  const source = [
    ["2026-10-22T13:29:00.000Z", "90.00", "1"], // premarket
    ["2026-10-22T13:30:00.000Z", "100.00", "2"],
    ["2026-10-22T13:31:00.000Z", "101.00", "3"],
    ["2026-10-22T14:29:00.000Z", "102.00", "4"],
    ["2026-10-22T14:30:00.000Z", "102.00", "5"], // next hour, inside the trading day
  ].map(([ts_recv, close, volume]) => JSON.stringify({ ts_recv, open: close, high: close, low: close, close, volume })).join("\n");
  const adapter = new DatabentoMarketDataAdapter(config({ now: () => new Date("2026-10-22T21:00:00.000Z"), fetch: async (_url, init) => {
    assert.equal(new URLSearchParams(init.body).get("schema"), "ohlcv-1m");
    return new Response(source, { status: 200 });
  } }));
  const hour = await adapter.getBars(query);
  assert.deepEqual(hour.data.items, [{ time: "2026-10-22T13:30:00.000Z", open: "100.00", high: "102.00", low: "100.00", close: "102.00", volume: "9" }]);
  assert.equal(hour.asOf, "2026-10-22T14:30:00.000Z");
  assert.equal(hour.data.nextCursor, null);
  const daily = await adapter.getBars({ ...query, interval: "1d", from: "2026-10-22T00:00:00.000Z", to: "2026-10-22T21:00:00.000Z" });
  assert.deepEqual(daily.data.items, [{ time: "2026-10-22T13:30:00.000Z", open: "100.00", high: "102.00", low: "100.00", close: "102.00", volume: "14" }]);
  assert.equal(daily.asOf, "2026-10-22T20:00:00.000Z");
});

test("Databento session aggregation preserves early-close buckets and futures overnight daily bars", async () => {
  const earlyCalendar = { getCalendar: async () => ({ data: { items: [{ tradingDate: "2026-11-27", open: "2026-11-27T14:30:00.000Z", close: "2026-11-27T18:00:00.000Z", timezone: "America/New_York", status: "early_close", authoritative: true }], nextCursor: null }, providerReference: "approved-early-close", asOf: "2026-11-27T19:00:00.000Z", delaySeconds: 0, freshness: "fresh", metadataVersion: 1, capabilities: config().calendarPort.capabilities, demo: false }) };
  const earlyRows = ["2026-11-27T14:30:00.000Z", "2026-11-27T15:30:00.000Z", "2026-11-27T16:30:00.000Z", "2026-11-27T17:30:00.000Z", "2026-11-27T18:00:00.000Z"].map((ts_recv, i) => JSON.stringify({ ts_recv, open: String(100 + i), high: String(101 + i), low: String(99 + i), close: String(100 + i), volume: "1" })).join("\n");
  const early = new DatabentoMarketDataAdapter(config({ calendarPort: earlyCalendar, now: () => new Date("2026-11-27T19:00:00.000Z"), fetch: async () => new Response(earlyRows) }));
  const shortSession = await early.getBars({ instrumentId: stockId, venue: "NYSE", interval: "1h", from: "2026-11-27T14:30:00.000Z", to: "2026-11-27T18:00:00.000Z", session: "regular" });
  assert.deepEqual(shortSession.data.items.map(x => x.time), ["2026-11-27T14:30:00.000Z", "2026-11-27T15:30:00.000Z", "2026-11-27T16:30:00.000Z", "2026-11-27T17:30:00.000Z"]);
  assert.equal(shortSession.data.items.at(-1).close, "103");
  assert.equal(shortSession.asOf, "2026-11-27T18:00:00.000Z");

  const futureId = "00000000-0000-4000-8000-000000000202", mapping = { [futureId]: { assetClass: "future", rawSymbol: "ESZ26", metadataVersion: 1 } };
  const futureCalendar = { getCalendar: async () => ({ data: { items: [{ tradingDate: "2026-10-23", open: "2026-10-22T22:00:00.000Z", close: "2026-10-23T21:00:00.000Z", timezone: "America/New_York", status: "open", authoritative: true }], nextCursor: null }, providerReference: "approved-cme", asOf: "2026-10-24T00:00:00.000Z", delaySeconds: 0, freshness: "fresh", metadataVersion: 1, capabilities: config().calendarPort.capabilities, demo: false }) };
  const futureRows = [
    ["2026-10-22T22:00:00.000Z", "5000.00", "1"],
    ["2026-10-22T23:59:00.000Z", "5001.00", "2"],
    ["2026-10-23T20:59:00.000Z", "5002.00", "3"],
    ["2026-10-23T21:30:00.000Z", "6000.00", "4"],
  ].map(([ts_recv, close, volume]) => JSON.stringify({ ts_recv, open: close, high: close, low: close, close, volume })).join("\n");
  const future = new DatabentoMarketDataAdapter(config({ instrumentMap: { ...config().instrumentMap, ...mapping }, calendarPort: futureCalendar, now: () => new Date("2026-10-24T00:00:00.000Z"), fetch: async (_url, init) => { assert.equal(new URLSearchParams(init.body).get("schema"), "ohlcv-1m"); return new Response(futureRows); } }));
  const overnight = await future.getBars({ instrumentId: futureId, venue: "CME_GLOBEX", interval: "1d", from: "2026-10-22T22:00:00.000Z", to: "2026-10-23T22:00:00.000Z", session: "all" });
  assert.deepEqual(overnight.data.items, [{ time: "2026-10-22T22:00:00.000Z", open: "5000.00", high: "5002.00", low: "5000.00", close: "5002.00", volume: "6" }]);
  assert.equal(overnight.asOf, "2026-10-23T21:00:00.000Z");
});

test("Databento 1h aggregation paginates a truncated 10,000-row 1m response without gaps or duplicate groups", async () => {
  const from = "2026-10-01T13:30:00.000Z", to = "2026-11-10T21:00:00.000Z", sessions = [], source = [];
  for (let day = Date.parse("2026-10-01T00:00:00.000Z"); day <= Date.parse("2026-11-10T00:00:00.000Z"); day += 86_400_000) {
    const date = new Date(day).toISOString().slice(0, 10), weekday = new Date(day).getUTCDay() > 0 && new Date(day).getUTCDay() < 6;
    sessions.push({ tradingDate: date, open: `${date}T13:30:00.000Z`, close: `${date}T20:00:00.000Z`, timezone: "America/New_York", status: weekday ? "open" : "closed", authoritative: true });
    if (weekday) for (let time = Date.parse(`${date}T13:30:00.000Z`); time < Date.parse(`${date}T20:00:00.000Z`); time += 60_000) source.push({ ts_recv: new Date(time).toISOString(), open: "100", high: "101", low: "99", close: "100", volume: "1" });
  }
  const calendarPort = { getCalendar: async () => ({ data: { items: sessions, nextCursor: null }, providerReference: "approved-calendar", asOf: "2026-12-01T22:00:00.000Z", delaySeconds: 0, freshness: "fresh", metadataVersion: 1, capabilities: config().calendarPort.capabilities, demo: false }) };
  const fetch = async (_url, init) => {
    const params = new URLSearchParams(init.body), start = Date.parse(params.get("start")), end = Date.parse(params.get("end"));
    return new Response(source.filter(row => Date.parse(row.ts_recv) >= start && Date.parse(row.ts_recv) < end).slice(0, 10_000).map(row => JSON.stringify(row)).join("\n"));
  };
  const adapter = new DatabentoMarketDataAdapter(config({ calendarPort, now: () => new Date("2026-12-01T22:00:00.000Z"), fetch }));
  const bars = [], starts = new Set(); let cursor, pages = 0;
  do {
    const response = await adapter.getBars({ instrumentId: stockId, venue: "NYSE", interval: "1h", from, to, session: "regular", limit: 100, ...(cursor ? { cursor } : {}) });
    pages++; for (const bar of response.data.items) { assert.equal(starts.has(bar.time), false, `duplicate ${bar.time}`); starts.add(bar.time); bars.push(bar); }
    cursor = response.data.nextCursor;
  } while (cursor && pages < 10);
  assert.equal(cursor, null);
  assert.ok(pages >= 2);
  assert.equal(bars.length, sessions.filter(s => s.status === "open").length * 7);
  assert.equal(bars.at(-1).time, "2026-11-10T19:30:00.000Z");
});

test("Databento bars validate provider values and paginate complete 5m aggregates", async () => {
  const q = { instrumentId: stockId, venue: "NYSE", interval: "5m", from: "2026-10-22T13:30:00.000Z", to: "2026-10-22T13:40:00.000Z", limit: 1 };
  const fetchBars = async (_url, init) => {
    const from = Date.parse(new URLSearchParams(init.body).get("start")), end = Date.parse(q.to), rows = [];
    for (let time = from; time < end; time += 60_000) {
      const price = (100 + ((time - Date.parse(q.from)) / 60_000) / 100).toFixed(2);
      rows.push(JSON.stringify({ ts_recv: new Date(time).toISOString(), open: "100.00", high: "101.00", low: "99.00", close: price, volume: "10" }));
    }
    return new Response(rows.join("\n"), { status: 200 });
  };
  const port = new DatabentoMarketDataAdapter(config({ fetch: fetchBars }));
  const first = await port.getBars(q);
  const second = await port.getBars({ ...q, cursor: first.data.nextCursor });
  assert.equal(first.data.items.length, 1);
  assert.equal(first.data.items[0].time, "2026-10-22T13:30:00.000Z");
  assert.equal(first.data.nextCursor, "2026-10-22T13:35:00.000Z");
  assert.equal(first.asOf, "2026-10-22T13:35:00.000Z");
  assert.equal(second.data.items[0].time, "2026-10-22T13:35:00.000Z");
  assert.equal(second.data.nextCursor, null);
  const malformed = new DatabentoMarketDataAdapter(config({ fetch: async () => new Response(JSON.stringify({ ts_recv: "2026-10-22T13:30:00.000Z", open: 100, high: 99, low: 98, close: 100, volume: "-1" }), { status: 200 }) }));
  await assert.rejects(() => malformed.getBars({ ...q, interval: "1m", to: "2026-10-22T13:31:00.000Z" }), ProviderUnavailableError);
  const future = new DatabentoMarketDataAdapter(config({ fetch: async () => new Response(JSON.stringify({ ts_recv: "2026-10-23T13:30:00.000Z", open: "100", high: "101", low: "99", close: "100", volume: "1" }), { status: 200 }) }));
  await assert.rejects(() => future.getBars({ ...q, interval: "1m", to: "2026-10-22T13:31:00.000Z" }), ProviderUnavailableError);
});

test("Databento 15m aggregation re-requests the final truncated source bucket without skipping it", async () => {
  const query = { instrumentId: stockId, venue: "NYSE", interval: "15m", from: "2026-10-22T15:00:00.000Z", to: "2026-10-29T14:00:00.000Z", session: "regular", limit: 100 };
  const calendarPort = { getCalendar: async q => {
    const items = [];
    for (let time = Date.parse(`${q.from}T00:00:00.000Z`); time <= Date.parse(`${q.to}T00:00:00.000Z`); time += 86_400_000) {
      const date = new Date(time).toISOString().slice(0, 10), open = date === "2026-10-29";
      items.push({ tradingDate: date, open: `${date}T13:30:00.000Z`, close: `${date}T20:00:00.000Z`, timezone: "America/New_York", status: open ? "open" : "closed", authoritative: true });
    }
    return { data: { items, nextCursor: null }, providerReference: "approved-calendar", asOf: fixedNow().toISOString(), delaySeconds: 0, freshness: "fresh", metadataVersion: 1, capabilities: config().calendarPort.capabilities, demo: false };
  } };
  const fetch = async (_url, init) => {
    const params = new URLSearchParams(init.body), start = Date.parse(params.get("start")), end = Date.parse(params.get("end")), rows = [];
    for (let time = start; time < end && rows.length < 10_000; time += 60_000) rows.push(JSON.stringify({ ts_recv: new Date(time).toISOString(), open: "100", high: "101", low: "99", close: "100", volume: "1" }));
    return new Response(rows.join("\n"), { status: 200 });
  };
  const adapter = new DatabentoMarketDataAdapter(config({ calendarPort, fetch, now: () => new Date("2026-10-30T22:00:00.000Z") }));
  const truncated = await adapter.getBars(query);
  assert.deepEqual(truncated.data.items, []);
  assert.equal(truncated.data.nextCursor, "2026-10-29T13:30:00.000Z");
  const completed = await adapter.getBars({ ...query, cursor: truncated.data.nextCursor });
  assert.deepEqual(completed.data.items.map(x => x.time), ["2026-10-29T13:30:00.000Z", "2026-10-29T13:45:00.000Z"]);
  assert.equal(completed.data.nextCursor, null);
});

test("Databento CME all-session bars keep overnight trading and exclude outside-calendar hours", async () => {
  const futureId = "00000000-0000-4000-8000-000000000202";
  const futureMapping = { [futureId]: { assetClass: "future", rawSymbol: "ESZ26", metadataVersion: 1 } };
  const calendarPort = { getCalendar: async q => {
    const items = [];
    for (let time = Date.parse(`${q.from}T00:00:00.000Z`); time <= Date.parse(`${q.to}T00:00:00.000Z`); time += 86_400_000) {
      const date = new Date(time).toISOString().slice(0, 10), open = date === "2026-10-23";
      items.push({ tradingDate: date, open: open ? "2026-10-22T22:00:00.000Z" : `${date}T13:30:00.000Z`, close: open ? "2026-10-23T21:00:00.000Z" : `${date}T20:00:00.000Z`, timezone: "America/New_York", status: open ? "open" : "closed", authoritative: true });
    }
    return { data: { items, nextCursor: null }, providerReference: "approved-cme-calendar", asOf: fixedNow().toISOString(), delaySeconds: 0, freshness: "fresh", metadataVersion: 1, capabilities: config().calendarPort.capabilities, demo: false };
  } };
  const rows = ["2026-10-22T22:00:00.000Z", "2026-10-23T20:59:00.000Z", "2026-10-23T21:00:00.000Z", "2026-10-23T21:30:00.000Z"].map(ts_recv => JSON.stringify({ ts_recv, open: "5000", high: "5000.25", low: "4999.75", close: "5000", volume: "1" })).join("\n");
  const adapter = new DatabentoMarketDataAdapter(config({ instrumentMap: { ...config().instrumentMap, ...futureMapping }, calendarPort, now: () => new Date("2026-10-24T00:00:00.000Z"), fetch: async () => new Response(rows, { status: 200 }) }));
  const result = await adapter.getBars({ instrumentId: futureId, venue: "CME_GLOBEX", interval: "1m", from: "2026-10-22T22:00:00.000Z", to: "2026-10-23T22:00:00.000Z", session: "all" });
  assert.deepEqual(result.data.items.map(x => x.time), ["2026-10-22T22:00:00.000Z", "2026-10-23T20:59:00.000Z"]);
});
