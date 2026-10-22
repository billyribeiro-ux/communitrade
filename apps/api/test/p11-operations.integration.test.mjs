import test from 'node:test';import assert from 'node:assert/strict';import {randomUUID} from 'node:crypto';import pg from 'pg';
import {AuthService,authConfigFromEnv} from '../dist/auth/service.js';
import {MeasurementService} from '../dist/measurement/service.js';import {recordProductEvent} from '../dist/measurement/events.js';
import {JobService} from '../dist/jobs/service.js';import {withActorTransaction} from '../dist/persistence/transactions.js';
import {cleanupP08Fixtures} from '../scripts/p08-fixture-cleanup.mjs';
const url=process.env.TEST_DATABASE_URL;
test('P11 PostgreSQL consent withdrawal, event privacy and bounded audited admin retries',{skip:url?false:'Requires TEST_DATABASE_URL'},async()=>{
 const pool=new pg.Pool({connectionString:url,max:8}),owner=randomUUID(),other=randomUUID(),staff=randomUUID(),suffix=randomUUID(),delivery=randomUUID(),uncertain=randomUUID(),exhausted=randomUUID();
 const ids=[owner,other,staff];
 try{
  for(const id of ids)await pool.query("INSERT INTO user_account(id,oidc_issuer,oidc_subject,email,email_verified,status,onboarding_version,created_at,updated_at) VALUES($1::uuid,$2,$1::text,$3,true,'active','p11',now(),now())",[id,`https://p11.operations.${suffix}.invalid`,`${id}@example.invalid`]);
  await pool.query("INSERT INTO role_grant(id,user_id,role,grantor_user_id,reason,granted_at) VALUES($1,$2,'admin',$2,'Synthetic P11 job audit',now())",[randomUUID(),staff]);
  const actor={userId:owner,roles:[],emailVerified:true,status:'active',onboarded:true},auth=new AuthService(pool,authConfigFromEnv()),measurement=new MeasurementService(pool),source=randomUUID();
  await measurement.recordReturn(owner,{name:'return',sourceKey:source,properties:{surface:'dashboard'}});assert.equal((await pool.query('SELECT count(*)::int AS n FROM product_event WHERE owner_user_id=$1',[owner])).rows[0].n,0);
  const consent=await auth.updatePreferences(actor,{analyticsConsent:true});assert.equal(consent.analyticsConsentVersion,'2026-10-20.v1');
  await Promise.all(Array.from({length:5},()=>measurement.recordReturn(owner,{name:'return',sourceKey:source,properties:{surface:'dashboard'}})));
  const rows=(await pool.query('SELECT event_name,source_key,properties,consent_version FROM product_event WHERE owner_user_id=$1',[owner])).rows;assert.equal(rows.length,1);assert.notEqual(rows[0].source_key,source);assert.deepEqual(rows[0].properties,{surface:'dashboard'});
  await assert.rejects(measurement.recordReturn(owner,{name:'conversion',sourceKey:randomUUID()}),{code:'CLIENT_EVENT_NOT_ALLOWED'});
  await assert.rejects(measurement.recordReturn(owner,{name:'return',sourceKey:randomUUID(),properties:{notes:'private'}}),{code:'INVALID_PRODUCT_PROPERTIES'});
  for(const name of ['activation','publication','review','report','conversion','churn'])await withActorTransaction(pool,owner,tx=>recordProductEvent(tx,owner,name,randomUUID(),{plan:'free'}));
  assert.equal((await pool.query('SELECT count(*)::int AS n FROM product_event WHERE owner_user_id=$1',[owner])).rows[0].n,7);
  await auth.updatePreferences(actor,{analyticsConsent:false});assert.equal((await pool.query('SELECT count(*)::int AS n FROM product_event WHERE owner_user_id=$1',[owner])).rows[0].n,0);
  await measurement.recordReturn(owner,{name:'return',sourceKey:randomUUID()});assert.equal((await pool.query('SELECT count(*)::int AS n FROM product_event WHERE owner_user_id=$1',[owner])).rows[0].n,0);
  for(const [id,status,attempts]of [[delivery,'failed',1],[uncertain,'uncertain',1],[exhausted,'failed',5]])await pool.query("INSERT INTO side_effect_delivery(id,channel,business_delivery_key,status,attempts,max_attempts,owner_user_id,payload,last_error_code,first_attempt_at,next_attempt_at,created_at,updated_at) VALUES($1,'email',$2,$3,$4,5,$5,$6::jsonb,'SMTP_TEMPORARY_FAILURE',now(),now(),now(),now())",[id,`p11-${id}`,status,attempts,owner,JSON.stringify({privateSentinel:'Do not expose delivery payload'})]);
  const jobs=new JobService(pool);await assert.rejects(jobs.list(other),{code:'ADMIN_REQUIRED'});
  const page=await jobs.list(staff,{kind:'email',limit:1});assert.equal(page.items.length,1);assert.ok(page.nextCursor);assert.ok(!JSON.stringify(page).includes('privateSentinel'));assert.ok(!JSON.stringify(page).includes(owner));
  const next=await jobs.list(staff,{kind:'email',limit:1,cursor:page.nextCursor});assert.notEqual(next.items[0].id,page.items[0].id);
  await assert.rejects(jobs.list(staff,{kind:'outbox',cursor:page.nextCursor}),{code:'INVALID_CURSOR'});
  const key=randomUUID(),command={action:'retry',kind:'email',reason:'Retry confirmed failed synthetic transport'};
  const audit=await jobs.retry(staff,delivery,key,command);assert.equal(audit.action,'job.retry');assert.equal((await jobs.retry(staff,delivery,key,command)).id,audit.id);
  const state=(await pool.query('SELECT status,attempts FROM side_effect_delivery WHERE id=$1',[delivery])).rows[0];assert.equal(state.status,'pending');assert.equal(state.attempts,1);
  await assert.rejects(jobs.retry(other,delivery,randomUUID(),command),{code:'ADMIN_REQUIRED'});
  await assert.rejects(jobs.retry(staff,uncertain,randomUUID(),command),{code:'JOB_RETRY_BUDGET_EXHAUSTED'});
  await assert.rejects(jobs.retry(staff,exhausted,randomUUID(),command),{code:'JOB_RETRY_BUDGET_EXHAUSTED'});
 }finally{await cleanupP08Fixtures(pool,ids);await pool.end();}
});

