import { Controller, Delete, Get, Inject, Param, Patch, Post, Put, Req, Res } from '@nestjs/common';
import { AUTH, AuthService, type AuthRequest } from '../auth/service.js';
import { CommandError } from '../http/problem.js';
import { requestWithPathParams, validateIncomingRequest } from '../http/validate-request.js';
import { NotificationService } from './service.js';

export const NOTIFICATION_SERVICE = Symbol('NOTIFICATION_SERVICE');
interface ResponseLike { status(code:number):ResponseLike; setHeader(name:string,value:string):void; end():void }
type Request = AuthRequest & { query?:Record<string,unknown>; body?:unknown };
const record=(value:unknown)=>value&&typeof value==='object'&&!Array.isArray(value)?value as Record<string,unknown>:{};

@Controller()
export class NotificationController {
  constructor(@Inject(AUTH) private readonly auth:AuthService,@Inject(NOTIFICATION_SERVICE) private readonly notifications:NotificationService){}

  @Get('notifications')
  async list(@Req() req:Request){
    const actor=await this.auth.authenticate(req,{verified:true,onboarded:true});
    validateIncomingRequest('listNotifications',req);
    return this.notifications.listNotifications(actor.userId,req.query?.cursor,req.query?.limit,req.query?.unreadOnly);
  }

  @Put('notifications/:id/read')
  async read(@Param('id') id:string,@Req() req:Request,@Res() res:ResponseLike){
    const actor=await this.auth.authenticate(req,{verified:true,onboarded:true});await this.auth.assertCsrf(req,actor);
    validateIncomingRequest('readNotification',requestWithPathParams(req,{id}));
    await this.notifications.markRead(actor.userId,id);res.status(204).end();
  }

  @Post('notifications/read-all')
  async readAll(@Req() req:Request,@Res() res:ResponseLike){
    const actor=await this.auth.authenticate(req,{verified:true,onboarded:true});await this.auth.assertCsrf(req,actor);
    validateIncomingRequest('readAllNotifications',req);await this.notifications.readAll(actor.userId);res.status(204).end();
  }

  @Get('me/saved-searches')
  async savedSearches(@Req() req:Request){
    const actor=await this.auth.authenticate(req,{verified:true,onboarded:true});validateIncomingRequest('listSavedSearches',req);
    return this.notifications.listSavedSearches(actor.userId,req.query?.cursor,req.query?.limit);
  }

  @Post('me/saved-searches')
  async createSavedSearch(@Req() req:Request,@Res({passthrough:true}) res:ResponseLike){
    const actor=await this.auth.authenticate(req,{verified:true,onboarded:true});await this.auth.assertCsrf(req,actor);
    const valid=validateIncomingRequest('createSavedSearch',req),key=req.headers['idempotency-key'];
    if(typeof key!=='string')throw new CommandError(400,'INVALID_COMMAND_KEY');
    const result=await this.notifications.createSavedSearch(actor.userId,key,record(valid.body) as {name:unknown;filters:unknown});
    res.status(201);return result;
  }

  @Patch('me/saved-searches/:id')
  async updateSavedSearch(@Param('id') id:string,@Req() req:Request){
    const actor=await this.auth.authenticate(req,{verified:true,onboarded:true});await this.auth.assertCsrf(req,actor);
    const valid=validateIncomingRequest('updateSavedSearch',requestWithPathParams(req,{id}));
    return this.notifications.updateSavedSearch(actor.userId,id,req.headers['if-match'],record(valid.body));
  }

  @Delete('me/saved-searches/:id')
  async deleteSavedSearch(@Param('id') id:string,@Req() req:Request,@Res() res:ResponseLike){
    const actor=await this.auth.authenticate(req,{verified:true,onboarded:true});await this.auth.assertCsrf(req,actor);
    validateIncomingRequest('deleteSavedSearch',requestWithPathParams(req,{id}));
    await this.notifications.deleteSavedSearch(actor.userId,id,req.headers['if-match']);res.status(204).end();
  }

  @Post('digest/unsubscribe')
  async unsubscribe(@Req() req:Request,@Res() res:ResponseLike){
    validateIncomingRequest('unsubscribeDigest',req);
    const body=record(req.body);await this.notifications.unsubscribeDigest(body.token);res.status(204).end();
  }
}
