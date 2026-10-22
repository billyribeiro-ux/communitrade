import { test } from 'node:test';
import assert from 'node:assert/strict';
import { chartHistoryRange, chartInstrument, computeEMA, formatChartTime, normalizeRenderBars, validateBarResult } from '../src/lib/chart-data.ts';

const wireBar = (time, open = '10', high = '12', low = '9', close = '11', volume = '100') => ({ time, open, high, low, close, volume });
const expected = { instrumentId: 'stock-1', interval: '1m', session: 'regular', adjustment: 'unadjusted' };
const meta = {
  provider: 'Fixture Provider', asOf: '2026-10-20T15:00:00.000Z', delaySeconds: 900,
  freshness: 'fresh', demo: true, providerReference: 'fixture:bars:stock-1', metadataVersion: 1,
  capabilities: { displayPublic: false, displayMember: true, retainBars: true, retainSnapshot: false, exportImage: false, exportPersonalRecord: false, newPublishing: false },
};
const result = (bars, overrides = {}) => ({ ...expected, meta, bars, nextCursor: null, ...overrides });
const instrument = (overrides = {}) => ({
  id: 'stock-1', asset: 'stock', symbol: 'XYZ', name: 'XYZ Inc.', venue: 'XNYS', currency: 'USD',
  metadataVersion: 1, multiplier: '1', tickSize: '0.01', enabled: true, adjusted: false,
  session: 'regular', source: 'fixture', meta, availableMetadataVersions: [1], versions: [{ metadataVersion: 1, sourceId: null }], ...overrides,
});

test('normalizes UTC timestamps and finite canvas numbers while retaining untouched decimal source bars', () => {
  const source = wireBar('2026-10-20T14:59:00Z', '1234567890.1234567890', '1234567891', '1234567890', '1234567890.5', '0');
  const [bar] = normalizeRenderBars([source]);
  assert.equal(bar.time, Date.parse(source.time) / 1000);
  assert.equal(bar.original, source);
  assert.equal(bar.original.open, '1234567890.1234567890');
  assert.equal(Number.isFinite(bar.open), true);
  assert.deepEqual(normalizeRenderBars([]), []);
});

test('normalizes merged history spanning more than one 10,000-bar API page', () => {
  const start = Date.parse('2026-10-20T14:00:00Z');
  const merged = Array.from({ length: 10_001 }, (_, index) => wireBar(new Date(start + index * 60_000).toISOString()));
  assert.equal(normalizeRenderBars(merged).length, 10_001);
});

test('keeps legitimate negative futures prices and does not invent missing weekend or holiday candles', () => {
  const input = [wireBar('2026-10-16T20:00:00.000Z', '-2', '0', '-3', '-1', '4'), wireBar('2026-10-19T13:30:00.000Z', '-1', '1', '-2', '0', '8')];
  const bars = normalizeRenderBars(input);
  assert.equal(bars.length, 2);
  assert.equal(bars[0].low, -3);
  assert.equal(bars[1].time - bars[0].time, 65.5 * 60 * 60);
});

test('rejects malformed decimal, malformed timestamp, inconsistent OHLC, duplicates, and out-of-order bars', () => {
  assert.throws(() => normalizeRenderBars([wireBar('2026-10-20T14:59:00.000Z', 'NaN')]), /decimal/i);
  assert.throws(() => normalizeRenderBars([wireBar('2026-10-20 14:59:00')]), /UTC/i);
  assert.throws(() => normalizeRenderBars([wireBar('2026-02-30T14:59:00Z')]), /UTC/i);
  assert.throws(() => normalizeRenderBars([wireBar('2026-10-20T14:59:00.000Z', '10', '10', '9', '11')]), /OHLC/i);
  assert.throws(() => normalizeRenderBars([wireBar('2026-10-20T14:59:00.000Z'), wireBar('2026-10-20T14:59:00.000Z')]), /chronological/i);
  assert.throws(() => normalizeRenderBars([wireBar('2026-10-20T14:59:00.000Z'), wireBar('2026-10-20T14:58:00.000Z')]), /chronological/i);
});

