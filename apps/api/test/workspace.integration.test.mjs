import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import pg from 'pg';
import {WorkspaceService} from '../dist/workspace/service.js';
import {effectivePlan} from '../dist/workspace/entitlements.js';
import {cleanupP08Fixtures} from '../scripts/p08-fixture-cleanup.mjs';
const url=process.env.TEST_DATABASE_URL;
test('P10 private watchlists/layouts enforce atomic quotas, revisions, expiry and downgrade preservation',{skip:url?false:'Requires TEST_DATABASE_URL'},async()=>{
 const pool=new pg.Pool({connectionString:url,max:8}),users=[randomUUID(),randomUUID(),randomUUID()],instruments=Array.from({length:101},()=>randomUUID()),metadata=randomUUID(),suffix=randomUUID();
 try{
  for(const id of users)await pool.query("INSERT INTO user_account(id,oidc_issuer,oidc_subject,email,email_verified,status,onboarding_version,created_at,updated_at) VALUES($1::uuid,$2,$1::text,$3,true,'active','p10',now(),now())",[id,`https://p10.workspace.${suffix}.invalid`,`${id}@example.invalid`]);
  await pool.query("INSERT INTO role_grant(id,user_id,role,grantor_user_id,reason,granted_at) VALUES($1,$2,'admin',$2,'Synthetic isolation',now())",[randomUUID(),users[2]]);
  for(const [index,id]of instruments.entries())await pool.query("INSERT INTO instrument(id,asset,vendor,vendor_id,venue,currency,enabled,created_at) VALUES($1,'stock','fixture',$2,'NASDAQ','USD',true,now())",[id,`P10-${suffix}-${index}`]);
  await pool.query("INSERT INTO instrument_metadata_version(id,instrument_id,version,multiplier,tick_size,created_at) VALUES($1,$2,1,1,0.01,now())",[metadata,instruments[0]]);
  const service=new WorkspaceService(pool),[owner,other,staff]=users;
  const race=await Promise.allSettled([service.create(owner,'watchlist',randomUUID(),{name:'Private alpha'}),service.create(owner,'watchlist',randomUUID(),{name:'Private beta'})]);
  assert.equal(race.filter(x=>x.status==='fulfilled').length,1);
  const list=race.find(x=>x.status==='fulfilled').value;
  for(const user of [other,staff]){assert.equal((await service.list(user,'watchlist')).items.length,0);await assert.rejects(service.get(user,'watchlist',list.id),{code:'NOT_FOUND'});await assert.rejects(service.update(user,'watchlist',list.id,'"1"',{name:'steal'}),{code:'NOT_FOUND'});await assert.rejects(service.instrument(user,list.id,instruments[0],true),{code:'NOT_FOUND'});await assert.rejects(service.remove(user,'watchlist',list.id,'"1"'),{code:'NOT_FOUND'});}
  for(const id of instruments.slice(0,24))await service.instrument(owner,list.id,id,true);
  const itemRace=await Promise.allSettled(instruments.slice(24,26).map(id=>service.instrument(owner,list.id,id,true)));
  assert.equal(itemRace.filter(x=>x.status==='fulfilled').length,1);
  const full=await service.get(owner,'watchlist',list.id);assert.equal(full.instrumentIds.length,25);
  await service.instrument(owner,list.id,full.instrumentIds[0],true);assert.equal((await service.get(owner,'watchlist',list.id)).revision,full.revision,'duplicate add idempotent even at quota');
  await assert.rejects(service.update(owner,'watchlist',list.id,'"1"',{name:'stale'}),{code:'STALE_REVISION'});
  const state={schemaVersion:1,instrumentId:instruments[0],metadataVersion:1,interval:'1d',timezone:'UTC',session:'regular',adjustment:'split-adjusted',viewport:{from:'2026-01-01T00:00:00Z',to:'2026-01-02T00:00:00Z'},indicators:[],provenance:{provider:'fixture',asOf:'2026-01-02T00:00:00Z',delaySeconds:0,demo:true},drawings:[]};
  const layout=await service.create(owner,'layout',randomUUID(),{name:'Private chart',state});
  await assert.rejects(service.create(owner,'layout',randomUUID(),{name:'Over limit',state}),{code:'QUOTA_EXCEEDED'});
  for(const user of [other,staff])await assert.rejects(service.get(user,'layout',layout.id),{code:'NOT_FOUND'});
  await pool.query("INSERT INTO subscription_entitlement(id,user_id,plan,limits,valid_from,valid_until) VALUES($1,$2,'pro','{}',now()-interval '1 day',now()+interval '1 day')",[randomUUID(),owner]);
  assert.equal((await service.usage(owner)).journalMonthly,1000);
  for(let i=0;i<9;i++){await service.create(owner,'watchlist',randomUUID(),{name:`Expanded ${i}`});await service.create(owner,'layout',randomUUID(),{name:`Expanded ${i}`,state});}
  await assert.rejects(service.create(owner,'watchlist',randomUUID(),{name:'Eleven'}),{code:'QUOTA_EXCEEDED'});
  await assert.rejects(service.create(owner,'layout',randomUUID(),{name:'Eleven',state}),{code:'QUOTA_EXCEEDED'});
  for(const id of instruments.slice(0,100))await service.instrument(owner,list.id,id,true);
  await assert.rejects(service.instrument(owner,list.id,instruments[100],true),{code:'QUOTA_EXCEEDED'});
  await pool.query("UPDATE subscription_entitlement SET valid_until=now()-interval '1 second' WHERE user_id=$1",[owner]);
  assert.equal((await service.usage(owner)).plan,'free');
  assert.equal((await service.list(owner,'watchlist')).items.length,10);assert.equal((await service.get(owner,'watchlist',list.id)).instrumentIds.length,100);
  const latest=await service.get(owner,'watchlist',list.id);await service.update(owner,'watchlist',list.id,`"${latest.revision}"`,{name:'Downgraded preserved'});
  await service.update(owner,'layout',layout.id,'"1"',{name:'Editable after downgrade',state});
  await assert.rejects(service.create(owner,'layout',randomUUID(),{name:'Blocked',state}),{code:'QUOTA_EXCEEDED'});
  await service.instrument(owner,list.id,instruments[0],false);await assert.rejects(service.instrument(owner,list.id,instruments[0],true),{code:'QUOTA_EXCEEDED'});
  const page=await service.list(owner,'layout',undefined,1);assert.ok(page.nextCursor);assert.notEqual((await service.list(owner,'layout',page.nextCursor,1)).items[0].id,page.items[0].id);await assert.rejects(service.list(other,'layout',page.nextCursor,1),{code:'INVALID_CURSOR'});
  const future=await effectivePlan(pool,owner,new Date('2099-01-01T00:00:00Z'));assert.equal(future.plan,'free');
 }finally{await cleanupP08Fixtures(pool,users,instruments);await pool.end();}
});
