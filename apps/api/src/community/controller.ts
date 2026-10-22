import { Controller, Delete, Get, Inject, Param, Patch, Post, Put, Req, Res } from '@nestjs/common';
import { AUTH, AuthService, type AuthRequest } from '../auth/service.js';
import { CommandError } from '../http/problem.js';
import { requestWithPathParams, validateIncomingRequest } from '../http/validate-request.js';
import { CommunityService } from './service.js';
import type { components } from '@trading/contracts';

export const COMMUNITY_SERVICE = Symbol('COMMUNITY_SERVICE');
interface ResponseLike { status(code: number): ResponseLike; setHeader(name: string, value: string): void; end(): void }

@Controller()
export class CommunityController {
  constructor(@Inject(AUTH) private readonly auth: AuthService, @Inject(COMMUNITY_SERVICE) private readonly community: CommunityService) {}

  @Get('publications/:id/community')
  async publicationCommunity(@Param('id') id: string, @Req() req: AuthRequest) {
    await this.auth.assertPublicRead(req);
    validateIncomingRequest('getPublicationCommunity', requestWithPathParams(req, { id }));
    const viewer = await this.auth.optionalActor(req);
    return this.community.getPublicationCommunity(id, viewer?.userId);
  }

  @Get('publications/:id/comments')
  async listComments(@Param('id') id: string, @Req() req: AuthRequest) {
    await this.auth.assertPublicRead(req);
    const valid = validateIncomingRequest('listComments', requestWithPathParams(req, { id }));
    const viewer = await this.auth.optionalActor(req);
    const result = await this.community.listComments(id, viewer?.userId, valid.query?.cursor, valid.query?.limit);
    return { items: result.items, nextCursor: result.nextCursor };
  }

  @Post('publications/:id/comments')
  async createComment(@Param('id') id: string, @Req() req: AuthRequest, @Res({ passthrough: true }) res: ResponseLike) {
    const actor = await this.auth.authenticate(req, { verified: true, onboarded: true }); await this.auth.assertCsrf(req, actor);
    const valid = validateIncomingRequest('createComment', requestWithPathParams(req, { id }));
    const key = req.headers['idempotency-key']; if (typeof key !== 'string') throw new CommandError(400, 'INVALID_COMMAND_KEY');
    const result = await this.community.createComment(actor.userId, id, key, valid.body as any);
    res.status(201); res.setHeader('ETag', `"${result.revision}"`); return result;
  }

  @Patch('comments/:id')
  async editComment(@Param('id') id: string, @Req() req: AuthRequest, @Res({ passthrough: true }) res: ResponseLike) {
    const actor = await this.auth.authenticate(req, { verified: true, onboarded: true }); await this.auth.assertCsrf(req, actor);
    const valid = validateIncomingRequest('editComment', requestWithPathParams(req, { id }));
    const result = await this.community.editComment(actor.userId, id, req.headers['if-match'], valid.body as any);
    res.setHeader('ETag', `"${result.revision}"`); return result.comment;
  }

  @Delete('comments/:id')
  async deleteComment(@Param('id') id: string, @Req() req: AuthRequest, @Res() res: ResponseLike) {
    const actor = await this.auth.authenticate(req, { verified: true, onboarded: true }); await this.auth.assertCsrf(req, actor);
    validateIncomingRequest('deleteComment', requestWithPathParams(req, { id }));
    await this.community.deleteComment(actor.userId, id, req.headers['if-match']);
    res.status(204).end();
  }

  @Put('publications/:id/reaction')
  async addHelpful(@Param('id') id: string, @Req() req: AuthRequest, @Res() res: ResponseLike) {
    const actor = await this.auth.authenticate(req, { verified: true, onboarded: true }); await this.auth.assertCsrf(req, actor);
    validateIncomingRequest('setReaction', requestWithPathParams(req, { id }));
    await this.community.toggleReaction(actor.userId, id, true); res.status(204).end();
  }

  @Delete('publications/:id/reaction')
  async removeHelpful(@Param('id') id: string, @Req() req: AuthRequest, @Res() res: ResponseLike) {
    const actor = await this.auth.authenticate(req, { verified: true, onboarded: true }); await this.auth.assertCsrf(req, actor);
    validateIncomingRequest('removeReaction', requestWithPathParams(req, { id }));
    await this.community.toggleReaction(actor.userId, id, false); res.status(204).end();
  }

