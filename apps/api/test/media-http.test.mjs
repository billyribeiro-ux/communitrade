import assert from 'node:assert/strict';
import test from 'node:test';
import { MediaController } from '../dist/media/controller.js';
import { MediaService } from '../dist/media/service.js';
import { CommandError } from '../dist/http/problem.js';
import { validateRequest } from '@trading/contracts';

test('processed media responses are never cached for owners or public profile viewers', async () => {
  const auth={authenticate:async req=>{if(req.headers.cookie==='signed-in')return {userId:'owner-1'};throw new CommandError(401,'AUTHENTICATION_REQUIRED');},assertPublicRead:async()=>{}};
  const service={content:async(owner,id)=>{assert.equal(id,'00000000-0000-4000-8000-000000000001');assert.ok(owner==='owner-1'||owner===null);return Buffer.from('webp');}};
  const controller=new MediaController(auth,service);
  for(const cookie of ['signed-in',undefined]){
    const headers={};const requestHeaders={};if(cookie)requestHeaders.cookie=cookie;const response={setHeader:(key,value)=>headers[key]=value,status(code){this.code=code;return this;},send(bytes){this.bytes=bytes;}};
    await controller.getContent('00000000-0000-4000-8000-000000000001',{headers:requestHeaders,params:{id:'00000000-0000-4000-8000-000000000001'}},response);
    assert.equal(response.code,200);assert.equal(headers['Cache-Control'],'private, no-store');assert.equal(headers['Content-Type'],'image/webp');
  }
});

test('raw upload route accepts the 2 MiB boundary and rejects oversized and spoofed MIME bytes',async()=>{
  const id='00000000-0000-4000-8000-000000000002';const owner='owner-1';
  const row={id,owner_user_id:owner,status:'quarantined',expires_at:new Date(Date.now()+60_000),declared_mime:'image/png',byte_size:2*1024*1024};
  const client={query:async(sql)=>{if(sql.includes('SELECT * FROM media'))return {rowCount:1,rows:[row]};return {rowCount:1,rows:[]};},release(){}};
  const pool={connect:async()=>client};const stored=[];const storage={putQuarantined:async(uploadId,bytes)=>{stored.push([uploadId,bytes.byteLength]);return `${uploadId}/quarantine.bin`;}};
  const media=new MediaService(pool,storage);const auth={authenticate:async()=>({userId:owner}),assertCsrf:async()=>{},assertPublicRead:async()=>{}};const controller=new MediaController(auth,media);
  assert.doesNotThrow(()=>validateRequest('uploadLocalBytes',{path:{id},headers:{'X-CSRF-Token':'csrf'},contentType:'image/png',body:Buffer.from([1])}));
  const request=bytes=>({headers:{'content-type':'image/png','x-csrf-token':'csrf',origin:'http://localhost'},body:bytes,params:{id}});
  const response={status(code){this.code=code;return this;},end(){this.ended=true;}};
  await controller.put(id,request(Buffer.alloc(2*1024*1024)),response);
  assert.equal(response.code,204);assert.deepEqual(stored,[[id,2*1024*1024]]);
  await assert.rejects(controller.put(id,request(Buffer.alloc(2*1024*1024+1)),response),error=>error.name==='ContractValidationError');
  const badType=request(Buffer.alloc(8));badType.headers['content-type']='image/svg+xml';
  await assert.rejects(controller.put(id,badType,response),error=>error.name==='ContractValidationError');
});

test('media polling exposes owner processing/rejected states and hides cross-owner media',async()=>{
  const id='00000000-0000-4000-8000-000000000003';let status='processing';let attached=null;
  const pool={query:async()=>({rowCount:1,rows:[{id,owner_user_id:'owner-1',purpose:'avatar',status,processed_key:status==='ready'?`${id}/processed.webp`:null,failure_code:status==='rejected'?'INVALID_IMAGE':null,avatar_media_id:attached,avatar_profile_public:true,account_status:attached?'active':null}]})};
  const media=new MediaService(pool,{});
  assert.equal((await media.getMeta('owner-1',id)).status,'processing');
  status='rejected';const rejected=await media.getMeta('owner-1',id);assert.equal(rejected.status,'rejected');assert.equal(rejected.reason,'INVALID_IMAGE');
  await assert.rejects(media.getMeta('owner-2',id),error=>error.status===404);
  status='ready';await assert.rejects(media.getMeta('owner-2',id),error=>error.status===404);attached=id;
  assert.equal((await media.getMeta(null,id)).url,`/api/v1/media/${id}/content`);
});
