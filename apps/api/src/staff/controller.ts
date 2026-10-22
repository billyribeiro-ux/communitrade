import { Controller, Get, Inject, Param, Post, Req, Res } from '@nestjs/common';
import { AUTH, AuthService, type Actor, type AuthRequest } from '../auth/service.js';
import { CommandError } from '../http/problem.js';
import { requestWithPathParams, validateIncomingRequest } from '../http/validate-request.js';
import { StaffService } from './service.js';

export const STAFF_SERVICE=Symbol('STAFF_SERVICE');
interface ResponseLike{setHeader(name:string,value:string):void}

@Controller()
export class StaffController{
  constructor(@Inject(AUTH) private readonly auth:AuthService,@Inject(STAFF_SERVICE) private readonly staff:StaffService){}

  private async authenticateStaff(req:AuthRequest,sensitiveAdmin=false):Promise<Actor>{
    let actor=await this.auth.authenticate(req,{verified:true,onboarded:true,staff:true});
    if(sensitiveAdmin&&actor.roles.includes('admin'))actor=await this.auth.authenticate(req,{verified:true,onboarded:true,staff:true,stepUp:true});
    return actor;
  }
  private key(req:AuthRequest){const key=req.headers['idempotency-key'];if(typeof key!=='string')throw new CommandError(400,'INVALID_COMMAND_KEY');return key;}

  @Get('admin/overview')
  async overview(@Req() req:AuthRequest){const actor=await this.authenticateStaff(req,true);return this.staff.overview(actor.userId,actor.roles);}

  @Get('admin/reports')
  async reports(@Req() req:AuthRequest){const actor=await this.authenticateStaff(req,true);const valid=validateIncomingRequest('adminListReportreports',req);return this.staff.reports(actor.userId,actor.roles,valid.query?.cursor,valid.query?.limit);}
  @Get('admin/reports/:id')
  async report(@Param('id') id:string,@Req() req:AuthRequest){const actor=await this.authenticateStaff(req,true);validateIncomingRequest('adminGetReport',requestWithPathParams(req,{id}));return this.staff.report(actor.userId,actor.roles,id);}
  @Post('admin/reports/:id/actions')
  async reportAction(@Param('id') id:string,@Req() req:AuthRequest){const actor=await this.authenticateStaff(req,true);await this.auth.assertCsrf(req,actor);const valid=validateIncomingRequest('adminActreports',requestWithPathParams(req,{id}));return this.staff.actReport(actor.userId,actor.roles,id,this.key(req),valid.body as any);}

  @Get('admin/appeals')
  async appeals(@Req() req:AuthRequest){const actor=await this.authenticateStaff(req,true);const valid=validateIncomingRequest('adminListReportappeals',req);return this.staff.listAppeals(actor.userId,actor.roles,valid.query?.cursor,valid.query?.limit);}
  @Post('admin/appeals/:id/actions')
  async appealAction(@Param('id') id:string,@Req() req:AuthRequest){const actor=await this.authenticateStaff(req,true);await this.auth.assertCsrf(req,actor);const valid=validateIncomingRequest('adminActappeals',requestWithPathParams(req,{id}));return this.staff.actAppeal(actor.userId,actor.roles,id,this.key(req),valid.body as any);}

  @Get('admin/users')
  async users(@Req() req:AuthRequest){const actor=await this.authenticateStaff(req,true);const valid=validateIncomingRequest('adminListUsers',req);return this.staff.users(actor.roles,valid.query?.cursor,valid.query?.limit,valid.query?.q);}
  @Post('admin/users/:id/actions')
  async userAction(@Param('id') id:string,@Req() req:AuthRequest){const actor=await this.authenticateStaff(req,true);await this.auth.assertCsrf(req,actor);const valid=validateIncomingRequest('adminActusers',requestWithPathParams(req,{id}));return this.staff.actUser(actor.userId,actor.roles,id,this.key(req),valid.body as any);}

  @Get('admin/editorial')
  async editorial(@Req() req:AuthRequest){const actor=await this.authenticateStaff(req,true);const valid=validateIncomingRequest('adminListEditorial',req);return this.staff.editorial(actor.roles,valid.query?.cursor,valid.query?.limit,valid.query?.q);}
  @Post('admin/editorial/:id/actions')
  async editorialAction(@Param('id') id:string,@Req() req:AuthRequest){const actor=await this.authenticateStaff(req,true);await this.auth.assertCsrf(req,actor);const valid=validateIncomingRequest('adminActeditorial',requestWithPathParams(req,{id}));return this.staff.actEditorial(actor.userId,actor.roles,id,this.key(req),valid.body as any);}

  @Get('admin/audit')
  async audit(@Req() req:AuthRequest){const actor=await this.authenticateStaff(req,true);const valid=validateIncomingRequest('adminListAuditEventaudit',req);return this.staff.audit(actor.userId,actor.roles,valid.query?.cursor,valid.query?.limit,valid.query?.q);}
  @Get('admin/audit/export')
  async exportAudit(@Req() req:AuthRequest,@Res({passthrough:true}) res:ResponseLike){const actor=await this.authenticateStaff(req,true);const valid=validateIncomingRequest('adminExportAudit',req);const csv=await this.staff.exportAudit(actor.roles,valid.query?.limit??5000,valid.query?.q);res.setHeader('Content-Type','text/csv; charset=utf-8');res.setHeader('Content-Disposition','attachment; filename="audit-events.csv"');res.setHeader('Cache-Control','no-store');return csv;}
}
