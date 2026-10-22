import test from 'node:test';
import assert from 'node:assert/strict';
import {createRequire} from 'node:module';
import {createApp} from '../dist/app.js';
const sharp=createRequire(new URL('../../../packages/media/package.json',import.meta.url))('sharp');
test('HTTP download=true appends licensed attribution while the default serves exact frozen bytes',async()=>{
 const id='10000000-0000-4000-8000-000000000001',version='10000000-0000-4000-8000-000000000002';
 const frozen=await sharp({create:{width:1200,height:760,channels:3,background:'#203040'}}).webp().toBuffer();let authorizations=0;
 const publications={assertShareImageExport:async()=>{authorizations++;},getPublication:async()=>({author:{handle:'option_member'},publishedAt:'2026-10-20T14:00:00.000Z',chart:{instrumentId:id,metadataVersion:1},plan:{asset:'future',strategy:'long'}})};
 const app=await createApp({$queryRaw:async()=>[]},null,{auth:{assertPublicRead:async()=>{}},publications,media:{content:async()=>frozen},instruments:{get:async()=>({symbol:'ESZ6',contractMonth:'2026-12'})}});
 try{
  await app.listen(0,'127.0.0.1');const url=`${await app.getUrl()}/api/v1/publications/${id}/share/image?versionId=${version}`;
  const original=await fetch(url);assert.equal(original.status,200);assert.deepEqual(Buffer.from(await original.arrayBuffer()),frozen);assert.equal(original.headers.get('content-disposition'),null);
  const download=await fetch(url+'&download=true');assert.equal(download.status,200);assert.match(download.headers.get('content-disposition'),/attachment/);assert.match(download.headers.get('cache-control'),/no-store/);
  const meta=await sharp(Buffer.from(await download.arrayBuffer())).metadata();assert.equal(meta.width,1200);assert.equal(meta.height,872);assert.equal(meta.format,'webp');assert.equal(authorizations,2);
  const invalid=await fetch(url+'&download=unexpected');assert.equal(invalid.status,400);assert.equal(authorizations,2,'Invalid query never reaches a licensed export.');
 }finally{await app.close();}
});
