import assert from 'node:assert/strict';
import test from 'node:test';
import {InstrumentService} from '../dist/instruments/service.js';
test('P10 watchlist summaries batch catalog/rights reads and omit revoked member display without fetching quotes',async()=>{
 const ids=['00000000-0000-4000-8000-000000000201','00000000-0000-4000-8000-000000000202'];
 const flags={displayPublic:false,displayMember:true,retainBars:false,retainSnapshot:false,exportImage:false,exportPersonalRecord:false,newPublishing:false};
 const rows=ids.map((id,index)=>({id,asset:'stock',vendor:'fixture',vendor_id:`SYN-${index}`,provider_dataset:'stock',venue:'TEST',currency:'USD',enabled:true,version:1,multiplier:'1',tick_size:'0.01',strike:null,expiry:null,option_type:null,adjusted:false,session:null,source_id:'fixture'}));
 const queries=[];const transaction={query:async(sql,values)=>{queries.push(sql);if(sql.includes('FROM instrument i')){assert.deepEqual(values,[ids]);return {rows};}if(sql.includes('FROM data_capability'))return {rows:[{supplier:'fixture',agreement_id:'test',dataset:'stock',audience:'member',purpose:'display',effective_at:new Date(0),revoked_at:null,flags}]};throw new Error('unexpected query');}};
 const checked=[];const provider={getCapabilities:async(id,audience,purpose)=>{checked.push(id);assert.equal(audience,'member');assert.equal(purpose,'display');return {data:{...flags,displayMember:id===ids[0]}};}};
 const service=new InstrumentService({query:async()=>{throw new Error('must use passed transaction');}},provider,'synthetic',true);
 const summary=await service.workspaceSummaries(ids,transaction);assert.equal(queries.length,2);assert.equal(summary.length,1);assert.equal(summary[0].symbol,'SYN-0');assert.deepEqual(checked,ids);assert.equal(summary[0].meta.capabilities.exportImage,false);
});
