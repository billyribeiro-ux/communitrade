import {Controller,Inject,Post,Req,Res} from '@nestjs/common';
import {CommandError} from '../http/problem.js';
import {validateIncomingRequest} from '../http/validate-request.js';
import {EmailWebhookService} from './webhook.js';
export const EMAIL_WEBHOOK=Symbol('EMAIL_WEBHOOK');
@Controller()
export class EmailWebhookController {
  constructor(@Inject(EMAIL_WEBHOOK)private readonly email:EmailWebhookService){}
  @Post('webhooks/resend')async receive(@Req()req:{rawBody?:Uint8Array;headers:Record<string,string|string[]|undefined>},@Res()res:{status:(code:number)=>{end:()=>void}}){
    validateIncomingRequest('receiveResendWebhook',req);
    if(!req.rawBody)throw new CommandError(400,'INVALID_EMAIL_WEBHOOK');
    await this.email.receive(req.rawBody,req.headers);res.status(204).end();
  }
}
