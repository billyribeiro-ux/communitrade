import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { Pool } from 'pg';
import { createApp } from '../dist/app.js';
import { SupportService } from '../dist/support/service.js';
const databaseUrl=process.env.TEST_DATABASE_URL;
test('public contact persists private intake, enforces origin/consent/rate limit and concurrent idempotency', {skip: databaseUrl?false:'Set TEST_DATABASE_URL for PostgreSQL contact acceptance.'}, async()=>{
  const pool=new Pool({connectionString:databaseUrl});
  const app=await createApp({$queryRaw:async()=>[]},new SupportService(pool,randomUUID(),'http://localhost:3000'));
  await app.listen(0,'127.0.0.1');
  const origin=await app.getUrl();
  const body={email:'contact@example.test',category:'privacy',subject:'Local acceptance',message:'Private contact acceptance sentinel',consent:true};
  const keys=[];const ids=[];
  async function submit(value=body,key=randomUUID(),extra={}){keys.push(key);return fetch(`${origin}/api/v1/support`,{method:'POST',headers:{Origin:'http://localhost:3000','Content-Type':'application/json','Idempotency-Key':key,...extra},body:JSON.stringify(value)});}
  try {
    let r=await submit(body,randomUUID(),{Origin:'https://attacker.invalid'});assert.equal(r.status,403);
    r=await submit({...body,consent:false});assert.equal(r.status,400);
    r=await submit({...body,subject:'x'.repeat(121)});assert.equal(r.status,400);
    const key=randomUUID();const pair=await Promise.all([submit(body,key),submit(body,key)]);assert.deepEqual(pair.map(x=>x.status),[201,201]);
    const receipts=await Promise.all(pair.map(x=>x.json()));assert.deepEqual(receipts[0],receipts[1]);
    const receipt=receipts[0];ids.push(receipt.id);assert.match(receipt.reference,/^TC-/);assert.equal(receipt.email,undefined);
    const row=await pool.query('SELECT requester_email,consent_version,consent_at,visibility FROM support_ticket WHERE id=$1',[receipt.id]);
    assert.equal(row.rows[0].requester_email,body.email);assert.equal(row.rows[0].visibility,'private');assert.equal(row.rows[0].consent_version,'2026-10-19.draft-1');assert.ok(row.rows[0].consent_at);
    r=await submit({...body,message:'Changed request'},key);assert.equal(r.status,409);
    r=await fetch(`${origin}/api/v1/support/${receipt.id}`);assert.equal(r.status,404);assert.ok(!(await r.text()).includes(body.message));
    for(let i=0;i<2;i++){r=await submit();assert.equal(r.status,201);ids.push((await r.json()).id);}
    r=await submit();assert.equal(r.status,429,'fourth distinct request in the UTC hour is rate limited');assert.ok(r.headers.get('retry-after'));
    r=await submit(body,key);assert.equal(r.status,201,'safe replay after rate cap');
  } finally {
    await pool.query("DELETE FROM side_effect_delivery WHERE channel='support_email' AND payload->>'ticketId'=ANY($1::text[])",[ids]);
    await pool.query('DELETE FROM support_message WHERE ticket_id=ANY($1::uuid[])',[ids]);
    await pool.query('DELETE FROM support_ticket WHERE id=ANY($1::uuid[])',[ids]);
    const rows=await pool.query('DELETE FROM idempotency_record WHERE key=ANY($1::text[]) RETURNING actor_key',[keys]);
    if(rows.rows.length) await pool.query("DELETE FROM rate_limit_bucket WHERE principal_hash=$1 AND route='/support'",[rows.rows[0].actor_key]);
    await app.close();await pool.end();
  }
});

test('contact dependency failure preserves a safe retry response without leaking connection details',async()=>{
  const service=new SupportService({connect:async()=>{throw new Error('postgresql://secret:password@internal/db');}},randomUUID(),'http://localhost:3000');
  const app=await createApp({$queryRaw:async()=>[]},service);await app.listen(0,'127.0.0.1');
  try{
    const response=await fetch(`${await app.getUrl()}/api/v1/support`,{method:'POST',headers:{Origin:'http://localhost:3000','Content-Type':'application/json','Idempotency-Key':randomUUID()},body:JSON.stringify({email:'synthetic@example.test',category:'other',subject:'Synthetic request',message:'This is only a test.',consent:true})});
    assert.equal(response.status,503);assert.match(response.headers.get('cache-control'),/no-store/);
    const body=await response.text();assert.match(body,/CONTACT_UNAVAILABLE/);assert.ok(!body.includes('password'));assert.ok(!body.includes('internal/db'));
  }finally{await app.close();}
});
