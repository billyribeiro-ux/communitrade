import { test } from 'node:test';
import assert from 'node:assert/strict';
import { authConfigFromEnv, AuthService } from '../dist/auth/service.js';
import { CommandError } from '../dist/http/problem.js';

const config = {
  issuer: 'http://auth.localhost:8080/realms/options-trade-ideas',
  clientId: 'trading-web',
  clientSecret: 'local-client-secret-that-is-never-in-the-browser',
  redirectUri: 'http://localhost:3000/api/v1/auth/callback',
  appOrigin: 'http://localhost:3000',
  sessionSecret: 'session-secret-that-is-at-least-thirty-two-characters-long',
  dataEncryptionKey: 'data-encryption-key-that-is-at-least-thirty-two-characters-long',
  cookieName: 'tc_session_dev',
  cookieSecure: false,
  providerAccountUrl: 'http://auth.localhost:8080/realms/options-trade-ideas/account',
  staffMaxSessionAgeSeconds: 8 * 60 * 60,
  memberMaxSessionAgeSeconds: 12 * 60 * 60,
  termsVersion: '2026-10-19.draft-1',
  mfaAssurance: '2',
};

test('CSRF requires both the exact configured origin and the session-bound token', async () => {
  const auth = new AuthService({ query: async () => ({ rows: [{ counter: 1 }], rowCount: 1 }) }, config);
  const actor = { userId: 'u1', sessionId: 's1', emailVerified: true, status: 'active', roles: ['member'], csrfToken: 'secret-csrf-value', onboarded: true };
  await auth.assertCsrf({ headers: { origin: config.appOrigin, 'x-csrf-token': actor.csrfToken } }, actor);
  for (const headers of [
    { origin: 'http://localhost:3000.evil.test', 'x-csrf-token': actor.csrfToken },
    { origin: 'null', 'x-csrf-token': actor.csrfToken },
    { origin: config.appOrigin, 'x-csrf-token': 'wrong' },
    { 'x-csrf-token': actor.csrfToken },
  ]) {
    await assert.rejects(auth.assertCsrf({ headers }, actor), (error) => error instanceof CommandError && error.status === 403 && error.code === 'CSRF_REJECTED');
  }
});

test('session cookie stays HttpOnly, host scoped, SameSite Lax, and local cookie is distinct from production', () => {
  const local = new AuthService({}, config);
  const cookie = local.cookieHeader('opaque-token', 3600);
  assert.match(cookie, /^tc_session_dev=opaque-token;/);
  assert.match(cookie, /Path=\//);
  assert.match(cookie, /HttpOnly/);
  assert.match(cookie, /SameSite=Lax/);
  assert.doesNotMatch(cookie, /; Secure/);
  assert.doesNotMatch(cookie, /Domain=/i);
  assert.match(local.cookieHeader(null), /Max-Age=0/);
  assert.throws(() => new AuthService({}, { ...config, cookieSecure: true }), /__Host-tc_session/);
  assert.throws(() => new AuthService({}, { ...config, cookieName: '__Host-tc_session', cookieSecure: true, issuer: 'http://auth.localhost:8080/realms/options-trade-ideas' }), /HTTPS/);
});

test('transaction cookie is short-lived and scoped only to auth callbacks', () => {
  const auth = new AuthService({}, config);
  const state = 'concurrent-state-example';
  const name = auth.transactionCookieName(state);
  const cookie = auth.transactionCookieHeader('binding-secret', state);
  assert.ok(cookie.startsWith(`${name}=binding-secret;`));
  assert.match(cookie, /Path=\/api\/v1\/auth/);
  assert.match(cookie, /HttpOnly/);
  assert.match(cookie, /SameSite=Lax/);
  assert.match(cookie, /Max-Age=600/);
  assert.match(auth.transactionCookieHeader(null, state), /Max-Age=0/);
  assert.notEqual(auth.transactionCookieName(state), auth.transactionCookieName('other-tab-state'));
});

test('production release flag enforces secure cookies, HTTPS endpoints, and non-draft policy version without NODE_ENV', () => {
  const env = {
    RELEASE_MODE: 'production',
    OIDC_ISSUER: 'https://identity.example.test/realms/community',
    OIDC_CLIENT_ID: 'trading-web',
    OIDC_CLIENT_SECRET: 'client-secret-with-more-than-thirty-two-characters',
    OIDC_REDIRECT_URI: 'https://community.example.test/api/v1/auth/callback',
    APP_ORIGIN: 'https://community.example.test',
    SESSION_SECRET: 'session-secret-with-more-than-thirty-two-characters',
    DATA_ENCRYPTION_KEY: 'encryption-key-with-more-than-thirty-two-characters',
    OIDC_ACCOUNT_URL: 'https://identity.example.test/realms/community/account',
    TERMS_VERSION: 'privacy-2026-10-20-v1',
  };
  const release = authConfigFromEnv(env);
  assert.equal(release.cookieSecure, true);
  assert.equal(release.cookieName, '__Host-tc_session');
  assert.throws(() => authConfigFromEnv({ ...env, OIDC_ISSUER: 'http://identity.example.test/realms/community', OIDC_ACCOUNT_URL: 'http://identity.example.test/realms/community/account' }), /HTTPS/);
  assert.throws(() => authConfigFromEnv({ ...env, TERMS_VERSION: '2026-10-19.draft-1' }), /non-draft/);
  const nodeProduction = authConfigFromEnv({ ...env, RELEASE_MODE: 'local', NODE_ENV: 'production' });
  assert.equal(nodeProduction.cookieSecure, true);
  assert.equal(nodeProduction.cookieName, '__Host-tc_session');
});
