import {createHmac,timingSafeEqual} from 'node:crypto';
import {Controller,Inject,Post,Req} from '@nestjs/common';
import {PUBLICATION_SERVICE} from '../publications/controller.js';
import {PublicationService} from '../publications/service.js';
import {CommandError} from '../http/problem.js';
import {validateIncomingRequest} from '../http/validate-request.js';
import type {AuthRequest} from '../auth/service.js';
export function sourceAuthorization(secret:string,publicationId:string,seconds:number){return createHmac('sha256',secret).update(`notification-source:v1:${publicationId}:${seconds}`).digest('base64url');}
@Controller()
export class NotificationSourceController{
 constructor(@Inject(PUBLICATION_SERVICE)private readonly publications:PublicationService){}
 @Post('internal/notifications/source')async authorize(@Req()req:AuthRequest):Promise<{available:boolean;title?:string;url?:string}>{
  const secret=process.env.SESSION_SECRET??'';
  const header=req.headers['x-notification-authorization'];if(secret.length<32||typeof header!=='string')throw new CommandError(401,'SERVICE_AUTH_REQUIRED');
  const match=/^(\d{10})\.([A-Za-z0-9_-]{43})$/.exec(header);if(!match||Math.abs(Math.floor(Date.now()/1000)-Number(match[1]))>30)throw new CommandError(401,'SERVICE_AUTH_REQUIRED');
  const valid=validateIncomingRequest('authorizeNotificationSource',req),body=valid.body as {publicationId:string};
  const expected=sourceAuthorization(secret,body.publicationId,Number(match[1]));if(!timingSafeEqual(Buffer.from(match[2]!),Buffer.from(expected)))throw new CommandError(401,'SERVICE_AUTH_REQUIRED');
  try{const publication=await this.publications.getPublication(body.publicationId);return {available:true,title:publication.title,url:`/ideas/${publication.id}/${publication.slug}`};}
  catch(error){if(error instanceof CommandError&&[403,404].includes(error.status))return {available:false};throw error;}
 }
}
