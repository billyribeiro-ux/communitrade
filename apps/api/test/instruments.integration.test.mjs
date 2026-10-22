import assert from 'node:assert/strict';
import test from 'node:test';
import { randomUUID } from 'node:crypto';
import pg from 'pg';
import { createApp } from '../dist/app.js';
import { CommandError } from '../dist/http/problem.js';
import { InstrumentService } from '../dist/instruments/service.js';
import { createMarketDataRuntime } from '../dist/instruments/market-data-config.js';

const databaseUrl = process.env.TEST_DATABASE_URL;
const integration = { skip: databaseUrl ? false : 'Set TEST_DATABASE_URL for instrument/catalog PostgreSQL+HTTP acceptance.' };
const STOCK = '00000000-0000-4000-8000-000000000201';
const ADMIN_TARGET = '00000000-0000-4000-8000-000000000206';
const CALL_100 = '00000000-0000-4000-8000-000000000221';
const CALL_105 = '00000000-0000-4000-8000-000000000222';
const ACTOR = {
  member: { userId:'00000000-0000-4000-8000-000000000101',status:'active',roles:['member'] },
  admin: { userId:'00000000-0000-4000-8000-000000000106',status:'active',roles:['admin'] },
};

test('PostgreSQL-backed instrument catalog, capability isolation, strategy validation, and audited admin action', integration, async (t) => {
  const pool = new pg.Pool({ connectionString: databaseUrl, max: 8, connectionTimeoutMillis: 3000, query_timeout: 15000 });
  pool.on('error', () => {});
  const capId = randomUUID();
  let app;
  let originalEnabled;
  let server;
  try {
    const fixture = (await pool.query('SELECT enabled,vendor FROM instrument WHERE id=$1',[ADMIN_TARGET])).rows[0];
    assert.equal(fixture?.vendor,'synthetic-fixture','P05 fixtures must be seeded before catalog acceptance');
    originalEnabled=fixture.enabled;
    const market=await createMarketDataRuntime(pool,{MARKET_DATA_PROVIDER:'synthetic'});
    const auth={
      config:{cookieName:'p05sid',appOrigin:'http://127.0.0.1'},
      assertPublicRead:async()=>{},
      authenticate:async(req,options={})=>{
        const token=String(req.headers.cookie??'').split(';').map(x=>x.trim()).find(x=>x.startsWith('p05sid='))?.slice(7);
        if(token==='stale-admin'&&options.stepUp)throw new CommandError(403,'RECENT_MFA_REQUIRED');
        const actor=token==='admin'||token==='stale-admin'?ACTOR.admin:token==='member'?ACTOR.member:null;
        if(!actor)throw new CommandError(401,'AUTHENTICATION_REQUIRED');
        return actor;
      },
      assertCsrf:async(req)=>{if(req.headers.origin!=='http://127.0.0.1'||req.headers['x-csrf-token']!=='fixture-csrf')throw new CommandError(403,'CSRF_FAILED');},
    };
    const instruments=new InstrumentService(pool,market.adapter,market.mode,market.configured);
    app=await createApp({$queryRaw:async()=>[]},null,{auth,instruments});
    await app.listen(0,'127.0.0.1');
    server=app.getHttpServer();const port=server.address().port,base=`http://127.0.0.1:${port}/api/v1`;
    async function request(path,{actor,method='GET',body,headers={}}={},status=200){
      const h=new Headers(headers);if(actor)h.set('Cookie',`p05sid=${actor}`);if(body!==undefined)h.set('Content-Type','application/json');if(method==='POST')h.set('Origin','http://127.0.0.1');
      const response=await fetch(`${base}${path}`,{method,headers:h,...(body===undefined?{}:{body:JSON.stringify(body)}),signal:AbortSignal.timeout(15000)});
      const text=await response.text();assert.equal(response.status,status,`${method} ${path}: ${text.slice(0,300)}`);assert.equal(response.headers.get('cache-control'),'no-store');
      return {response,body:text?JSON.parse(text):null};
    }
    await t.test('catalog metadata history and server-side futures/options pagination',async()=>{
      const detail=(await request(`/instruments/${STOCK}`)).body;
      assert.equal(detail.asset,'stock');assert.equal(detail.meta.demo,true);assert.deepEqual(detail.availableMetadataVersions,[1]);assert.equal(detail.versions[0].sourceId,'synthetic-fixture-v1');
      const search=(await request('/instruments?asset=future&root=ES&limit=1')).body;
      assert.equal(search.items.length,1);assert.equal(search.items[0].root,'ES');assert.ok(search.nextCursor);
      const next=(await request(`/instruments?asset=future&root=ES&limit=1&cursor=${encodeURIComponent(search.nextCursor)}`)).body;
      assert.equal(next.items.length,1);assert.notEqual(next.items[0].id,search.items[0].id);assert.equal(next.nextCursor,null);
      const ordered=(await request('/futures-contracts?root=ES&limit=1')).body;const orderedNext=(await request(`/futures-contracts?root=ES&limit=1&cursor=${encodeURIComponent(ordered.nextCursor)}`)).body;assert.equal(ordered.items[0].contractMonth,'2026-12');assert.equal(orderedNext.items[0].contractMonth,'2027-03');
      const badTuple=Buffer.from(JSON.stringify({id:STOCK,sort:['invalid','other','NaN',STOCK]})).toString('base64url');await request(`/futures-contracts?cursor=${badTuple}`,{},400);await request(`/instruments?cursor=${badTuple}`,{},400);await request(`/instruments/${STOCK}/option-contracts?cursor=${badTuple}`,{},400);
      const legacy=(await request(`/instruments/00000000-0000-4000-8000-000000000202?metadataVersion=1`)).body;
      const corrected=(await request(`/instruments/00000000-0000-4000-8000-000000000202?metadataVersion=2`)).body;
      assert.equal(legacy.expiration,'2026-12-18T21:00:00.000Z');assert.equal(corrected.expiration,'2026-12-18T14:30:00.000Z');
      const options=(await request(`/instruments/${STOCK}/option-contracts?limit=50`)).body;
      assert.ok(options.items.length>=12);assert.ok(options.items.every(x=>x.meta.demo===true));
    });
    await t.test('actual listed contract validation returns quote-derived vertical net debit',async()=>{
      const calendar=(await request('/market-data/calendar?venue=US_EQUITY&from=2026-10-20&to=2026-11-20&limit=50')).body;assert.ok(calendar.items.length>0);
      const body={strategy:'bull_call_debit',underlyingInstrumentId:STOCK,optionContractIds:[CALL_100,CALL_105],quantity:1,legs:[{side:'long',quantity:1},{side:'short',quantity:1}]};
      const valid=(await request('/trade-plans/validate-strategy',{actor:'member',method:'POST',body,headers:{'X-CSRF-Token':'fixture-csrf'}})).body;
      assert.equal(valid.valid,true,JSON.stringify(valid));assert.equal(valid.netKind,'debit');assert.equal(typeof valid.netPrice,'string');assert.equal(valid.meta.demo,true);
      const invalid=(await request('/trade-plans/validate-strategy',{actor:'member',method:'POST',body:{...body,optionContractIds:[CALL_100,CALL_100]}})).body;
      assert.equal(invalid.valid,false);assert.equal(invalid.netPrice,null);assert.ok(invalid.validationIssues.some(x=>x.code==='duplicate_contract'));
    });
    await t.test('public and member permissions remain independent for option quotes',async()=>{
      const flags={displayPublic:false,displayMember:false,retainBars:false,retainSnapshot:false,exportImage:false,exportPersonalRecord:false,newPublishing:false};
      await pool.query(`INSERT INTO data_capability(id,supplier,agreement_id,dataset,audience,purpose,effective_at,flags) VALUES($1,'synthetic-fixture','p05-api-test-denial','option','public','display',now(),$2::jsonb)`,[capId,JSON.stringify(flags)]);
      await request(`/instruments/${CALL_100}/quote`,{},403);
      const member=(await request(`/instruments/${CALL_100}/quote`,{actor:'member'})).body;assert.equal(member.meta.capabilities.displayMember,true);
    });
    await t.test('recent-MFA admin action is reasoned, idempotent, and leaves metadata readable',async()=>{
      await request('/admin/instruments',{actor:'stale-admin'},403);
      const reason=`P05 integration acceptance ${randomUUID()}`,key=randomUUID();
      const command={action:'disable',reason};
      const first=(await request(`/admin/instruments/${ADMIN_TARGET}/actions`,{actor:'admin',method:'POST',body:command,headers:{'X-CSRF-Token':'fixture-csrf','Idempotency-Key':key}},201)).body;
      const replay=(await request(`/admin/instruments/${ADMIN_TARGET}/actions`,{actor:'admin',method:'POST',body:command,headers:{'X-CSRF-Token':'fixture-csrf','Idempotency-Key':key}},201)).body;
      assert.deepEqual(replay,first);
      await request(`/admin/instruments/${ADMIN_TARGET}/actions`,{actor:'admin',method:'POST',body:{action:'enable',reason},headers:{'X-CSRF-Token':'fixture-csrf','Idempotency-Key':key}},409);
      await pool.query(`UPDATE idempotency_record SET expires_at=now()-interval '1 second' WHERE actor_key=$1 AND route=$2 AND key=$3`,[ACTOR.admin.userId,`POST:/admin/instruments/${ADMIN_TARGET}/actions`,key]);
      const expired=(await request(`/admin/instruments/${ADMIN_TARGET}/actions`,{actor:'admin',method:'POST',body:{action:'enable',reason},headers:{'X-CSRF-Token':'fixture-csrf','Idempotency-Key':key}},201)).body;assert.equal(expired.action,'enable');
      await request(`/admin/instruments/${ADMIN_TARGET}/actions`,{actor:'admin',method:'POST',body:{action:'disable',reason},headers:{'X-CSRF-Token':'fixture-csrf','Idempotency-Key':randomUUID()}},201);
      const audit=await pool.query('SELECT id FROM audit_event WHERE id=$1 AND actor=$2 AND resource_id=$3',[first.id,ACTOR.admin.userId,ADMIN_TARGET]);assert.equal(audit.rowCount,1);
      const detail=(await request(`/instruments/${ADMIN_TARGET}?metadataVersion=1`)).body;assert.equal(detail.enabled,false);assert.equal(detail.metadataVersion,1);
      const status=(await request('/admin/data',{actor:'admin'})).body;assert.equal(status.productionReady,false);assert.ok(status.items.some(x=>x.providerReference&&x.freshness==='fresh'));
    });
  } finally {
    await pool.query('DELETE FROM data_capability WHERE id=$1',[capId]).catch(()=>{});
    if(typeof originalEnabled==='boolean')await pool.query('UPDATE instrument SET enabled=$2 WHERE id=$1 AND vendor=\'synthetic-fixture\'',[ADMIN_TARGET,originalEnabled]).catch(()=>{});
    await app?.close().catch(()=>{});
    await pool.end();
  }
});
