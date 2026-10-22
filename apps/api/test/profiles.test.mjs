import assert from 'node:assert/strict';
import test from 'node:test';
import { ProfileService, validateHandle } from '../dist/profiles/service.js';
import { createApp } from '../dist/app.js';

test('handle validation normalizes input and blocks route-reserved names', () => {
  assert.equal(validateHandle('Trader_01'),'trader_01');
  assert.throws(()=>validateHandle('support'),error=>error.code==='HANDLE_RESERVED');
  assert.throws(()=>validateHandle('api_internals'),error=>error.code==='HANDLE_RESERVED');
  for (const routeName of ['pricing','features','faq','about','accessibility','subscribe','design_preview','staff','security','official']) {
    assert.throws(()=>validateHandle(routeName),error=>error.code==='HANDLE_RESERVED', `${routeName} must stay reserved`);
  }
  assert.throws(()=>validateHandle('ab'),error=>error.code==='INVALID_HANDLE');
});

test('public profile projection omits email and includes only public-performance counts', async()=>{
  const pool={query:async sql=>{
    if(sql.includes('FROM profile p JOIN user_account'))return {rowCount:1,rows:[{user_id:'owner-1',handle:'trader_01',display_name:'Trader',bio:null,links:null,interests:null,avatar_media_id:null,revision:4,created_at:new Date('2026-01-01T00:00:00Z'),email:'private@example.test'}]};
    if(sql.includes('FROM follow'))return {rows:[{followers:3,following:2}]};
    if(sql.includes('WITH latest AS'))return {rows:[{closed:2,wins:1,losses:1,breakevens:0,unresolved:1,incomplete_costs:1,realized:'12.50',mean_r:'0.5'}]};
    if(sql.includes('subscription_entitlement'))return {rows:[{pro:true}]};
    throw new Error('Unexpected query');
  }};
  const result=await new ProfileService(pool).getPublic('trader_01');
  assert.equal(result.profile.user.pro,true);assert.equal(result.profile.followers,3);assert.equal(result.profile.statistics.reportedRealizedPnl,'12.50');
  assert.equal('email' in result.profile.user,false);assert.equal('email' in result.profile,false);
});

test('real Nest HTTP GET preserves Express request fields for profile contract validation', async()=>{
  const pool={query:async sql=>{
    if(sql.includes('FROM profile p JOIN user_account'))return {rowCount:1,rows:[{user_id:'owner-1',handle:'trader_01',display_name:'Trader',bio:null,links:null,interests:null,avatar_media_id:null,revision:4,created_at:new Date('2026-01-01T00:00:00Z')}]};
    if(sql.includes('FROM follow'))return {rows:[{followers:0,following:0}]};
    if(sql.includes('WITH latest AS'))return {rows:[{closed:0,wins:0,losses:0,breakevens:0,unresolved:0,incomplete_costs:0,realized:'0',mean_r:null}]};
    if(sql.includes('subscription_entitlement'))return {rows:[{pro:false}]};
    throw new Error('Unexpected query');
  }};
  const auth={authenticate:async()=>({userId:'owner-1'}),assertPublicRead:async()=>{}};
  const app=await createApp({$queryRaw:async()=>[]},null,{auth,profiles:new ProfileService(pool)});
  try {
    await app.listen(0,'127.0.0.1');
    const address=app.getHttpServer().address();
    const response=await fetch(`http://127.0.0.1:${address.port}/api/v1/users/trader_01`);
    const body=await response.text();
    assert.equal(response.status,200,body);
    const profile=JSON.parse(body);
    assert.equal(profile.user.handle,'trader_01');
  } finally { await app.close(); }
});
