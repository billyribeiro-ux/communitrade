import test from 'node:test';
import assert from 'node:assert/strict';
import {publicShareUrl,socialShareLinks,shareImagePath} from '../src/lib/sharing.ts';
const id='10000000-0000-4000-8000-000000000001',version='10000000-0000-4000-8000-000000000002';
test('public share identity and URLs exclude private resources, credentials, and URL injection',()=>{
 const url=`https://community.example/ideas/${id}/defined-risk`;
 assert.equal(publicShareUrl(url,{publicationId:id}),url);
 for(const bad of [`https://community.example/app/journal`,`${url}?private=1`,`${url}#secret`,url.replace(id,version),`javascript:alert(1)`,url.replace('https://','https://person:password@')])assert.throws(()=>publicShareUrl(bad,{publicationId:id}));
 assert.equal(publicShareUrl('https://community.example/u/member_1',{handle:'member_1'}),'https://community.example/u/member_1');
});
test('social destinations encode values once without adding arbitrary intent parameters',()=>{
 const url=`https://community.example/ideas/${id}/risk`,title='Options & risk? #1 + 2';
 const links=socialShareLinks(url,title);for(const link of Object.values(links)){const parsed=new URL(link);assert.equal(parsed.searchParams.get('url'),url);assert.equal(parsed.protocol,'https:');}
 assert.equal(new URL(links.x).searchParams.get('text'),title);assert.equal(new URL(links.reddit).searchParams.get('title'),title);
});
test('image downloads bind the visible original resource and exact version through the authorization proxy',()=>{
 const path=`/api/v1/publications/${id}/share/image?versionId=${version}&download=true`;
 assert.equal(shareImagePath(`https://community.example${path}`,id,version),path);
 for(const bad of [path.replace(id,version),path.replace(version,id),`${path}&url=https://private.example`,path.replace('/share/image','/draft')])assert.throws(()=>shareImagePath(`https://community.example${bad}`,id,version));
});
