import assert from 'node:assert/strict';
import test from 'node:test';
import { spawnSync } from 'node:child_process';
import { ContractValidationError, validateRequest, validateChartState, createApiClient } from '../dist/index.js';

const uuid = '00000000-0000-4000-8000-000000000000';

test('numeric parameter coercion handles adversarial digit strings within a bounded child process', () => {
  const moduleUrl = new URL('../dist/runtime.js', import.meta.url).href;
  const result = spawnSync(process.execPath, ['--input-type=module', '-e', `
    import assert from 'node:assert/strict';
    import {coerce} from ${JSON.stringify(moduleUrl)};
    for (const [text, number] of [['0',0],['-12.25',-12.25],['.5',.5],['1.',1],['-.25',-.25]]) assert.equal(coerce(text,{type:'number'}),number);
    for (const text of ['1e2','--1','0'.repeat(100000)+'!']) assert.equal(coerce(text,{type:'number'}),text);
  `], {encoding:'utf8',timeout:2000});
  assert.equal(result.error, undefined, 'hostile numeric input must not exhaust the validation CPU budget');
  assert.equal(result.status, 0, result.stderr);
});

test('request schemas reject missing path values, malformed UUIDs and unknown fields', () => {
  assert.throws(() => validateRequest('getInstrument', {}), ContractValidationError);
  assert.throws(() => validateRequest('getInstrument', { path: { id: 'bad' } }), ContractValidationError);
  assert.throws(() => validateRequest('getInstrument', { path: { id: uuid, mystery: 'x' } }), ContractValidationError);
});

test('writes validate required concurrency and CSRF headers and reject unknown body properties', () => {
  const good = { path: { id: uuid }, headers: { 'If-Match': '"3"', 'X-CSRF-Token': 'token' }, body: { title: 'Draft' } };
  assert.equal(validateRequest('saveDraft', good), good);
  assert.throws(() => validateRequest('saveDraft', { ...good, headers: {} }), ContractValidationError);
  assert.throws(() => validateRequest('saveDraft', { ...good, body: { title: 'Draft', extra: true } }), ContractValidationError);
});

test('nullable values and decimal strings retain their intended representation', () => {
  const profile = { body: { avatarMediaId: null } };
  assert.equal(validateRequest('updateProfile', { ...profile, headers: { 'If-Match': '"1"', 'X-CSRF-Token': 'token' } }).body.avatarMediaId, null);
  assert.throws(() => validateRequest('updateProfile', { body: { avatarMediaId: 4 }, headers: { 'If-Match': '"1"', 'X-CSRF-Token': 'token' } }), ContractValidationError);
});

test('query validation enforces formats and bounds, including opaque decimal text', () => {
  const common = { path: { id: uuid }, query: { interval: '1d', from: '2026-01-01T00:00:00Z', to: '2026-01-02T00:00:00Z' } };
  assert.equal(validateRequest('getBars', common), common);
  assert.throws(() => validateRequest('getBars', { ...common, query: { ...common.query, from: 'yesterday', surprise: '1' } }), ContractValidationError);
});

test('chart state validates structural bounds and rejects unknown fields', () => {
  const chart = { schemaVersion: 1, instrumentId: uuid, metadataVersion: 1, interval: '1d', timezone: 'UTC', session: 'regular', adjustment: 'split-adjusted', viewport: { from: '2026-01-01T00:00:00Z', to: '2026-01-02T00:00:00Z' }, indicators: [], provenance: { provider: 'fixture', asOf: '2026-01-02T00:00:00Z', delaySeconds: 0, demo: true }, drawings: [] };
  assert.equal(validateChartState(chart), true);
  assert.equal(validateChartState({ ...chart, ignored: true }), false);
  assert.equal(validateChartState({ ...chart, drawings: Array.from({ length: 501 }, () => ({})) }), false);
});

test('typed client omits credentials for public reads and uses safe fetch defaults', async () => {
  let seen;
  const client = createApiClient({ fetch: async (url, init) => { seen = { url, init }; return new Response('{"id":"ok"}', { status: 200, headers: { 'content-type': 'application/json' } }); } });
  await client.request('getInstrument', { path: { id: uuid } });
  assert.equal(seen.url, `/api/v1/instruments/${uuid}`);
  assert.equal(seen.init.credentials, 'omit');
  assert.equal(seen.init.cache, 'no-store');
});

test('typed client attaches CSRF and same-origin credentials on private writes', async () => {
  let seen;
  const client = createApiClient({ csrfToken: () => 'csrf', fetch: async (_url, init) => { seen = init; return new Response('{"id":"ok"}', { status: 201, headers: { 'content-type': 'application/json' } }); } });
  await client.request('createDraft', { headers: { 'Idempotency-Key': '0123456789abcdef' }, body: { kind: 'trade' } });
  assert.equal(seen.credentials, 'same-origin');
  assert.equal(seen.cache, 'no-store');
  assert.equal(seen.headers.get('X-CSRF-Token'), 'csrf');
});

test('client preserves binary and form-encoded request transports and binary responses', async () => {
  let binaryRequest;
  const uploadClient = createApiClient({ fetch: async (_url, init) => { binaryRequest = init; return new Response(null, { status: 204 }); } });
  await uploadClient.request('uploadLocalBytes', { path: { id: uuid }, headers: { 'X-CSRF-Token': 'csrf' }, contentType: 'image/png', body: new Uint8Array([1, 2]) });
  assert.equal(binaryRequest.headers.get('Content-Type'), 'image/png');
  assert.equal(binaryRequest.body instanceof Uint8Array, true);

  let formRequest;
  const oidcClient = createApiClient({ fetch: async (_url, init) => { formRequest = init; return new Response(null, { status: 204 }); } });
  await oidcClient.request('oidcBackchannelLogout', { body: { logout_token: 'signed.jwt' } });
  assert.equal(formRequest.headers.get('Content-Type'), 'application/x-www-form-urlencoded');
  assert.equal(formRequest.body.toString(), 'logout_token=signed.jwt');

  const mediaClient = createApiClient({ fetch: async () => new Response(new Uint8Array([1, 2]), { status: 200, headers: { 'content-type': 'image/webp' } }) });
  const media = await mediaClient.request('getMediaContent', { path: { id: uuid } });
  assert.equal(media.data instanceof Blob, true);
});
