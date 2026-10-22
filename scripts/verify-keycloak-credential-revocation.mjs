import assert from 'node:assert/strict';
import { createHash, createHmac, randomUUID } from 'node:crypto';
import { driveKeycloakCredentialDeletion } from './lib/drive-keycloak-aia.mjs';
import { readFile } from 'node:fs/promises';
import { parseEnv } from 'node:util';
import { spawnSync } from 'node:child_process';

const env = { ...parseEnv(await readFile('.env.local', 'utf8')), ...process.env };
if (env.RELEASE_MODE !== 'local' || env.NODE_ENV === 'production') throw new Error('Credential revocation acceptance requires explicit local mode.');
const personas = JSON.parse(await readFile('.local/identity-personas.json', 'utf8'));
const person = personas.users?.admin;
if (!person?.providerId || !person?.otpSecret) throw new Error('Local synthetic administrator fixture is unavailable.');
const app = new URL(env.APP_ORIGIN ?? `http://localhost:${env.WEB_PORT ?? 3000}`).origin;
const issuer = env.OIDC_ISSUER;
if (!issuer) throw new Error('OIDC_ISSUER is required.');
const provider = new URL(issuer).origin;
const realm = new URL(issuer).pathname.split('/').at(-1);

class CookieJar {
  cookies = new Map();

  async request(url, options = {}) {
    const logical = new URL(url, app);
    if (![app, provider].includes(logical.origin)) throw new Error('Protocol check attempted an unexpected destination.');
    const headers = new Headers(options.headers);
    const attached = [...this.cookies.values()]
      .filter((cookie) => cookie.host === logical.hostname && logical.pathname.startsWith(cookie.path))
      .map((cookie) => `${cookie.name}=${cookie.value}`).join('; ');
    if (attached) headers.set('cookie', attached);
    if (logical.origin === app) headers.set('host', new URL(app).host);
    const response = await fetch(logical, { ...options, headers, redirect: 'manual', signal: AbortSignal.timeout(15000) });
    for (const raw of response.headers.getSetCookie()) {
      const [pair, ...attributes] = raw.split(';');
      const separator = pair.indexOf('=');
      const name = pair.slice(0, separator);
      const value = pair.slice(separator + 1);
      const path = attributes.find((item) => item.trim().toLowerCase().startsWith('path='))?.trim().slice(5) ?? '/';
      const key = `${logical.hostname}|${path}|${name}`;
      if (attributes.some((item) => /^\s*max-age=0\s*$/i.test(item))) this.cookies.delete(key);
      else this.cookies.set(key, { host: logical.hostname, path, name, value });
    }
    return { response, url: logical.href, text: await response.text() };
  }

  async follow(result) {
    for (let index = 0; index < 12; index++) {
      if (![302, 303, 307, 308].includes(result.response.status)) return result;
      const location = result.response.headers.get('location');
      if (!location) throw new Error('Provider redirect omitted its destination.');
      result = await this.request(new URL(location, result.url).href);
    }
    throw new Error('Provider redirect loop exceeded its bound.');
  }

  async api(path) {
    return this.request(`${app}/api/v1${path}`);
  }

  setApplicationSession(name, value) {
    const hostname = new URL(app).hostname;
    this.cookies.set(`${hostname}|/|${name}`, { host: hostname, path: '/', name, value });
  }
}

function totp(secret) {
  const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
  let value = 0; let bits = 0; const bytes = [];
  for (const letter of secret) { value = (value << 5) | alphabet.indexOf(letter); bits += 5; if (bits >= 8) { bytes.push((value >>> (bits - 8)) & 255); bits -= 8; } }
  const time = Buffer.alloc(8); time.writeBigUInt64BE(BigInt(Math.floor(Date.now() / 30000)));
  const hash = createHmac('sha1', Buffer.from(bytes)).update(time).digest();
  const offset = hash[19] & 15;
  return String((hash.readUInt32BE(offset) & 0x7fffffff) % 1000000).padStart(6, '0');
}

async function admin(path, method = 'GET', body) {
  const tokenResponse = await fetch(`${provider}/realms/master/protocol/openid-connect/token`, {
    method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ grant_type: 'password', client_id: 'admin-cli', username: env.KEYCLOAK_ADMIN, password: env.KEYCLOAK_ADMIN_PASSWORD }),
    signal: AbortSignal.timeout(10000),
  });
  if (!tokenResponse.ok) throw new Error('Local provider administrator authentication failed.');
  const token = (await tokenResponse.json()).access_token;
  const response = await fetch(`${provider}/admin/realms/${realm}${path}`, {
    method, headers: { authorization: `Bearer ${token}`, ...(body === undefined ? {} : { 'content-type': 'application/json' }) },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }), signal: AbortSignal.timeout(10000),
  });
  if (!response.ok) throw new Error(`Local provider fixture operation failed (${response.status}).`);
  return response.status === 204 ? null : response.json();
}

