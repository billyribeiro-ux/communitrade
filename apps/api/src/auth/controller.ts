import { Controller, Delete, Get, Inject, Patch, Post, Req, Res } from '@nestjs/common';
import { validateIncomingRequest } from '../http/validate-request.js';
import { CommandError } from '../http/problem.js';
import { AUTH, AuthService, type AuthRequest } from './service.js';

interface ResponseLike {
  redirect(status: number, url: string): void;
  status(code: number): ResponseLike;
  json(value: unknown): void;
  end(): void;
  setHeader(name: string, value: string | string[]): void;
  set?(name: string, value: string): ResponseLike;
}

interface HttpRequest extends AuthRequest {
  originalUrl?: string;
  protocol?: string;
  query?: Record<string, unknown>;
  params?: Record<string, unknown>;
  body?: unknown;
}

@Controller()
export class AuthController {
  constructor(@Inject(AUTH) private readonly auth: AuthService) {}

  @Get('auth/login')
  async login(@Req() request: HttpRequest, @Res() response: ResponseLike) {
    validateIncomingRequest('startLogin', request);
    const result = await this.auth.beginLogin({
      ...(one(request.query?.returnTo) ? { returnTo: one(request.query?.returnTo)! } : {}),
      ...(one(request.query?.intent) ? { intent: one(request.query?.intent)! } : {}),
      ...(one(request.query?.screen) ? { screen: one(request.query?.screen)! } : {}),
      address: request.ip ?? request.socket?.remoteAddress ?? 'unknown',
    });
    response.setHeader('Cache-Control', 'no-store');
    response.setHeader('Referrer-Policy', 'no-referrer');
    response.setHeader('Set-Cookie', this.auth.transactionCookieHeader(result.transactionCookie, result.state));
    response.redirect(302, result.location);
  }

  @Get('auth/callback')
  async callback(@Req() request: HttpRequest, @Res() response: ResponseLike) {
    validateIncomingRequest('completeLogin', request);
    const code = one(request.query?.code);
    const state = one(request.query?.state);
    const error = one(request.query?.error);
    if (error || !code || !state) {
      if (state) response.setHeader('Set-Cookie', this.auth.transactionCookieHeader(null, state));
      throw new CommandError(401, 'OIDC_AUTHENTICATION_FAILED', 'Sign-in could not be verified. Start again.');
    }
    const cookies = parseCookies(request.headers.cookie);
    const callbackUrl = new URL(this.auth.config.redirectUri);
    for (const key of ['code', 'state', 'iss', 'session_state']) {
      const value = one(request.query?.[key]);
      if (value !== undefined) callbackUrl.searchParams.set(key, value);
    }
    const result = await this.auth.completeLogin(code, state, cookies[this.auth.transactionCookieName(state)], callbackUrl.href);
    const maxAge = Math.max(0, Math.floor((result.cookie.expiresAt.getTime() - Date.now()) / 1000));
    response.setHeader('Cache-Control', 'no-store');
    response.setHeader('Set-Cookie', [this.auth.cookieHeader(result.cookie.token, maxAge), this.auth.transactionCookieHeader(null, state)]);
    response.redirect(302, result.returnTo);
  }

  @Post('auth/logout')
  async logout(@Req() request: HttpRequest, @Res() response: ResponseLike) {
    const actor = await this.auth.authenticate(request);
    await this.auth.assertCsrf(request, actor);
    await this.auth.revoke(actor);
    response.setHeader('Cache-Control', 'no-store');
    response.setHeader('Set-Cookie', this.auth.cookieHeader(null));
    response.status(204).end();
  }

  @Post('auth/logout-all')
  async logoutAll(@Req() request: HttpRequest, @Res() response: ResponseLike) {
    const actor = await this.auth.authenticate(request);
    await this.auth.assertCsrf(request, actor);
    await this.auth.revokeAll(actor);
    response.setHeader('Cache-Control', 'no-store');
    response.setHeader('Set-Cookie', this.auth.cookieHeader(null));
    response.status(204).end();
  }

