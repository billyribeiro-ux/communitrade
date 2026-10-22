import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { Pool } from 'pg';
import { setTimeout as delay } from 'node:timers/promises';
import { AuthService, authConfigFromEnv } from '../dist/auth/service.js';

// End-to-end local synthetic acceptance. These sessions come from the real
// AuthService and are never printed. Seeded drafts are read-only in this test.
if (process.env.RELEASE_MODE !== 'local' || (process.env.MARKET_DATA_PROVIDER ?? 'synthetic') !== 'synthetic') throw new Error('P07 live checks require local synthetic mode.');
const pool = new Pool({ connectionString: process.env.DATABASE_URL, max: 4 });
const auth = new AuthService(pool, authConfigFromEnv());
const sessions = [];
const drafts = [];
const idempotencyKeys = [];
const persona101 = '00000000-0000-4000-8000-000000000101';
const persona102 = '00000000-0000-4000-8000-000000000102';
const administrator = '00000000-0000-4000-8000-000000000106';
const stock = '00000000-0000-4000-8000-000000000201';
const future = '00000000-0000-4000-8000-000000000202';
let stage = 'fixture setup';

async function session(id) {
  const row = (await pool.query('SELECT oidc_issuer,oidc_subject,email,email_verified,synthetic,status,onboarding_version FROM user_account WHERE id=$1', [id])).rows[0];
  assert.ok(row?.synthetic && row.status === 'active' && row.email_verified && row.onboarding_version, 'Only existing active, verified synthetic personas with completed onboarding are used');
  const value = await auth.createSession({ issuer: row.oidc_issuer, subject: row.oidc_subject, email: row.email, emailVerified: row.email_verified, sid: `p07-live-${randomUUID()}`, assurance: '1', authTime: Math.floor(Date.now() / 1000) }, undefined, false);
  sessions.push(createHash('sha256').update(value.token).digest('hex'));
  return value;
}

async function http(path, actor, init = {}, expected = 200) {
  const headers = new Headers(init.headers);
  if (actor) headers.set('Cookie', `${auth.config.cookieName}=${actor.token}`);
  if (init.body !== undefined) headers.set('Content-Type', 'application/json');
  const response = await fetch(`http://web:3000${path}`, { ...init, headers, redirect: 'manual', signal: AbortSignal.timeout(30000) });
  const text = await response.text();
  assert.equal(response.status, expected, `P07 ${stage}: HTTP ${response.status}, expected ${expected}`);
  assert.match(response.headers.get('cache-control') ?? '', /no-store/, 'Draft API and private SSR responses are not cached');
  return { response, text, json: () => JSON.parse(text) };
}

function writeHeaders(actor, extra = {}) {
  return { Origin: auth.config.appOrigin, 'X-CSRF-Token': actor.csrfToken, ...extra };
}

async function makeDraft(actor, asset, label) {
  const key = randomUUID();
  idempotencyKeys.push(key);
  const made = (await http('/api/v1/drafts', actor, { method: 'POST', headers: writeHeaders(actor, { 'Idempotency-Key': key }), body: JSON.stringify({ kind: 'trade', asset }) }, 201)).json();
  drafts.push(made.id);
  const instrumentId = asset === 'future' ? future : stock;
  const plan = { asset, instrumentId, ...(asset === 'option' ? { strategy: 'long_call', priceKind: 'option_premium', entryPrice: '2.50' } : {}) };
  const patched = await http(`/api/v1/drafts/${made.id}`, actor, { method: 'PATCH', headers: writeHeaders(actor, { 'If-Match': `"${made.revision}"` }), body: JSON.stringify({ title: label, plan }) });
  assert.equal(patched.json().plan.instrumentId, instrumentId);
  return { draft: patched.json(), instrumentId, asset };
}

async function chartState(actor, entryPrice) {
  const instrumentId = entryPrice === '6000.00' ? future : stock;
  const sessionName = instrumentId === future ? 'exchange' : 'regular';
  const now = new Date();
  const from = new Date(now.getTime() - 60 * 24 * 60 * 60 * 1000).toISOString();
  const to = now.toISOString();
  const params = new URLSearchParams({ interval: '1d', from, to, session: sessionName, limit: '10000' });
  const bars = (await http(`/api/v1/instruments/${instrumentId}/bars?${params}`, actor)).json();
  assert.ok(bars.bars.length > 0, 'The live member bar source supplies history for each selected family');
  assert.equal(bars.instrumentId, instrumentId);
  assert.equal(bars.meta.capabilities.retainBars, true);
  const first = bars.bars[0].time;
  const last = bars.bars.at(-1).time;
  return {
    schemaVersion: 1,
    instrumentId,
    metadataVersion: bars.meta.metadataVersion,
    interval: '1d',
    timezone: instrumentId === future ? 'America/Chicago' : 'America/New_York',
    session: sessionName,
    adjustment: 'unadjusted',
    viewport: { from: first, to: new Date(Date.parse(last) + 60_000).toISOString() },
    indicators: [],
    provenance: { provider: bars.meta.provider, asOf: bars.meta.asOf, delaySeconds: bars.meta.delaySeconds, demo: bars.meta.demo },
    drawings: [
      { id: randomUUID(), type: 'entry', anchors: [{ time: first, price: entryPrice }], style: { color: '#16865d', lineWidth: 1, lineStyle: 'dashed', fillOpacity: 0 }, planField: 'entryUnderlying' },
      ...['horizontal', 'trendline', 'rectangle', 'arrow', 'text', 'target', 'invalidation'].map(type => ({
        id: randomUUID(), type,
        anchors: ['trendline', 'rectangle', 'arrow'].includes(type) ? [{time: first, price: entryPrice}, {time: last, price: entryPrice}] : [{time: first, price: entryPrice}],
        style: {color: '#8AB4FF', lineWidth: 2, lineStyle: 'dotted', fillOpacity: 0.2},
        ...(type === 'text' ? {text: '<img src=x onerror=alert(1)>'} : {}),
        ...(type === 'target' ? {planField: 'targetUnderlying1'} : type === 'invalidation' ? {planField: 'invalidationUnderlying'} : {}),
      })),
    ],
  };
}

