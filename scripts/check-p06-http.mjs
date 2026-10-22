import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { chartHistoryRange, computeEMA, normalizeRenderBars, validateBarResult } from '../apps/web/src/lib/chart-data.ts';
import { loadChartHistory } from '../apps/web/src/lib/chart-history.ts';

const require = createRequire(new URL('../packages/contracts/package.json', import.meta.url));
const Ajv = require('ajv/dist/2020.js').default;
const addFormats = require('ajv-formats').default;
const contract = JSON.parse(await readFile(new URL('../contracts/openapi.json', import.meta.url), 'utf8'));
const ajv = new Ajv({ strict: false, allErrors: true });
addFormats(ajv);
ajv.addSchema({ ...contract, $id: 'p06-contract' });
const pointer = value => value.replaceAll('~', '~0').replaceAll('/', '~1');
const origin = process.env.WEB_TEST_ORIGIN ?? 'http://localhost:3000';
const stockId = '00000000-0000-4000-8000-000000000201';
const futureId = '00000000-0000-4000-8000-000000000202';
const optionId = '00000000-0000-4000-8000-000000000221';
let checks = 0;

async function api(path, expected = 200) {
  const response = await fetch(new URL(`/api/v1${path}`, origin), {
    redirect: 'manual',
    signal: AbortSignal.timeout(30000),
  });
  assert.equal(response.status, expected, `${path}: expected HTTP ${expected}, received ${response.status}`);
  assert.match(response.headers.get('cache-control') ?? '', /no-store/, `${path}: response is not cached`);
  const text = await response.text();
  assert.doesNotMatch(text, /PRIVATE_SENTINEL|CSRF_SENTINEL|DATABENTO_API_KEY|SESSION_SECRET|DATA_ENCRYPTION_KEY/, `${path}: private configuration is absent`);
  const value = JSON.parse(text);
  const pathname = new URL(path, origin).pathname;
  const template = Object.keys(contract.paths).find(route => route.split('/').length === pathname.split('/').length && route.split('/').every((part, index) => part.startsWith('{') || part === pathname.split('/')[index]));
  assert.ok(template && contract.paths[template].get, 'Bars endpoint exists in canonical OpenAPI');
  const media = expected >= 400 ? 'application/problem+json' : 'application/json';
  const schemaPath = `p06-contract#/paths/${pointer(template)}/get/responses/${expected}/content/${pointer(media)}/schema`;
  const validate = ajv.compile({ $ref: schemaPath });
  assert.ok(validate(value), `${path}: response contract ${validate.errors?.map(error => `${error.instancePath} ${error.keyword}`).join(', ')}`);
  checks++;
  return value;
}

async function page(path, snippets) {
  const response = await fetch(new URL(path, origin), { redirect: 'manual', signal: AbortSignal.timeout(30000) });
  assert.equal(response.status, 200, `${path}: public instrument page should render`);
  const html = await response.text();
  assert.match(html, /<h1/, `${path}: page has a rendered heading`);
  for (const snippet of snippets) assert.ok(html.includes(snippet), `${path}: server output contains ${snippet}`);
  assert.doesNotMatch(html, /DATABENTO_API_KEY|SESSION_SECRET|DATA_ENCRYPTION_KEY/, `${path}: private configuration is absent`);
  checks++;
}

function barsPath(id, interval, from, to, extras = {}) {
  const query = new URLSearchParams({ interval, from, to, ...extras });
  return `/instruments/${id}/bars?${query}`;
}

function assertBarPage(result, id, interval, session, maximum = 100) {
  assert.equal(result.instrumentId, id);
  assert.equal(result.interval, interval);
  assert.equal(result.session, session);
  assert.equal(result.adjustment, 'unadjusted');
  assert.ok(Array.isArray(result.bars) && result.bars.length <= maximum);
  assert.equal(result.meta.demo, true, 'Synthetic chart bars carry a demo provenance label');
  assert.equal(result.meta.capabilities.retainBars, true);
  assert.ok(['fresh', 'stale', 'missing', 'unavailable'].includes(result.meta.freshness));
  for (const bar of result.bars) {
    assert.ok(Number.isFinite(Date.parse(bar.time)) && bar.time.endsWith('Z'));
    for (const key of ['open', 'high', 'low', 'close', 'volume']) assert.equal(typeof bar[key], 'string');
  }
  checks++;
}

