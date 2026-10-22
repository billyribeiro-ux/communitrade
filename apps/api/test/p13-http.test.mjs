import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { createApp } from '../dist/app.js';
import { CommandError } from '../dist/http/problem.js';

const csrf='synthetic-p13-csrf';
const headers=(idempotencyKey=randomUUID())=>({'Content-Type':'application/json','Accept':'application/json','X-CSRF-Token':csrf,'Idempotency-Key':idempotencyKey});

test('P13 staff HTTP routes require recent admin MFA, CSRF and role-scoped service calls',async()=>{
 const admin=randomUUID(),moderator=randomUUID(),user=randomUUID(),calls=[],authCalls=[];
 let roles=['admin'],mfaRecent=true,csrfValid=true;
 const auth={
  authenticate:async(_req,options)=>{authCalls.push(options);if(options?.stepUp&&!mfaRecent)throw new CommandError(403,'RECENT_MFA_REQUIRED');return{userId:roles.includes('admin')?admin:roles.includes('moderator')?moderator:user,roles};},
  assertCsrf:async req=>{if(!csrfValid||req.headers['x-csrf-token']!==csrf)throw new CommandError(403,'CSRF_FAILED');}
 };
 const staff={
  overview:async(...args)=>{calls.push(['overview',...args]);return{openReports:0,openAppeals:0,pendingCorrections:0,failedJobs:0,openSupport:0};},
  reports:async(...args)=>{calls.push(['reports',...args]);return{items:[],nextCursor:null};},
  users:async(...args)=>{calls.push(['users',...args]);if(!roles.includes('admin'))throw new CommandError(403,'ADMIN_REQUIRED');return{items:[],nextCursor:null};},
  actUser:async(...args)=>{calls.push(['actUser',...args]);return{id:randomUUID(),action:args[4].action};}
 };
 const app=await createApp({$queryRaw:async()=>[]},null,{auth,staff});let listening=false;
 try{
  await app.listen(0,'127.0.0.1');listening=true;const origin=`http://127.0.0.1:${app.getHttpServer().address().port}/api/v1`;
  let response=await fetch(`${origin}/admin/reports?limit=10`);assert.equal(response.status,200);assert.deepEqual(authCalls.at(-1),{verified:true,onboarded:true,staff:true,stepUp:true});assert.deepEqual(calls.at(-1),['reports',admin,['admin'],undefined,'10']);
  mfaRecent=false;response=await fetch(`${origin}/admin/overview`);assert.equal(response.status,403);mfaRecent=true;
  roles=['moderator'];response=await fetch(`${origin}/admin/reports?limit=7`);assert.equal(response.status,200);assert.deepEqual(authCalls.at(-1),{verified:true,onboarded:true,staff:true});assert.deepEqual(calls.at(-1),['reports',moderator,['moderator'],undefined,'7']);
  response=await fetch(`${origin}/admin/users`);assert.equal(response.status,403);assert.deepEqual(authCalls.at(-1),{verified:true,onboarded:true,staff:true});
  roles=['admin'];const noCsrf=await fetch(`${origin}/admin/users/${user}/actions`,{method:'POST',headers:{'Content-Type':'application/json','Idempotency-Key':randomUUID()},body:JSON.stringify({action:'revoke_sessions',reason:'Member requested session revocation'})});assert.equal(noCsrf.status,403);assert.equal(calls.some(call=>call[0]==='actUser'),false);
  const key=randomUUID();response=await fetch(`${origin}/admin/users/${user}/actions`,{method:'POST',headers:headers(key),body:JSON.stringify({action:'revoke_sessions',reason:'Member requested session revocation'})});assert.equal(response.status,201,JSON.stringify(await response.clone().json()));assert.deepEqual(calls.at(-1),['actUser',admin,['admin'],user,key,{action:'revoke_sessions',reason:'Member requested session revocation'}]);
  const invalidAction=await fetch(`${origin}/admin/users/${user}/actions`,{method:'POST',headers:headers(),body:JSON.stringify({action:'delete_account',reason:'Invalid action'})});assert.equal(invalidAction.status,400);assert.equal(calls.at(-1)[0],'actUser');
 }finally{if(listening)await app.close();}
});
