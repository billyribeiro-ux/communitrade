import assert from 'node:assert/strict';
import test from 'node:test';
import {randomUUID} from 'node:crypto';
import pg from 'pg';
import {MediaService} from '../dist/media/service.js';
import {cleanupP08Fixtures} from '../scripts/p08-fixture-cleanup.mjs';

const url=process.env.TEST_DATABASE_URL;
test('publication images require committed attachment membership, active author and current source authorization', {skip:url?false:'Set TEST_DATABASE_URL for PostgreSQL media isolation.'}, async()=>{
 const pool=new pg.Pool({connectionString:url,max:3});
 const owner=randomUUID(),pub=randomUUID(),original=randomUUID(),pending=randomUUID(),image=randomUUID(),uncommittedImage=randomUUID();
 const bytes=Buffer.from('processed test bytes');let allowed=true;const authorizedVersions=[];
 const service=new MediaService(pool,{readAuthorized:async()=>bytes},async(publicationId,versionId)=>{assert.equal(publicationId,pub);authorizedVersions.push(versionId);return allowed;});
 const denied=action=>assert.rejects(action,error=>error.status===404);
 try{
  await pool.query(`INSERT INTO user_account(id,oidc_issuer,oidc_subject,email,email_verified,status,onboarding_version,created_at,updated_at) VALUES($1,'https://p08.media.invalid',$2,$3,true,'active','test',now(),now())`,[owner,owner,`${owner}@example.invalid`]);
  await pool.query(`INSERT INTO publication(id,author_user_id,kind,visibility,published_at) VALUES($1,$2,'education','private',NULL)`,[pub,owner]);
  await pool.query(`INSERT INTO publication_version(id,publication_id,sequence,terms,thesis,chart,disclosures) VALUES($1,$2,1,$3::jsonb,'Public explanation','{}','{}')`,[original,pub,JSON.stringify({title:'Original',attachmentIds:[]})]);
  await pool.query("UPDATE publication SET original_version_id=$2,current_version_id=$2,visibility='public',published_at=now() WHERE id=$1",[pub,original]);
  for(const id of [image,uncommittedImage])await pool.query(`INSERT INTO media(id,owner_user_id,purpose,resource_type,resource_id,version,status,quarantine_key,processed_key) VALUES($1,$2,'publication_attachment','publication',$3,1,'ready','',$4)`,[id,owner,pub,`${id}/processed.webp`]);
  await denied(()=>service.content(null,image));
  assert.deepEqual(await service.content(owner,image),bytes,'unreferenced upload remains private to its owner');
  // The immutable replacement is pending: neither its media nor its terms are public.
  await pool.query(`INSERT INTO publication_version(id,publication_id,sequence,previous_version_id,terms,thesis,chart,disclosures) VALUES($1,$2,2,$3,$4::jsonb,'Replacement explanation','{}','{}')`,[pending,pub,original,JSON.stringify({title:'Replacement',attachmentIds:[image,uncommittedImage]})]);
  await denied(()=>service.getMeta(null,uncommittedImage));
  assert.equal(authorizedVersions.length,0,'pending version never reaches the public source guard');
  await pool.query('UPDATE publication SET current_version_id=$2 WHERE id=$1',[pub,pending]);
  assert.deepEqual(await service.content(null,image),bytes);
  assert.equal((await service.getMeta(null,image)).status,'ready');
  assert.ok(authorizedVersions.includes(pending));
  allowed=false;
  await denied(()=>service.getMeta(null,image));await denied(()=>service.content(null,image));
  await pool.query(`INSERT INTO media(id,owner_user_id,purpose,resource_type,resource_id,version,status,quarantine_key,processed_key) VALUES($1,$2,'chart_snapshot','publication',$3,1,'ready','',$4)`,[pending,owner,pub,`${pending}/processed.webp`]);
  await denied(()=>service.content(owner,pending));
  allowed=true;
  await pool.query("UPDATE user_account SET status='suspended' WHERE id=$1",[owner]);
  await denied(()=>service.content(null,image));
 }finally{
  try{await cleanupP08Fixtures(pool,[owner]);}finally{await pool.end();}
 }
});
