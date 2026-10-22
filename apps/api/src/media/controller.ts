import { Controller, Get, Inject, Param, Post, Req, Res } from '@nestjs/common';
import { AUTH, AuthService, type AuthRequest } from '../auth/service.js';
import { CommandError } from '../http/problem.js';
import { requestWithPathParams, validateIncomingRequest } from '../http/validate-request.js';
import { MediaService, type UploadInput } from './service.js';
export const MEDIA_SERVICE=Symbol('MEDIA_SERVICE');
interface ResponseLike { setHeader(name:string,value:string):void; status(code:number):ResponseLike; end():void; send(data:Buffer):void; json(body:unknown):void }

@Controller()
export class MediaController {
  constructor(@Inject(AUTH) private readonly auth:AuthService,@Inject(MEDIA_SERVICE) private readonly media:MediaService){}
  @Post('uploads')
  async create(@Req() req:AuthRequest){const actor=await this.auth.authenticate(req,{verified:true,onboarded:true});await this.auth.assertCsrf(req,actor);const valid=validateIncomingRequest('createUploadIntent',req);return this.media.createIntent(actor.userId,req.headers['idempotency-key'] as string,valid.body as UploadInput);}
  @Post('uploads/:id/content')
  async put(@Param('id') id:string,@Req() req:AuthRequest,@Res() res:ResponseLike){
    const actor=await this.auth.authenticate(req,{verified:true,onboarded:true});await this.auth.assertCsrf(req,actor);
    if(!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(id))throw new CommandError(400,'INVALID_UPLOAD_ID','Upload ID is invalid.');
    validateIncomingRequest('uploadLocalBytes',requestWithPathParams(req,{id}));
    const mime=req.headers['content-type'];if(typeof mime!=='string'||!['image/png','image/jpeg','image/webp'].includes(mime))throw new CommandError(400,'INVALID_UPLOAD_TYPE','Use a supported image content type.');
    const bytes=Buffer.isBuffer(req.body)?req.body:undefined;if(!bytes)throw new CommandError(400,'RAW_BODY_REQUIRED','Upload raw image bytes with the matching content type.');
    await this.media.putBytes(actor.userId,id,mime,bytes);res.status(204).end();
  }
  @Post('uploads/:id/complete')
  async complete(@Param('id') id:string,@Req() req:AuthRequest,@Res() res:ResponseLike){const actor=await this.auth.authenticate(req,{verified:true,onboarded:true});await this.auth.assertCsrf(req,actor);validateIncomingRequest('completeUpload',requestWithPathParams(req,{id}));const result=await this.media.complete(actor.userId,id,req.headers['idempotency-key'] as string);res.status(202).json(result);}
  @Get('media/:id')
  async getMeta(@Param('id') id:string,@Req() req:AuthRequest){await this.auth.assertPublicRead(req);validateIncomingRequest('getMedia',requestWithPathParams(req,{id}));let owner:string|null=null;try{owner=(await this.auth.authenticate(req)).userId;}catch(error){if(!(error instanceof CommandError)||![401,403].includes(error.status))throw error;}return this.media.getMeta(owner,id);}
  @Get('media/:id/content')
  async getContent(@Param('id') id:string,@Req() req:AuthRequest,@Res() res:ResponseLike){await this.auth.assertPublicRead(req);validateIncomingRequest('getMediaContent',requestWithPathParams(req,{id}));let owner:string|null=null;try{owner=(await this.auth.authenticate(req)).userId;}catch(error){if(!(error instanceof CommandError)||![401,403].includes(error.status))throw error;}const bytes=await this.media.content(owner,id);res.setHeader('Content-Type','image/webp');res.setHeader('Cache-Control','private, no-store');res.setHeader('X-Content-Type-Options','nosniff');res.status(200).send(bytes);}
}
