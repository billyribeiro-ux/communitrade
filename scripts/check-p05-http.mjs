import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createRequire } from 'node:module';

const require = createRequire(new URL('../packages/contracts/package.json', import.meta.url));
const Ajv = require('ajv/dist/2020.js').default;
const addFormats = require('ajv-formats').default;
const contract = JSON.parse(await readFile(new URL('../contracts/openapi.json', import.meta.url), 'utf8'));
const ajv = new Ajv({ strict: false, allErrors: true });
addFormats(ajv);
ajv.addSchema({ ...contract, $id: 'p05-contract' });
const pointer = value => value.replaceAll('~', '~0').replaceAll('/', '~1');

// HTTP/SSR evidence only. This does not drive or replace a rendered browser.
const origin = process.env.WEB_TEST_ORIGIN ?? 'http://localhost:3000';
let checks = 0;
const seen = new Set();
async function request(path, expected = 200) {
  const response = await fetch(new URL(path, origin), { redirect: 'manual', signal: AbortSignal.timeout(30000) });
  assert.equal(response.status, expected, `${path}: expected ${expected}, received ${response.status}`);
  assert.match(response.headers.get('cache-control') ?? '', /no-store/, `${path}: uncached response`);
  const text = await response.text();
  assert.doesNotMatch(text, /PRIVATE_SENTINEL|CSRF_SENTINEL|DATABENTO_API_KEY|SESSION_SECRET|DATA_ENCRYPTION_KEY/, `${path}: no private configuration`);
  checks++;
  return { response, text };
}
async function api(path, expected = 200) {
  const result = await request(`/api/v1${path}`, expected);
  const value = JSON.parse(result.text);
  const pathname = new URL(path, origin).pathname;
  const template = Object.keys(contract.paths).find(route => route.split('/').length === pathname.split('/').length && route.split('/').every((part, index) => part.startsWith('{') || part === pathname.split('/')[index]));
  assert.ok(template && contract.paths[template].get, 'Endpoint exists in the canonical contract');
  const media = expected >= 400 ? 'application/problem+json' : 'application/json';
  const schemaPath = `p05-contract#/paths/${pointer(template)}/get/responses/${expected}/content/${pointer(media)}/schema`;
  const validate = ajv.compile({ $ref: schemaPath });
  assert.ok(validate(value), `${path}: response contract ${validate.errors?.map(error => `${error.instancePath} ${error.keyword}`).join(', ')}`);
  return value;
}
function meta(result) {
  if (Array.isArray(result.items) && !result.meta && !result.envelope) {
    for (const item of result.items) meta(item);
    return;
  }
  const value = result.meta ?? result.envelope;
  assert.ok(value, 'A source/freshness envelope is supplied');
  assert.equal(value.demo, true, 'Synthetic data is explicitly marked demo');
  assert.ok(value.provider || value.providerReference, 'The provider is identified');
  assert.ok(Number.isInteger(value.metadataVersion) && value.metadataVersion > 0, 'Metadata version is explicit');
  assert.ok(['fresh', 'stale', 'missing', 'unavailable'].includes(value.freshness), 'Canonical freshness state');
  assert.ok(value.capabilities && typeof value.capabilities.displayPublic === 'boolean', 'Explicit data-use rights');
  checks++;
}

let cursor;
do {
  const page = await api(`/instruments?limit=3${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ''}`);
  meta(page);
  for (const item of page.items) {
    assert.ok(!seen.has(item.id), 'Search pagination cannot duplicate an instrument');
    seen.add(item.id);
    assert.match(item.id, /^[0-9a-f-]{36}$/i, 'Stable UUID identity');
    assert.match(item.symbol, /^SYN-/, 'Fixture symbol is visibly synthetic');
  }
  cursor = page.nextCursor;
  assert.ok(seen.size < 200, 'Catalog pagination terminates within the bounded fixture');
} while (cursor);
assert.ok(seen.size >= 9, 'All baseline asset classes remain in the catalog');