  @Get('me')
  async me(@Req() request: HttpRequest, @Res() response: ResponseLike) {
    const actor = await this.auth.authenticate(request);
    response.setHeader('Cache-Control', 'no-store');
    response.json(await this.auth.me(actor));
  }

  @Post('me/onboarding')
  async onboarding(@Req() request: HttpRequest, @Res() response: ResponseLike) {
    const actor = await this.auth.authenticate(request);
    await this.auth.assertCsrf(request, actor);
    validateIncomingRequest('completeOnboarding', request);
    response.setHeader('Cache-Control', 'no-store');
    response.status(201).json(await this.auth.completeOnboarding(actor, asRecord(request.body)));
  }

  @Get('me/preferences')
  async getPreferences(@Req() request: HttpRequest, @Res() response: ResponseLike) {
    const actor = await this.auth.authenticate(request, { verified: true, onboarded: true });
    response.setHeader('Cache-Control', 'no-store');
    response.json(await this.auth.getPreferences(actor));
  }

  @Patch('me/preferences')
  async updatePreferences(@Req() request: HttpRequest, @Res() response: ResponseLike) {
    const actor = await this.auth.authenticate(request, { verified: true, onboarded: true });
    await this.auth.assertCsrf(request, actor);
    validateIncomingRequest('updatePreferences', request);
    response.setHeader('Cache-Control', 'no-store');
    response.json(await this.auth.updatePreferences(actor, asRecord(request.body)));
  }

  @Get('me/sessions')
  async sessions(@Req() request: HttpRequest, @Res() response: ResponseLike) {
    const actor = await this.auth.authenticate(request);
    validateIncomingRequest('listSessions', request);
    const limit = Number(one(request.query?.limit) ?? 20);
    response.setHeader('Cache-Control', 'no-store');
    response.json(await this.auth.listSessions(actor, limit, one(request.query?.cursor)));
  }

  @Delete('me/sessions/:id')
  async revokeSession(@Req() request: HttpRequest, @Res() response: ResponseLike) {
    const actor = await this.auth.authenticate(request);
    await this.auth.assertCsrf(request, actor);
    validateIncomingRequest('revokeSession', request);
    await this.auth.revokeSession(actor, String(request.params?.id));
    response.setHeader('Cache-Control', 'no-store');
    response.status(204).end();
  }

  @Post('webhooks/oidc/logout')
  async backchannelLogout(@Req() request: HttpRequest, @Res() response: ResponseLike) {
    validateIncomingRequest('oidcBackchannelLogout', request);
    const body = asRecord(request.body);
    await this.auth.validateBackchannelLogout(String(body.logout_token ?? ''));
    response.status(204).end();
  }

  @Get('auth/account')
  async providerAccount(@Req() request: HttpRequest, @Res() response: ResponseLike) {
    await this.auth.authenticate(request);
    response.setHeader('Cache-Control', 'no-store');
    response.redirect(302, await this.auth.providerAccountLocation());
  }

  @Get('auth/step-up')
  async stepUp(@Req() request: HttpRequest, @Res() response: ResponseLike) {
    const actor = await this.auth.authenticate(request);
    const result = await this.auth.beginLogin({ stepUp: true, actor, address: request.ip ?? request.socket?.remoteAddress ?? 'unknown' });
    response.setHeader('Cache-Control', 'no-store');
    response.setHeader('Referrer-Policy', 'no-referrer');
    response.setHeader('Set-Cookie', this.auth.transactionCookieHeader(result.transactionCookie, result.state));
    response.redirect(302, result.location);
  }
}

function one(value: unknown): string | undefined {
  if (typeof value === 'string') return value;
  if (Array.isArray(value) && typeof value[0] === 'string') return value[0];
  return undefined;
}
function asRecord(value: unknown): Record<string, unknown> { return value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {}; }
function parseCookies(header: string | string[] | undefined): Record<string, string> {
  const value = Array.isArray(header) ? header[0] ?? '' : header ?? '';
  const out: Record<string, string> = {};
  for (const piece of value.split(';')) { const idx = piece.indexOf('='); if (idx > 0) out[piece.slice(0, idx).trim()] = piece.slice(idx + 1).trim(); }
  return out;
}
