import {Controller,Get,Inject,Req} from '@nestjs/common';
import {AUTH,AuthService,type AuthRequest} from '../auth/service.js';
import {validateIncomingRequest} from '../http/validate-request.js';
import {DiscoveryService} from './service.js';
import type {components} from '@trading/contracts';
export const DISCOVERY_SERVICE=Symbol('DISCOVERY_SERVICE');
@Controller()
export class DiscoveryController {
  constructor(@Inject(AUTH)private readonly auth:AuthService,@Inject(DISCOVERY_SERVICE)private readonly discovery:DiscoveryService){}
  @Get('discovery/sitemap')
  async list(@Req()req:AuthRequest):Promise<components['schemas']['DiscoveryPage']>{await this.auth.assertPublicRead(req);const valid=validateIncomingRequest('getPublicDiscovery',req);return this.discovery.list(valid.query??{});}
}
