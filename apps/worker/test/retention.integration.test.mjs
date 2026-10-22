import test from 'node:test';import assert from 'node:assert/strict';import {randomUUID,createHash} from 'node:crypto';import pg from 'pg';
import {purgeExpiredProductEvents} from '../dist/retention.js';import {cleanupP08Fixtures} from '../../api/scripts/p08-fixture-cleanup.mjs';
const url=process.env.TEST_DATABASE_URL;
test('ProductEvent retention purges only records older than 90 days in bounded repeatable batches',{skip:url?false:'Requires TEST_DATABASE_URL'},async()=>{
 const pool=new pg.Pool({connectionString:url,max:3}),owner=randomUUID(),now=new Date(),ids=Array.from({length:3},()=>randomUUID());
 try{
  await pool.query("INSERT INTO user_account(id,oidc_issuer,oidc_subject,email,email_verified,status,created_at,updated_at) VALUES($1::uuid,$2,$1::text,$3,true,'active',now(),now())",[owner,`https://p11.operations.${owner}.invalid`,`${owner}@example.invalid`]);
  for(const [index,id]of ids.entries())await pool.query("INSERT INTO product_event(id,owner_user_id,event_name,source_key,properties,consent_version,created_at) VALUES($1,$2,'publication',$3,'{}','2026-10-20.v1',$4)",[id,owner,createHash('sha256').update(id).digest('hex'),new Date(now.getTime()-(index===2?89:91)*86400000)]);
  const scoped={query:(sql,values)=>pool.query(sql.replace('ORDER BY created_at,id LIMIT $2','AND owner_user_id=$3 ORDER BY created_at,id LIMIT $2'),[...values,owner])};
  assert.equal(await purgeExpiredProductEvents(scoped,now,1),1);assert.equal(await purgeExpiredProductEvents(scoped,now,1),1);assert.equal(await purgeExpiredProductEvents(scoped,now,1),0);
  assert.equal((await pool.query('SELECT count(*)::int AS n FROM product_event WHERE owner_user_id=$1 AND id=$2',[owner,ids[2]])).rows[0].n,1);
 }finally{await cleanupP08Fixtures(pool,[owner]);await pool.end();}
});