test('compares wire OHLC decimals exactly before numeric conversion can collapse distinct prices', () => {
  const collapsed = wireBar('2026-10-20T14:59:00Z', '100000000000000000.00', '100000000000000000.00', '99999999999999999.99', '100000000000000000.01', '1');
  assert.throws(() => normalizeRenderBars([collapsed]), /OHLC/i);
  assert.throws(() => validateBarResult(result([collapsed]), expected, new Date('2026-10-20T15:00:00Z')), /Invalid or unavailable/);
});

test('keeps exact oversized volume available in validated source data but rejects unsafe canvas rendering', () => {
  const oversized = wireBar('2026-10-20T14:59:00Z', '10', '12', '9', '11', '10000000000000000');
  assert.equal(validateBarResult(result([oversized]), expected, new Date('2026-10-20T15:00:00Z')).bars[0].volume, '10000000000000000');
  assert.throws(() => normalizeRenderBars([oversized]), /exact numeric rendering range/i);
});

test('EMA starts at the SMA seed after a complete period, with no fabricated warmup values', () => {
  const bars = Array.from({ length: 22 }, (_, index) => ({ time: index + 1, open: 0, high: index + 1, low: index + 1, close: index + 1, volume: 1, original: null }));
  const ema = computeEMA(bars, 20);
  assert.equal(ema.length, 3);
  assert.deepEqual(ema[0], { time: 20, value: 10.5 });
  assert.equal(ema[1].value, 11.5);
  assert.equal(ema[2].time, 22);
  assert.deepEqual(computeEMA(bars.slice(0, 19), 20), []);
});

test('formats the two sides of DST in the requested timezone and displays daily labels without a time', () => {
  const before = formatChartTime(Date.parse('2026-11-01T05:30:00Z') / 1000, 'America/New_York');
  const after = formatChartTime(Date.parse('2026-11-01T06:30:00Z') / 1000, 'America/New_York');
  assert.match(before, /1:30 AM EDT/);
  assert.match(after, /1:30 AM EST/);
  assert.equal(formatChartTime(Date.parse('2026-10-20T14:30:00Z') / 1000, 'America/New_York', true), 'Oct 20, 2026');
  assert.throws(() => formatChartTime(1, 'Invalid/Zone'), RangeError);
});

test('history range uses 90 calendar days intraday and one calendar year daily across DST boundaries', () => {
  const now = new Date('2026-11-01T06:30:00.000Z');
  assert.deepEqual(chartHistoryRange('15m', now), { from: '2026-08-03T06:30:00.000Z', to: '2026-11-01T06:30:00.000Z' });
  assert.deepEqual(chartHistoryRange('1d', now), { from: '2025-11-01T06:30:00.000Z', to: '2026-11-01T06:30:00.000Z' });
});

test('options chart the exact available underlying and futures chart their actual listed contract', () => {
  const underlying = instrument({ id: 'underlying-1' });
  const option = instrument({ id: 'option-1', asset: 'option', underlyingId: 'underlying-1', expiration: '2026-12-18T21:00:00.000Z', optionType: 'call', strike: '100' });
  assert.equal(chartInstrument(option, underlying), underlying);
  assert.throws(() => chartInstrument(option), /underlying/i);
  assert.throws(() => chartInstrument(option, instrument({ id: 'other' })), /underlying/i);
  assert.throws(() => chartInstrument(option, instrument({ id: 'underlying-1', asset: 'future' })), /underlying/i);
  const future = instrument({ id: 'future-1', asset: 'future', root: 'ES', contractMonth: '2026-12' });
  assert.equal(chartInstrument(future), future);
  assert.throws(() => chartInstrument(instrument({ asset: 'future', root: 'ES' })), /dated/i);
  assert.equal(chartInstrument(instrument({ enabled: false })).enabled, false, 'disabled instruments may retain accessible historical charts');
});

