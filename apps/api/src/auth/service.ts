import {isDeletionSuppressed} from '../privacy/service.js';
import { billingEntitlementScope, billingEntitlementPredicate } from '@trading/config';
import { createCipheriv, createDecipheriv, createHash, createHmac, randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import type { Pool } from 'pg';
import * as oidc from 'openid-client';
import { createRemoteJWKSet, jwtVerify } from 'jose';
import { CommandError } from '../http/problem.js';
import { validateHandle } from '../profiles/service.js';
import { enqueueTransactionalNotification } from '../notifications/service.js';

export const AUTH = Symbol('AUTH');

export interface AuthConfig {
  privacySuppressionKey?:string;
  issuer: string;
  clientId: string;
  clientSecret: string;
  redirectUri: string;
  appOrigin: string;
  sessionSecret: string;
  dataEncryptionKey: string;
  cookieName: string;
  cookieSecure: boolean;
  providerAccountUrl: string;
  staffMaxSessionAgeSeconds: number;
  memberMaxSessionAgeSeconds: number;
  termsVersion: string;
  mfaAssurance: string;
}

export function authConfigFromEnv(env: NodeJS.ProcessEnv = process.env): AuthConfig {
  const required = (key: string) => {
    const value = env[key];
    if (!value) throw new Error(`Missing required auth configuration: ${key}`);
    return value;
  };
  const issuer = new URL(required('OIDC_ISSUER')).toString().replace(/\/$/, '');
  const appOrigin = new URL(required('APP_ORIGIN')).origin;
  const productionRelease = env.NODE_ENV === 'production' || ['production','public'].includes((env.RELEASE_MODE ?? '').toLowerCase());
  const cookieSecure = productionRelease;
  const cookieName = cookieSecure ? '__Host-tc_session' : 'tc_session_dev';
  const dataEncryptionKey = required('DATA_ENCRYPTION_KEY');
  if (dataEncryptionKey.length < 32) throw new Error('DATA_ENCRYPTION_KEY must contain at least 32 characters.');
  const sessionSecret = required('SESSION_SECRET');
  if (sessionSecret.length < 32) throw new Error('SESSION_SECRET must contain at least 32 characters.');
  const config: AuthConfig = {
    issuer,
    clientId: required('OIDC_CLIENT_ID'),
    clientSecret: required('OIDC_CLIENT_SECRET'),
    redirectUri: required('OIDC_REDIRECT_URI'),
    appOrigin,
    sessionSecret,
    privacySuppressionKey:env.PRIVACY_SUPPRESSION_KEY?.trim()||sessionSecret,
    dataEncryptionKey,
    cookieName,
    cookieSecure,
    providerAccountUrl: required('OIDC_ACCOUNT_URL'),
    staffMaxSessionAgeSeconds: 8 * 60 * 60,
    memberMaxSessionAgeSeconds: 12 * 60 * 60,
    termsVersion: env.TERMS_VERSION ?? '2026-10-19.draft-1',
    mfaAssurance: env.OIDC_MFA_ASSURANCE ?? '2',
  };
  if (new URL(config.redirectUri).origin !== appOrigin) throw new Error('OIDC_REDIRECT_URI must use APP_ORIGIN.');
  const account = new URL(config.providerAccountUrl);
  if (account.origin !== new URL(issuer).origin) throw new Error('OIDC_ACCOUNT_URL must use the configured issuer origin.');
  if (productionRelease) {
    if (![issuer,config.redirectUri,appOrigin,config.providerAccountUrl].every((value) => value.startsWith('https://'))) throw new Error('Production auth URLs must use HTTPS.');
    if (/(?:draft|placeholder|test)/i.test(config.termsVersion)) throw new Error('Production requires an approved non-draft TERMS_VERSION.');
  }
  return config;
}

export interface AuthRequest {
  headers: Record<string, string | string[] | undefined>;
  query?: Record<string, unknown>;
  params?: Record<string, unknown>;
  body?: unknown;
  ip?: string;
  socket?: { remoteAddress?: string };
}

export interface Actor {
  userId: string;
  sessionId: string;
  emailVerified: boolean;
  status: string;
  roles: string[];
  csrfToken: string;
  profile?: Record<string, unknown>;
  onboarded: boolean;
}

export interface AuthenticateOptions { verified?: boolean; onboarded?: boolean; staff?: boolean; stepUp?: boolean }
export interface OidcLoginOptions { returnTo?: string; intent?: string; screen?: string; stepUp?: boolean; actor?: Actor; address?: string }
export interface TokenIdentity { subject: string; issuer: string; email?: string; emailVerified: boolean; sid?: string; authTime?: number; assurance?: string }
export interface SessionCookie { token: string; csrfToken: string; expiresAt: Date }
export interface SessionSummary { id: string; createdAt: string; lastSeenAt: string; current: boolean; expiresAt: string }

type TransactionSecret = { verifier: string; nonce: string; browserBinding: string; sessionId?: string; stepUp?: boolean };
type Claims = Record<string, unknown> & { sub?: string; iss?: string; email?: string; email_verified?: boolean; sid?: string; session_state?: string; auth_time?: number; acr?: string; amr?: string[]; aud?: string | string[]; exp?: number; iat?: number; jti?: string; events?: Record<string, unknown> };

const SESSION_COOKIE_PATH = '/';
const MEMBER_IDLE_MS = 30 * 60 * 1000;
const STAFF_IDLE_MS = 15 * 60 * 1000;
const STEP_UP_MS = 5 * 60 * 1000;
const OIDC_LOGOUT_EVENT = 'http://schemas.openid.net/event/backchannel-logout';

const hash = (value: string) => createHash('sha256').update(value).digest('hex');
const base64url = (size = 32) => randomBytes(size).toString('base64url');
const hmac = (secret: string, value: string) => createHmac('sha256', secret).update(value).digest('base64url');
const stringHeader = (value: string | string[] | undefined) => Array.isArray(value) ? value[0] : value;
const encryptedKey = (input: string) => createHash('sha256').update('trading-community:auth-transaction:v1:').update(input).digest();
const safeEqual = (left: string, right: string) => {
  const a = Buffer.from(left); const b = Buffer.from(right);
  return a.length === b.length && timingSafeEqual(a, b);
};

export class AuthService {
  private discovery?: Promise<oidc.Configuration>;
  private logoutJwks?: ReturnType<typeof createRemoteJWKSet>;

  constructor(private readonly pool: Pool, readonly config: AuthConfig) {
    if (config.sessionSecret.length < 32 || config.dataEncryptionKey.length < 32) throw new Error('Auth keys must contain at least 32 characters.');
    if (new URL(config.redirectUri).origin !== config.appOrigin) throw new Error('OIDC redirect origin must match the application origin.');
    if (config.cookieSecure && config.cookieName !== '__Host-tc_session') throw new Error('Secure deployments must use the __Host-tc_session cookie.');
    if (!config.cookieSecure && config.cookieName !== 'tc_session_dev') throw new Error('Local deployments must use tc_session_dev.');
    if (new URL(config.issuer).protocol !== 'https:' && config.cookieSecure) throw new Error('Production OIDC issuer must use HTTPS.');
  }

  private oidcConfiguration(): Promise<oidc.Configuration> {
    const url = new URL(this.config.issuer);
    let options: oidc.DiscoveryRequestOptions | undefined;
    if (url.protocol === 'http:') {
      if (this.config.cookieSecure || !['localhost','127.0.0.1','::1','auth.localhost','keycloak'].includes(url.hostname)) throw new Error('Insecure OIDC issuer is not allowed.');
      options = { execute: [oidc.allowInsecureRequests] };
    }
    this.discovery ??= oidc.discovery(url, this.config.clientId, { client_secret: this.config.clientSecret }, oidc.ClientSecretPost(), options);
    return this.discovery;
  }

  private encryptTransaction(data: TransactionSecret): string {
    const iv = randomBytes(12);
    const cipher = createCipheriv('aes-256-gcm', encryptedKey(this.config.dataEncryptionKey), iv);
    const ciphertext = Buffer.concat([cipher.update(JSON.stringify(data)), cipher.final()]);
    return [iv, cipher.getAuthTag(), ciphertext].map((part) => part.toString('base64url')).join('.');
  }

  private decryptTransaction(value: string): TransactionSecret {
    try {
      const [iv, tag, ciphertext] = value.split('.').map((part) => Buffer.from(part, 'base64url'));
      if (!iv || !tag || !ciphertext || iv.length !== 12 || tag.length !== 16) throw new Error('invalid envelope');
      const decipher = createDecipheriv('aes-256-gcm', encryptedKey(this.config.dataEncryptionKey), iv);
      decipher.setAuthTag(tag);
      return JSON.parse(Buffer.concat([decipher.update(ciphertext), decipher.final()]).toString('utf8')) as TransactionSecret;
    } catch { throw new CommandError(400, 'INVALID_AUTH_TRANSACTION', 'The sign-in transaction is invalid or expired. Start again.'); }
  }

  private returnPath(input: unknown): string {
    const fallback = '/app';
    if (typeof input !== 'string' || !input || input.length > 500 || !input.startsWith('/') || input.startsWith('//') || input.includes('\\') || [...input].some((char) => char.charCodeAt(0) <= 32)) return fallback;
    try {
      const url = new URL(input, this.config.appOrigin);
      if (url.origin !== this.config.appOrigin || !/^\/(?:app(?:\/|$)|ideas(?:\/|$)|u\/|instruments\/|subscribe$|onboarding$|verify-email$)/.test(url.pathname)) return fallback;
      return `${url.pathname}${url.search}${url.hash}`;
    } catch { return fallback; }
  }

  private async postLoginPath(userId: string, intent: string | null, returnTo: string): Promise<string> {
    const result = await this.pool.query('SELECT onboarding_version FROM user_account WHERE id=$1',[userId]);
    const onboarded = Boolean(result.rows[0]?.onboarding_version);
    if (!onboarded) {
      const onboarding = new URL('/onboarding',this.config.appOrigin);
      if (intent) onboarding.searchParams.set('intent',intent);
      onboarding.searchParams.set('returnTo',returnTo);
      return `${onboarding.pathname}${onboarding.search}`;
    }
    if (intent === 'pro_monthly' || intent === 'pro_annual') {
      const subscribe = new URL('/subscribe',this.config.appOrigin);
      subscribe.searchParams.set('plan','pro');
      subscribe.searchParams.set('interval',intent === 'pro_annual' ? 'year' : 'month');
      subscribe.searchParams.set('returnTo',returnTo);
      return `${subscribe.pathname}${subscribe.search}`;
    }
    return returnTo;
  }

  async beginLogin(options: OidcLoginOptions = {}): Promise<{ location: string; transactionCookie: string; state: string }> {
    const config = await this.oidcConfiguration();
    const state = oidc.randomState();
    const nonce = oidc.randomNonce();
    const verifier = oidc.randomPKCECodeVerifier();
    const challenge = await oidc.calculatePKCECodeChallenge(verifier);
    const browserBinding = base64url(32);
    const addressHash = hmac(this.config.sessionSecret, options.address ?? 'unknown');
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))', [`auth-start:${addressHash}`]);
      await client.query('DELETE FROM auth_transaction WHERE expires_at<=now()-interval \'24 hours\'');
      const limited = await client.query(`INSERT INTO rate_limit_bucket(id,principal_hash,route,window_start,counter,expires_at)
        VALUES ($1,$2,'/auth/login',date_bin('10 minutes',now(),TIMESTAMPTZ '2000-01-01'),1,now()+interval '11 minutes')
        ON CONFLICT(principal_hash,route,window_start) DO UPDATE SET counter=rate_limit_bucket.counter+1 RETURNING counter`, [randomUUID(),addressHash]);
      if (Number(limited.rows[0].counter) > 10) throw new CommandError(429, 'LOGIN_RATE_LIMIT', 'Too many sign-in attempts. Try again later.');
      if (options.stepUp && options.actor) await client.query('UPDATE auth_transaction SET used_at=now() WHERE used_at IS NULL AND expires_at<=now()');
      const payload: TransactionSecret = { verifier, nonce, browserBinding, ...(options.actor ? { sessionId: options.actor.sessionId } : {}), ...(options.stepUp ? { stepUp: true } : {}) };
      const intent = JSON.stringify({ returnTo: this.returnPath(options.returnTo), plan: ['free','pro_monthly','pro_annual'].includes(options.intent ?? '') ? options.intent : null, screen: ['login','signup','recover'].includes(options.screen ?? '') ? options.screen : 'login' });
      await client.query(`INSERT INTO auth_transaction(id,state_hash,nonce_hash,pkce_verifier_encrypted,return_intent,expires_at)
        VALUES($1,$2,$3,$4,$5,now()+interval '10 minutes')`, [randomUUID(),hash(state),hash(nonce),this.encryptTransaction(payload),intent]);
      await client.query('COMMIT');
    } catch (error) {
      await client.query('ROLLBACK').catch(() => undefined);
      if (error instanceof CommandError) throw error;
      throw error;
    } finally { client.release(); }
    const authorization = oidc.buildAuthorizationUrl(config, {
      redirect_uri: this.config.redirectUri, response_type: 'code', scope: 'openid email profile',
      state, nonce, code_challenge: challenge, code_challenge_method: 'S256',
      ...(options.stepUp ? { prompt: 'login', max_age: '0', acr_values: this.config.mfaAssurance } : {}),
    });
    // Keycloak exposes registration as a protocol endpoint that supports the
    // same OIDC state/nonce/PKCE query. Password recovery stays on its login
    // screen so its built-in Forgot password flow can complete safely.
    if (options.screen === 'signup') {
      const issuer = new URL(this.config.issuer);
      authorization.pathname = `${issuer.pathname.replace(/\/$/, '')}/protocol/openid-connect/registrations`;
    }
    return { location: authorization.href, transactionCookie: browserBinding, state };
  }

  async completeLogin(code: string, state: string, currentTransactionCookie: string | undefined, currentUrl?: string): Promise<{ identity: TokenIdentity; cookie: SessionCookie; returnTo: string; stepUp: boolean }> {
    if (!code || code.length > 200 || !state || state.length > 200 || !currentTransactionCookie) throw new CommandError(400, 'INVALID_AUTH_CALLBACK', 'The sign-in callback is invalid or expired. Start again.');
    const client = await this.pool.connect();
    let tx: { id: string; nonce_hash: string; pkce_verifier_encrypted: string; return_intent: string };
    try {
      await client.query('BEGIN');
      const result = await client.query(`SELECT id,nonce_hash,pkce_verifier_encrypted,return_intent FROM auth_transaction
        WHERE state_hash=$1 AND used_at IS NULL AND expires_at>now() FOR UPDATE`, [hash(state)]);
      if (!result.rowCount) throw new CommandError(400, 'INVALID_AUTH_TRANSACTION', 'The sign-in transaction is invalid or expired. Start again.');
      tx = result.rows[0];
      const secret = this.decryptTransaction(tx.pkce_verifier_encrypted);
      if (!safeEqual(secret.browserBinding, currentTransactionCookie)) throw new CommandError(400, 'INVALID_AUTH_TRANSACTION', 'The sign-in transaction is not bound to this browser. Start again.');
      if (!safeEqual(tx.nonce_hash, hash(secret.nonce))) throw new CommandError(400, 'INVALID_AUTH_TRANSACTION', 'The sign-in transaction is invalid. Start again.');
      await client.query('UPDATE auth_transaction SET used_at=now() WHERE id=$1', [tx.id]);
      await client.query('COMMIT');
      const config = await this.oidcConfiguration();
      const callback = new URL(this.config.redirectUri);
      const url = currentUrl ? new URL(currentUrl) : callback;
      url.searchParams.set('code', code); url.searchParams.set('state', state);
      const tokenSet = await oidc.authorizationCodeGrant(config, url, {
        pkceCodeVerifier: secret.verifier, expectedState: state, expectedNonce: secret.nonce,
        idTokenExpected: true,
      });
      if (!tokenSet.id_token) throw new Error('No ID token');
      const claims = tokenSet.claims() as Claims;
      if (claims.iss !== this.config.issuer || typeof claims.sub !== 'string' || !claims.sub || typeof claims.exp !== 'number' || claims.exp <= Math.floor(Date.now() / 1000)) throw new Error('Invalid ID token claims');
      let userInfo: { email?: string; email_verified?: boolean } = {};
      if (typeof claims.email !== 'string' && tokenSet.access_token) {
        userInfo = await oidc.fetchUserInfo(config, tokenSet.access_token, claims.sub) as { email?: string; email_verified?: boolean };
      }
      const rawEmail = typeof claims.email === 'string' ? claims.email : userInfo.email;
      const email = typeof rawEmail === 'string' && rawEmail.length <= 254 ? rawEmail.trim().toLowerCase() : undefined;
      if (!email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) throw new Error('No valid email claim');
      const identity: TokenIdentity = {
        subject: claims.sub, issuer: claims.iss,
        email, emailVerified: claims.email_verified === true || userInfo.email_verified === true,
        ...(typeof claims.sid === 'string' ? { sid: claims.sid } : typeof claims.session_state === 'string' ? { sid: claims.session_state } : {}),
        ...(typeof claims.auth_time === 'number' ? { authTime: claims.auth_time } : {}),
        ...(typeof claims.acr === 'string' ? { assurance: claims.acr } : Array.isArray(claims.amr) ? { assurance: claims.amr.join(' ') } : {}),
      };
      if (secret.stepUp && (!isMfaAssurance(identity.assurance, this.config.mfaAssurance) || !identity.authTime || Date.now() / 1000 - identity.authTime > 300 || identity.authTime > Date.now() / 1000 + 5)) throw new CommandError(403, 'STEP_UP_FAILED', 'The identity provider did not confirm a recent multi-factor check.');
      const intent = JSON.parse(tx.return_intent) as { returnTo?: string; plan?: string | null };
      const cookie = await this.createSession(identity, secret.sessionId, secret.stepUp === true);
      const landing = secret.stepUp ? '/app' : await this.postLoginPath((await this.pool.query('SELECT id FROM user_account WHERE oidc_issuer=$1 AND oidc_subject=$2',[identity.issuer,identity.subject])).rows[0].id,safePlanIntent(intent.plan),this.returnPath(intent.returnTo));
      return { identity, cookie, returnTo: landing, stepUp: secret.stepUp === true };
    } catch (error) {
      await client.query('ROLLBACK').catch(() => undefined);
      if (error instanceof CommandError) throw error;
      throw new CommandError(401, 'OIDC_AUTHENTICATION_FAILED', 'Sign-in could not be verified. Start again.');
    } finally { client.release(); }
  }

  async createSession(identity: TokenIdentity, replaceSessionId?: string, stepUp = false): Promise<SessionCookie> {
    const client = await this.pool.connect();
    const token = base64url(32);
    const tokenHash = hash(token);
    const sessionId = randomUUID();
    const now = new Date();
    let expiresAt = new Date(now.getTime() + this.config.memberMaxSessionAgeSeconds * 1000);
    try {
      await client.query('BEGIN');
      if(await isDeletionSuppressed(client as any,this.config.privacySuppressionKey||this.config.sessionSecret,identity.issuer,identity.subject))throw new CommandError(403,'ACCOUNT_DELETED','This identity is suppressed after a completed deletion request.');
      if (replaceSessionId) {
        const original = await client.query(`SELECT s.user_id,s.issued_at,s.last_seen_at,u.oidc_issuer,u.oidc_subject,u.status,
            EXISTS(SELECT 1 FROM role_grant g WHERE g.user_id=u.id AND g.role IN ('moderator','admin')) AS staff
          FROM app_session s JOIN user_account u ON u.id=s.user_id
          WHERE s.id=$1 AND s.revoked_at IS NULL AND s.expires_at>now() FOR UPDATE OF s,u`,[replaceSessionId]);
        if (!original.rowCount) throw new CommandError(401,'SESSION_EXPIRED','Your session has expired. Sign in again.');
        const session = original.rows[0];
        if (session.status !== 'active') throw new CommandError(403,'ACCOUNT_UNAVAILABLE','This account is not available.');
        if (session.oidc_issuer !== identity.issuer || session.oidc_subject !== identity.subject) throw new CommandError(403,'STEP_UP_ACCOUNT_MISMATCH','Multi-factor verification must use the current account.');
        const idleMs = session.staff ? STAFF_IDLE_MS : MEMBER_IDLE_MS;
        const absoluteMs = session.staff ? 8 : 12;
        if (Date.now()-new Date(session.last_seen_at).getTime()>idleMs || Date.now()-new Date(session.issued_at).getTime()>absoluteMs*60*60*1000) throw new CommandError(401,'SESSION_EXPIRED','Your session has expired. Sign in again.');
      }
      const user = await client.query(`INSERT INTO user_account(id,oidc_issuer,oidc_subject,email,email_verified,status,created_at,updated_at)
        VALUES($1,$2,$3,$4,$5,'active',now(),now())
        ON CONFLICT(oidc_issuer,oidc_subject) DO UPDATE SET email=EXCLUDED.email,email_verified=EXCLUDED.email_verified,updated_at=now()
        RETURNING id,status`, [randomUUID(), identity.issuer, identity.subject, identity.email ?? null, identity.emailVerified]);
      if (user.rows[0].status !== 'active') throw new CommandError(403, 'ACCOUNT_UNAVAILABLE', 'This account is not available.');
      const staff = await client.query("SELECT 1 FROM role_grant WHERE user_id=$1 AND role IN ('moderator','admin') LIMIT 1",[user.rows[0].id]);
      if (staff.rowCount) expiresAt = new Date(now.getTime() + this.config.staffMaxSessionAgeSeconds * 1000);
      if (replaceSessionId) await client.query('UPDATE app_session SET revoked_at=now() WHERE id=$1 AND user_id=$2 AND revoked_at IS NULL', [replaceSessionId,user.rows[0].id]);
      await client.query(`INSERT INTO app_session(id,token_hash,user_id,issued_at,last_seen_at,expires_at,provider_session_id,mfa_at,assurance)
        VALUES($1,$2,$3,now(),now(),$4,$5,$6,$7)`, [sessionId,tokenHash,user.rows[0].id,expiresAt,identity.sid ?? null,stepUp && identity.authTime ? new Date(identity.authTime * 1000) : null,identity.assurance ?? null]);
      await client.query('COMMIT');
    } catch (error) {
      await client.query('ROLLBACK').catch(() => undefined);
      if (error instanceof CommandError) throw error;
      throw new CommandError(503, 'SESSION_UNAVAILABLE', 'Sign-in could not be completed. Try again.');
    } finally { client.release(); }
    return { token, csrfToken: this.csrfForSession(sessionId), expiresAt };
  }

  async recentVerification(actor:Actor):Promise<Date>{const row=await this.pool.query('SELECT issued_at FROM app_session WHERE id=$1 AND user_id=$2 AND revoked_at IS NULL AND expires_at>now()',[actor.sessionId,actor.userId]);const at=row.rows[0]?.issued_at;if(!at||Date.now()-new Date(at).getTime()>300000)throw new CommandError(403,'RECENT_VERIFICATION_REQUIRED','Sign in again before requesting deletion.');return new Date(at);}

  private csrfForSession(sessionId: string) { return hmac(this.config.sessionSecret, `csrf:${sessionId}`); }

  /** Personal public reads distinguish absent credentials from invalid supplied ones. */
  async optionalActor(request: AuthRequest): Promise<Actor | null> {
    const cookie = stringHeader(request.headers.cookie) ?? '';
    const supplied = cookie.split(';').some(item => item.trim().startsWith(`${this.config.cookieName}=`));
    return supplied ? this.authenticate(request) : null;
  }

  async authenticate(request: AuthRequest, options: AuthenticateOptions = {}): Promise<Actor> {
    const cookie = stringHeader(request.headers.cookie) ?? '';
    const token = cookie.split(';').map((item) => item.trim()).find((item) => item.startsWith(`${this.config.cookieName}=`))?.slice(this.config.cookieName.length + 1);
    if (!token || !/^[A-Za-z0-9_-]{40,60}$/.test(token)) throw new CommandError(401, 'AUTHENTICATION_REQUIRED', 'Sign in to continue.');
    const result = await this.pool.query(`SELECT s.id AS session_id,s.user_id,s.issued_at,s.last_seen_at,s.expires_at,s.mfa_at,s.assurance,
        u.oidc_issuer,u.oidc_subject,u.email,u.email_verified,u.status,u.onboarding_version,p.handle,p.display_name,p.bio,p.links,p.interests,p.avatar_media_id,p.revision
      FROM app_session s JOIN user_account u ON u.id=s.user_id LEFT JOIN profile p ON p.user_id=u.id
      WHERE s.token_hash=$1 AND s.revoked_at IS NULL AND s.expires_at>now()`, [hash(token)]);
    if (!result.rowCount) throw new CommandError(401, 'SESSION_EXPIRED', 'Your session has expired. Sign in again.');
    const row = result.rows[0];
    if (row.status !== 'active') {
      await this.pool.query('UPDATE app_session SET revoked_at=now() WHERE id=$1 AND revoked_at IS NULL', [row.session_id]);
      throw new CommandError(403, 'ACCOUNT_UNAVAILABLE', 'This account is not available.');
    }
    if(await isDeletionSuppressed(this.pool,this.config.privacySuppressionKey||this.config.sessionSecret,row.oidc_issuer,row.oidc_subject)){await this.pool.query('UPDATE app_session SET revoked_at=now() WHERE id=$1',[row.session_id]);throw new CommandError(403,'ACCOUNT_DELETED','This account is suppressed after deletion.');}
    const roles = await this.roles(row.user_id);
    const staff = roles.some((role) => role === 'moderator' || role === 'admin');
    const idleLimit = staff ? STAFF_IDLE_MS : MEMBER_IDLE_MS;
    if (Date.now() - new Date(row.last_seen_at).getTime() > idleLimit) {
      await this.pool.query('UPDATE app_session SET revoked_at=now() WHERE id=$1', [row.session_id]);
      throw new CommandError(401, 'SESSION_EXPIRED', 'Your session has expired. Sign in again.');
    }
    if (Date.now() - new Date(row.issued_at).getTime() > (staff ? 8 : 12) * 60 * 60 * 1000) {
      await this.pool.query('UPDATE app_session SET revoked_at=now() WHERE id=$1', [row.session_id]);
      throw new CommandError(401, 'SESSION_EXPIRED', 'Your session has expired. Sign in again.');
    }
    if (options.verified && !row.email_verified) throw new CommandError(403, 'EMAIL_VERIFICATION_REQUIRED', 'Verify your email to continue.');
    if (options.onboarded && !row.onboarding_version) throw new CommandError(403, 'ONBOARDING_REQUIRED', 'Complete account setup to continue.');
    if (options.staff && !roles.includes('admin') && !roles.includes('moderator')) throw new CommandError(403, 'STAFF_REQUIRED', 'Staff access is required.');
    if (options.staff && roles.includes('admin') && (!row.mfa_at || !isMfaAssurance(row.assurance, this.config.mfaAssurance))) throw new CommandError(403, 'MFA_REQUIRED', 'Complete multi-factor verification to access administrator tools.');
    if (options.stepUp && (!row.mfa_at || Date.now() - new Date(row.mfa_at).getTime() > STEP_UP_MS || !isMfaAssurance(row.assurance, this.config.mfaAssurance))) throw new CommandError(403, 'STEP_UP_REQUIRED', 'Complete a recent multi-factor check to continue.');
    await this.pool.query('UPDATE app_session SET last_seen_at=now() WHERE id=$1', [row.session_id]);
    const profile = row.handle ? { handle: row.handle, displayName: row.display_name, bio: row.bio ?? '', links: row.links ?? [], interests: row.interests ?? [], avatarMediaId: row.avatar_media_id, revision: row.revision } : undefined;
    return { userId: row.user_id, sessionId: row.session_id, emailVerified: row.email_verified, status: row.status, roles, csrfToken: this.csrfForSession(row.session_id), ...(profile ? { profile } : {}), onboarded: Boolean(row.onboarding_version) };
  }

  async assertCsrf(request: AuthRequest, actor: Actor): Promise<void> {
    const origin = stringHeader(request.headers.origin);
    const csrf = stringHeader(request.headers['x-csrf-token']);
    if (origin !== this.config.appOrigin || !csrf || !safeEqual(csrf, actor.csrfToken)) throw new CommandError(403, 'CSRF_REJECTED', 'The request could not be verified. Reload and try again.');
    const principalHash = hmac(this.config.sessionSecret, `authenticated-write:${actor.userId}`);
    const limited = await this.pool.query(`INSERT INTO rate_limit_bucket(id,principal_hash,route,window_start,counter,expires_at)
      VALUES($1,$2,'authenticated-write',date_bin('1 minute',now(),TIMESTAMPTZ '2000-01-01'),1,now()+interval '2 minutes')
      ON CONFLICT(principal_hash,route,window_start) DO UPDATE SET counter=rate_limit_bucket.counter+1
      RETURNING counter`, [randomUUID(),principalHash]);
    if (Number(limited.rows[0].counter) === 1) {
      await this.pool.query("DELETE FROM rate_limit_bucket WHERE expires_at < now()-interval '1 day'");
    }
    if (Number(limited.rows[0].counter) > 60) throw new CommandError(429, 'AUTHENTICATED_WRITE_RATE_LIMIT', 'Too many changes were submitted. Try again in a minute.');
  }

  async assertPublicRead(request: AuthRequest): Promise<void> {
    // Never trust caller-controlled forwarding headers here. The runtime's trusted
    // ingress must supply request.ip itself when proxy-aware address resolution is enabled.
    const address = request.ip ?? request.socket?.remoteAddress ?? 'unknown';
    const principalHash = hmac(this.config.sessionSecret, `public-read:${address}`);
    const limited = await this.pool.query(`INSERT INTO rate_limit_bucket(id,principal_hash,route,window_start,counter,expires_at)
      VALUES($1,$2,'public-read',date_bin('1 minute',now(),TIMESTAMPTZ '2000-01-01'),1,now()+interval '2 minutes')
      ON CONFLICT(principal_hash,route,window_start) DO UPDATE SET counter=rate_limit_bucket.counter+1
      RETURNING counter`, [randomUUID(),principalHash]);
    if (Number(limited.rows[0].counter) === 1) {
      await this.pool.query("DELETE FROM rate_limit_bucket WHERE expires_at < now()-interval '1 day'");
    }
    if (Number(limited.rows[0].counter) > 120) throw new CommandError(429, 'PUBLIC_READ_RATE_LIMIT', 'Too many public requests were submitted. Try again in a minute.');
  }

  async roles(userId: string): Promise<string[]> {
    const grants = await this.pool.query(`SELECT role FROM role_grant WHERE user_id=$1 AND role IN ('moderator','admin')`, [userId]);
    return ['member', ...grants.rows.map((row) => row.role)];
  }

  async revoke(actor: Actor): Promise<void> { await this.pool.query('UPDATE app_session SET revoked_at=now() WHERE id=$1 AND user_id=$2 AND revoked_at IS NULL', [actor.sessionId,actor.userId]); }
  async revokeAll(actor: Actor): Promise<void> { await this.pool.query('UPDATE app_session SET revoked_at=now() WHERE user_id=$1 AND revoked_at IS NULL', [actor.userId]); }
  async revokeUserSessions(userId: string): Promise<void> { await this.pool.query('UPDATE app_session SET revoked_at=now() WHERE user_id=$1 AND revoked_at IS NULL', [userId]); }

  async revokeSession(actor: Actor, id: string): Promise<void> {
    if (!isUuid(id)) throw new CommandError(400, 'INVALID_SESSION_ID', 'The session id is invalid.');
    const result = await this.pool.query('UPDATE app_session SET revoked_at=now() WHERE id=$1 AND user_id=$2 AND revoked_at IS NULL', [id,actor.userId]);
    if (!result.rowCount) {
      const known = await this.pool.query('SELECT 1 FROM app_session WHERE id=$1 AND user_id=$2', [id,actor.userId]);
      if (!known.rowCount) throw new CommandError(404, 'SESSION_NOT_FOUND', 'Session not found.');
    }
  }

  async listSessions(actor: Actor, limit = 20, cursor?: string): Promise<{ items: SessionSummary[]; nextCursor: string | null }> {
    if (!Number.isInteger(limit) || limit < 1 || limit > 50) throw new CommandError(400, 'INVALID_LIMIT', 'Limit must be between 1 and 50.');
    let after: { issuedAt: string; id: string } | undefined;
    if (cursor) {
      try { const parsed = JSON.parse(Buffer.from(cursor, 'base64url').toString()); if (parsed.u !== actor.userId || typeof parsed.t !== 'string' || !Number.isFinite(Date.parse(parsed.t)) || typeof parsed.i !== 'string' || !isUuid(parsed.i)) throw new Error(); after = { issuedAt: new Date(parsed.t).toISOString(), id: parsed.i }; }
      catch { throw new CommandError(400, 'INVALID_CURSOR', 'The session cursor is invalid.'); }
    }
    const result = await this.pool.query(`SELECT id,issued_at,last_seen_at,expires_at FROM app_session WHERE user_id=$1 AND revoked_at IS NULL AND expires_at>now()
      AND ($2::timestamptz IS NULL OR (issued_at,id)<($2::timestamptz,$3::uuid)) ORDER BY issued_at DESC,id DESC LIMIT $4`, [actor.userId,after?.issuedAt ?? null,after?.id ?? null,limit + 1]);
    const hasMore = result.rows.length > limit;
    const rows = result.rows.slice(0,limit);
    const items = rows.map((row) => ({ id: row.id, createdAt: iso(row.issued_at), lastSeenAt: iso(row.last_seen_at), current: row.id === actor.sessionId, expiresAt: iso(row.expires_at) }));
    const last = rows.at(-1);
    const nextCursor = hasMore && last ? Buffer.from(JSON.stringify({u:actor.userId,t:iso(last.issued_at),i:last.id})).toString('base64url') : null;
    return { items, nextCursor };
  }

  async me(actor: Actor): Promise<Record<string, unknown>> {
    const userResult = await this.pool.query(`SELECT u.id,u.email,u.email_verified,u.onboarding_version,p.handle,p.display_name,p.avatar_media_id,
      COALESCE(pref.settings->>'timezone','UTC') AS timezone FROM user_account u LEFT JOIN profile p ON p.user_id=u.id
      LEFT JOIN preference pref ON pref.user_id=u.id WHERE u.id=$1`, [actor.userId]);
    const row = userResult.rows[0];
    if (!row || typeof row.email !== 'string' || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(row.email)) throw new CommandError(503,'ACCOUNT_UNAVAILABLE','Account details are temporarily unavailable.');
    const entitlement = await this.pool.query(`SELECT plan,limits,valid_until FROM subscription_entitlement WHERE user_id=$1 AND valid_from<=now() AND (valid_until IS NULL OR valid_until>now()) AND ${billingEntitlementPredicate('',2)}`,[actor.userId,...billingEntitlementScope(process.env)]);
    const active = entitlement.rows[0];
    const scope=billingEntitlementScope(process.env);
    const sub = await this.pool.query('SELECT provider_status,paid_through,grace_until FROM subscription WHERE user_id=$1 AND provider_account=$2 AND mode=$3 ORDER BY last_reconciled_at DESC NULLS LAST,id DESC LIMIT 1',[actor.userId,scope[0],scope[1]]);
    const subscription = sub.rows[0];
    const roles = await this.roles(actor.userId);
    const authSession = await this.pool.query('SELECT mfa_at,assurance FROM app_session WHERE id=$1 AND user_id=$2 AND revoked_at IS NULL',[actor.sessionId,actor.userId]);
    const mfaVerified = Boolean(authSession.rows[0]?.mfa_at && isMfaAssurance(authSession.rows[0].assurance,this.config.mfaAssurance));
    const mfaRecent = Boolean(mfaVerified && Date.now()-new Date(authSession.rows[0].mfa_at).getTime() <= STEP_UP_MS);
      const profile = row.handle ? { id: row.id, handle: row.handle, displayName: row.display_name, avatarUrl: row.avatar_media_id ? `/api/v1/media/${row.avatar_media_id}/content` : null, pro: active?.plan === 'pro' } : { id: row.id, handle: `member_${row.id.replaceAll('-','').slice(0,12)}`, displayName: 'New member', avatarUrl: null, pro: active?.plan === 'pro' };
    const plan = active?.plan === 'pro' ? 'pro' : 'free';
    const allowedStatuses = new Set(['free','active','trialing','past_due','canceled','unpaid','incomplete','incomplete_expired']);
    const candidateStatus = subscription?.provider_status;
    const status = typeof candidateStatus === 'string' && allowedStatuses.has(candidateStatus) ? candidateStatus : plan === 'pro' ? 'active' : 'free';
    return { user: profile, email: row.email ?? '', emailVerified: row.email_verified, onboarded: Boolean(row.onboarding_version), roles, timezone: row.timezone ?? 'UTC', security:{mfaVerified,mfaRecent}, entitlement: {
      plan, status, paidThrough: subscription?.paid_through ? iso(subscription.paid_through) : null,
      graceUntil: subscription?.grace_until ? iso(subscription.grace_until) : null, limits: contractLimits(plan),
    }, csrfToken: actor.csrfToken };
  }

  async completeOnboarding(actor: Actor, body: Record<string, unknown>): Promise<Record<string, unknown>> {
    const handle = validateHandle(String(body.handle ?? ''));
    const displayName = String(body.displayName ?? '').trim();
    if (!actor.emailVerified) throw new CommandError(403,'EMAIL_VERIFICATION_REQUIRED','Verify your email to continue.');
    if (!/^[a-z0-9_]{3,30}$/.test(handle) || displayName.length < 2 || displayName.length > 60 || !['beginner','intermediate','experienced'].includes(String(body.experience)) || !Array.isArray(body.interests) || body.interests.length > 3 || body.interests.some((item) => !['stock','option','future'].includes(String(item))) || !isValidTimezone(body.timezone) || body.adultUSDeclaration !== true || body.termsVersion !== this.config.termsVersion) throw new CommandError(422,'INVALID_ONBOARDING','Complete the required account setup fields.');
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      const existing = await client.query('SELECT normalized_handle FROM profile WHERE user_id=$1 FOR UPDATE',[actor.userId]);
      if (existing.rowCount) throw new CommandError(409,'ALREADY_ONBOARDED','Account setup is already complete.');
      const reserved = await client.query('SELECT 1 FROM handle_history WHERE old_handle=$1',[handle]);
      if (reserved.rowCount) throw new CommandError(409,'HANDLE_UNAVAILABLE','That handle is reserved.');
      const ins = await client.query(`INSERT INTO profile(user_id,handle,normalized_handle,display_name,interests,links,revision,created_at,updated_at)
        VALUES($1,$2,$2,$3,$4,'[]',1,now(),now()) ON CONFLICT(normalized_handle) DO NOTHING RETURNING user_id`, [actor.userId,handle,displayName,JSON.stringify(body.interests ?? [])]);
      if (!ins.rowCount) throw new CommandError(409,'HANDLE_UNAVAILABLE','That handle is unavailable.');
      await client.query(`UPDATE user_account SET onboarding_version=$2,declaration_version=$3,policy_version=$3,updated_at=now() WHERE id=$1`,[actor.userId,this.config.termsVersion,this.config.termsVersion]);
      await client.query(`INSERT INTO policy_acceptance(id,user_id,policy_slug,version,accepted_at)
        SELECT gen_random_uuid(),$1,policy_slug,$2,now() FROM unnest(ARRAY['terms','privacy','risk-disclosure','community-guidelines','adult-us-declaration']) AS policy_slug
        ON CONFLICT(user_id,policy_slug,version) DO NOTHING`,[actor.userId,this.config.termsVersion]);
      await client.query(`INSERT INTO preference(id,user_id,settings,updated_at) VALUES($1,$2,$3,now()) ON CONFLICT(user_id) DO UPDATE SET settings=preference.settings || EXCLUDED.settings,updated_at=now()`,[randomUUID(),actor.userId,JSON.stringify({theme:'system',timezone:body.timezone,digestEnabled:false,digestHour:8,quietFrom:'22:00',quietUntil:'08:00',publicationNotices:true,replyNotices:true,experience:body.experience,interests:body.interests})]);
      await enqueueTransactionalNotification(client,{recipientUserId:actor.userId,category:'account',internalUrl:'/app',text:'Your account setup is complete.',email:{subject:'Your account is ready',title:'Welcome',body:'Your account setup is complete. You can review your profile and preferences in the app.'}});
      await client.query('COMMIT');
    } catch (error) { await client.query('ROLLBACK').catch(()=>undefined); if(error instanceof CommandError) throw error; throw new CommandError(503,'ONBOARDING_UNAVAILABLE','Account setup could not be saved.'); }
    finally { client.release(); }
    return this.me(actor);
  }

  async getPreferences(actor: Actor): Promise<Record<string, unknown>> {
    const result = await this.pool.query(`SELECT p.settings,(d.suppressed_at IS NOT NULL) AS digest_suppressed
      FROM preference p LEFT JOIN digest_suppression d ON d.owner_user_id=p.user_id WHERE p.user_id=$1`,[actor.userId]);
    return shapePreferences(result.rows[0]?.settings,Boolean(result.rows[0]?.digest_suppressed));
  }

  async updatePreferences(actor: Actor, patch: Record<string, unknown>): Promise<Record<string, unknown>> {
    const allowed = new Set(['theme','timezone','digestEnabled','digestHour','quietFrom','quietUntil','publicationNotices','replyNotices','mentionNotices','bookmarkNotices','moderationNotices','analyticsConsent']);
    if (!patch || Object.keys(patch).some((key) => !allowed.has(key))) throw new CommandError(422,'INVALID_PREFERENCES','Preference values are invalid.');
    const quiet = /^([01]\d|2[0-3]):[0-5]\d$/;
    if (Object.hasOwn(patch,'theme') && !['system','dark','light'].includes(String(patch.theme))
      || Object.hasOwn(patch,'timezone') && !isValidTimezone(patch.timezone)
      || Object.hasOwn(patch,'digestEnabled') && typeof patch.digestEnabled !== 'boolean'
      || Object.hasOwn(patch,'digestHour') && patch.digestHour !== 8
      || Object.hasOwn(patch,'quietFrom') && (typeof patch.quietFrom !== 'string' || !quiet.test(patch.quietFrom))
      || Object.hasOwn(patch,'quietUntil') && (typeof patch.quietUntil !== 'string' || !quiet.test(patch.quietUntil))
      || ['publicationNotices','replyNotices','mentionNotices','bookmarkNotices','moderationNotices','analyticsConsent'].some(key => Object.hasOwn(patch,key) && typeof patch[key] !== 'boolean')) {
      throw new CommandError(422,'INVALID_PREFERENCES','Preference values are invalid.');
    }
    const update = { ...patch } as Record<string,unknown>;
    if (patch.analyticsConsent === true) { update.analyticsConsentVersion='2026-10-20.v1'; update.analyticsConsentAt=new Date().toISOString(); }
    else if (patch.analyticsConsent === false) { update.analyticsConsentVersion=null; update.analyticsConsentAt=null; }
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      // Merge only submitted public fields. Concurrent changes to other preference fields survive.
      await client.query(`INSERT INTO preference(id,user_id,settings,updated_at) VALUES($1,$2,$3::jsonb,now())
        ON CONFLICT(user_id) DO UPDATE SET settings=preference.settings || EXCLUDED.settings,updated_at=now()`,
      [randomUUID(),actor.userId,JSON.stringify(update)]);
      if (patch.digestEnabled === true) await client.query(`INSERT INTO digest_suppression(owner_user_id,suppressed_at,updated_at) VALUES($1,NULL,now())
        ON CONFLICT(owner_user_id) DO UPDATE SET suppressed_at=NULL,updated_at=now()`,[actor.userId]);
      if (patch.analyticsConsent === false) await client.query('DELETE FROM product_event WHERE owner_user_id=$1',[actor.userId]);
      await client.query('COMMIT');
    } catch (error) { await client.query('ROLLBACK').catch(()=>undefined); throw error; }
    finally { client.release(); }
    return this.getPreferences(actor);
  }

  async providerAccountLocation(): Promise<string> {
    await this.oidcConfiguration();
    const url = new URL(this.config.providerAccountUrl);
    if (url.origin !== new URL(this.config.issuer).origin) throw new CommandError(503,'IDENTITY_PROVIDER_UNAVAILABLE','Account settings are temporarily unavailable.');
    return url.href;
  }

  async validateBackchannelLogout(token: string): Promise<void> {
    if (!token || token.length > 10000) throw new CommandError(400,'INVALID_LOGOUT_TOKEN','Logout token is invalid.');
    try {
      const config = await this.oidcConfiguration();
      const metadata = config.serverMetadata();
      if (!metadata.jwks_uri) throw new Error('No JWKS');
      this.logoutJwks ??= createRemoteJWKSet(new URL(metadata.jwks_uri));
      const { payload, protectedHeader } = await jwtVerify(token,this.logoutJwks,{issuer:this.config.issuer,audience:this.config.clientId,clockTolerance:5,maxTokenAge:'2 minutes',requiredClaims:['iss','aud','iat','jti']});
      const claims = payload as Claims;
      const eventValue = claims.events?.[OIDC_LOGOUT_EVENT];
      const validEvent = eventValue !== null && typeof eventValue === 'object' && !Array.isArray(eventValue) && Object.keys(eventValue).length === 0;
      const validSid = claims.sid === undefined || (typeof claims.sid === 'string' && claims.sid.length > 0);
      const validSub = claims.sub === undefined || (typeof claims.sub === 'string' && claims.sub.length > 0);
      if (!protectedHeader.kid || claims.nonce !== undefined || typeof claims.jti !== 'string' || !claims.jti || !claims.iat || Math.abs(Date.now()/1000-claims.iat)>120 || !validEvent || !validSid || !validSub || (!claims.sid && !claims.sub)) throw new Error('Invalid logout claims');
      const client = await this.pool.connect();
      try {
        await client.query('BEGIN');
        await client.query('DELETE FROM oidc_logout_replay WHERE expires_at<=now()');
        const replay = await client.query('INSERT INTO oidc_logout_replay(issuer,jti,expires_at) VALUES($1,$2,to_timestamp($3)+interval \'2 minutes\') ON CONFLICT DO NOTHING RETURNING jti',[claims.iss,claims.jti,claims.iat]);
        if (!replay.rowCount) throw new CommandError(409,'LOGOUT_TOKEN_REPLAYED','Logout token has already been used.');
        if (claims.sid) await client.query('UPDATE app_session SET revoked_at=now() WHERE provider_session_id=$1 AND revoked_at IS NULL',[claims.sid]);
        else await client.query(`UPDATE app_session s SET revoked_at=now() FROM user_account u WHERE s.user_id=u.id AND u.oidc_issuer=$1 AND u.oidc_subject=$2 AND s.revoked_at IS NULL`,[claims.iss,claims.sub]);
        await client.query('COMMIT');
      } catch(error) { await client.query('ROLLBACK').catch(()=>undefined); if(error instanceof CommandError) throw error; throw error; }
      finally { client.release(); }
    } catch(error) { if(error instanceof CommandError) throw error; throw new CommandError(400,'INVALID_LOGOUT_TOKEN','Logout token is invalid.'); }
  }

  cookieHeader(value: string | null, maxAgeSeconds = 0): string {
    const cookieValue = value === null ? '' : value;
    return `${this.config.cookieName}=${cookieValue}; Path=${SESSION_COOKIE_PATH}; HttpOnly; SameSite=Lax${this.config.cookieSecure ? '; Secure' : ''}${value === null ? '; Max-Age=0' : `; Max-Age=${maxAgeSeconds}`}`;
  }
  transactionCookieName(state: string) { return `tc_oidc_tx_${hash(state).slice(0,16)}`; }
  transactionCookieHeader(value: string | null, state: string): string {
    return `${this.transactionCookieName(state)}=${value ?? ''}; Path=/api/v1/auth; HttpOnly; SameSite=Lax${this.config.cookieSecure ? '; Secure' : ''}; Max-Age=${value ? 600 : 0}`;
  }
}

