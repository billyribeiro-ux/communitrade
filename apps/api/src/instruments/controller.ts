import { Controller, Get, HttpCode, Inject, Param, Post, Req, Res } from '@nestjs/common';
import { AUTH, AuthService, type Actor, type AuthRequest } from '../auth/service.js';
import { CommandError } from '../http/problem.js';
import { requestWithPathParams, validateIncomingRequest } from '../http/validate-request.js';
import { InstrumentService } from './service.js';
export const INSTRUMENT_SERVICE = Symbol('INSTRUMENT_SERVICE');
interface Request extends AuthRequest {
  params?: Record<string, unknown>;
  query?: Record<string, unknown>;
  body?: unknown;
}
interface Response {
  setHeader(name: string, value: string): void;
  status(code: number): Response;
}
const one = (value: unknown) => Array.isArray(value) ? value.length === 1 ? String(value[0]) : undefined : typeof value === 'string' ? value : undefined;
const record = (value: unknown): Record<string, unknown> => value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};
const cookies = (value: unknown) => Object.fromEntries(String(value ?? '').split(';').map(x => x.trim()).filter(Boolean).flatMap(x => {
  const i = x.indexOf('=');
  return i < 0 ? [] : [[x.slice(0, i), decodeURIComponent(x.slice(i + 1))]];
}));
@Controller()
export class InstrumentController {
  constructor(@Inject(AUTH)
  private readonly auth: AuthService, @Inject(INSTRUMENT_SERVICE)
  private readonly instruments: InstrumentService) {}
  private async audience(req: Request): Promise<MarketAudience> {
    await this.auth.assertPublicRead(req);
    const cookie = cookies(req.headers.cookie)[this.auth.config.cookieName];
    if (!cookie) return 'public';
    const actor = await this.auth.authenticate(req);
    return actor.status === 'active' ? 'member' : 'public';
  }
  private async admin(req: Request, write = false): Promise<Actor> {
    const actor = await this.auth.authenticate(req, {
      staff: true,
      stepUp: true
    });
    if (!actor.roles.includes('admin')) throw new CommandError(403, 'ADMIN_REQUIRED', 'Administrator access is required.');
    if (write) await this.auth.assertCsrf(req, actor);
    return actor;
  }
  @Get('instruments')
  async search(@Req()
  req: Request, @Res({
    passthrough: true
  })
  res: Response) {
    const audience = await this.audience(req);
    validateIncomingRequest('searchInstruments', req);
    res.setHeader('Cache-Control', 'no-store');
    return this.instruments.search(one(req.query?.q) ?? '', one(req.query?.asset), one(req.query?.root), one(req.query?.cursor), one(req.query?.limit), audience);
  }
  @Get('instruments/:id')
  async detail(@Param('id')
  id: string, @Req()
  req: Request, @Res({
    passthrough: true
  })
  res: Response) {
    const audience = await this.audience(req);
    validateIncomingRequest('getInstrument', requestWithPathParams(req, {
      id
    }));
    res.setHeader('Cache-Control', 'no-store');
    return this.instruments.get(id, one(req.query?.metadataVersion), audience);
  }
  @Get('instruments/:id/option-contracts')
  async options(@Param('id')
  id: string, @Req()
  req: Request, @Res({
    passthrough: true
  })
  res: Response) {
    const audience = await this.audience(req);
    validateIncomingRequest('listOptionContracts', requestWithPathParams(req, {
      id
    }));
    res.setHeader('Cache-Control', 'no-store');
    return this.instruments.optionContracts(id, one(req.query?.expiration), one(req.query?.optionType), one(req.query?.cursor), one(req.query?.limit), audience);
  }
  @Get('futures-contracts')
  async futures(@Req()
  req: Request, @Res({
    passthrough: true
  })
  res: Response) {
    const audience = await this.audience(req);
    validateIncomingRequest('listFuturesContracts', req);
    res.setHeader('Cache-Control', 'no-store');
    return this.instruments.futuresContracts(one(req.query?.root), one(req.query?.contractMonth), one(req.query?.cursor), one(req.query?.limit), audience);
  }
  @Get('market-data/calendar')
  async calendar(@Req()
  req: Request, @Res({
    passthrough: true
  })
  res: Response) {
    const audience = await this.audience(req);
    validateIncomingRequest('getMarketCalendar', req);
    res.setHeader('Cache-Control', 'no-store');
    return this.instruments.calendar(one(req.query?.venue), one(req.query?.from), one(req.query?.to), one(req.query?.cursor), one(req.query?.limit), audience);
  }
  @Get('instruments/:id/quote')
  async quote(@Param('id')
  id: string, @Req()
  req: Request, @Res({
    passthrough: true
  })
  res: Response) {
    const audience = await this.audience(req);
    validateIncomingRequest('getQuote', requestWithPathParams(req, {
      id
    }));
    res.setHeader('Cache-Control', 'no-store');
    return this.instruments.quote(id, audience);
  }
  @Get('instruments/:id/bars')
  async bars(@Param('id')
  id: string, @Req()
  req: Request, @Res({
    passthrough: true
  })
  res: Response) {
    const audience = await this.audience(req);
    validateIncomingRequest('getBars', requestWithPathParams(req, {
      id
    }));
    res.setHeader('Cache-Control', 'no-store');
    return this.instruments.bars(id, req.query ?? {}, audience);
  }
  @Post('trade-plans/validate-strategy')
  @HttpCode(200)
  async validateStrategy(@Req()
  req: Request, @Res({
    passthrough: true
  })
  res: Response) {
    const audience = await this.audience(req);
    validateIncomingRequest('validateOptionStrategy', req);
    res.setHeader('Cache-Control', 'no-store');
    return this.instruments.validateStrategy(record(req.body), audience);
  }
  @Get('admin/instruments')
  async adminList(@Req()
  req: Request, @Res({
    passthrough: true
  })
  res: Response) {
    await this.admin(req);
    validateIncomingRequest('adminListInstruments', req);
    res.setHeader('Cache-Control', 'no-store');
    return this.instruments.adminList(one(req.query?.q) ?? '', one(req.query?.asset), one(req.query?.cursor), one(req.query?.limit));
  }
  @Get('admin/data')
  async adminData(@Req()
  req: Request, @Res({
    passthrough: true
  })
  res: Response) {
    await this.admin(req);
    validateIncomingRequest('adminDataStatus', req);
    res.setHeader('Cache-Control', 'no-store');
    return this.instruments.adminData();
  }
  @Post('admin/instruments/:id/actions')
  async adminAction(@Param('id')
  id: string, @Req()
  req: Request, @Res({
    passthrough: true
  })
  res: Response) {
    const actor = await this.admin(req, true);
    const body = record(req.body);
    validateIncomingRequest('adminActinstruments', requestWithPathParams(req, {
      id
    }));
    res.setHeader('Cache-Control', 'no-store');
    res.status(201);
    return this.instruments.adminAction(actor, id, body.action, body.reason, one(req.headers['idempotency-key']));
  }
}
type MarketAudience = 'public' | 'member';