test('validates source, rights, missingness, provenance, expected metadata and bounded chronological payloads', () => {
  const now = new Date('2026-10-20T15:00:00.000Z');
  const bars = [wireBar('2026-10-20T14:59:00.000Z', '-2', '0', '-3', '-1', '4')];
  assert.equal(validateBarResult(result(bars), { ...expected, audience: 'member', metadataVersion: 1, from: '2026-10-20T14:00:00.000Z', to: '2026-10-20T15:00:00.000Z' }, now).bars, bars);
  for (const bad of [
    result(bars, { instrumentId: 'other' }),
    result(bars, { interval: '1d' }),
    result(bars, { session: 'exchange' }),
    result(bars, { adjustment: 'split-adjusted' }),
    result(bars, { meta: { ...meta, freshness: 'missing' } }),
    result(bars, { meta: { ...meta, asOf: null } }),
    result(bars, { meta: { ...meta, provider: '' } }),
    result(bars, { meta: { ...meta, capabilities: { ...meta.capabilities, displayMember: false } } }),
    result(bars, { meta: { ...meta, capabilities: { ...meta.capabilities, retainBars: false } } }),
    result(bars, { meta: { ...meta, capabilities: { ...meta.capabilities, retainSnapshot: 'yes' } } }),
    result(bars, { meta: { ...meta, delaySeconds: 86_401 } }),
    result([wireBar('2026-10-20T15:10:00.000Z')]),
    result([wireBar('2026-10-20T14:59:00.000Z'), wireBar('2026-10-20T14:58:00.000Z')]),
    result([wireBar('2026-10-20T14:59:00.000Z', 'bad')]),
    result(Array.from({ length: 10_001 }, (_, index) => wireBar(new Date(Date.parse('2026-10-20T14:59:00Z') - (10_001 - index) * 60_000).toISOString()))),
  ]) assert.throws(() => validateBarResult(bad, { ...expected, from: '2026-10-20T14:00:00.000Z', to: '2026-10-20T15:00:00.000Z' }, now), /Invalid or unavailable/);
  assert.throws(() => validateBarResult(result(bars, { meta: { ...meta, capabilities: { ...meta.capabilities, displayPublic: false, displayMember: false } } }), expected, now), /Invalid or unavailable/);
  assert.throws(() => validateBarResult(result(bars), { ...expected, audience: 'public' }, now), /Invalid or unavailable/);
  assert.throws(() => validateBarResult(result(bars), { ...expected, metadataVersion: 2 }, now), /Invalid or unavailable/);
  assert.throws(() => validateBarResult(result(bars), { ...expected, from: '2026-10-20T15:00:00.000Z' }, now), /Invalid or unavailable/);
  assert.equal(validateBarResult(result(bars, { meta: { ...meta, freshness: 'stale' } }), expected, now).meta.freshness, 'stale');
  const unavailable = result([], { meta: { ...meta, asOf: null, freshness: 'unavailable' } });
  assert.equal(validateBarResult(unavailable, expected, now).meta.freshness, 'unavailable');
  assert.equal(validateBarResult(result([], { meta: { ...meta, asOf: null, freshness: 'missing' } }), expected, now).meta.freshness, 'missing');
  assert.throws(() => validateBarResult(result(bars, { meta: { ...meta, asOf: null, freshness: 'unavailable' } }), expected, now), /Invalid or unavailable/);
  assert.throws(() => validateBarResult(result([], { meta: { ...meta, asOf: null } }), expected, now), /Invalid or unavailable/);
  const secondPrecision = result([wireBar('2026-10-20T14:59:00Z')]);
  assert.equal(validateBarResult(secondPrecision, expected, now).bars.length, 1);
});
