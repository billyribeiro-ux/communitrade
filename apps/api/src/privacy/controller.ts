import {Controller,Get,Inject,Post,Param,Req,Res} from '@nestjs/common';
import {AUTH,AuthService,type AuthRequest} from '../auth/service.js';
import {CommandError} from '../http/problem.js';
import {requestWithPathParams,validateIncomingRequest} from '../http/validate-request.js';
import {PrivacyService} from './service.js';
export const PRIVACY_SERVICE=Symbol('PRIVACY_SERVICE');
@Controller()
export class PrivacyController {
 constructor(@Inject(AUTH)private readonly auth:AuthService,@Inject(PRIVACY_SERVICE)private readonly privacy:PrivacyService){}
 @Get('privacy/requests')async own(@Req()req:AuthRequest){const actor=await this.auth.authenticate(req,{verified:true});validateIncomingRequest('listPrivacyRequests',req);return this.privacy.listOwn(actor.userId);}
 @Post('privacy/deletion')async deletion(@Req()req:AuthRequest,@Res({passthrough:true})res:{status(n:number):void}){const actor=await this.auth.authenticate(req,{verified:true});await this.auth.assertCsrf(req,actor);const valid=validateIncomingRequest('requestDeletion',req);const body=valid.body as {confirm:string;reason?:string};const key=req.headers['idempotency-key'];if(typeof key!=='string')throw new CommandError(400,'IDEMPOTENCY_KEY_REQUIRED','A valid idempotency key is required.');const verifiedAt=await this.auth.recentVerification(actor);res.status(202);return this.privacy.requestDeletion(actor.userId,verifiedAt,key,body.confirm,body.reason);}
 @Get('admin/privacy/requests')async list(@Req()req:AuthRequest){const actor=await this.auth.authenticate(req,{verified:true,staff:true,stepUp:true});if(!actor.roles.includes('admin'))throw new CommandError(403,'ADMIN_REQUIRED');const valid=validateIncomingRequest('adminListPrivacyRequests',req);return this.privacy.adminList(typeof valid.query?.status==='string'?valid.query.status:undefined);}
 @Post('admin/privacy/requests/:id/actions')async action(@Param('id')id:string,@Req()req:AuthRequest){const actor=await this.auth.authenticate(req,{verified:true,staff:true,stepUp:true});if(!actor.roles.includes('admin'))throw new CommandError(403,'ADMIN_REQUIRED');await this.auth.assertCsrf(req,actor);const valid=validateIncomingRequest('adminActPrivacyRequest',requestWithPathParams(req,{id}));const body=valid.body as {action:'hold'|'release_hold'|'process';reason:string;holdUntil?:string};const key=req.headers['idempotency-key'];if(typeof key!=='string')throw new CommandError(400,'IDEMPOTENCY_KEY_REQUIRED','A valid idempotency key is required.');return this.privacy.adminAction({actorUserId:actor.userId,sessionId:actor.sessionId,requestId:id,requestTraceId:String(req.headers['x-request-id']??''),idempotencyKey:key,...body});}
}
