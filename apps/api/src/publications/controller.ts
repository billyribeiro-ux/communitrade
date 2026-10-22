import { Controller, Get, Inject, Param, Post, Req, Res } from '@nestjs/common';
import { AUTH, AuthService, type AuthRequest } from '../auth/service.js';
import { CommandError } from '../http/problem.js';
import { requestWithPathParams, validateIncomingRequest } from '../http/validate-request.js';
import { parseIfMatch } from '../persistence/transactions.js';
import { PublicationService } from './service.js';
import { MEDIA_SERVICE } from '../media/controller.js';
import type { MediaService } from '../media/service.js';
import type { components } from '@trading/contracts';
import { createAttributedShareImage } from '@trading/media';
import { INSTRUMENT_SERVICE } from '../instruments/controller.js';
import type { InstrumentService } from '../instruments/service.js';

export const PUBLICATION_SERVICE=Symbol('PUBLICATION_SERVICE');
interface ResponseLike {status(code:number):ResponseLike;setHeader(name:string,value:string):void;json(body:unknown):void;send(data:Buffer):void}
type InternalRequest=AuthRequest&{headers:Record<string,string|string[]|undefined>};

@Controller()
export class PublicationController {
  constructor(@Inject(AUTH)private readonly auth:AuthService,@Inject(PUBLICATION_SERVICE)private readonly publications:PublicationService,@Inject(MEDIA_SERVICE)private readonly media:MediaService|null,@Inject(INSTRUMENT_SERVICE)private readonly instruments:InstrumentService|null){}

  @Get('publications')
  async list(@Req()req:AuthRequest):Promise<components['schemas']['PublicationPage']>{
    await this.auth.assertPublicRead(req);
    const valid=validateIncomingRequest('listPublications',req);
    const viewer=await this.auth.optionalActor(req);
    return this.publications.listPublications(valid.query??{},viewer?.userId);
  }

  @Get('publications/:id/share')
  async shareMetadata(@Param('id')id:string,@Req()req:AuthRequest):Promise<components['schemas']['ShareMetadata']>{
    await this.auth.assertPublicRead(req);
    validateIncomingRequest('getShareMetadata',requestWithPathParams(req,{id}));
    const origin=process.env.PUBLIC_SITE_URL??process.env.WEB_ORIGIN??'http://localhost:3000';
    return this.publications.getShareMetadata(id,origin);
  }

  @Post('drafts/:id/publish')
  async publish(@Param('id')id:string,@Req()req:AuthRequest,@Res({passthrough:true})res:ResponseLike){
    const actor=await this.auth.authenticate(req,{verified:true,onboarded:true});await this.auth.assertCsrf(req,actor);
    const valid=validateIncomingRequest('publishDraft',requestWithPathParams(req,{id}));
    const expected=parseIfMatch(req.headers['if-match']);
    const result=await this.publications.publish(actor.userId,id,req.headers['if-match'],String(req.headers['idempotency-key']),valid.body as {draftRevision:number;chartRevision:number});
    res.status(202);res.setHeader('ETag',`"${expected}"`);return result;
  }

  @Get('publication-jobs/:id')
  async getJob(@Param('id')id:string,@Req()req:AuthRequest):Promise<components['schemas']['PublicationJob']>{
    const actor=await this.auth.authenticate(req,{verified:true,onboarded:true});validateIncomingRequest('getPublicationJob',requestWithPathParams(req,{id}));
    return this.publications.getPublicationJob(actor.userId,id);
  }

  @Get('publications/:id')
  async getPublication(@Param('id')id:string,@Req()req:AuthRequest):Promise<components['schemas']['Publication']>{
    await this.auth.assertPublicRead(req);validateIncomingRequest('getPublication',requestWithPathParams(req,{id}));
    return this.publications.getPublication(id);
  }

  @Get('publications/:id/revisions')
  async getRevisions(@Param('id')id:string,@Req()req:AuthRequest):Promise<components['schemas']['RevisionPage']>{
    await this.auth.assertPublicRead(req);const valid=validateIncomingRequest('getPublicationRevisions',requestWithPathParams(req,{id}));
    return this.publications.getRevisions(id,valid.query?.cursor,valid.query?.limit);
  }

