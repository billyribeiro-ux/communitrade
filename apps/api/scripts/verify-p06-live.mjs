import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { Pool } from 'pg';
import { AuthService, authConfigFromEnv } from '../dist/auth/service.js';

// Local opaque session fixture, not a new provider login/MFA acceptance claim.
if (process.env.RELEASE_MODE !== 'local' || (process.env.MARKET_DATA_PROVIDER ?? 'synthetic') !== 'synthetic') throw new Error('P06 live checks require local synthetic mode.');
const pool = new Pool({ connectionString: process.env.DATABASE_URL, max: 3 });
const auth = new AuthService(pool, authConfigFromEnv());
const capability = randomUUID();
const stock = '00000000-0000-4000-8000-000000000201';
const option = '00000000-0000-4000-8000-000000000221';
let tokenHash;
let stage = 'fixture setup';
async function request(path, actor, expected = 200) {
  const response = await fetch(`http://web:3000${path}`, { headers: actor ? { Cookie: `${auth.config.cookieName}=${actor.token}` } : {}, redirect: 'manual', signal: AbortSignal.timeout(30000) });
  assert.equal(response.status, expected, `P06 ${stage}: HTTP ${response.status}, expected ${expected}`);
  assert.match(response.headers.get('cache-control') ?? '', /no-store/);
  return response.text();
}
try {
  const row = (await pool.query('SELECT oidc_issuer,oidc_subject,email,email_verified,synthetic,status FROM user_account WHERE id=$1', ['00000000-0000-4000-8000-000000000101'])).rows[0];
  assert.ok(row?.synthetic && row.status === 'active' && row.email_verified);
  const member = await auth.createSession({ issuer: row.oidc_issuer, subject: row.oidc_subject, email: row.email, emailVerified: row.email_verified, sid: `p06-fixture-${randomUUID()}`, assurance: '1', authTime: Math.floor(Date.now() / 1000) }, undefined, false);
  tokenHash = createHash('sha256').update(member.token).digest('hex');
  const query = new URLSearchParams({ interval: '15m', from: '2026-10-19T13:30:00.000Z', to: '2026-10-19T14:30:00.000Z', session: 'regular', limit: '10000' });
  const bars = `/api/v1/instruments/${stock}/bars?${query}`;
  stage = 'member and anonymous chart snapshots';
  for (const actor of [undefined, member]) {
    const result = JSON.parse(await request(bars, actor));
    assert.equal(result.instrumentId, stock);
    assert.equal(result.meta.demo, true);
    assert.ok(result.bars.length > 0);
  }
  const optionHtml = await request(`/instruments/${option}`, member);
  assert.match(optionHtml, /Underlying price chart/);
  assert.match(optionHtml, /Text price history/);
  assert.match(optionHtml, /Observed OHLC and volume/);
  assert.match(optionHtml, /Demo data/);
  console.log('PASS anonymous/member bars and actual option-underlying SSR with exact text prices.');

  stage = 'independent public retention restriction';
  const flags = { displayPublic: true, displayMember: true, retainBars: false, retainSnapshot: true, exportImage: true, exportPersonalRecord: true, newPublishing: true };
  await pool.query("INSERT INTO data_capability(id,supplier,agreement_id,dataset,audience,purpose,effective_at,flags) VALUES($1,'synthetic-fixture','p06-live-local-denial','stock','public','chart',now(),$2::jsonb)", [capability, JSON.stringify(flags)]);
  await request(bars, undefined, 403);
  await request(bars, member);
  const deniedPublic = await request(`/instruments/${stock}`);
  assert.match(deniedPublic, /Chart unavailable/);
  assert.doesNotMatch(deniedPublic, /Observed OHLC and volume/);
  assert.match(await request(`/instruments/${stock}`, member), /Observed OHLC and volume/);
  console.log('PASS public retained-bar denial with independent member chart access and explicit public SSR failure.');

  stage = 'independent member restriction and session expiry';
  await pool.query("UPDATE data_capability SET audience='member' WHERE id=$1", [capability]);
  await request(bars);
  await request(bars, member, 403);
  assert.doesNotMatch(await request(`/instruments/${stock}`, member), /Observed OHLC and volume/);
  await pool.query('DELETE FROM data_capability WHERE id=$1', [capability]);
  await pool.query("UPDATE app_session SET expires_at=now()-interval '1 second' WHERE token_hash=$1", [tokenHash]);
  await request(bars, member, 401);
  console.log('PASS member-specific retained-bar denial and expired-session refusal without public fallback.');
} catch {
  console.error(`FAIL P06 live stage: ${stage}. Credentials and response content omitted.`);
  process.exitCode = 1;
} finally {
  try {
    await pool.query('DELETE FROM data_capability WHERE id=$1', [capability]);
    if (tokenHash) await pool.query('DELETE FROM app_session WHERE token_hash=$1', [tokenHash]);
    assert.equal((await pool.query('SELECT 1 FROM data_capability WHERE id=$1', [capability])).rowCount, 0);
    if (tokenHash) assert.equal((await pool.query('SELECT 1 FROM app_session WHERE token_hash=$1', [tokenHash])).rowCount, 0);
    console.log('PASS temporary P06 permission/session fixtures removed and verified.');
  } catch {
    console.error('FAIL P06 fixture cleanup; inspect synthetic acceptance records before rerunning.');
    process.exitCode = 1;
  } finally { await pool.end(); }
}