  @Put('publications/:id/bookmark')
  async bookmark(@Param('id') id: string, @Req() req: AuthRequest, @Res() res: ResponseLike) {
    const actor = await this.auth.authenticate(req, { verified: true, onboarded: true }); await this.auth.assertCsrf(req, actor);
    validateIncomingRequest('setBookmark', requestWithPathParams(req, { id }));
    await this.community.toggleBookmark(actor.userId, id, true); res.status(204).end();
  }

  @Delete('publications/:id/bookmark')
  async unbookmark(@Param('id') id: string, @Req() req: AuthRequest, @Res() res: ResponseLike) {
    const actor = await this.auth.authenticate(req, { verified: true, onboarded: true }); await this.auth.assertCsrf(req, actor);
    validateIncomingRequest('removeBookmark', requestWithPathParams(req, { id }));
    await this.community.toggleBookmark(actor.userId, id, false); res.status(204).end();
  }

  @Put('users/:handle/follow')
  async followAuthor(@Param('handle') handle: string, @Req() req: AuthRequest, @Res() res: ResponseLike) {
    const actor = await this.auth.authenticate(req, { verified: true, onboarded: true }); await this.auth.assertCsrf(req, actor);
    validateIncomingRequest('setAuthorfollow', requestWithPathParams(req, { handle }));
    await this.community.setAuthorFollow(actor.userId, handle, true); res.status(204).end();
  }

  @Delete('users/:handle/follow')
  async unfollowAuthor(@Param('handle') handle: string, @Req() req: AuthRequest, @Res() res: ResponseLike) {
    const actor = await this.auth.authenticate(req, { verified: true, onboarded: true }); await this.auth.assertCsrf(req, actor);
    validateIncomingRequest('removeAuthorfollow', requestWithPathParams(req, { handle }));
    await this.community.setAuthorFollow(actor.userId, handle, false); res.status(204).end();
  }

  @Put('users/:handle/mute')
  async muteAuthor(@Param('handle') handle: string, @Req() req: AuthRequest, @Res() res: ResponseLike) {
    const actor = await this.auth.authenticate(req, { verified: true, onboarded: true }); await this.auth.assertCsrf(req, actor);
    validateIncomingRequest('setAuthormute', requestWithPathParams(req, { handle }));
    await this.community.setMute(actor.userId, handle, true); res.status(204).end();
  }

  @Delete('users/:handle/mute')
  async unmuteAuthor(@Param('handle') handle: string, @Req() req: AuthRequest, @Res() res: ResponseLike) {
    const actor = await this.auth.authenticate(req, { verified: true, onboarded: true }); await this.auth.assertCsrf(req, actor);
    validateIncomingRequest('removeAuthormute', requestWithPathParams(req, { handle }));
    await this.community.setMute(actor.userId, handle, false); res.status(204).end();
  }

  @Get('users/:handle/relationship')
  async relationship(@Param('handle') handle: string, @Req() req: AuthRequest) {
    await this.auth.assertPublicRead(req); validateIncomingRequest('getAuthorRelationship', requestWithPathParams(req, { handle }));
    const actor = await this.auth.optionalActor(req);
    return this.community.getRelationship(actor?.userId, handle);
  }

  @Put('instruments/:id/follow')
  async followInstrument(@Param('id') id: string, @Req() req: AuthRequest, @Res() res: ResponseLike) {
    const actor = await this.auth.authenticate(req, { verified: true, onboarded: true }); await this.auth.assertCsrf(req, actor);
    validateIncomingRequest('followInstrument', requestWithPathParams(req, { id }));
    await this.community.setInstrumentFollow(actor.userId, id, true); res.status(204).end();
  }

  @Delete('instruments/:id/follow')
  async unfollowInstrument(@Param('id') id: string, @Req() req: AuthRequest, @Res() res: ResponseLike) {
    const actor = await this.auth.authenticate(req, { verified: true, onboarded: true }); await this.auth.assertCsrf(req, actor);
    validateIncomingRequest('unfollowInstrument', requestWithPathParams(req, { id }));
    await this.community.setInstrumentFollow(actor.userId, id, false); res.status(204).end();
  }

