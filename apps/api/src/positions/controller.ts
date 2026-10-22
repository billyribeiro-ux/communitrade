import { Controller, Get, Inject, Param, Post, Req, Res } from '@nestjs/common';
import { AUTH, AuthService, type AuthRequest } from '../auth/service.js';
import { CommandError } from '../http/problem.js';
import { requestWithPathParams, validateIncomingRequest } from '../http/validate-request.js';
import { parseIfMatch } from '../persistence/transactions.js';
import { PositionService } from './service.js';

export const POSITION_SERVICE = Symbol('POSITION_SERVICE');
export const PERFORMANCE_SERVICE = Symbol('PERFORMANCE_SERVICE');
interface ResponseLike { setHeader(name:string,value:string):void; status(code:number):ResponseLike }
function hasSession(request: AuthRequest) { const cookie = request.headers.cookie; return typeof cookie === 'string' && /(?:^|;\s*)(?:__Host-tc_session|tc_session_dev)=/.test(cookie); }

@Controller()
export class PositionController {
  constructor(@Inject(AUTH) private readonly auth: AuthService, @Inject(POSITION_SERVICE) private readonly positions: PositionService) {}

  private async optionalOwner(req: AuthRequest) {
    if (!hasSession(req)) return undefined;
    return (await this.auth.authenticate(req)).userId;
  }

  @Get('positions/:id')
  async get(@Param('id') id:string,@Req() req:AuthRequest,@Res({passthrough:true}) res:ResponseLike) {
    await this.auth.assertPublicRead(req);
    validateIncomingRequest('getPosition',requestWithPathParams(req,{id}));
    const position=await this.positions.get(id,await this.optionalOwner(req));
    res.setHeader('ETag',`"${position.revision}"`);
    return position;
  }

  @Get('positions/:id/events')
  async listEvents(@Param('id') id:string,@Req() req:AuthRequest) {
    await this.auth.assertPublicRead(req);
    const valid=validateIncomingRequest('listPositionEvents',{headers:req.headers,params:{id},query:req.query as Record<string,unknown>});
    return this.positions.listEvents(id,await this.optionalOwner(req),valid.query?.cursor,valid.query?.limit);
  }

  @Post('positions/:id/events')
  async append(@Param('id') id:string,@Req() req:AuthRequest,@Res({passthrough:true}) res:ResponseLike) {
    const actor=await this.auth.authenticate(req,{verified:true,onboarded:true});
    await this.auth.assertCsrf(req,actor);
    const valid=validateIncomingRequest('appendPositionEvent',requestWithPathParams(req,{id}));
    const key=req.headers['idempotency-key'];
    if(typeof key!=='string') throw new CommandError(400,'INVALID_COMMAND_KEY');
    const receipt=await this.positions.append(actor.userId,id,parseIfMatch(req.headers['if-match']),key,valid.body as any);
    const current=await this.positions.get(id,actor.userId);
    res.status(201);res.setHeader('ETag',`"${current.revision}"`);
    return receipt;
  }
}

@Controller()
export class PerformanceController {
  constructor(@Inject(AUTH) private readonly auth: AuthService,@Inject(PERFORMANCE_SERVICE) private readonly performance: import('./service.js').PerformanceService) {}

  @Get('users/:handle/performance')
  async get(@Param('handle') handle:string,@Req() req:AuthRequest) {
    await this.auth.assertPublicRead(req);
    const valid=validateIncomingRequest('getPerformance',{headers:req.headers,params:{handle},query:req.query as Record<string,unknown>});
    return this.performance.get(handle,{
      ...(valid.query?.asset === undefined ? {} : {asset:valid.query.asset as string}),
      ...(valid.query?.strategy === undefined ? {} : {strategy:valid.query.strategy as string}),
    });
  }
}
