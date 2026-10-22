import assert from 'node:assert/strict';
import test from 'node:test';
import { assertProductionDataReady } from '../dist/persistence/production-data-readiness.js';

const flags=(enabled)=>({displayPublic:enabled,displayMember:enabled,retainBars:enabled,retainSnapshot:enabled,exportImage:false,exportPersonalRecord:false,newPublishing:enabled});
function completeRows(){
  const grants=[];
  for(const [asset,dataset] of [['stock','equities'],['option','options'],['future','futures']])for(const audience of ['public','member']){
    grants.push({asset,dataset,audience,purpose:'display',flags:flags(true)});
    grants.push({asset,dataset,audience,purpose:'snapshot',flags:flags(true)});
    grants.push({asset,dataset,audience,purpose:'publishing',flags:flags(true)});
    if(asset!=='option')grants.push({asset,dataset,audience,purpose:'chart',flags:flags(true)});
  }
  return {grants,calendar:['public','member'].map(audience=>({audience,purpose:'display',flags:{...flags(false),displayPublic:audience==='public',displayMember:audience==='member'}}))};
}
function fakePool(data){return {query:async(sql)=>({rows:sql.includes("dataset='calendar'")?data.calendar:data.grants})};}

test('production data readiness accepts complete per-dataset rights and separate calendar approvals',async()=>{
  const rows=completeRows();
  await assert.doesNotReject(()=>assertProductionDataReady(fakePool(rows),true));
});

test('production data readiness fails closed for missing or incomplete rights',async()=>{
  const rows=completeRows();rows.calendar=rows.calendar.filter(row=>row.audience!=='member');
  await assert.rejects(()=>assertProductionDataReady(fakePool(rows),true),/calendar display rights are incomplete for member/);
  await assert.rejects(()=>assertProductionDataReady(fakePool(completeRows()),false),/not fully configured/);
});