  @Get('instruments/:id/follow')
  async instrumentFollowState(@Param('id') id: string, @Req() req: AuthRequest) {
    await this.auth.assertPublicRead(req); validateIncomingRequest('getInstrumentFollowState', requestWithPathParams(req, { id }));
    const actor = await this.auth.optionalActor(req);
    return this.community.getInstrumentFollow(actor?.userId, id);
  }

  @Get('me/bookmarks')
  async bookmarks(@Req() req: AuthRequest): Promise<components['schemas']['PublicationPage']> {
    const actor = await this.auth.authenticate(req, { verified: true, onboarded: true });
    const valid = validateIncomingRequest('listBookmarks', req);
    return this.community.listBookmarks(actor.userId, valid.query?.cursor, valid.query?.limit);
  }

  @Post('publications/:id/reposts')
  async createRepost(@Param('id') id: string, @Req() req: AuthRequest, @Res({ passthrough: true }) res: ResponseLike) {
    const actor = await this.auth.authenticate(req, { verified: true, onboarded: true }); await this.auth.assertCsrf(req, actor);
    const valid = validateIncomingRequest('createRepost', requestWithPathParams(req, { id }));
    const key = req.headers['idempotency-key']; if (typeof key !== 'string') throw new CommandError(400, 'INVALID_COMMAND_KEY');
    const result = await this.community.createRepost(actor.userId, id, key, (valid.body as any).commentary);
    res.status(201); return result;
  }

  @Delete('publications/:id/reposts/mine')
  async undoRepost(@Param('id') id: string, @Req() req: AuthRequest, @Res() res: ResponseLike) {
    const actor = await this.auth.authenticate(req, { verified: true, onboarded: true }); await this.auth.assertCsrf(req, actor);
    validateIncomingRequest('removeRepost', requestWithPathParams(req, { id }));
    await this.community.undoRepost(actor.userId, id); res.status(204).end();
  }

  @Get('users/:handle/reposts')
  async authorReposts(@Param('handle') handle: string, @Req() req: AuthRequest) {
    await this.auth.assertPublicRead(req);
    const valid = validateIncomingRequest('listReposts', requestWithPathParams(req, { handle }));
    return this.community.listReposts(handle, valid.query?.cursor, valid.query?.limit);
  }

  @Post('reports')
  async report(@Req() req: AuthRequest) {
    const actor = await this.auth.authenticate(req, { verified: true, onboarded: true }); await this.auth.assertCsrf(req, actor);
    const valid = validateIncomingRequest('createReport', req);
    const key = req.headers['idempotency-key']; if (typeof key !== 'string') throw new CommandError(400, 'INVALID_COMMAND_KEY');
    return this.community.submitReport(actor.userId, key, valid.body as any);
  }

  @Get('reports')
  async ownReports(@Req() req:AuthRequest){
    const actor=await this.auth.authenticate(req,{verified:true,onboarded:true});
    const valid=validateIncomingRequest('listOwnReports',req);
    return this.community.listOwnReports(actor.userId,valid.query?.cursor,valid.query?.limit);
  }

  @Get('reports/:id')
  async ownReport(@Param('id') id: string, @Req() req: AuthRequest) {
    const actor = await this.auth.authenticate(req, { verified: true, onboarded: true });
    validateIncomingRequest('getOwnReport', requestWithPathParams(req, { id }));
    return this.community.getOwnReport(actor.userId, id);
  }

  @Post('reports/:id/appeals')
  async appealReport(@Param('id') id:string,@Req() req:AuthRequest){
    const actor=await this.auth.authenticate(req,{verified:true,onboarded:true});await this.auth.assertCsrf(req,actor);
    const valid=validateIncomingRequest('appealReport',requestWithPathParams(req,{id}));
    const key=req.headers['idempotency-key'];if(typeof key!=='string')throw new CommandError(400,'INVALID_COMMAND_KEY');
    return this.community.appealReport(actor.userId,id,key,(valid.body as {reason:string}).reason);
  }
}
