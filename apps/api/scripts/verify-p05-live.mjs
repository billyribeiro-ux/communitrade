import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { Pool } from 'pg';
import { AuthService, authConfigFromEnv } from '../dist/auth/service.js';

// Disposable opaque session fixtures exercise the running API/web authorization
// boundary. Actual provider sign-in/MFA is independently covered by P04.
if (process.env.RELEASE_MODE !== 'local' || (process.env.MARKET_DATA_PROVIDER ?? 'synthetic') !== 'synthetic') throw new Error('P05 live acceptance requires local synthetic mode.');
const pool = new Pool({ connectionString: process.env.DATABASE_URL, max: 3 });
const auth = new AuthService(pool, authConfigFromEnv());
const sessions = [];
const capId = randomUUID();
const target = '00000000-0000-4000-8000-000000000201';
let originalEnabled;
let stage = 'synthetic fixture validation';
async function session(id, mfa = false) {
  const row = (await pool.query('SELECT oidc_issuer,oidc_subject,email,email_verified,synthetic,status FROM user_account WHERE id=$1', [id])).rows[0];
  assert.ok(row?.synthetic && row.status === 'active', 'Only existing active synthetic identities can be used');
  const value = await auth.createSession({ issuer: row.oidc_issuer, subject: row.oidc_subject, email: row.email, emailVerified: row.email_verified, sid: `p05-local-fixture-${randomUUID()}`, assurance: mfa ? '2' : '1', authTime: Math.floor(Date.now() / 1000) }, undefined, mfa);
  sessions.push(createHash('sha256').update(value.token).digest('hex'));
  return value;
}
async function http(path, actor, init = {}, expected = 200) {
  const headers = new Headers(init.headers);
  if (actor) headers.set('Cookie', `${auth.config.cookieName}=${actor.token}`);
  if (init.body) headers.set('Content-Type', 'application/json');
  const response = await fetch(`http://web:3000${path}`, { ...init, headers, redirect: 'manual', signal: AbortSignal.timeout(30000) });
  const text = await response.text();
  assert.equal(response.status, expected, `P05 ${stage}: HTTP ${response.status}, expected ${expected}`);
  assert.match(response.headers.get('cache-control') ?? '', /no-store/, 'Private and capability-dependent responses are not cached');
  return { response, text, json: () => JSON.parse(text) };
}
async function action(actor, verb, reason, key = randomUUID(), csrf = true, expected = 201) {
  return http(`/api/v1/admin/instruments/${target}/actions`, actor, { method: 'POST', headers: { Origin: auth.config.appOrigin, 'Idempotency-Key': key, ...(csrf ? { 'X-CSRF-Token': actor.csrfToken } : {}) }, body: JSON.stringify({ action: verb, reason }) }, expected);
}
try {
  const fixture = (await pool.query('SELECT vendor,enabled FROM instrument WHERE id=$1', [target])).rows[0];
  assert.equal(fixture?.vendor, 'synthetic-fixture');
  originalEnabled = fixture.enabled;
  const member = await session('00000000-0000-4000-8000-000000000101');
  const moderator = await session('00000000-0000-4000-8000-000000000105', true);
  const admin = await session('00000000-0000-4000-8000-000000000106', true);
  const staleAdmin = await session('00000000-0000-4000-8000-000000000106', true);
  await pool.query("UPDATE app_session SET mfa_at=now()-interval '6 minutes' WHERE token_hash=$1", [sessions.at(-1)]);
  stage = 'role and recent MFA boundaries';
  for (const actor of [member, moderator, staleAdmin]) await http('/api/v1/admin/instruments', actor, {}, 403);
  await http('/api/v1/admin/instruments', admin);
  const data = (await http('/api/v1/admin/data', admin)).json();
  assert.equal(data.productionReady, false, 'Synthetic data never closes procurement/release gates');
  await action(admin, 'disable', 'Synthetic P05 acceptance of CSRF denial.', randomUUID(), false, 403);
  console.log('PASS running API role, fresh MFA, CSRF and synthetic production-readiness boundaries.');

  stage = 'all six quote-derived option structures';
  for (const [strategy, ids] of [
    ['long_call', [221]], ['long_put', [223]],
    ['bull_call_debit', [221, 222]], ['bear_put_debit', [224, 223]],
    ['bull_put_credit', [224, 223]], ['bear_call_credit', [221, 222]],
  ]) {
    const credit = strategy.endsWith('credit');
    const body = { strategy, underlyingInstrumentId: target, optionContractIds: ids.map(id => `00000000-0000-4000-8000-000000000${id}`), quantity: 1, legs: ids.map((_, index) => ({ side: index === 0 ? (credit ? 'short' : 'long') : (credit ? 'long' : 'short'), quantity: 1 })) };
    const result = (await http('/api/v1/trade-plans/validate-strategy', member, { method: 'POST', headers: { Origin: auth.config.appOrigin, 'X-CSRF-Token': member.csrfToken }, body: JSON.stringify(body) })).json();
    assert.equal(result.valid, true, `Actual API quote-derived ${strategy} validates`);
    assert.equal(result.netKind, credit ? 'credit' : 'debit');
    assert.match(result.netPrice, /^\d+\.\d+$/, 'Net price is a decimal string');
  }
  console.log('PASS all six option structures using actual catalog IDs and provider bid/ask snapshots.');

  stage = 'idempotent disable and retained history';
  const key = randomUUID();
  const reason = 'Synthetic P05 acceptance: disable new publishing while preserving history.';
  const first = (await action(admin, 'disable', reason, key)).json();
  const replay = (await action(admin, 'disable', reason, key)).json();
  assert.deepEqual(replay, first, 'Same command returns the original audit receipt');
  await action(admin, 'enable', reason, key, true, 409);
  const audit = await pool.query('SELECT id FROM audit_event WHERE id=$1 AND actor=$2 AND resource_id=$3', [first.id, '00000000-0000-4000-8000-000000000106', target]);
  assert.equal(audit.rowCount, 1, 'Actual audit event persisted');
  const disabled = (await http(`/api/v1/instruments/${target}`, undefined)).json();
  assert.equal(disabled.enabled, false, 'Disabled state is visible without erasing reference history');
  await http(`/api/v1/instruments/${target}?metadataVersion=1`, undefined);
  const historyQuery = new URLSearchParams({ interval: '15m', from: '2026-10-19T13:30:00.000Z', to: '2026-10-19T14:30:00.000Z', session: 'regular' });
  const disabledHistory = (await http(`/api/v1/instruments/${target}/bars?${historyQuery}`, member)).json();
  assert.ok(disabledHistory.bars.length > 0, 'Disabled new publishing preserves permitted chart history');
  assert.match((await http(`/instruments/${target}`, member)).text, /Observed OHLC and volume/, 'Disabled reference keeps its permitted text chart history');
  const body = { strategy: 'bull_call_debit', underlyingInstrumentId: target, optionContractIds: ['00000000-0000-4000-8000-000000000221', '00000000-0000-4000-8000-000000000222'], quantity: 1, legs: [{ side: 'long', quantity: 1 }, { side: 'short', quantity: 1 }] };
  const validated = (await http('/api/v1/trade-plans/validate-strategy', member, { method: 'POST', headers: { Origin: auth.config.appOrigin, 'X-CSRF-Token': member.csrfToken }, body: JSON.stringify(body) })).json();
  assert.equal(validated.valid, false, 'Disabled underlying cannot validate new publication eligibility');
  await action(admin, 'enable', 'Synthetic P05 acceptance: restore the original reference availability.');
  console.log('PASS idempotent reasoned audit, disabled-publishing validation and retained metadata.');

  stage = 'independent public/member option display permissions';
  const flags = { displayPublic: false, displayMember: false, retainBars: false, retainSnapshot: false, exportImage: false, exportPersonalRecord: false, newPublishing: false };
  await pool.query("INSERT INTO data_capability(id,supplier,agreement_id,dataset,audience,purpose,effective_at,flags) VALUES($1,'synthetic-fixture','p05-live-local-denial','option','public','display',now(),$2::jsonb)", [capId, JSON.stringify(flags)]);
  await http('/api/v1/instruments/00000000-0000-4000-8000-000000000221/quote', undefined, {}, 403);
  await http('/api/v1/instruments/00000000-0000-4000-8000-000000000221/quote', member);
  await http(`/api/v1/instruments/${target}/quote`, undefined);
  await pool.query('DELETE FROM data_capability WHERE id=$1', [capId]);
  console.log('PASS public option-right restriction without blocking member or unrelated stock display.');

  stage = 'member and administrator server-rendered surfaces';
  for (const path of ['/app/explore']) assert.match((await http(path, member)).text, /Demo data/i);
  for (const path of ['/admin/instruments', '/admin/data']) assert.match((await http(path, admin)).text, /<h1/);
  console.log('PASS authenticated member and administrator SSR through the running web/API stack.');
} catch {
  console.error(`FAIL P05 live stage: ${stage}. Assertion or transport failure; credentials and responses omitted.`);
  process.exitCode = 1;
} finally {
  try {
    await pool.query('DELETE FROM data_capability WHERE id=$1', [capId]);
    if (typeof originalEnabled === 'boolean') await pool.query('UPDATE instrument SET enabled=$2 WHERE id=$1 AND vendor=\'synthetic-fixture\'', [target, originalEnabled]);
    if (sessions.length) await pool.query('DELETE FROM app_session WHERE token_hash=ANY($1::text[])', [sessions]);
    assert.equal((await pool.query('SELECT 1 FROM data_capability WHERE id=$1', [capId])).rowCount, 0);
    if (typeof originalEnabled === 'boolean') assert.equal((await pool.query('SELECT enabled FROM instrument WHERE id=$1', [target])).rows[0].enabled, originalEnabled);
    if (sessions.length) assert.equal((await pool.query('SELECT 1 FROM app_session WHERE token_hash=ANY($1::text[])', [sessions])).rowCount, 0);
    console.log('PASS temporary permission/session fixtures removed and original catalog enablement restored.');
  } catch {
    console.error('FAIL local P05 fixture cleanup; inspect the synthetic acceptance records before rerunning.');
    process.exitCode = 1;
  } finally { await pool.end(); }
}