function iso(value: Date | string) { return new Date(value).toISOString(); }
function isMfaAssurance(value: unknown, expected: string) { return value === expected; }
function defaultLimits() { return { watchlists:1, itemsPerWatchlist:25, savedLayouts:1, newJournalEntriesPerMonth:30 }; }
function contractLimits(plan: string) {
  return plan === 'pro' ? {watchlists:10,itemsPerWatchlist:100,savedLayouts:10,newJournalEntriesPerMonth:1000} : defaultLimits();
}
function safePlanIntent(value: unknown): string | null { return value === 'free' || value === 'pro_monthly' || value === 'pro_annual' ? value : null; }
function isUuid(value: string) { return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value); }
function isValidTimezone(value: unknown): value is string {
  if (typeof value !== 'string' || value.length > 64 || value.length === 0) return false;
  try { new Intl.DateTimeFormat('en-US',{timeZone:value}).format(); return true; } catch { return false; }
}
function shapePreferences(input: unknown, digestSuppressed = false): Record<string, unknown> {
  const value = input && typeof input === 'object' && !Array.isArray(input) ? input as Record<string,unknown> : {};
  const quiet = /^([01]\d|2[0-3]):[0-5]\d$/;
  return {
    theme: ['system','dark','light'].includes(String(value.theme)) ? value.theme : 'system',
    timezone: isValidTimezone(value.timezone) ? value.timezone : 'UTC',
    digestEnabled: value.digestEnabled === true,
    digestHour: 8,
    quietFrom: typeof value.quietFrom === 'string' && quiet.test(value.quietFrom) ? value.quietFrom : '22:00',
    quietUntil: typeof value.quietUntil === 'string' && quiet.test(value.quietUntil) ? value.quietUntil : '08:00',
    publicationNotices: typeof value.publicationNotices === 'boolean' ? value.publicationNotices : true,
    replyNotices: typeof value.replyNotices === 'boolean' ? value.replyNotices : true,
    mentionNotices: typeof value.mentionNotices === 'boolean' ? value.mentionNotices : true,
    bookmarkNotices: typeof value.bookmarkNotices === 'boolean' ? value.bookmarkNotices : true,
    moderationNotices: typeof value.moderationNotices === 'boolean' ? value.moderationNotices : true,
    analyticsConsent: value.analyticsConsent === true,
    analyticsConsentVersion: value.analyticsConsent === true && value.analyticsConsentVersion === '2026-10-20.v1' ? '2026-10-20.v1' : null,
    analyticsConsentAt: value.analyticsConsent === true && typeof value.analyticsConsentAt === 'string' && Number.isFinite(Date.parse(value.analyticsConsentAt)) ? new Date(value.analyticsConsentAt).toISOString() : null,
    accountNotices: true,
    billingNotices: true,
    digestSuppressed,
  };
}
