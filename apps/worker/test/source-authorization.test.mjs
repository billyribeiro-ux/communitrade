import test from 'node:test';import assert from 'node:assert/strict';import {randomUUID,createHmac} from 'node:crypto';
import {createSourceAuthorizer} from '../dist/source-authorization.js';
test('source adapter authenticates exact sources without cookies and fails closed on malformed/provider responses',async()=>{
 const id=randomUUID(),secret='synthetic-p11-source-secret-at-least-32-characters';let calls=0;
 const authorize=createSourceAuthorizer('http://api:3001',secret,async(url,options)=>{calls++;assert.equal(String(url),'http://api:3001/api/v1/internal/notifications/source');assert.equal(options.credentials,'omit');assert.equal(options.redirect,'error');assert.equal(JSON.parse(options.body).publicationId,id);const [seconds,signature]=options.headers['X-Notification-Authorization'].split('.');assert.equal(signature,createHmac('sha256',secret).update(`notification-source:v1:${id}:${seconds}`).digest('base64url'));return Response.json({available:true,title:'Public idea',url:`/ideas/${id}/public-idea`});});
 assert.equal((await authorize(id)).available,true);assert.equal(calls,1);
 await assert.rejects(authorize('not-an-id'),/INVALID_SOURCE_ID/);
 for(const response of [{available:true,title:'Unsafe',url:'https://example.com/'},{available:'true'},null]){let attempts=0;const invalid=createSourceAuthorizer('http://api:3001',secret,async()=>{attempts++;return Response.json(response);});await assert.rejects(invalid(id),/SOURCE_AUTH_UNAVAILABLE/);assert.equal(attempts,2);}
 let failures=0;await assert.rejects(createSourceAuthorizer('http://api:3001',secret,async()=>{failures++;throw new Error('provider private detail');})(id),/SOURCE_AUTH_UNAVAILABLE/);assert.equal(failures,2);
 assert.throws(()=>createSourceAuthorizer('http://user:password@api:3001',secret),/CONFIGURATION/);
});
