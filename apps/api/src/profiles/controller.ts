import { Controller, Get, Inject, Patch, Param, Req, Res } from '@nestjs/common';
import { AUTH, AuthService, type AuthRequest } from '../auth/service.js';
import { requestWithPathParams, validateIncomingRequest } from '../http/validate-request.js';
import { CommandError } from '../http/problem.js';
import { ProfileService, type ProfileWrite } from './service.js';
export const PROFILE_SERVICE = Symbol('PROFILE_SERVICE');
interface ResponseLike { setHeader(name:string,value:string):void; status(code:number):ResponseLike }

@Controller()
export class ProfileController {
  constructor(@Inject(AUTH) private readonly auth: AuthService, @Inject(PROFILE_SERVICE) private readonly profiles: ProfileService) {}
  @Patch('me/profile')
  async update(@Req() req: AuthRequest, @Res({passthrough:true}) res: ResponseLike) {
    const actor=await this.auth.authenticate(req,{verified:true,onboarded:true}); await this.auth.assertCsrf(req,actor);
    const valid=validateIncomingRequest('updateProfile',req); const match=req.headers['if-match'];
    if(typeof match!=='string'||!/^"[1-9][0-9]*"$/.test(match)) throw new CommandError(400,'INVALID_REVISION','If-Match must contain the current profile revision.');
    const profile=await this.profiles.update(actor.userId,Number(match.slice(1,-1)),valid.body as ProfileWrite);
    res.setHeader('ETag',`"${profile.revision}"`); return profile;
  }
  @Get('users/:handle')
  async get(@Param('handle') handle:string,@Req() req:AuthRequest,@Res({passthrough:true}) res:ResponseLike) {
    await this.auth.assertPublicRead(req);
    // Express request properties are prototype-backed, so spreading req drops
    // headers/query/body and breaks contract validation on real HTTP requests.
    validateIncomingRequest('getProfile',requestWithPathParams(req,{handle}));
    const found=await this.profiles.getPublic(handle);
    if(found.redirect){res.status(308);res.setHeader('Location',`/api/v1/users/${encodeURIComponent(found.redirect)}`);return {canonicalHandle:found.redirect};}
    res.setHeader('ETag',`"${found.profile.revision}"`); return found.profile;
  }
}