  @Get('publications/:id/versions/:versionId')
  async getVersion(@Param('id')id:string,@Param('versionId')versionId:string,@Req()req:AuthRequest):Promise<components['schemas']['Publication']>{
    await this.auth.assertPublicRead(req);validateIncomingRequest('getPublicationVersion',requestWithPathParams(req,{id,versionId}));
    return this.publications.getPublication(id,versionId);
  }

  @Get('publications/:id/share/image')
  async shareImage(@Param('id')id:string,@Req()req:AuthRequest,@Res()res:ResponseLike){
    await this.auth.assertPublicRead(req);
    const valid=validateIncomingRequest('getShareImage',requestWithPathParams(req,{id}));
    const versionId=String(valid.query?.versionId??'');
    await this.publications.assertShareImageExport(id,versionId);
    if(!this.media)throw new CommandError(503,'MEDIA_UNAVAILABLE','Publication image storage is unavailable.');
    let bytes=await this.media.content(null,versionId);
    if(valid.query?.download===true||valid.query?.download==='true'){
      const publication=await this.publications.getPublication(id,versionId);
      if(!this.instruments)throw new CommandError(503,'INSTRUMENT_SERVICE_UNAVAILABLE','The source attribution service is temporarily unavailable.');
      const instrument=await this.instruments.get(publication.chart.instrumentId,publication.chart.metadataVersion,'public');
      bytes=await createAttributedShareImage(bytes,{authorHandle:publication.author.handle,publishedAt:publication.publishedAt,strategy:publication.plan?.strategy??'educational content',instrument:`${instrument.symbol}${instrument.contractMonth?` · ${instrument.contractMonth}`:''}${publication.plan?.asset==='option'?' · underlying chart for options':''}`});
      res.setHeader('Content-Disposition',`attachment; filename="idea-${id}-${versionId}.webp"`);
    }
    res.setHeader('Content-Type','image/webp');res.setHeader('Cache-Control','private, no-store');res.setHeader('X-Content-Type-Options','nosniff');res.status(200).send(bytes);
  }

  @Post('internal/publication-snapshot-jobs/:jobId/claim')
  async claimRender(@Param('jobId')jobId:string,@Req()req:InternalRequest){
    const token=single(req.headers['x-publication-render-token']);const secret=process.env.PUBLICATION_RENDER_HMAC_SECRET;
    if(!secret||!token)throw new CommandError(401,'INVALID_RENDER_TOKEN','Render authorization is invalid or expired.');
    return this.publications.loadCandidateByToken(token,secret,jobId);
  }

  @Post('internal/publication-snapshot-jobs/:jobId/complete')
  async completeRender(@Param('jobId')jobId:string,@Req()req:InternalRequest){
    const token=single(req.headers['x-publication-render-token']);const secret=process.env.PUBLICATION_RENDER_HMAC_SECRET;
    if(!secret||!token)throw new CommandError(401,'INVALID_RENDER_TOKEN','Render authorization is invalid or expired.');
    if(!isObject(req.body)||Object.keys(req.body).some(key=>!['objectKey','checksum','width','height','mime'].includes(key)))throw new CommandError(400,'INVALID_SNAPSHOT_ARTIFACT','Snapshot artifact metadata is invalid.');
    return this.publications.completeByToken(token,secret,jobId,req.body as any);
  }

  @Post('internal/publication-snapshot-jobs/:jobId/fail')
  async failRender(@Param('jobId')jobId:string,@Req()req:InternalRequest){
    const token=single(req.headers['x-publication-render-token']);const secret=process.env.PUBLICATION_RENDER_HMAC_SECRET;
    if(!secret||!token)throw new CommandError(401,'INVALID_RENDER_TOKEN','Render authorization is invalid or expired.');
    if(!isObject(req.body)||Object.keys(req.body).some(key=>!['failureCode','retryable'].includes(key))||typeof req.body.failureCode!=='string'||typeof req.body.retryable!=='boolean')throw new CommandError(400,'INVALID_SNAPSHOT_FAILURE','Snapshot failure report is invalid.');
    return this.publications.failByToken(token,secret,jobId,req.body as {failureCode:string;retryable:boolean});
  }
}

function single(value:string|string[]|undefined):string|undefined{return typeof value==='string'?value:undefined;}
function isObject(value:unknown):value is Record<string,any>{return Boolean(value)&&typeof value==='object'&&!Array.isArray(value);}
