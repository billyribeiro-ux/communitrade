import {Controller,Inject,Post,Req,Res} from '@nestjs/common';
import {AUTH,AuthService,type AuthRequest} from '../auth/service.js';
import {validateIncomingRequest} from '../http/validate-request.js';
import {MeasurementService} from './service.js';
export const MEASUREMENT_SERVICE=Symbol('MEASUREMENT_SERVICE');
@Controller()
export class MeasurementController{
 constructor(@Inject(AUTH)private readonly auth:AuthService,@Inject(MEASUREMENT_SERVICE)private readonly measurement:MeasurementService){}
 @Post('product-events')async record(@Req()req:AuthRequest,@Res()res:{status(n:number):{end():void}}){
  const actor=await this.auth.authenticate(req,{verified:true,onboarded:true});await this.auth.assertCsrf(req,actor);
  const valid=validateIncomingRequest('recordProductEvent',req);await this.measurement.recordReturn(actor.userId,valid.body as any);res.status(204).end();
 }
}
