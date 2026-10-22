import { Controller, Delete, Get, Inject, Param, Patch, Post, Req, Res } from '@nestjs/common';
import { AUTH, AuthService, type AuthRequest } from '../auth/service.js';
import { CommandError } from '../http/problem.js';
import { requestWithPathParams, validateIncomingRequest } from '../http/validate-request.js';
import { parseIfMatch } from '../persistence/transactions.js';
import { POSITION_SERVICE } from '../positions/controller.js';
import { PositionService } from '../positions/service.js';
import { JournalService } from './service.js';

export const JOURNAL_SERVICE=Symbol('JOURNAL_SERVICE');
interface ResponseLike{setHeader(name:string,value:string):void;status(code:number):ResponseLike}

@Controller()
export class JournalController {
  constructor(@Inject(AUTH) private readonly auth:AuthService,@Inject(JOURNAL_SERVICE) private readonly journal:JournalService,@Inject(POSITION_SERVICE) private readonly positions:PositionService){}

  @Get('journal')
  async list(@Req() req:AuthRequest){
    const actor=await this.auth.authenticate(req,{verified:true,onboarded:true});
    const valid=validateIncomingRequest('listJournal',{headers:req.headers,query:req.query as Record<string,unknown>});
    return this.journal.list(actor.userId,valid.query as any);
  }

  @Post('journal')
  async create(@Req() req:AuthRequest,@Res({passthrough:true}) res:ResponseLike){
    const actor=await this.auth.authenticate(req,{verified:true,onboarded:true});
    await this.auth.assertCsrf(req,actor);
    const valid=validateIncomingRequest('createJournalEntry',requestWithPathParams(req,{}));
    const key=req.headers['idempotency-key'];
    if(typeof key!=='string')throw new CommandError(400,'INVALID_COMMAND_KEY');
    const result=await this.journal.create(actor.userId,key,valid.body as any);
    res.status(201);res.setHeader('ETag',`"${result.revision}"`);
    return result;
  }

  @Get('journal-analytics')
  async analytics(@Req() req:AuthRequest){
    const actor=await this.auth.authenticate(req,{verified:true,onboarded:true});
    const valid=validateIncomingRequest('getJournalAnalytics',{headers:req.headers,query:req.query as Record<string,unknown>});
    return this.journal.analytics(actor.userId,valid.query as any);
  }

  @Get('journal/:id')
  async get(@Param('id') id:string,@Req() req:AuthRequest,@Res({passthrough:true}) res:ResponseLike){
    const actor=await this.auth.authenticate(req,{verified:true,onboarded:true});
    validateIncomingRequest('getJournalEntry',requestWithPathParams(req,{id}));
    const result=await this.journal.get(actor.userId,id);
    res.setHeader('ETag',`"${result.revision}"`);
    return result;
  }

  @Patch('journal/:id')
  async update(@Param('id') id:string,@Req() req:AuthRequest,@Res({passthrough:true}) res:ResponseLike){
    const actor=await this.auth.authenticate(req,{verified:true,onboarded:true});
    await this.auth.assertCsrf(req,actor);
    const valid=validateIncomingRequest('saveJournalEntry',requestWithPathParams(req,{id}));
    const result=await this.journal.update(actor.userId,id,parseIfMatch(req.headers['if-match']),valid.body as any);
    res.setHeader('ETag',`"${result.revision}"`);
    return result;
  }

  @Delete('journal/:id')
  async delete(@Param('id') id:string,@Req() req:AuthRequest,@Res({passthrough:true}) res:ResponseLike){
    const actor=await this.auth.authenticate(req,{verified:true,onboarded:true});
    await this.auth.assertCsrf(req,actor);
    validateIncomingRequest('deleteJournalEntry',requestWithPathParams(req,{id}));
    await this.journal.delete(actor.userId,id,parseIfMatch(req.headers['if-match']));
    res.status(204);
    return undefined;
  }

  @Post('journal/:id/position-corrections')
  async correctPrivatePositionEvent(@Param('id') id:string,@Req() req:AuthRequest,@Res({passthrough:true}) res:ResponseLike){
    const actor=await this.auth.authenticate(req,{verified:true,onboarded:true});
    await this.auth.assertCsrf(req,actor);
    const valid=validateIncomingRequest('correctPrivatePositionEvent',requestWithPathParams(req,{id}));
    const body=valid.body as {sourceEventId:string;event:any};
    const key=req.headers['idempotency-key'];
    if(typeof key!=='string')throw new CommandError(400,'INVALID_COMMAND_KEY');
    const positionId=await this.journal.privatePositionId(actor.userId,id);
    const receipt=await this.positions.correctPrivateEvent(actor.userId,positionId,parseIfMatch(req.headers['if-match']),body.sourceEventId,key,body.event);
    const current=await this.positions.get(positionId,actor.userId);
    res.status(201);res.setHeader('ETag',`"${current.revision}"`);
    return receipt;
  }
}
