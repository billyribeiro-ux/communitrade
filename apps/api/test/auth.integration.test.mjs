import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { createHash, createHmac, randomUUID } from 'node:crypto';
import { test } from 'node:test';
import { Pool } from 'pg';
import { exportJWK, generateKeyPair, SignJWT } from 'jose';
import { AuthService } from '../dist/auth/service.js';
import { CommandError } from '../dist/http/problem.js';
import { createApp } from '../dist/app.js';
import { readFile } from 'node:fs/promises';

const databaseUrl = process.env.TEST_DATABASE_URL;

test('PostgreSQL and fixture OIDC protocol: PKCE/state/nonce, opaque sessions, ownership, expiry, and signed backchannel logout', {
  skip: databaseUrl ? false : 'Set TEST_DATABASE_URL to run the auth integration test.',
  timeout: 30000,
}, async () => {
  const pool = new Pool({ connectionString: databaseUrl, max: 4 });
  const { publicKey, privateKey } = await generateKeyPair('RS256');
  const wrongKeyPair = await generateKeyPair('RS256');
  const key = { ...await exportJWK(publicKey), kid: 'p04-fixture-key', use: 'sig', alg: 'RS256' };
  const issuerState = { issuer: '', next: undefined, codes: new Map() };
  const server = createServer(async (request, response) => {
    const url = new URL(request.url ?? '/', issuerState.issuer);
    response.setHeader('content-type', 'application/json');
    if (request.method === 'GET' && url.pathname === `${new URL(issuerState.issuer).pathname}/.well-known/openid-configuration`) {
      response.end(JSON.stringify({
        issuer: issuerState.issuer,
        authorization_endpoint: `${issuerState.issuer}/protocol/auth`,
        token_endpoint: `${issuerState.issuer}/protocol/token`,
        userinfo_endpoint: `${issuerState.issuer}/protocol/userinfo`,
        jwks_uri: `${issuerState.issuer}/protocol/jwks`,
        response_types_supported: ['code'],
        subject_types_supported: ['public'],
        id_token_signing_alg_values_supported: ['RS256'],
        token_endpoint_auth_methods_supported: ['client_secret_post'],
        code_challenge_methods_supported: ['S256'],
        authorization_response_iss_parameter_supported: true,
      }));
      return;
    }
    if (request.method === 'GET' && url.pathname.endsWith('/protocol/jwks')) { response.end(JSON.stringify({ keys: [key] })); return; }
    if (request.method === 'POST' && url.pathname.endsWith('/protocol/token')) {
      let body = '';
      for await (const part of request) body += part;
      const form = new URLSearchParams(body);
      const code = form.get('code') ?? '';
      const expected = issuerState.codes.get(code);
      const verifier = form.get('code_verifier') ?? '';
      const challenge = Buffer.from(createHash('sha256').update(verifier).digest()).toString('base64url');
      if (form.get('client_id') !== 'fixture-client' || form.get('client_secret') !== 'fixture-secret' || !expected || expected.challenge !== challenge) {
        response.statusCode = 400; response.end(JSON.stringify({ error: 'invalid_grant' })); return;
      }
      const claims = issuerState.next ?? {};
      issuerState.next = undefined;
      const idToken = await new SignJWT({
        sub: claims.sub ?? `fixture-${randomUUID()}`,
        email: claims.email ?? `${randomUUID()}@example.test`,
        email_verified: claims.emailVerified ?? true,
        nonce: claims.nonce ?? expected.nonce,
        sid: claims.sid ?? `sid-${randomUUID()}`,
        auth_time: claims.authTime ?? Math.floor(Date.now() / 1000),
        acr: claims.acr ?? '1',
      }).setProtectedHeader({ alg: 'RS256', kid: 'p04-fixture-key' })
        .setIssuer(claims.issuer ?? issuerState.issuer)
        .setAudience(claims.audience ?? 'fixture-client')
        .setIssuedAt(claims.iat ?? Math.floor(Date.now() / 1000))
        .setExpirationTime(claims.exp ?? Math.floor(Date.now() / 1000) + 120)
        .sign(privateKey);
      response.end(JSON.stringify({ access_token: 'fixture-access-token', token_type: 'Bearer', expires_in: 120, id_token: idToken }));
      return;
    }
    if (request.method === 'GET' && url.pathname.endsWith('/protocol/userinfo')) { response.end('{}'); return; }
    response.statusCode = 404; response.end(JSON.stringify({ error: 'not_found' }));
  });

  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  const issuer = `http://127.0.0.1:${address.port}/realms/p04-test`;
  issuerState.issuer = issuer;
  const config = {
    issuer, clientId: 'fixture-client', clientSecret: 'fixture-secret',
    redirectUri: 'http://localhost:3000/api/v1/auth/callback', appOrigin: 'http://localhost:3000',
    sessionSecret: 'session-secret-for-auth-integration-tests-only-123456789',
    dataEncryptionKey: 'transaction-encryption-key-for-auth-integration-tests-123456789',
    cookieName: 'tc_session_dev', cookieSecure: false,
    providerAccountUrl: issuer + '/account', staffMaxSessionAgeSeconds: 8 * 60 * 60,
    memberMaxSessionAgeSeconds: 12 * 60 * 60, termsVersion: 'test-policy', mfaAssurance: '2',
  };
  const auth = new AuthService(pool, config);
  const usedStates = [];
  const userIds = [];
  const logins = [];
  let app;

  async function signLogout(overrides = {}) {
    const sid = Object.hasOwn(overrides, 'sid') ? overrides.sid : 'fixture-backchannel-sid';
    return new SignJWT({
      ...(sid ? { sid } : {}),
      events: overrides.events ?? { 'http://schemas.openid.net/event/backchannel-logout': {} },
      jti: overrides.jti ?? `p04-${randomUUID()}`,
      ...(overrides.nonce ? { nonce: overrides.nonce } : {}),
      ...(overrides.sub ? { sub: overrides.sub } : {}),
    }).setProtectedHeader({ alg: 'RS256', kid: 'p04-fixture-key' })
      .setIssuer(overrides.issuer ?? issuer).setAudience(overrides.audience ?? config.clientId)
      .setIssuedAt().setExpirationTime('2m').sign(overrides.signer ?? privateKey);
  }

  async function issueLogin({ claims = {}, addressKey = randomUUID(), screen, intent, returnTo } = {}) {
    const start = await auth.beginLogin({ address: `test-${addressKey}`, ...(screen ? { screen } : {}), ...(intent ? { intent } : {}), ...(returnTo ? { returnTo } : {}) });
    const authorize = new URL(start.location);
    assert.equal(authorize.searchParams.get('state'), start.state);
    const code = `fixture-code-${randomUUID()}`;
    issuerState.codes.set(code, { challenge: authorize.searchParams.get('code_challenge'), nonce: authorize.searchParams.get('nonce') });
    issuerState.next = claims;
    const callback = new URL(config.redirectUri);
    callback.searchParams.set('code', code);
    callback.searchParams.set('state', start.state);
    callback.searchParams.set('iss', issuer);
    callback.searchParams.set('session_state', 'fixture-session-state');
    usedStates.push(start.state);
    const result = await auth.completeLogin(code, start.state, start.transactionCookie, callback.href);
    userIds.push(result.identity.subject);
    logins.push(result);
    return result;
  }

  try {
    const ordinary = await issueLogin({ claims: { sub: `member-${randomUUID()}`, sid: `sid-${randomUUID()}` } });
    assert.equal(ordinary.identity.emailVerified, true);
    assert.equal(ordinary.stepUp, false);
    const tokenHashRows = await pool.query('SELECT token_hash FROM app_session WHERE token_hash=$1', [createHash('sha256').update(ordinary.cookie.token).digest('hex')]);
    assert.equal(tokenHashRows.rowCount, 1);
    assert.notEqual(tokenHashRows.rows[0].token_hash, ordinary.cookie.token);
    const actorA = await auth.authenticate({ headers: { cookie: `${config.cookieName}=${ordinary.cookie.token}` } });
    assert.equal(actorA.emailVerified, true);

    await assert.rejects(auth.completeLogin('no-code', 'wrong-state', ordinary.cookie.token), (error) => error instanceof CommandError && error.status === 400);
    const unverified = await issueLogin({ claims: { sub: `unverified-${randomUUID()}`, emailVerified: false } });
    const unverifiedActor = await auth.authenticate({ headers: { cookie: `${config.cookieName}=${unverified.cookie.token}` } });
    await assert.rejects(auth.authenticate({ headers: { cookie: `${config.cookieName}=${unverified.cookie.token}` } }, { verified: true }), (error) => error instanceof CommandError && error.status === 403 && error.code === 'EMAIL_VERIFICATION_REQUIRED');
    assert.equal(unverifiedActor.emailVerified, false);

    const actorBLogin = await issueLogin({ claims: { sub: `member-${randomUUID()}` } });
    const actorB = await auth.authenticate({ headers: { cookie: `${config.cookieName}=${actorBLogin.cookie.token}` } });
    const actorBSession = (await auth.listSessions(actorB)).items[0];
    await assert.rejects(auth.revokeSession(actorA, actorBSession.id), (error) => error instanceof CommandError && error.status === 404);

    app = await createApp({}, null, { auth });
    await app.listen(0, '127.0.0.1');
    const apiOrigin = await app.getUrl();
    const unauthenticated = await fetch(`${apiOrigin}/api/v1/me`);
    assert.equal(unauthenticated.status, 401);
    const missingCsrf = await fetch(`${apiOrigin}/api/v1/auth/logout`, { method: 'POST', headers: { cookie: `${config.cookieName}=${ordinary.cookie.token}` } });
    assert.equal(missingCsrf.status, 403);
    const meResponse = await fetch(`${apiOrigin}/api/v1/me`, { headers: { cookie: `${config.cookieName}=${ordinary.cookie.token}` } });
    assert.equal(meResponse.status, 200);
    const me = await meResponse.json();
    const contract = JSON.parse(await readFile(new URL('../../../contracts/openapi.json', import.meta.url), 'utf8'));
    const schemas = contract.components.schemas;
    assert.deepEqual(Object.keys(me).sort(), Object.keys(schemas.Me.properties).sort());
    assert.ok(schemas.UserSummary.required.every(key=>Object.hasOwn(me.user,key)));
    assert.ok(Object.keys(me.user).every(key=>Object.hasOwn(schemas.UserSummary.properties,key)),'User cards expose only declared public fields.');
    if(me.user.bio!==undefined)assert.ok(typeof me.user.bio==='string'&&me.user.bio.length<=500);
    assert.deepEqual(Object.keys(me.entitlement).sort(), Object.keys(schemas.Entitlement.properties).sort());
    assert.deepEqual(Object.keys(me.entitlement.limits).sort(), Object.keys(schemas.Limits.properties).sort());
    assert.equal(me.onboarded, false);
    assert.deepEqual(me.roles, ['member']);
    assert.equal(me.entitlement.plan, 'free');
    assert.equal(me.entitlement.status, 'free');
    assert.equal(me.entitlement.limits.watchlists, 1);
    assert.equal(me.entitlement.limits.itemsPerWatchlist, 25);
    assert.equal(me.entitlement.limits.savedLayouts, 1);
    assert.equal(me.entitlement.limits.newJournalEntriesPerMonth, 30);
    assert.deepEqual(me.security, { mfaVerified: false, mfaRecent: false });
    const unauthorizedDelete = await fetch(`${apiOrigin}/api/v1/me/sessions/${actorBSession.id}`, {
      method: 'DELETE', headers: { cookie: `${config.cookieName}=${ordinary.cookie.token}`, origin: config.appOrigin, 'x-csrf-token': me.csrfToken },
    });
    assert.equal(unauthorizedDelete.status, 404);

    const onboardingResponse = await fetch(`${apiOrigin}/api/v1/me/onboarding`, {
      method: 'POST', headers: { cookie: `${config.cookieName}=${ordinary.cookie.token}`, origin: config.appOrigin, 'x-csrf-token': me.csrfToken, 'content-type': 'application/json' },
      body: JSON.stringify({ handle: `auth_${randomUUID().replaceAll('-','').slice(0,10)}`, displayName: 'Auth Test Member', experience: 'beginner', interests: ['stock'], timezone: 'UTC', termsVersion: config.termsVersion, adultUSDeclaration: true }),
    });
    assert.equal(onboardingResponse.status, 201, await onboardingResponse.clone().text());
    const onboardedMe = await onboardingResponse.json();
    assert.equal(onboardedMe.onboarded, true);
    assert.deepEqual(onboardedMe.roles, ['member']);
    const preferencesResponse = await fetch(`${apiOrigin}/api/v1/me/preferences`, { headers: { cookie: `${config.cookieName}=${ordinary.cookie.token}` } });
    assert.equal(preferencesResponse.status, 200);
    const preferences = await preferencesResponse.json();
    const preferenceSchema = schemas.Preference;
    assert.deepEqual(Object.keys(preferences).sort(), Object.keys(preferenceSchema.properties).sort());
    assert.equal(preferences.digestEnabled, false);
    const invalidPreferences = await fetch(`${apiOrigin}/api/v1/me/preferences`, {
      method: 'PATCH', headers: { cookie: `${config.cookieName}=${ordinary.cookie.token}`, origin: config.appOrigin, 'x-csrf-token': onboardedMe.csrfToken, 'content-type': 'application/json' },
      body: JSON.stringify({ timezone: 'Mars/Olympus_Mons' }),
    });
    assert.equal(invalidPreferences.status, 422);

    const writePrincipalHash = createHmac('sha256', config.sessionSecret).update(`authenticated-write:${actorA.userId}`).digest('base64url');
    await pool.query("DELETE FROM rate_limit_bucket WHERE principal_hash=$1 AND route='authenticated-write'",[writePrincipalHash]);
    const badOriginWrite = await fetch(`${apiOrigin}/api/v1/me/preferences`, {
      method: 'PATCH', headers: { cookie: `${config.cookieName}=${ordinary.cookie.token}`, origin: 'http://attacker.example', 'x-csrf-token': onboardedMe.csrfToken, 'content-type': 'application/json' },
      body: JSON.stringify({ timezone: 'UTC' }),
    });
    assert.equal(badOriginWrite.status, 403);
    const afterBadOrigin = await pool.query("SELECT counter FROM rate_limit_bucket WHERE principal_hash=$1 AND route='authenticated-write'",[writePrincipalHash]);
    assert.equal(afterBadOrigin.rowCount, 0);
    let lastAllowedWrite;
    for (let index=0; index<60; index++) {
      lastAllowedWrite = await fetch(`${apiOrigin}/api/v1/me/preferences`, {
        method: 'PATCH', headers: { cookie: `${config.cookieName}=${ordinary.cookie.token}`, origin: config.appOrigin, 'x-csrf-token': onboardedMe.csrfToken, 'content-type': 'application/json' },
        body: JSON.stringify({ timezone: 'UTC' }),
      });
      assert.equal(lastAllowedWrite.status, 200);
    }
    const blockedWrite = await fetch(`${apiOrigin}/api/v1/me/preferences`, {
      method: 'PATCH', headers: { cookie: `${config.cookieName}=${ordinary.cookie.token}`, origin: config.appOrigin, 'x-csrf-token': onboardedMe.csrfToken, 'content-type': 'application/json' },
      body: JSON.stringify({ timezone: 'UTC' }),
    });
    assert.equal(blockedWrite.status, 429);
    assert.equal((await blockedWrite.json()).code, 'AUTHENTICATED_WRITE_RATE_LIMIT');
    await pool.query("DELETE FROM rate_limit_bucket WHERE principal_hash=$1 AND route='authenticated-write'",[writePrincipalHash]);

    const publicAddress = '198.51.100.23';
    const publicPrincipalHash = createHmac('sha256', config.sessionSecret).update(`public-read:${publicAddress}`).digest('base64url');
    for (let index=0; index<120; index++) await auth.assertPublicRead({ headers: { 'x-forwarded-for': '203.0.113.9' }, ip: publicAddress });
    await assert.rejects(auth.assertPublicRead({ headers: { 'x-forwarded-for': publicAddress }, ip: publicAddress }), (error) => error instanceof CommandError && error.status === 429 && error.code === 'PUBLIC_READ_RATE_LIMIT');
    const publicBucket = await pool.query("SELECT counter FROM rate_limit_bucket WHERE principal_hash=$1 AND route='public-read'",[publicPrincipalHash]);
    assert.equal(Number(publicBucket.rows[0].counter),121);
    await pool.query("DELETE FROM rate_limit_bucket WHERE principal_hash=$1 AND route='public-read'",[publicPrincipalHash]);

    const adminLogin = await issueLogin({ claims: { sub: `admin-${randomUUID()}` } });
    const adminIdentity = await pool.query('SELECT id FROM user_account WHERE oidc_issuer=$1 AND oidc_subject=$2',[issuer,adminLogin.identity.subject]);
    await pool.query('INSERT INTO role_grant(id,user_id,role,grantor_user_id,reason) VALUES($1,$2,$3,$4,$5)',[randomUUID(),adminIdentity.rows[0].id,'admin',actorA.userId,'P04 integration test']);
    await assert.rejects(auth.authenticate({ headers: { cookie: `${config.cookieName}=${adminLogin.cookie.token}` } }), (error) => error instanceof CommandError && error.status === 401);
    const adminRefresh = await issueLogin({ claims: { sub: adminLogin.identity.subject } });
    const adminActor = await auth.authenticate({ headers: { cookie: `${config.cookieName}=${adminRefresh.cookie.token}` } });
    await assert.rejects(auth.authenticate({ headers: { cookie: `${config.cookieName}=${adminRefresh.cookie.token}` } }, { staff: true }), (error) => error instanceof CommandError && error.status === 403 && error.code === 'MFA_REQUIRED');
    assert.deepEqual((await auth.me(adminActor)).security, { mfaVerified: false, mfaRecent: false });
    const proIntent = await issueLogin({ claims: { sub: ordinary.identity.subject }, intent: 'pro_annual', returnTo: '/ideas?symbol=AAPL' });
    assert.equal(proIntent.returnTo, '/subscribe?plan=pro&interval=year&returnTo=%2Fideas%3Fsymbol%3DAAPL');
    const currentActor = await auth.authenticate({ headers: { cookie: `${config.cookieName}=${proIntent.cookie.token}` } });

    const badNonces = [
      { issuer: 'http://127.0.0.1:1/attacker', sub: `bad-issuer-${randomUUID()}` },
      { audience: 'wrong-client', sub: `bad-audience-${randomUUID()}` },
      { nonce: 'wrong-nonce', sub: `bad-nonce-${randomUUID()}` },
      { exp: Math.floor(Date.now() / 1000) - 60, sub: `expired-${randomUUID()}` },
    ];
    for (const claims of badNonces) {
      const started = await auth.beginLogin({ address: `bad-${randomUUID()}` });
      const authorize = new URL(started.location);
      const code = `fixture-code-${randomUUID()}`;
      issuerState.codes.set(code, { challenge: authorize.searchParams.get('code_challenge'), nonce: authorize.searchParams.get('nonce') });
      issuerState.next = claims;
      const callback = new URL(config.redirectUri); callback.searchParams.set('code',code); callback.searchParams.set('state',started.state); callback.searchParams.set('iss',issuer);
      usedStates.push(started.state);
      await assert.rejects(auth.completeLogin(code,started.state,started.transactionCookie,callback.href), (error) => error instanceof CommandError && error.status === 401 && error.code === 'OIDC_AUTHENTICATION_FAILED');
    }

    const stepUp = await issueLogin({ claims: { sub: `stepup-${randomUUID()}`, acr: '2', authTime: Math.floor(Date.now() / 1000) } });
    assert.equal(stepUp.stepUp, false);

    const staleStepStart = await auth.beginLogin({ stepUp: true, actor: currentActor, address: `stale-step-${randomUUID()}` });
    const staleStepAuth = new URL(staleStepStart.location);
    const staleStepCode = `fixture-code-${randomUUID()}`;
    issuerState.codes.set(staleStepCode, { challenge: staleStepAuth.searchParams.get('code_challenge'), nonce: staleStepAuth.searchParams.get('nonce') });
    issuerState.next = { sub: ordinary.identity.subject, acr: '2', authTime: Math.floor(Date.now() / 1000) - 301 };
    const staleStepCallback = new URL(config.redirectUri); staleStepCallback.searchParams.set('code',staleStepCode); staleStepCallback.searchParams.set('state',staleStepStart.state); staleStepCallback.searchParams.set('iss',issuer);
    usedStates.push(staleStepStart.state);
    await assert.rejects(auth.completeLogin(staleStepCode,staleStepStart.state,staleStepStart.transactionCookie,staleStepCallback.href), (error) => error instanceof CommandError && error.status === 403 && error.code === 'STEP_UP_FAILED');

    const mismatchStart = await auth.beginLogin({ stepUp: true, actor: currentActor, address: `mismatch-${randomUUID()}` });
    const mismatchAuth = new URL(mismatchStart.location);
    const mismatchCode = `fixture-code-${randomUUID()}`;
    issuerState.codes.set(mismatchCode, { challenge: mismatchAuth.searchParams.get('code_challenge'), nonce: mismatchAuth.searchParams.get('nonce') });
    issuerState.next = { sub: actorBLogin.identity.subject, acr: '2', authTime: Math.floor(Date.now() / 1000) };
    const mismatchCallback = new URL(config.redirectUri); mismatchCallback.searchParams.set('code',mismatchCode); mismatchCallback.searchParams.set('state',mismatchStart.state); mismatchCallback.searchParams.set('iss',issuer);
    usedStates.push(mismatchStart.state);
    await assert.rejects(auth.completeLogin(mismatchCode,mismatchStart.state,mismatchStart.transactionCookie,mismatchCallback.href), (error) => error instanceof CommandError && error.status === 403 && error.code === 'STEP_UP_ACCOUNT_MISMATCH');

    const stepStart = await auth.beginLogin({ stepUp: true, actor: currentActor, address: `step-${randomUUID()}` });
    const stepAuth = new URL(stepStart.location);
    assert.equal(stepAuth.searchParams.get('acr_values'), '2');
    const stepCode = `fixture-code-${randomUUID()}`;
    issuerState.codes.set(stepCode, { challenge: stepAuth.searchParams.get('code_challenge'), nonce: stepAuth.searchParams.get('nonce') });
    const signedAuthTime = Math.floor(Date.now() / 1000);
    issuerState.next = { sub: ordinary.identity.subject, sid: ordinary.identity.sid, acr: '2', authTime: signedAuthTime };
    const stepCallback = new URL(config.redirectUri); stepCallback.searchParams.set('code',stepCode); stepCallback.searchParams.set('state',stepStart.state); stepCallback.searchParams.set('iss',issuer);
    usedStates.push(stepStart.state);
    const stepped = await auth.completeLogin(stepCode,stepStart.state,stepStart.transactionCookie,stepCallback.href);
    assert.equal(stepped.stepUp, true);
    const stepActor = await auth.authenticate({ headers: { cookie: `${config.cookieName}=${stepped.cookie.token}` } }, { stepUp: true });
    assert.equal(stepActor.userId, currentActor.userId);
    const mfaTimestamp = await pool.query('SELECT mfa_at FROM app_session WHERE id=$1',[stepActor.sessionId]);
    assert.equal(new Date(mfaTimestamp.rows[0].mfa_at).getTime(), signedAuthTime * 1000);
    await assert.rejects(auth.authenticate({ headers: { cookie: `${config.cookieName}=${proIntent.cookie.token}` } }), (error) => error instanceof CommandError && error.status === 401);

    for (const invalidToken of [
      await signLogout({ issuer: `${issuer}/wrong` }),
      await signLogout({ audience: 'wrong-client' }),
      await signLogout({ signer: wrongKeyPair.privateKey }),
      await signLogout({ nonce: 'logout-tokens-must-not-have-nonce' }),
      await signLogout({ sid: undefined }),
      await signLogout({ events: {} }),
      await signLogout({ events: { 'http://schemas.openid.net/event/backchannel-logout': true } }),
      await signLogout({ jti: 12 }),
      await signLogout({ sid: 12 }),
      await signLogout({ sub: 12 }),
    ]) await assert.rejects(auth.validateBackchannelLogout(invalidToken), (error) => error instanceof CommandError && error.status === 400);
    const backchannelToken = await signLogout({ sid: ordinary.identity.sid });
    await auth.validateBackchannelLogout(backchannelToken);
    await assert.rejects(auth.authenticate({ headers: { cookie: `${config.cookieName}=${stepped.cookie.token}` } }), (error) => error instanceof CommandError && error.status === 401);
    await assert.rejects(auth.validateBackchannelLogout(backchannelToken), (error) => error instanceof CommandError && error.status === 409 && error.code === 'LOGOUT_TOKEN_REPLAYED');

    const suspended = await pool.query("UPDATE user_account SET status='suspended' WHERE oidc_subject=$1", [actorBLogin.identity.subject]);
    assert.equal(suspended.rowCount, 1);
    await assert.rejects(auth.authenticate({ headers: { cookie: `${config.cookieName}=${actorBLogin.cookie.token}` } }), (error) => error instanceof CommandError && [401,403].includes(error.status));

    const stale = await issueLogin({ claims: { sub: `stale-${randomUUID()}` } });
    const staleActor = await auth.authenticate({ headers: { cookie: `${config.cookieName}=${stale.cookie.token}` } });
    await pool.query("UPDATE app_session SET last_seen_at=now()-interval '31 minutes' WHERE id=$1", [staleActor.sessionId]);
    await assert.rejects(auth.authenticate({ headers: { cookie: `${config.cookieName}=${stale.cookie.token}` } }), (error) => error instanceof CommandError && error.status === 401);

    const absolute = await issueLogin({ claims: { sub: `absolute-${randomUUID()}` } });
    const absoluteActor = await auth.authenticate({ headers: { cookie: `${config.cookieName}=${absolute.cookie.token}` } });
    await pool.query("UPDATE app_session SET expires_at=now()-interval '1 second' WHERE id=$1", [absoluteActor.sessionId]);
    await assert.rejects(auth.authenticate({ headers: { cookie: `${config.cookieName}=${absolute.cookie.token}` } }), (error) => error instanceof CommandError && error.status === 401);
  } finally {
    if (app) await app.close();
    for (const state of usedStates) await pool.query('DELETE FROM auth_transaction WHERE state_hash=$1', [createHash('sha256').update(state).digest('hex')]);
    for (const sub of userIds) {
      const user = await pool.query('SELECT id FROM user_account WHERE oidc_subject=$1 AND oidc_issuer=$2',[sub,issuer]);
      if (!user.rowCount) continue;
      const id = user.rows[0].id;
      await pool.query('DELETE FROM role_grant WHERE user_id=$1 OR grantor_user_id=$1',[id]);
      await pool.query('DELETE FROM policy_acceptance WHERE user_id=$1',[id]);
      await pool.query('DELETE FROM app_session WHERE user_id=$1',[id]);
      await pool.query('DELETE FROM preference WHERE user_id=$1',[id]);
      await pool.query('DELETE FROM profile WHERE user_id=$1',[id]);
      await pool.query('DELETE FROM user_account WHERE id=$1',[id]);
    }
    await pool.query("DELETE FROM oidc_logout_replay WHERE issuer=$1 AND jti LIKE 'p04-%'",[issuer]);
    server.closeAllConnections?.();
    await new Promise((resolve) => server.close(resolve));
    await pool.end();
  }
});