function createApplicationSessionFixtures() {
  const script = `
    import { createRequire } from 'node:module';
    import { randomUUID } from 'node:crypto';
    import { AuthService, authConfigFromEnv } from './apps/api/dist/auth/service.js';
    if (process.env.RELEASE_MODE !== 'local' || process.env.NODE_ENV === 'production') throw new Error('Fixture guard failed');
    const require = createRequire(new URL('./apps/api/package.json', import.meta.url));
    const { Pool } = require('pg');
    const pool = new Pool({ connectionString: process.env.DATABASE_URL });
    const identity = ${JSON.stringify({ issuer, subject: person.providerId, email: person.email })};
    try {
      const check = await pool.query('SELECT synthetic,status FROM user_account WHERE oidc_issuer=$1 AND oidc_subject=$2', [identity.issuer, identity.subject]);
      if (!check.rowCount || check.rows[0].synthetic !== true || check.rows[0].status !== 'active') throw new Error('Synthetic application user was not verified in SQL');
      const auth = new AuthService(pool, authConfigFromEnv());
      const sessions = [];
      for (let index=0; index<2; index++) {
        const cookie = await auth.createSession({ ...identity, emailVerified: true, sid: randomUUID() });
        sessions.push(cookie.token);
      }
      process.stdout.write(JSON.stringify({ cookieName: auth.config.cookieName, sessions }));
    } finally { await pool.end(); }
  `;
  const result = spawnSync('docker', ['compose', '--env-file', '.env.local', 'exec', '-T', 'api', 'node', '--input-type=module', '-e', script], {
    encoding: 'utf8', timeout: 30000,
  });
  if (result.status !== 0) throw new Error('Could not create verified synthetic app-session fixtures inside the API container.');
  try {
    const fixtures = JSON.parse(result.stdout);
    if (fixtures.sessions?.length !== 2 || typeof fixtures.cookieName !== 'string') throw new Error();
    return fixtures;
  } catch { throw new Error('API session-fixture helper returned invalid machine data.'); }
}

async function orphanApplicationSession(jar) {
  const cookieName = env.NODE_ENV === 'production' ? '__Host-tc_session' : 'tc_session_dev';
  const cookie = [...jar.cookies.values()].find((item) => item.name === cookieName);
  assert.ok(cookie, 'app session cookie must be available for orphan-SID setup');
  const tokenHash = createHash('sha256').update(cookie.value).digest('hex');
  const orphanSid = randomUUID();
  const sql = "UPDATE app_session SET provider_session_id = :'orphan_sid' WHERE token_hash = :'token_hash' AND revoked_at IS NULL;";
  const update = spawnSync('docker', [
    'compose', '--env-file', '.env.local', 'exec', '-T', 'postgres', 'psql',
    '-v', 'ON_ERROR_STOP=1', '-U', env.APP_DB_USER, '-d', env.APP_DB_NAME,
    '-v', `orphan_sid=${orphanSid}`, '-v', `token_hash=${tokenHash}`,
  ], { input: sql, encoding: 'utf8', timeout: 15000 });
  if (update.status !== 0 || !/UPDATE 1/.test(update.stdout)) throw new Error('Could not prepare the synthetic orphan provider session id.');
}

const deleteCredentialWithAia = (jar, credentialId) => driveKeycloakCredentialDeletion(jar, credentialId, { issuer, person, totp });

function docker(action) {
  const result = spawnSync('docker', ['compose', '--env-file', '.env.local', action, 'api'], { encoding: 'utf8', timeout: 30000 });
  if (result.status !== 0) throw new Error(`Could not ${action} the local API container.`);
}

