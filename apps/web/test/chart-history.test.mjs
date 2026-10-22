import { test } from 'node:test';
import assert from 'node:assert/strict';
import { chartBarsPath, chartFailure, loadChartHistory } from '../src/lib/chart-history.ts';
import { validateBarResult } from '../src/lib/chart-data.ts';

const request = { instrumentId: '10000000-0000-4000-8000-000000000001', metadataVersion: 2, interval: '1m', session: 'regular', adjustment: 'unadjusted', audience: 'public', from: '2026-10-19T13:30:00.000Z', to: '2026-10-19T14:00:00.000Z' };
const caps = { displayPublic: true, displayMember: true, retainBars: true, retainSnapshot: false, exportImage: false, exportPersonalRecord: false, newPublishing: false };
function page(time, nextCursor = null) {
  return { instrumentId: request.instrumentId, interval: request.interval, session: request.session, adjustment: request.adjustment, bars: [{ time, open: '100.00000001', high: '101', low: '99', close: '100', volume: '120000' }], nextCursor, meta: { provider: 'synthetic', providerReference: 'Demo data: stock', metadataVersion: 2, delaySeconds: 900, demo: true, freshness: 'fresh', asOf: '2026-10-19T14:00:00.000Z', capabilities: { ...caps } } };
}
function fetchPages(pages, paths) {
  return async (path, options) => {
    paths.push(path);
    assert.equal(options.credentials, 'same-origin');
    assert.equal(options.cache, 'no-store');
    assert.equal(options.redirect, 'error');
    return Response.json(pages.shift());
  };
}
test('history request keeps real instrument/session identity and merges chronological pages without changing source decimals', async () => {
  const paths = [];
  const initial = page('2026-10-19T13:30:00.000Z', 'page+2');
  const result = await loadChartHistory(request, { signal: new AbortController().signal, validate: validateBarResult, initial, fetcher: fetchPages([page('2026-10-19T13:31:00.000Z')], paths) });
  assert.equal(result.bars.length, 2);
  assert.equal(result.bars[0].open, '100.00000001');
  assert.match(paths[0], /cursor=page%2B2/);
  assert.match(paths[0], /limit=10000/);
  assert.match(chartBarsPath(request), /session=regular/);
});
test('history rejects duplicate pages, pagination loops, permission changes and unavailable partial results', async () => {
  const first = page('2026-10-19T13:30:00.000Z', 'next');
  const duplicate = page('2026-10-19T13:30:00.000Z');
  await assert.rejects(loadChartHistory(request, { signal: new AbortController().signal, validate: validateBarResult, initial: first, fetcher: fetchPages([duplicate], []) }), /overlap/);
  const loop = page('2026-10-19T13:31:00.000Z', 'next');
  await assert.rejects(loadChartHistory(request, { signal: new AbortController().signal, validate: validateBarResult, initial: first, fetcher: fetchPages([loop], []) }), /did not advance/);
  const changed = page('2026-10-19T13:31:00.000Z');
  changed.meta.capabilities.exportImage = true;
  await assert.rejects(loadChartHistory(request, { signal: new AbortController().signal, validate: validateBarResult, initial: first, fetcher: fetchPages([changed], []) }), /permissions changed/);
  const unavailable = { ...changed, bars: [], meta: { ...first.meta, asOf: null, freshness: 'unavailable' } };
  await assert.rejects(loadChartHistory(request, { signal: new AbortController().signal, validate: validateBarResult, initial: first, fetcher: fetchPages([unavailable], []) }), /unavailable/);
});
test('an empty advancing transport page preserves gaps and the last observed source timestamp', async () => {
  const first = page('2026-10-19T13:30:00.000Z', 'empty');
  const empty = { ...page('2026-10-19T13:31:00.000Z'), bars: [], meta: { ...first.meta, asOf: null, freshness: 'missing' } };
  const result = await loadChartHistory(request, { signal: new AbortController().signal, validate: validateBarResult, initial: first, fetcher: fetchPages([empty], []) });
  assert.equal(result.bars.length, 1);
  assert.equal(result.meta.asOf, first.meta.asOf);
  assert.equal(result.meta.freshness, 'fresh');
  const before = { ...empty, nextCursor: 'resume' };
  const recovered = await loadChartHistory(request, { signal: new AbortController().signal, validate: validateBarResult, initial: before, fetcher: fetchPages([first, empty], []) });
  assert.equal(recovered.bars.length, 1);
});
test('route or interval cancellation aborts the in-flight request and never returns old history', async () => {
  const controller = new AbortController();
  let release;
  const started = new Promise(resolve => { release = resolve; });
  const pending = loadChartHistory(request, { signal: controller.signal, validate: validateBarResult, fetcher: async (_path, options) => {
    release();
    return new Promise((_resolve, reject) => { options.signal.addEventListener('abort', () => reject(options.signal.reason), { once: true }); });
  } });
  await started;
  controller.abort(new Error('Instrument changed'));
  await assert.rejects(pending, /Instrument changed/);
});
test('sparse supplier aggregation can continue beyond twenty transport pages while remaining bounded', async () => {
  const pages = Array.from({ length: 29 }, (_, index) => page(new Date(Date.parse(request.from) + index * 60000).toISOString(), index === 28 ? null : String(index + 1)));
  const paths = [];
  const result = await loadChartHistory(request, { signal: new AbortController().signal, validate: validateBarResult, fetcher: fetchPages(pages, paths) });
  assert.equal(paths.length, 29);
  assert.equal(result.bars.length, 29);
  assert.equal(result.nextCursor, null);
});
test('explicit empty history is retained while HTTP permissions and throttles expose safe retry messages', async () => {
  const empty = { ...page('2026-10-19T13:30:00.000Z'), bars: [], meta: { ...page('2026-10-19T13:30:00.000Z').meta, asOf: null, freshness: 'missing' } };
  assert.equal((await loadChartHistory(request, { signal: new AbortController().signal, validate: validateBarResult, initial: empty })).meta.freshness, 'missing');
  for (const status of [401, 403, 429, 503]) {
    await assert.rejects(loadChartHistory(request, { signal: new AbortController().signal, validate: validateBarResult, fetcher: async () => new Response('', { status }) }), { message: chartFailure(status) });
  }
});
