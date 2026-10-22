import { Controller, Get, Inject, Param, Post, Req } from '@nestjs/common';
import { AUTH, AuthService, type AuthRequest } from '../auth/service.js';
import { CommandError } from '../http/problem.js';
import { requestWithPathParams, validateIncomingRequest } from '../http/validate-request.js';
import { CorrectionService } from './service.js';

export const CORRECTION_SERVICE=Symbol('CORRECTION_SERVICE');

@Controller()
export class CorrectionController {
  constructor(@Inject(AUTH) private readonly auth:AuthService,@Inject(CORRECTION_SERVICE) private readonly corrections:CorrectionService){}

  @Post('publications/:id/corrections')
  async request(@Param('id') id:string,@Req() req:AuthRequest){
    const actor=await this.auth.authenticate(req,{verified:true,onboarded:true});await this.auth.assertCsrf(req,actor);
    const valid=validateIncomingRequest('requestCorrection',requestWithPathParams(req,{id}));
    const key=req.headers['idempotency-key'];if(typeof key!=='string')throw new CommandError(400,'INVALID_COMMAND_KEY');
    return this.corrections.request(actor.userId,id,key,valid.body as any);
  }

  @Get('publications/:id/correction-requests')
  async listOwn(@Param('id') id:string,@Req() req:AuthRequest){
    const actor=await this.auth.authenticate(req,{verified:true,onboarded:true});
    const valid=validateIncomingRequest('listOwnCorrectionRequests',requestWithPathParams(req,{id}));
    return this.corrections.listOwn(actor.userId,id,valid.query?.cursor,valid.query?.limit);
  }

  @Get('admin/corrections')
  async listQueue(@Req() req:AuthRequest){
    await this.auth.authenticate(req,{verified:true,onboarded:true,staff:true,stepUp:true});
    const valid=validateIncomingRequest('adminListCorrections',req);
    return this.corrections.listQueue(valid.query?.cursor,valid.query?.limit);
  }

  @Post('admin/corrections/:id/actions')
  async review(@Param('id') id:string,@Req() req:AuthRequest){
    const actor=await this.auth.authenticate(req,{verified:true,onboarded:true,staff:true,stepUp:true});await this.auth.assertCsrf(req,actor);
    const valid=validateIncomingRequest('adminReviewCorrection',requestWithPathParams(req,{id}));
    const key=req.headers['idempotency-key'];if(typeof key!=='string')throw new CommandError(400,'INVALID_COMMAND_KEY');
    const command=valid.body as {action:string;reason:string};
    if(command.action!=='approve'&&command.action!=='reject')throw new CommandError(422,'INVALID_CORRECTION_ACTION');
    return this.corrections.review(actor.userId,id,key,command.action,command.reason);
  }
}
