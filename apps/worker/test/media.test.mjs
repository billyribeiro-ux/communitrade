import assert from 'node:assert/strict';
import test from 'node:test';
import sharp from 'sharp';
import { dispatchMediaOutbox, processMediaJob, purgeExpiredUploads } from '../dist/media.js';

const queryPool = (query) => ({ connect: async () => ({ query, release() {} }) });

test('media worker re-encodes valid bytes and persists ready state', async () => {
  const image = await sharp({ create: { width: 20, height: 12, channels: 3, background: '#abcdef' } }).png().toBuffer();
  const media = { id: '00000000-0000-4000-8000-000000000001', status: 'processing', purpose: 'avatar', declared_mime: 'image/png', byte_size: image.byteLength, quarantine_key: 'ignored' };
  const calls=[]; const pool=queryPool(async(sql,values)=>{calls.push({sql,values});if(sql.startsWith('SELECT id,status'))return {rowCount:1,rows:[media]};if(sql.includes("status='ready'"))return {rowCount:1,rows:[]};return {rowCount:1,rows:[]};});
  const storage={readQuarantined:async()=>image,putProcessed:async(id,bytes)=>{assert.equal(id,media.id);assert.equal((await sharp(bytes).metadata()).format,'webp');return `${id}/processed.webp`;},deleteObject:async()=>{}};
  await processMediaJob(pool,storage,{mediaId:media.id});
  const saved=calls.find(call=>call.sql.includes("status='ready'"));
  assert.match(saved.sql,/status='ready'/);
  assert.equal(saved.values[1],`${media.id}/processed.webp`);
});

test('media worker rejects malformed bytes and does not publish an object', async () => {
  const media = { id: '00000000-0000-4000-8000-000000000002', status: 'processing', purpose: 'avatar', declared_mime: 'image/png', byte_size: 5, quarantine_key: 'ignored' };
  const calls=[]; const pool=queryPool(async(sql,values)=>{calls.push({sql,values});if(sql.startsWith('SELECT id,status'))return {rowCount:1,rows:[media]};return {rowCount:1,rows:[]};});
  const storage={readQuarantined:async()=>Buffer.from('hello'),putProcessed:async()=>{throw new Error('must not process invalid bytes');},deleteObject:async()=>{}};
  await processMediaJob(pool,storage,{mediaId:media.id});
  const rejected=calls.find(call=>call.sql.includes("status='rejected'"));
  assert.match(rejected.sql,/status='rejected'/);
  assert.equal(rejected.values[1],'INVALID_IMAGE');
});

test('worker persists terminal processing failure after bounded retries',async()=>{
  const media={id:'00000000-0000-4000-8000-000000000003',status:'processing',purpose:'avatar',declared_mime:'image/png',byte_size:10,quarantine_key:'ignored'};const calls=[];
  const pool=queryPool(async(sql,values)=>{calls.push({sql,values});if(sql.startsWith('SELECT id,status'))return {rowCount:1,rows:[media]};return {rowCount:1,rows:[]};});
  const storage={readQuarantined:async()=>{throw new Error('temporary disk failure');},putProcessed:async()=>{throw new Error('unexpected');},deleteObject:async()=>{}};
  await processMediaJob(pool,storage,{mediaId:media.id},5,5);
  assert.ok(calls.some(call=>call.sql.includes("status='rejected'")&&call.sql.includes("'MEDIA_PROCESSING_FAILED'")&&call.values[0]===media.id));
});

test('worker row lock serializes duplicate processing and makes expiry purge skip active work',async()=>{
  const raw=await sharp({create:{width:8,height:8,channels:3,background:'#123456'}}).png().toBuffer();
  const media={id:'00000000-0000-4000-8000-000000000004',status:'processing',purpose:'avatar',declared_mime:'image/png',byte_size:raw.byteLength,quarantine_key:'ignored',expires_at:new Date(Date.now()+1000)};
  const calls=[];let locked=false;const waiters=[];const pool={connect:async()=>{let ownsLock=false;return{query:async(sql,values)=>{calls.push({sql,values});if(sql.startsWith('SELECT id,status')){if(locked)await new Promise(resolve=>waiters.push(resolve));locked=true;ownsLock=true;return{rowCount:1,rows:[media]};}if(sql.includes("status='ready'"))media.status='ready';if(['COMMIT','ROLLBACK'].includes(sql)&&ownsLock){ownsLock=false;locked=false;waiters.shift()?.();}return{rowCount:1,rows:[]};},release(){}};}};
  let entered;const reading=new Promise(resolve=>entered=resolve);let resume;const blocked=new Promise(resolve=>resume=resolve);let reads=0;const objects=new Map();
  const storage={readQuarantined:async()=>{reads++;entered();await blocked;return raw;},putProcessed:async(id,bytes)=>{objects.set(`${id}/processed.webp`,bytes);return `${id}/processed.webp`;},deleteObject:async key=>{objects.delete(key);}};
  const processing=processMediaJob(pool,storage,{mediaId:media.id});await reading;
  const duplicate=processMediaJob(pool,storage,{mediaId:media.id});
  await new Promise(resolve=>setTimeout(resolve,30));
  assert.equal(reads,1);
  const purgeClient={query:async(sql)=>{if(sql.startsWith('SELECT m.id,m.status,m.purpose'))return{rows:[]};return{rows:[]};},release(){}};
  const purged=await purgeExpiredUploads({connect:async()=>purgeClient},storage);
  assert.equal(purged,0);
  resume();await Promise.all([processing,duplicate]);
  assert.ok(calls.some(call=>call.sql.includes('FOR UPDATE')));
  assert.equal(reads,1);
});