async function waitForApi() {
  for (let attempt = 0; attempt < 40; attempt++) {
    try { const response = await fetch(`${app}/api/v1/health/live`, { signal: AbortSignal.timeout(1000) }); if (response.ok) return; } catch { /* API is still starting. */ }
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  throw new Error('Local API did not return after restart.');
}

async function waitForFreshTotpPeriod() {
  const remaining = 30_000 - (Date.now() % 30_000) + 1_000;
  await new Promise((resolve) => setTimeout(resolve, remaining));
}

const otpCredentials = async () => (await admin(`/users/${encodeURIComponent(person.providerId)}/credentials`)).filter((credential) => credential.type === 'otp');
let apiStopped = false;
try {
  await admin(`/attack-detection/brute-force/users/${encodeURIComponent(person.providerId)}`, 'DELETE');
  await admin(`/users/${encodeURIComponent(person.providerId)}/logout`, 'POST');
  assert.equal((await admin(`/users/${encodeURIComponent(person.providerId)}/sessions`)).length, 0, 'provider SSO must be empty for the subject-only event test');
  const noSsoFixtures = createApplicationSessionFixtures();
  const noSsoJars = [new CookieJar(), new CookieJar()];
  for (const [index, jar] of noSsoJars.entries()) jar.setApplicationSession(noSsoFixtures.cookieName, noSsoFixtures.sessions[index]);
  assert.equal((await noSsoJars[0].api('/me')).response.status, 200, 'synthetic app session must remain active without provider SSO');
  assert.equal((await noSsoJars[1].api('/me')).response.status, 200, 'second synthetic app session must remain active without provider SSO');

  // Admin password reset exercises the provider event when its user-session list is empty.
  await admin(`/users/${encodeURIComponent(person.providerId)}/reset-password`, 'PUT', { type: 'password', value: person.password, temporary: false });
  assert.equal((await admin(`/users/${encodeURIComponent(person.providerId)}/sessions`)).length, 0, 'admin password reset must not create a provider SSO session');
  assert.equal((await noSsoJars[0].api('/me')).response.status, 401, 'subject-only logout must revoke an app session with no provider session');
  assert.equal((await noSsoJars[1].api('/me')).response.status, 401, 'subject-only logout must revoke every app session with no provider session');
  assert.equal((await otpCredentials()).length, 1, 'the synthetic administrator OTP credential must remain for the account-console test');

  const appFixtures = createApplicationSessionFixtures();
  const first = new CookieJar();
  const second = new CookieJar();
  first.setApplicationSession(appFixtures.cookieName, appFixtures.sessions[0]);
  second.setApplicationSession(appFixtures.cookieName, appFixtures.sessions[1]);
  assert.equal((await first.api('/me')).response.status, 200);
  assert.equal((await second.api('/me')).response.status, 200);
  // Both provider SIDs are synthetic and intentionally have no matching Keycloak session.
  // The signed subject-wide logout must therefore revoke the app sessions independently.
  await orphanApplicationSession(first);

  let credentials = await otpCredentials();
  assert.equal(credentials.length, 1, 'exactly one synthetic OTP credential must exist');
  const credentialId = credentials[0].id;
  await waitForFreshTotpPeriod();
  docker('stop');
  apiStopped = true;
  const unavailable = await deleteCredentialWithAia(first, credentialId);
  docker('start');
  apiStopped = false;
  await waitForApi();
  // Health can precede the Keycloak container's refreshed DNS view of the API.
  // Let service discovery settle before testing the fail-closed event listener.
  await new Promise((resolve) => setTimeout(resolve, 15_000));
  // Keycloak can redirect to the account console even when a listener marks the
  // provider transaction rollback-only, so assert the persisted provider and app state.
  assert.equal(unavailable.confirmationSubmitted, true, 'offline result must follow an attempted credential-delete confirmation');
  credentials = await otpCredentials();
  assert.ok(credentials.some((credential) => credential.id === credentialId), 'OTP removal must roll back while the app backchannel is unavailable');
  assert.equal((await first.api('/me')).response.status, 200, 'current app session must remain valid after the rejected credential change');
  assert.equal((await second.api('/me')).response.status, 200, 'other app session must remain valid after the rejected credential change');

  let removed;
  for (let attempt = 0; attempt < 2; attempt++) {
    await waitForFreshTotpPeriod();
    removed = await deleteCredentialWithAia(first, credentialId);
    assert.equal(removed.confirmationSubmitted, true, 'online result must follow the credential-delete confirmation');
    if (removed.completed) break;
    if (attempt === 0) {
      const stillHasOtp = (await otpCredentials()).some((credential) => credential.id === credentialId);
      const currentSession = (await first.api('/me')).response.status === 200;
      const otherSession = (await second.api('/me')).response.status === 200;
      assert.ok(stillHasOtp && currentSession && otherSession,
        `online retry is permitted only while the OTP and both app sessions remain (HTTP ${removed.response.status})`);
      // Keycloak may have cached a temporary DNS failure or lost the event to a
      // startup race. Retry once with a new TOTP period, preserving both jars.
      await new Promise((resolve) => setTimeout(resolve, 15_000));
    }
  }
  assert.ok(removed?.completed, `account-console OTP removal should complete when backchannel is available (HTTP ${removed?.response.status ?? 'none'})`);
  credentials = await otpCredentials();
  assert.ok(!credentials.some((credential) => credential.id === credentialId), 'OTP credential must be removed after successful operation');
  assert.equal((await first.api('/me')).response.status, 401, 'current app session must be revoked');
  assert.equal((await second.api('/me')).response.status, 401, 'other app session must be revoked');
  console.log(`PASS subject-only admin reset revoked two app sessions with no provider SSO; account-console OTP removal revoked orphan-SID app sessions; API-unavailable attempt rolled back (HTTP ${unavailable.response.status}, action=${unavailable.actionStatus ?? 'none'}, error=${unavailable.oidcError ?? 'none'}).`);
} catch (error) {
  if (apiStopped) { try { docker('start'); await waitForApi(); } catch { console.error('The local API needs to be started manually.'); } }
  console.error(`FAIL Keycloak credential revocation acceptance: ${error instanceof Error ? error.message.replace(/https?:[^\s]+/g, '[url]').replace(/(?:[?&](?:code|state|token|session_state)=[^&\s]+)/gi, '[redacted]') : 'unknown failure'}`);
  process.exitCode = 1;
}
try { const result = spawnSync('node', ['scripts/seed-local-identity.mjs'], { encoding: 'utf8', timeout: 30000 }); if (result.status !== 0) throw new Error(); }
catch { console.error('Could not restore the local synthetic TOTP fixture; rerun `node scripts/seed-local-identity.mjs`.'); process.exitCode = 1; }
