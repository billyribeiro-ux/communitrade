import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {NotificationSourceController,sourceAuthorization} from '../dist/notifications/source-controller.js';
import {CommandError} from '../dist/http/problem.js';
test('notification source authorization binds signature to source, purpose and a short time window',async()=>{
 const original=process.env.SESSION_SECRET,secret='synthetic-p11-source-secret-at-least-32-characters',id=randomUUID(),seconds=Math.floor(Date.now()/1000);process.env.SESSION_SECRET=secret;
 const request=(source=id,time=seconds,signature=sourceAuthorization(secret,source,time))=>({headers:{'content-type':'application/json','x-notification-authorization':`${time}.${signature}`},body:{publicationId:source}});
 try{
  let calls=0;const controller=new NotificationSourceController({async getPublication(source){calls++;return{id:source,slug:'safe-public-idea',title:'A public title'};}});
  assert.deepEqual(await controller.authorize(request()),{available:true,title:'A public title',url:`/ideas/${id}/safe-public-idea`});
  for(const invalid of [request(randomUUID(),seconds,sourceAuthorization(secret,id,seconds)),request(id,seconds-60),request(id,seconds,'a'.repeat(43)),{headers:{'content-type':'application/json'},body:{publicationId:id}}])await assert.rejects(controller.authorize(invalid),{code:'SERVICE_AUTH_REQUIRED'});
  assert.equal(calls,1);
  const hidden=new NotificationSourceController({async getPublication(){throw new CommandError(404,'NOT_FOUND');}});assert.deepEqual(await hidden.authorize(request()),{available:false});
  const unavailable=new NotificationSourceController({async getPublication(){throw new CommandError(503,'PROVIDER_UNAVAILABLE');}});await assert.rejects(unavailable.authorize(request()),{code:'PROVIDER_UNAVAILABLE'});
 }finally{if(original===undefined)delete process.env.SESSION_SECRET;else process.env.SESSION_SECRET=original;}
});