test('outbox marks delivered only after the queue accepts a recoverable job', async () => {
  const calls=[];const client={query:async(sql,values)=>{calls.push({sql,values});if(sql.includes('SELECT e.id,e.aggregate_id'))return {rows:[{id:'event-1',aggregate_id:'media-1',quarantine_key:'media-1/quarantine.bin'}]};return {rows:[]};},release(){}};
  const pool={connect:async()=>client};let sent=0;
  const storage={deleteObject:async()=>{}};const count=await dispatchMediaOutbox(pool,storage,async(queue,data,options)=>{sent++;assert.equal(queue,'media.process');assert.equal(data.mediaId,'media-1');assert.equal(options.id,'event-1');assert.equal('singletonSeconds' in options,false);return 'job-id';});
  assert.equal(count,1);assert.equal(sent,1);assert.ok(calls.some(call=>call.sql.includes("status='delivered'")));
});

test('outbox dispatch reaches a terminal media failure after eight bounded attempts',async()=>{
  let attempts=0;let pending=true;const calls=[];const client={query:async(sql,values)=>{calls.push({sql,values});if(sql.includes('SELECT e.id,e.aggregate_id'))return {rows:pending?[{id:'event-2',aggregate_id:'media-3',quarantine_key:'media-3/quarantine.bin'}]:[]};if(sql.includes('RETURNING status')){attempts++;if(attempts>=8)pending=false;return {rows:[{status:pending?'pending':'failed'}]};}if(sql.includes("failure_code='QUEUE_DISPATCH_FAILED'"))return{rowCount:1,rows:[{id:'media-3'}]};return {rows:[]};},release(){}};
  const deleted=[];const storage={deleteObject:async key=>deleted.push(key)};const send=async()=>{throw new Error('queue unavailable');};
  for(let index=0;index<8;index++)await dispatchMediaOutbox({connect:async()=>client},storage,send);
  assert.equal(attempts,8);assert.ok(calls.some(call=>call.sql.includes("failure_code='QUEUE_DISPATCH_FAILED'")));assert.deepEqual(deleted,['media-3/quarantine.bin','media-3/processed.webp']);
});

test('terminal outbox failure never deletes processed media if the row already became ready',async()=>{
  let attempts=0;let pending=true;const calls=[];const client={query:async(sql,values)=>{calls.push({sql,values});if(sql.includes('SELECT e.id,e.aggregate_id'))return{rows:pending?[{id:'event-ready',aggregate_id:'media-ready',quarantine_key:'media-ready/quarantine.bin'}]:[]};if(sql.includes('RETURNING status')){attempts++;if(attempts>=8)pending=false;return{rows:[{status:pending?'pending':'failed'}]};}if(sql.includes("failure_code='QUEUE_DISPATCH_FAILED'"))return{rowCount:0,rows:[]};return{rows:[]};},release(){}};
  const deleted=[];const storage={deleteObject:async key=>deleted.push(key)};const send=async()=>{throw new Error('queue unavailable')};
  for(let index=0;index<8;index++)await dispatchMediaOutbox({connect:async()=>client},storage,send);
  assert.equal(attempts,8);
  assert.ok(calls.some(call=>call.sql.includes("WHERE id=$1 AND status='processing' RETURNING id")));
  assert.deepEqual(deleted,[]);
});

test('expired unattached upload quarantine is purged from storage and database', async()=>{
  const calls=[];const client={query:async(sql,values)=>{calls.push({sql,values});if(sql.includes('SELECT m.id,m.status,m.purpose'))return {rows:[{id:'media-2',status:'quarantined',purpose:'avatar',quarantine_key:'media-2/quarantine.bin',processed_key:null}]};return {rows:[]};},release(){}};
  const deleted=[];const count=await purgeExpiredUploads({connect:async()=>client},{deleteObject:async key=>deleted.push(key)});
  assert.equal(count,1);assert.deepEqual(deleted,['media-2/quarantine.bin']);assert.ok(calls.some(call=>call.sql.startsWith('DELETE FROM media')));
});