test('P11 activation requires three follows then a trusted contribution within seven days and consent',{skip:url?false:'Requires TEST_DATABASE_URL'},async()=>{
 const {recordActivation}=await import('../dist/measurement/events.js'),pool=new pg.Pool({connectionString:url,max:4}),ids=Array.from({length:4},()=>randomUUID()),owner=ids[0],auth=new AuthService(pool,authConfigFromEnv()),actor={userId:owner,roles:[],emailVerified:true,status:'active',onboarded:true};
 try{
  for(const id of ids)await pool.query("INSERT INTO user_account(id,oidc_issuer,oidc_subject,email,email_verified,status,onboarding_version,created_at,updated_at) VALUES($1::uuid,$2,$1::text,$3,true,'active','p11',now(),now())",[id,`https://p11.operations.${owner}.invalid`,`${id}@example.invalid`]);
  await auth.updatePreferences(actor,{analyticsConsent:true});
  assert.equal(await withActorTransaction(pool,owner,tx=>recordActivation(tx,owner,'feed')),false);
  for(const target of ids.slice(1))await pool.query('INSERT INTO follow(id,follower_user_id,target_user_id,created_at) VALUES($1,$2,$3,now())',[randomUUID(),owner,target]);
  assert.equal(await withActorTransaction(pool,owner,tx=>recordActivation(tx,owner,'journal')),true);
  assert.equal(await withActorTransaction(pool,owner,tx=>recordActivation(tx,owner,'publish')),false,'Repeated contributions must not count another activation');
  assert.deepEqual((await pool.query('SELECT properties FROM product_event WHERE owner_user_id=$1',[owner])).rows[0].properties,{surface:'journal'});
  await auth.updatePreferences(actor,{analyticsConsent:false});assert.equal(await withActorTransaction(pool,owner,tx=>recordActivation(tx,owner,'feed')),false);
  await auth.updatePreferences(actor,{analyticsConsent:true});await pool.query("UPDATE user_account SET created_at=now()-interval '8 days' WHERE id=$1",[owner]);assert.equal(await withActorTransaction(pool,owner,tx=>recordActivation(tx,owner,'feed')),false);
 }finally{await cleanupP08Fixtures(pool,ids);await pool.end();}
});
