import {Controller,Get,Inject,Param,Post,Req} from '@nestjs/common';
import {AUTH,AuthService,type AuthRequest} from '../auth/service.js';
import {CommandError} from '../http/problem.js';
import {requestWithPathParams,validateIncomingRequest} from '../http/validate-request.js';
import {JobService} from './service.js';
import type {components} from '@trading/contracts';
export const JOB_SERVICE=Symbol('JOB_SERVICE');
@Controller()
export class JobController{
 constructor(@Inject(AUTH)private readonly auth:AuthService,@Inject(JOB_SERVICE)private readonly jobs:JobService){}
 @Get('admin/jobs')async list(@Req()req:AuthRequest):Promise<components['schemas']['OperationalJobPage']>{const actor=await this.auth.authenticate(req,{verified:true,onboarded:true,staff:true,stepUp:true});if(!actor.roles.includes('admin'))throw new CommandError(403,'ADMIN_REQUIRED');const v=validateIncomingRequest('adminListJobs',req);return this.jobs.list(actor.userId,v.query as any);}
 @Post('admin/jobs/:id/actions')async retry(@Param('id')id:string,@Req()req:AuthRequest):Promise<components['schemas']['AuditEvent']>{const actor=await this.auth.authenticate(req,{verified:true,onboarded:true,staff:true,stepUp:true});if(!actor.roles.includes('admin'))throw new CommandError(403,'ADMIN_REQUIRED');await this.auth.assertCsrf(req,actor);const v=validateIncomingRequest('adminActjobs',requestWithPathParams(req,{id})),key=req.headers['idempotency-key'];if(typeof key!=='string')throw new CommandError(400,'INVALID_COMMAND_KEY');return this.jobs.retry(actor.userId,id,key,v.body as any);}
}
