import test from 'node:test';
import assert from 'node:assert/strict';
import {collectDiscoveryEntries} from '../src/lib/sitemap-entries.ts';
const entry={path:'/u/options_member',lastModified:'2026-10-20T14:00:00.000Z'};
test('public discovery traverses empty revoked pages and fails rather than retaining stale partial output',async()=>{
 const cursors=[];assert.deepEqual(await collectDiscoveryEntries(async cursor=>{cursors.push(cursor);return cursor?{items:[entry],nextCursor:null}:{items:[],nextCursor:'next'};}),[entry]);assert.deepEqual(cursors,[undefined,'next']);
 await assert.rejects(collectDiscoveryEntries(async cursor=>{if(cursor)throw new Error('Rights service down');return {items:[entry],nextCursor:'next'};}));
 await assert.rejects(collectDiscoveryEntries(async()=>({items:[],nextCursor:'same'})));
 await assert.rejects(collectDiscoveryEntries(async()=>({items:[{...entry,path:'/app/journal'}],nextCursor:null})));
});
