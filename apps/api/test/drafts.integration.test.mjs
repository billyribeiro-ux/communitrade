import assert from 'node:assert/strict';
import test from 'node:test';
import { createHash, randomUUID } from 'node:crypto';
import pg from 'pg';
import { createApp } from '../dist/app.js';
import { CommandError } from '../dist/http/problem.js';
import { DraftService } from '../dist/drafts/service.js';

const databaseUrl = process.env.TEST_DATABASE_URL;
const integration = { skip: databaseUrl ? false : 'Set TEST_DATABASE_URL for draft/chart PostgreSQL acceptance.' };
const ownerA = randomUUID();
const ownerB = randomUUID();
const seededOwner = '00000000-0000-4000-8000-000000000101';
const seededStockDraft = '00000000-0000-4000-8000-000000000701';
const stock = '00000000-0000-4000-8000-000000000201';
let providerBehavior = 'allow';
const providerPermissions = { displayPublic: true, displayMember: true, retainBars: true, retainSnapshot: true, exportImage: true, exportPersonalRecord: true, newPublishing: true };

test('PostgreSQL-owned drafts and chart documents enforce isolation, revisions, and linked plan levels', integration, async (t) => {
  const pool = new pg.Pool({ connectionString: databaseUrl, max: 8, connectionTimeoutMillis: 3000, query_timeout: 15000 });
  pool.on('error', () => {});
  const prefix = `p07-${randomUUID()}`;
  const createdIds = [];
  const idemKeys = [`${prefix}-create`, `${prefix}-create-race`];
  const deniedCapabilityId = randomUUID();
const deniedDisplayCapabilityId = randomUUID();
  const auth = {
    authenticate: async (req) => {
      const token = String(req.headers.cookie ?? '').split(';').map(part => part.trim()).find(part => part.startsWith('p07sid='))?.slice(7);
      if (token === 'seed-owner') return { userId: seededOwner, status: 'active', roles: [], emailVerified: true, onboarded: true };
      if (token === 'owner-a') return { userId: ownerA, status: 'active', roles: [], emailVerified: true, onboarded: true };
      if (token === 'owner-b') return { userId: ownerB, status: 'active', roles: ['admin'], emailVerified: true, onboarded: true };
      throw new CommandError(401, 'AUTHENTICATION_REQUIRED');
    },
    assertCsrf: async (req) => { if (req.headers.origin !== 'http://127.0.0.1' || req.headers['x-csrf-token'] !== 'p07-csrf') throw new CommandError(403, 'CSRF_REJECTED'); },
  };
  const provider = {
    getCapabilities: async (_instrumentId, _audience, purpose) => {
      if (providerBehavior === 'error') throw new Error('synthetic test provider unavailable');
      if (providerBehavior === 'deny-display' && purpose === 'display') return { data: { ...providerPermissions, displayMember: false } };
      if (providerBehavior === 'deny-chart' && purpose === 'chart') return { data: { ...providerPermissions, retainBars: false } };
      return { data: providerPermissions };
    },
  };
  const service = new DraftService(pool, provider);
  const app = await createApp({ $queryRaw: async () => [] }, null, { auth, drafts: service });
  try {
    for (const [id, subject] of [[ownerA, `${prefix}-a`], [ownerB, `${prefix}-b`]]) {
      await pool.query(`INSERT INTO user_account(id,oidc_issuer,oidc_subject,email,email_verified,status,onboarding_version,created_at,updated_at)
        VALUES($1,'https://p07.drafts.integration.invalid',$2,$3,true,'active','p07-integration',now(),now())`, [id, subject, `${subject}@example.invalid`]);
    }
    const reference = await pool.query("SELECT i.enabled,i.vendor,m.version FROM instrument i JOIN instrument_metadata_version m ON m.instrument_id=i.id AND m.version=(SELECT max(mx.version) FROM instrument_metadata_version mx WHERE mx.instrument_id=i.id) WHERE i.id=$1", [stock]);
    assert.equal(reference.rows[0]?.vendor, 'synthetic-fixture', 'P05 synthetic catalog seed must run first');
    assert.equal(reference.rows[0]?.enabled, true);
    await app.listen(0, '127.0.0.1');
    const base = `${await app.getUrl()}/api/v1`;
    async function request(path, { actor = 'owner-a', method = 'GET', body, headers = {} } = {}, expectedStatus = 200) {
      const h = new Headers(headers);
      h.set('Cookie', `p07sid=${actor}`);
      if (body !== undefined) h.set('Content-Type', 'application/json');
      if (['POST', 'PUT', 'PATCH', 'DELETE'].includes(method)) { h.set('Origin', 'http://127.0.0.1'); h.set('X-CSRF-Token', 'p07-csrf'); }
      const response = await fetch(`${base}${path}`, { method, headers: h, ...(body === undefined ? {} : { body: JSON.stringify(body) }), signal: AbortSignal.timeout(15000) });
      const text = await response.text();
      if (expectedStatus !== null) assert.equal(response.status, expectedStatus, `${method} ${path}: ${text.slice(0, 300)}`);
      return { response, body: text ? JSON.parse(text) : null };
    }

    await t.test('create is idempotent, owner-scoped and starts with an uninitialized chart', async () => {
      const seededChart = await request(`/drafts/${seededStockDraft}/chart`, { actor: 'seed-owner' });
      assert.ok(Number.isSafeInteger(seededChart.body.revision) && seededChart.body.revision >= 1, 'Existing seeded charts may retain founder edits and later revisions');
      assert.ok(Array.isArray(seededChart.body.state.drawings), 'The owned seeded chart remains readable without assuming its local edits');
      await request(`/drafts/${seededStockDraft}/chart`, { actor: 'owner-b' }, 404);
      const key = idemKeys[0];
      const body = { kind: 'trade', asset: 'option' };
      const first = await request('/drafts', { method: 'POST', body, headers: { 'Idempotency-Key': key } }, 201);
      createdIds.push(first.body.id);
      const replay = await request('/drafts', { method: 'POST', body, headers: { 'Idempotency-Key': key } }, 201);
      assert.deepEqual(replay.body, first.body);
      const raceKey = idemKeys[1];
      const race = await Promise.all([
        request('/drafts', { method: 'POST', body, headers: { 'Idempotency-Key': raceKey } }, 201),
        request('/drafts', { method: 'POST', body, headers: { 'Idempotency-Key': raceKey } }, 201),
      ]);
      assert.equal(race[0].body.id, race[1].body.id);
      createdIds.push(race[0].body.id);
      await request('/drafts', { method: 'POST', body: { ...body, asset: 'stock' }, headers: { 'Idempotency-Key': key } }, 409);
      await request(`/drafts/${first.body.id}/chart`, { actor: 'owner-b' }, 404);
      await request(`/drafts/${first.body.id}/chart`, {}, 404);
      const patched = await request(`/drafts/${first.body.id}`, { method: 'PATCH', headers: { 'If-Match': '"1"' }, body: { title: 'Option plan', plan: { instrumentId: stock, strategy: 'long_call', priceKind: 'option_premium', entryPrice: '2.50' } } });
      assert.equal(patched.body.revision, 2);
      assert.equal(patched.body.plan.instrumentId, stock);
    });

    await t.test('chart save serializes plan overlays and draft revisions atomically; stale racing saves conflict', async () => {
      const draft = { id: createdIds[0] };
      assert.ok(draft.id, 'draft from the prior scenario');
      const makeState = (drawings = []) => ({
        schemaVersion: 1, instrumentId: stock, metadataVersion: 1, interval: '1d', timezone: 'America/New_York', session: 'regular', adjustment: 'unadjusted',
        viewport: { from: '2026-09-21T13:30:00.000Z', to: '2026-10-20T20:00:00.000Z' }, indicators: [],
        provenance: { provider: 'synthetic-fixture', asOf: '2026-10-19T20:00:00.000Z', delaySeconds: 900, demo: true }, drawings,
      });
      const entry = { id: randomUUID(), type: 'entry', anchors: [{ time: '2026-10-01T13:30:00.000Z', price: '101.25' }], style: { color: '#16865d', lineWidth: 1, lineStyle: 'dashed', fillOpacity: 0 }, planField: 'entryUnderlying' };
      const target = { id: randomUUID(), type: 'target', anchors: [{ time: '2026-10-01T13:30:00.000Z', price: '108.00' }], style: { color: '#4678d4', lineWidth: 1, lineStyle: 'dashed', fillOpacity: 0 }, planField: 'targetUnderlying1' };
      const skippedTarget = { ...target, id: randomUUID(), planField: 'targetUnderlying3' };
      await request(`/drafts/${draft.id}/chart`, { method: 'PUT', headers: { 'If-Match': '"0"' }, body: makeState([skippedTarget]) }, 422);
      await request(`/drafts/${draft.id}/chart`, { method: 'PUT', headers: { 'If-Match': '"0"' }, body: { ...makeState(), indicators: [{ kind: 'ema', period: 20, color: '#123456' }, { kind: 'ema', period: 20, color: '#654321' }] } }, 422);
      const first = await request(`/drafts/${draft.id}/chart`, { method: 'PUT', headers: { 'If-Match': '"0"' }, body: makeState([entry, target]) });
      assert.equal(first.body.revision, 1);
      assert.equal(first.response.headers.get('etag'), '"1"');
      const savedDraft = await request(`/drafts/${draft.id}`);
      assert.equal(savedDraft.body.chartRevision, 1);
      assert.equal(savedDraft.body.plan.entryPrice, '2.50', 'option premium must not be overwritten by an underlying level');
      assert.deepEqual(savedDraft.body.plan.underlyingChartLevels, { entry: '101.25', targets: ['108.00'] });
      const roundTrip = await request(`/drafts/${draft.id}/chart`);
      assert.deepEqual(roundTrip.body.state.drawings, [entry, target]);

      await request(`/drafts/${draft.id}`, { method: 'PATCH', headers: { 'If-Match': `"${savedDraft.body.revision}"` }, body: { plan: { instrumentId: '00000000-0000-4000-8000-000000000202' } } }, 409);
      const afterRollback = await request(`/drafts/${draft.id}`);
      assert.equal(afterRollback.body.revision, savedDraft.body.revision);
      assert.equal(afterRollback.body.plan.instrumentId, stock, 'a failed instrument change rolls back plan and chart updates');

      const [left, right] = await Promise.all([
        request(`/drafts/${draft.id}/chart`, { method: 'PUT', headers: { 'If-Match': '"1"' }, body: makeState([entry]) }, null),
        request(`/drafts/${draft.id}/chart`, { method: 'PUT', headers: { 'If-Match': '"1"' }, body: makeState([target]) }, null),
      ]);
      assert.deepEqual([left.response.status, right.response.status].sort(), [200, 409]);
      const afterRace = await request(`/drafts/${draft.id}/chart`);
      assert.equal(afterRace.body.revision, 2);
      const current = (await pool.query('SELECT revision,chart_revision FROM draft WHERE id=$1', [draft.id])).rows[0];
      assert.equal(current.chart_revision, afterRace.body.revision);
      assert.equal(current.revision, savedDraft.body.revision + 1);
    });

    await t.test('the 50 object bound, linked level edits, rights checks, and lock state fail without partial writes', async () => {
      const draft = { id: createdIds[0] };
      const prior = await request(`/drafts/${draft.id}/chart`);
      const blank = (index) => ({ id: randomUUID(), type: 'trendline', anchors: [{ time: '2026-10-01T13:30:00.000Z', price: String(80 + index) }, { time: '2026-10-02T13:30:00.000Z', price: String(81 + index) }], style: { color: '#123abc', lineWidth: 2, lineStyle: 'solid', fillOpacity: 0.2 } });
      const fifty = Array.from({ length: 50 }, (_, index) => blank(index));
      const accepted = await request(`/drafts/${draft.id}/chart`, { method: 'PUT', headers: { 'If-Match': `"${prior.body.revision}"` }, body: { ...prior.body.state, drawings: fifty } });
      assert.equal(accepted.body.state.drawings.length, 50);
      await request(`/drafts/${draft.id}/chart`, { method: 'PUT', headers: { 'If-Match': `"${accepted.body.revision}"` }, body: { ...accepted.body.state, drawings: [...fifty, blank(50)] } }, 400);
      const draftAfterInvalid = await request(`/drafts/${draft.id}`);
      assert.equal(draftAfterInvalid.body.chartRevision, accepted.body.revision, 'invalid 51st drawing rolls back both revision clocks');

      const current = await request(`/drafts/${draft.id}/chart`);
      const fortyNine = await request(`/drafts/${draft.id}/chart`, { method: 'PUT', headers: { 'If-Match': `"${current.body.revision}"` }, body: { ...current.body.state, drawings: fifty.slice(0, 49) } });
      const draftBeforePlan = await request(`/drafts/${draft.id}`);
      const planSave = await request(`/drafts/${draft.id}`, { method: 'PATCH', headers: { 'If-Match': `"${draftBeforePlan.body.revision}"` }, body: { plan: { underlyingChartLevels: { invalidation: '95.00' } } } });
      assert.equal(planSave.body.chartRevision, fortyNine.body.revision + 1);
      const synced = await request(`/drafts/${draft.id}/chart`);
      assert.ok(synced.body.state.drawings.some(item => item.planField === 'invalidationUnderlying' && item.anchors[0].price === '95.00'));

      await pool.query("UPDATE draft SET plan=plan||'{\"locked\":true}'::jsonb WHERE id=$1", [draft.id]);
      const before = await request(`/drafts/${draft.id}/chart`);
      await request(`/drafts/${draft.id}/chart`, { method: 'PUT', headers: { 'If-Match': `"${before.body.revision}"` }, body: before.body.state }, 409);
      const still = await request(`/drafts/${draft.id}/chart`);
      assert.equal(still.body.revision, before.body.revision);

      await pool.query("UPDATE draft SET plan=plan-'locked' WHERE id=$1", [draft.id]);
      const rightsCheck = await request(`/drafts/${draft.id}/chart`);
      const draftBeforeProviderDenial = await request(`/drafts/${draft.id}`);
      providerBehavior = 'deny-display';
      await request(`/drafts/${draft.id}/chart`, { method: 'PUT', headers: { 'If-Match': `"${rightsCheck.body.revision}"` }, body: rightsCheck.body.state }, 403);
      providerBehavior = 'deny-chart';
      await request(`/drafts/${draft.id}/chart`, { method: 'PUT', headers: { 'If-Match': `"${rightsCheck.body.revision}"` }, body: rightsCheck.body.state }, 403);
      providerBehavior = 'error';
      await request(`/drafts/${draft.id}/chart`, { method: 'PUT', headers: { 'If-Match': `"${rightsCheck.body.revision}"` }, body: rightsCheck.body.state }, 503);
      providerBehavior = 'allow';
      const draftAfterProviderDenial = await request(`/drafts/${draft.id}`);
      assert.equal(draftAfterProviderDenial.body.revision, draftBeforeProviderDenial.body.revision, 'provider denial/failure rolls back the draft revision');
      assert.equal(draftAfterProviderDenial.body.chartRevision, rightsCheck.body.revision, 'provider denial/failure rolls back the chart revision');
      await pool.query(`INSERT INTO data_capability(id,supplier,agreement_id,dataset,audience,purpose,effective_at,flags)
        VALUES($1,'synthetic-fixture',$2,'stock','member','display',now(),$3::jsonb)`, [deniedDisplayCapabilityId, `${prefix}-display-denial`, JSON.stringify({ displayPublic: false, displayMember: false, retainBars: true, retainSnapshot: false, exportImage: false, exportPersonalRecord: false, newPublishing: false })]);
      await request(`/drafts/${draft.id}/chart`, { method: 'PUT', headers: { 'If-Match': `"${rightsCheck.body.revision}"` }, body: rightsCheck.body.state }, 403);
      await pool.query('DELETE FROM data_capability WHERE id=$1', [deniedDisplayCapabilityId]);
      await pool.query(`INSERT INTO data_capability(id,supplier,agreement_id,dataset,audience,purpose,effective_at,flags)
        VALUES($1,'synthetic-fixture',$2,'stock','member','chart',now(),$3::jsonb)`, [deniedCapabilityId, prefix, JSON.stringify({ displayPublic: false, displayMember: false, retainBars: false, retainSnapshot: false, exportImage: false, exportPersonalRecord: false, newPublishing: false })]);
      await request(`/drafts/${draft.id}/chart`, { method: 'PUT', headers: { 'If-Match': `"${rightsCheck.body.revision}"` }, body: rightsCheck.body.state }, 403);
      assert.equal((await request(`/drafts/${draft.id}/chart`)).body.revision, rightsCheck.body.revision, 'revoked rights block writes while saved owner state remains readable');
    });
  } finally {
    await app.close().catch(() => {});
    if (createdIds.length) {
      await pool.query('DELETE FROM chart_state WHERE draft_id=ANY($1::uuid[]) AND publication_version_id IS NULL', [createdIds]).catch(() => {});
      await pool.query('DELETE FROM draft WHERE id=ANY($1::uuid[])', [createdIds]).catch(() => {});
    }
    await pool.query('DELETE FROM idempotency_record WHERE actor_key=ANY($1::text[]) AND route=$2 AND key=ANY($3::text[])', [[ownerA, ownerB], 'POST /drafts', idemKeys]).catch(() => {});
    await pool.query('DELETE FROM data_capability WHERE id=$1', [deniedCapabilityId]).catch(() => {});
    await pool.query('DELETE FROM data_capability WHERE id=$1', [deniedDisplayCapabilityId]).catch(() => {});
    await pool.query('DELETE FROM rate_limit_bucket WHERE principal_hash=ANY($1::text[])', [[ownerA, ownerB].map(id => createHash('sha256').update(id).digest('hex'))]).catch(() => {});
    await pool.query('DELETE FROM user_account WHERE id=ANY($1::uuid[])', [[ownerA, ownerB]]).catch(() => {});
    await pool.end();
  }
});