const intervalRanges = {
  '1m': ['2026-10-19T13:30:00.000Z', '2026-10-19T13:35:00.000Z'],
  '5m': ['2026-10-19T13:30:00.000Z', '2026-10-19T14:00:00.000Z'],
  '15m': ['2026-10-19T13:30:00.000Z', '2026-10-19T15:00:00.000Z'],
  '1h': ['2026-10-19T13:30:00.000Z', '2026-10-19T20:00:00.000Z'],
  '1d': ['2026-10-16T00:00:00.000Z', '2026-10-20T00:00:00.000Z'],
};

for (const [interval, [from, to]] of Object.entries(intervalRanges)) {
  const result = await api(barsPath(stockId, interval, from, to, { session: 'regular', limit: '100' }));
  assertBarPage(result, stockId, interval, 'regular');
  assert.ok(result.bars.length, `Stock ${interval} history is available for a synthetic trading session`);
  if (interval === '1h') {
    assert.equal(result.bars[0].time, from, 'Hourly stock bars anchor at the 09:30 ET session open');
    assert.equal(result.bars.at(-1).time, '2026-10-19T19:30:00.000Z', 'The final 30-minute regular-session bucket remains present');
    assert.equal(result.meta.asOf, '2026-10-19T20:00:00.000Z');
  }
  const localDates = result.bars.map(bar => new Intl.DateTimeFormat('en-CA', { timeZone: 'America/New_York', year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date(bar.time)));
  assert.ok(localDates.every(date => date >= '2026-10-16' && date <= '2026-10-19'), `${interval} candle timestamps map to their intended Eastern trading dates`);
}

for (const interval of Object.keys(intervalRanges)) {
  const [from, to] = interval === '1d'
    ? ['2026-10-18T00:00:00.000Z', '2026-10-20T22:00:00.000Z']
    : ['2026-10-19T22:00:00.000Z', '2026-10-20T02:00:00.000Z'];
  const result = await api(barsPath(futureId, interval, from, to, { session: 'exchange', limit: '100' }));
  assertBarPage(result, futureId, interval, 'exchange');
  assert.ok(result.bars.length, `Actual futures contract has ${interval} exchange-session bars`);
  if (interval === '1m') assert.ok(result.bars.some(bar => bar.time.startsWith('2026-10-19T22:')), 'Futures include the evening reopen');
}

const firstPage = await api(barsPath(stockId, '1m', '2026-10-19T13:30:00.000Z', '2026-10-19T13:35:00.000Z', { session: 'regular', limit: '2' }));
assertBarPage(firstPage, stockId, '1m', 'regular', 2);
assert.ok(firstPage.nextCursor, 'Truncated chart history has a continuation cursor');
const secondPage = await api(barsPath(stockId, '1m', '2026-10-19T13:30:00.000Z', '2026-10-19T13:35:00.000Z', { session: 'regular', limit: '2', cursor: firstPage.nextCursor }));
assertBarPage(secondPage, stockId, '1m', 'regular', 2);
assert.notEqual(firstPage.bars.at(-1).time, secondPage.bars[0].time, 'Bar pagination does not repeat a candle');
const largePage = await api(barsPath(stockId, '1m', '2026-10-19T13:30:00.000Z', '2026-10-19T13:35:00.000Z', { session: 'regular', limit: '10000' }));
assertBarPage(largePage, stockId, '1m', 'regular', 10_000);
assert.equal(largePage.bars.length, 5, 'A bounded large page returns the available bars without artificial truncation');

for (const date of ['2026-07-04', '2026-07-03']) {
  const result = await api(barsPath(stockId, '1m', `${date}T13:30:00.000Z`, `${date}T20:00:00.000Z`, { session: 'regular' }));
  assertBarPage(result, stockId, '1m', 'regular');
  assert.equal(result.bars.length, 0, `${date} weekend/holiday has no fabricated equity candles`);
}
for (const interval of ['1m', '5m', '15m']) {
  const result = await api(barsPath(stockId, interval, '2025-11-28T18:00:00.000Z', '2025-11-28T19:00:00.000Z', { session: 'regular' }));
  assertBarPage(result, stockId, interval, 'regular');
  assert.equal(result.bars.length, 0, `${interval} stock candles stop after the synthetic 13:00 ET early close`);
}
for (const interval of ['1m', '5m', '15m', '1h']) {
  const result = await api(barsPath(futureId, interval, '2026-07-02T22:00:00.000Z', '2026-07-03T02:00:00.000Z', { session: 'exchange' }));
  assertBarPage(result, futureId, interval, 'exchange');
  assert.equal(result.bars.length, 0, `${interval} futures candles respect the synthetic closed trading date`);
}

const dst = await api('/market-data/calendar?venue=NYSE&from=2026-03-06&to=2026-03-09');
assert.equal(dst.items.find(item => item.tradingDate === '2026-03-06')?.open, '2026-03-06T14:30:00.000Z');
assert.equal(dst.items.find(item => item.tradingDate === '2026-03-09')?.open, '2026-03-09T13:30:00.000Z');
checks++;

await page(`/instruments/${stockId}`, ['PRICE HISTORY', 'Price chart', 'Text price history']);
await page(`/instruments/${futureId}`, ['PRICE HISTORY', 'Listed ES contract', 'Exchange futures session']);
await page(`/instruments/${optionId}`, ['Underlying price chart', 'Option premiums and net spread prices are separate values']);

for (const path of [
  barsPath(stockId, '1m', '2026-10-19T13:30:00.000Z', '2026-10-19T13:31:00.000Z', { session: 'exchange' }),
  barsPath(futureId, '1m', '2026-10-19T13:30:00.000Z', '2026-10-19T13:31:00.000Z', { session: 'regular' }),
  barsPath(optionId, '1m', '2026-10-19T13:30:00.000Z', '2026-10-19T13:31:00.000Z'),
  barsPath(stockId, '1m', '2026-10-19T13:30:00.000Z', '2026-10-19T13:31:00.000Z', { adjustment: 'split_adjusted' }),
  barsPath(stockId, '1m', '2026-10-19T13:30:00.000Z', '2026-10-18T13:30:00.000Z'),
  barsPath(stockId, '1m', '2026-10-19T13:30:00.000Z', '2026-10-19T13:31:00.000Z', { limit: '10001' }),
  barsPath(stockId, '1m', '2026-10-19T13:30:00.000Z', '2026-10-19T13:31:00.000Z', { cursor: 'bad-cursor' }),
  barsPath(stockId, '1m', '2026-07-22T13:30:00.000Z', '2026-10-21T13:30:00.000Z'),
  barsPath(stockId, '1d', '2025-10-20T00:00:00.000Z', '2026-10-21T00:00:00.000Z'),
]) await api(path, 400);

console.log(`PASS ${checks} P06 HTTP checks: all intervals, futures exchange sessions, UTC bars/provenance, pagination, weekend/holiday gaps, DST and explicit unsupported-query errors. This script does not claim rendered browser acceptance.`);

// Exercise the actual client data loader over HTTP without launching a browser.
const reference = await api(`/instruments/${futureId}`);
const historyRequest = { instrumentId: futureId, metadataVersion: reference.metadataVersion, interval: '1m', session: 'exchange', adjustment: 'unadjusted', audience: 'public', ...chartHistoryRange('1m') };
let historyPages = 0;
const started = performance.now();
const history = await loadChartHistory(historyRequest, {
  signal: AbortSignal.timeout(120000),
  validate: validateBarResult,
  fetcher: async (path, init) => { historyPages++; return fetch(new URL(path, origin), init); },
});
assert.ok(historyPages > 1 && history.bars.length > 10000, 'The full 90-day 1m futures history crosses the 10,000-bar boundary');
assert.equal(history.nextCursor, null, 'The requested history finishes without hidden truncation');
const normalized = normalizeRenderBars(history.bars);
assert.equal(normalized.length, history.bars.length, 'Normalization preserves every observed bar');
assert.equal(computeEMA(normalized, 200).length, history.bars.length - 199, 'EMA warmup does not invent observations');
console.log(`PASS full 90-day synthetic 1m futures history: ${history.bars.length} bars, ${historyPages} pages, ${(performance.now() - started).toFixed(0)} ms for HTTP loading plus Node normalization/EMA. This is not a browser performance measurement.`);