for (const asset of ['stock', 'option', 'future']) {
  const page = await api(`/instruments?asset=${asset}&limit=50`);
  assert.ok(page.items.length, `${asset} reference catalog is populated`);
  assert.ok(page.items.every(item => item.asset === asset), `${asset} filter is honored`);
  meta(page);
}
const stockId = '00000000-0000-4000-8000-000000000201';
const detail = await api(`/instruments/${stockId}`);
meta(detail);
const chain = await api(`/instruments/${stockId}/option-contracts?limit=50`);
meta(chain);
assert.ok(chain.items.some(item => item.optionType === 'call'), 'Actual call contracts are available');
assert.ok(chain.items.some(item => item.optionType === 'put'), 'Actual put contracts are available');
assert.ok(chain.items.every(item => item.underlyingId === stockId && Number(item.multiplier) === 100), 'Standard contract identity and multiplier');
assert.ok(!Object.hasOwn(chain, 'greeks'), 'Missing Greeks are not invented');
for (const root of ['ES', 'MES', 'NQ', 'MNQ']) {
  const page = await api(`/futures-contracts?root=${root}&limit=50`);
  meta(page);
  assert.ok(page.items.length >= 2, `${root} has multiple actual contract months`);
  assert.ok(page.items.every(item => item.root === root && /^\d{4}-(03|06|09|12)$/.test(item.contractMonth)), `${root} always identifies a quarterly month`);
}
const futureId = '00000000-0000-4000-8000-000000000202';
const original = await api(`/instruments/${futureId}?metadataVersion=1`);
const corrected = await api(`/instruments/${futureId}`);
assert.equal(original.metadataVersion, 1, 'Historical metadata remains addressable');
assert.ok(corrected.metadataVersion > original.metadataVersion, 'Correction appends a version');
assert.equal(corrected.expiration, '2026-12-18T14:30:00.000Z', 'Corrected quarterly last-trade boundary');
assert.notEqual(original.expiration, corrected.expiration, 'Original reference snapshot was preserved');
const quote = await api(`/instruments/${stockId}/quote`);
meta(quote);
assert.ok(quote.bid === null || typeof quote.bid === 'string', 'Quotes preserve decimal strings or absence');
assert.ok(quote.ask === null || typeof quote.ask === 'string', 'Quotes preserve decimal strings or absence');
const barQuery = new URLSearchParams({ interval: '1m', from: '2026-10-20T13:30:00.000Z', to: '2026-10-20T13:34:00.000Z', session: 'regular', limit: '2' });
const firstBars = await api(`/instruments/${stockId}/bars?${barQuery}`);
meta(firstBars);
assert.equal(firstBars.bars.length, 2, 'Requested bar page size is honored');
assert.ok(firstBars.nextCursor, 'A truncated range has explicit continuation');
barQuery.set('cursor', firstBars.nextCursor);
const nextBars = await api(`/instruments/${stockId}/bars?${barQuery}`);
assert.equal(nextBars.bars.length, 2, 'Next bar page returns the rest of the range');
assert.notEqual(firstBars.bars.at(-1).time, nextBars.bars[0].time, 'Bar continuation cannot repeat the boundary');
const daily = await api(`/instruments/${stockId}/bars?${new URLSearchParams({ interval: '1d', from: '2026-10-12T00:00:00.000Z', to: '2026-10-17T00:00:00.000Z', session: 'regular' })}`);
assert.equal(daily.bars.length, 5, 'Daily equity history uses trading sessions');
const evening = await api(`/instruments/${futureId}/bars?${new URLSearchParams({ interval: '1h', from: '2026-10-19T22:00:00.000Z', to: '2026-10-20T00:00:00.000Z', session: 'exchange' })}`);
assert.equal(evening.bars.length, 2, 'Actual futures contract includes the evening reopen');
const calendar = await api('/market-data/calendar?venue=NYSE&from=2026-03-06&to=2026-03-09');
const sessions = calendar.items;
assert.equal(sessions.find(item => item.tradingDate === '2026-03-06').open, '2026-03-06T14:30:00.000Z');
assert.equal(sessions.find(item => item.tradingDate === '2026-03-09').open, '2026-03-09T13:30:00.000Z');

for (const path of [
  '/instruments?asset=crypto', '/instruments?limit=51', '/instruments?cursor=invalid',
  `/instruments/${stockId}?metadataVersion=0`, `/instruments/${stockId}/option-contracts?optionType=invalid`,
  '/futures-contracts?root=CL', '/futures-contracts?contractMonth=2026-11',
]) await api(path, 400);
await api('/instruments/00000000-0000-4000-8000-000000999999', 404);
for (const path of ['/admin/instruments', '/admin/data']) await api(path, 401);
const empty = await api('/instruments?q=no-such-synthetic-instrument');
assert.equal(empty.items.length, 0, 'Empty lookup is explicit');

for (const path of ['/instruments', '/instruments?asset=option', `/instruments/${stockId}`, `/instruments/${futureId}`]) {
  const { text } = await request(path);
  assert.match(text, /<h1/, `${path}: accessible page heading`);
  assert.match(text, /Demo data/i, `${path}: prominent synthetic label`);
}
for (const path of ['/app/explore', '/admin/instruments', '/admin/data']) {
  const { response } = await request(path, 307);
  assert.match(response.headers.get('location') ?? '', /^\/login\?returnTo=/, 'Private pages require identity');
}
console.log(`PASS ${checks} P05 HTTP/SSR checks; contract pagination, all asset classes, actual months, metadata history, demo labels and anonymous authorization. Rendered browser acceptance remains unverified.`);