try {
  stage = 'local services ready';
  let ready = false;
  for (let attempt = 0; attempt < 30; attempt++) {
    try {
      const response = await fetch('http://web:3000/api/v1/health/ready', {signal: AbortSignal.timeout(2000)});
      if (response.ok) { ready = true; break; }
    } catch { /* A just-recreated development service can still be binding its port. */ }
    await delay(500);
  }
  assert.ok(ready, 'Local web proxy and API must be ready before acceptance sessions are created');
  stage = 'authenticated synthetic identities and insert-only seed read';
  const [owner, ownerSecondSession, otherOwner, admin] = await Promise.all([session(persona101), session(persona101), session(persona102), session(administrator)]);
  const seeds = [
    ['00000000-0000-4000-8000-000000000701', stock],
    ['00000000-0000-4000-8000-000000000702', stock],
    ['00000000-0000-4000-8000-000000000703', future],
  ];
  for (const [id, instrumentId] of seeds) {
    const saved = (await http(`/api/v1/drafts/${id}/chart`, owner)).json();
    assert.equal(saved.state.instrumentId, instrumentId);
    assert.match((await http(`/app/drafts/${id}`, owner)).text, /PRIVATE CHART DRAFT/);
  }
  assert.match((await http('/app/drafts', owner)).text, /Your drafts/);
  assert.match((await http('/app/publish', owner)).text, /Set up a draft/);
  assert.equal((await pool.query('SELECT id FROM role_grant WHERE user_id=$1 AND role=$2 LIMIT 1', [administrator, 'admin'])).rowCount, 1, 'The seed provides an administrator for the no-bypass check');
  await http(`/api/v1/drafts/00000000-0000-4000-8000-000000000701/chart`, otherOwner, {}, 404);
  await http(`/api/v1/drafts/00000000-0000-4000-8000-000000000701/chart`, admin, {}, 404);
  console.log('PASS owned seeded chart reads and editor SSR for stock, option-underlying, and dated futures; cross-owner read is hidden.');

  stage = 'create, CSRF and all-family chart initialization';
  await http('/api/v1/drafts', owner, { method: 'POST', headers: { Origin: auth.config.appOrigin, 'Idempotency-Key': randomUUID() }, body: JSON.stringify({ kind: 'trade', asset: 'stock' }) }, 403);
  for (const [asset, label, entry] of [['stock', 'P07 live stock', '100.00'], ['option', 'P07 live option underlying', '101.25'], ['future', 'P07 live futures', '6000.00']]) {
    const { draft, instrumentId } = await makeDraft(owner, asset, label);
    const state = await chartState(owner, entry);
    assert.equal(state.instrumentId, instrumentId);
    const saved = await http(`/api/v1/drafts/${draft.id}/chart`, owner, { method: 'PUT', headers: writeHeaders(owner, { 'If-Match': '"0"' }), body: JSON.stringify(state) });
    const doc = saved.json();
    assert.equal(saved.response.headers.get('ETag'), '"1"');
    assert.equal(doc.revision, 1);
    const roundtrip = (await http(`/api/v1/drafts/${draft.id}/chart`, ownerSecondSession)).json();
    assert.deepEqual(roundtrip, doc, 'A second session can reload the saved chart document');
    assert.equal(roundtrip.state.drawings.length, 8, 'All supported drawing families survive the actual HTTP persistence boundary');
    const draftAfterChart = (await http(`/api/v1/drafts/${draft.id}`, owner)).json();
    assert.equal(draftAfterChart.chartRevision, 1);
    assert.equal(draftAfterChart.plan.underlyingChartLevels.entry, entry);
    if (asset === 'option') assert.equal(draftAfterChart.plan.entryPrice, '2.50', 'Underlying chart levels do not overwrite option premium');
    const editorHtml = (await http(`/app/drafts/${draft.id}`, owner)).text;
    assert.match(editorHtml, /PRIVATE CHART DRAFT/);
    assert.ok(!editorHtml.includes('<img src=x onerror=alert(1)>'), 'Annotation text is not interpreted as an HTML element');
    if (asset === 'stock') {
      await http(`/api/v1/drafts/${draft.id}/chart`, otherOwner, {method: 'PUT', headers: writeHeaders(otherOwner, {'If-Match': '"1"'}), body: JSON.stringify(state)}, 404);
      await http(`/api/v1/drafts/${draft.id}/chart`, admin, {method: 'PUT', headers: writeHeaders(admin, {'If-Match': '"1"'}), body: JSON.stringify(state)}, 404);
      await http(`/api/v1/drafts/${draft.id}`, otherOwner, {method: 'PATCH', headers: writeHeaders(otherOwner, {'If-Match': '"3"'}), body: JSON.stringify({title: 'Not owned'})}, 404);
      const malformed = {...state, drawings: [{...state.drawings[0], style: {...state.drawings[0].style, color: 'url(https://example.invalid/tracker)'}}]};
      await http(`/api/v1/drafts/${draft.id}/chart`, owner, {method: 'PUT', headers: writeHeaders(owner, {'If-Match': '"1"'}), body: JSON.stringify(malformed)}, 400);
      await http(`/api/v1/drafts/${draft.id}/chart`, owner, {method: 'PUT', headers: writeHeaders(owner, {'If-Match': '"1"'}), body: JSON.stringify({...state, journalNotes: 'private journal must never enter chart state'})}, 400);
      await http(`/api/v1/drafts/${draft.id}/chart`, owner, {method: 'PUT', headers: writeHeaders(owner, {'If-Match': 'W/"1"'}), body: JSON.stringify(state)}, 400);
      await http(`/api/v1/drafts/${draft.id}/chart`, owner, {method: 'PUT', headers: writeHeaders(owner, {'If-Match': '"1"'}), body: JSON.stringify({...state, timezone: 'Invalid/Timezone'})}, 422);
      const wrong = { ...state, provenance: { ...state.provenance, provider: 'unverified-broker-feed' } };
      await http(`/api/v1/drafts/${draft.id}/chart`, owner, { method: 'PUT', headers: writeHeaders(owner, { 'If-Match': '"1"' }), body: JSON.stringify(wrong) }, 422);
      const changed = { ...state, drawings: [{ ...state.drawings[0], id: randomUUID(), anchors: [{ ...state.drawings[0].anchors[0], price: '103.50' }] }] };
      const advanced = await http(`/api/v1/drafts/${draft.id}/chart`, owner, { method: 'PUT', headers: writeHeaders(owner, { 'If-Match': '"1"' }), body: JSON.stringify(changed) });
      await http(`/api/v1/drafts/${draft.id}/chart`, ownerSecondSession, { method: 'PUT', headers: writeHeaders(ownerSecondSession, { 'If-Match': '"1"' }), body: JSON.stringify(state) }, 409);
      assert.equal((await http(`/api/v1/drafts/${draft.id}/chart`, ownerSecondSession)).json().revision, 2, 'Reload sees the winning concurrent-session save');
      assert.equal(advanced.json().revision, 2);
    }
  }
  console.log('PASS CSRF denial, stock/options/futures chart saves, reload, ETags, stale-session conflict, and premium isolation.');
} catch {
  console.error(`FAIL P07 live stage: ${stage}. Assertion or transport failure; credentials and response content omitted.`);
  process.exitCode = 1;
} finally {
  try {
    const ids = drafts;
    if (ids.length) {
      await pool.query('DELETE FROM chart_state WHERE draft_id=ANY($1::uuid[]) AND publication_version_id IS NULL', [ids]);
      await pool.query('DELETE FROM draft WHERE id=ANY($1::uuid[])', [ids]);
      await pool.query('DELETE FROM idempotency_record WHERE resource_id=ANY($1::uuid[])', [ids]);
      assert.equal((await pool.query('SELECT 1 FROM draft WHERE id=ANY($1::uuid[])', [ids])).rowCount, 0);
      assert.equal((await pool.query('SELECT 1 FROM chart_state WHERE draft_id=ANY($1::uuid[])', [ids])).rowCount, 0);
    }
    if (idempotencyKeys.length) {
      await pool.query('DELETE FROM idempotency_record WHERE route=$1 AND key=ANY($2::text[])', ['POST /drafts', idempotencyKeys]);
      assert.equal((await pool.query('SELECT 1 FROM idempotency_record WHERE route=$1 AND key=ANY($2::text[])', ['POST /drafts', idempotencyKeys])).rowCount, 0);
    }
    if (sessions.length) await pool.query('DELETE FROM app_session WHERE token_hash=ANY($1::text[])', [sessions]);
    assert.equal((await pool.query('SELECT 1 FROM app_session WHERE token_hash=ANY($1::text[])', [sessions])).rowCount, 0);
    console.log('PASS temporary P07 drafts, idempotency receipts, and sessions removed and verified; seeded records were not modified.');
  } catch {
    console.error('FAIL P07 fixture cleanup; inspect only the generated local acceptance draft/session records before rerunning.');
    process.exitCode = 1;
  } finally { await pool.end(); }
}
