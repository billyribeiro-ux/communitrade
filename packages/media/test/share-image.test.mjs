import test from 'node:test';
import assert from 'node:assert/strict';
import sharp from 'sharp';
import {createAttributedShareImage} from '../dist/index.js';
test('share export appends attribution without mutating original pixels or accepting arbitrary input dimensions',async()=>{
 const source=await sharp({create:{width:1200,height:760,channels:3,background:'#203040'}}).webp().toBuffer();
 const before=Buffer.from(source);const attribution={authorHandle:'options_member',publishedAt:'2026-10-20T14:00:00.000Z',strategy:'bull_call_debit',instrument:'SPY options'};
 const result=await createAttributedShareImage(source,attribution);assert.deepEqual(source,before);
 const metadata=await sharp(result).metadata();assert.equal(metadata.format,'webp');assert.equal(metadata.width,1200);assert.equal(metadata.height,872);
 const footer=await sharp(result).extract({left:0,top:760,width:1200,height:112}).stats();
 assert.ok(footer.channels.slice(0,3).every(channel=>channel.stdev>2),'Attribution footer must contain rendered glyphs, not an empty background.');
 assert.notDeepEqual(result,source);await assert.rejects(createAttributedShareImage(source,{...attribution,authorHandle:'../private'}));
 const tiny=await sharp({create:{width:100,height:100,channels:3,background:'#203040'}}).webp().toBuffer();await assert.rejects(createAttributedShareImage(tiny,attribution));
});
