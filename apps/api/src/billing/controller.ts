import { Controller, Get, Inject, Param, Post, Req, Res } from '@nestjs/common';
import { AUTH, AuthService, type AuthRequest } from '../auth/service.js';
import { CommandError } from '../http/problem.js';
import { requestWithPathParams, validateIncomingRequest } from '../http/validate-request.js';
import { BillingService } from './service.js';

export const BILLING_SERVICE = Symbol('BILLING_SERVICE');
interface ResponseLike { status(code:number):ResponseLike; setHeader(name:string,value:string):void; end():void }
type BillingRequest = AuthRequest & { rawBody?: Uint8Array; params?: Record<string,unknown> };

@Controller()
export class BillingController {
  constructor(@Inject(AUTH) private readonly auth:AuthService,@Inject(BILLING_SERVICE) private readonly billing:BillingService){}
  private async actor(req:AuthRequest,write=false){const actor=await this.auth.authenticate(req,{verified:true,onboarded:true});if(write)await this.auth.assertCsrf(req,actor);return actor;}

  @Get('plans') async plans(@Req()req:AuthRequest){validateIncomingRequest('listPlans',req);return this.billing.listPlans();}
  @Get('billing/subscription') async subscription(@Req()req:AuthRequest){const actor=await this.actor(req);validateIncomingRequest('getSubscription',req);return this.billing.getSubscription(actor.userId);}
  @Post('billing/checkout') async checkout(@Req()req:AuthRequest){
    const actor=await this.actor(req,true),valid=validateIncomingRequest('createCheckout',req),key=req.headers['idempotency-key'];
    if(typeof key!=='string')throw new CommandError(400,'INVALID_COMMAND_KEY');
    return this.billing.createCheckout(actor.userId,valid.body as any,key);
  }
  @Post('billing/portal') async portal(@Req()req:AuthRequest){
    const actor=await this.actor(req,true);validateIncomingRequest('createBillingPortal',req);const key=req.headers['idempotency-key'];
    if(typeof key!=='string')throw new CommandError(400,'INVALID_COMMAND_KEY');return this.billing.createPortal(actor.userId,key);
  }
  @Post('webhooks/stripe') async webhook(@Req()request:BillingRequest,@Res()response:ResponseLike){
    validateIncomingRequest('receiveStripeWebhook',request);
    const raw=request.rawBody??(request.body instanceof Uint8Array?request.body:undefined);
    if(!raw||raw.byteLength>1024*1024)throw new CommandError(400,'INVALID_WEBHOOK_BODY');
    const header=request.headers['stripe-signature'];const signature=Array.isArray(header)?header[0]:header;
    await this.billing.receiveWebhook(raw,signature);response.status(204).end();
  }
  @Get('billing/demo/:sessionId') async demoSession(@Param('sessionId')sessionId:string,@Req()req:AuthRequest){
    const actor=await this.actor(req);validateIncomingRequest('getDemoBillingSession',requestWithPathParams(req,{sessionId}));return this.billing.getDemoSession(actor.userId,sessionId);
  }
  @Post('billing/demo/:sessionId/actions') async demoAction(@Param('sessionId')sessionId:string,@Req()req:AuthRequest){
    const actor=await this.actor(req,true),valid=validateIncomingRequest('actDemoBillingSession',requestWithPathParams(req,{sessionId}));const key=req.headers['idempotency-key'];
    if(typeof key!=='string')throw new CommandError(400,'INVALID_COMMAND_KEY');return this.billing.applyDemoAction(actor.userId,sessionId,(valid.body as any).action,key);
  }
  @Get('admin/billing') async adminList(@Req()req:AuthRequest){
    const actor=await this.auth.authenticate(req,{verified:true,onboarded:true,staff:true,stepUp:true});if(!actor.roles.includes('admin'))throw new CommandError(403,'ADMIN_REQUIRED');
    const valid=validateIncomingRequest('adminListSubscriptions',req);return this.billing.adminListSubscriptions(actor.userId,valid.query?.cursor,valid.query?.limit,valid.query?.q);
  }
  @Post('admin/billing/:id/actions') async adminAction(@Param('id')id:string,@Req()req:AuthRequest){
    const actor=await this.auth.authenticate(req,{verified:true,onboarded:true,staff:true,stepUp:true});if(!actor.roles.includes('admin'))throw new CommandError(403,'ADMIN_REQUIRED');await this.auth.assertCsrf(req,actor);
    const valid=validateIncomingRequest('adminActbilling',requestWithPathParams(req,{id})),key=req.headers['idempotency-key'];if(typeof key!=='string')throw new CommandError(400,'INVALID_COMMAND_KEY');
    return this.billing.adminBillingAction(actor.userId,id,valid.body as any,key);
  }
}
