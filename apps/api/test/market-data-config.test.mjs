import assert from 'node:assert/strict';
import test from 'node:test';
import { createMarketDataRuntime } from '../dist/instruments/market-data-config.js';

const allRights={displayPublic:true,displayMember:true,retainBars:true,retainSnapshot:true,exportImage:true,exportPersonalRecord:true,newPublishing:true};
const schemas={stock:{'1m':'ohlcv-1m','5m':'ohlcv-1m','15m':'ohlcv-1m','1h':'ohlcv-1h','1d':'ohlcv-1d'},option:{},future:{'1m':'ohlcv-1m','5m':'ohlcv-1m','15m':'ohlcv-1m','1h':'ohlcv-1h','1d':'ohlcv-1d'}};
const today=new Date().toISOString().slice(0,10),tomorrowDate=new Date(Date.parse(`${today}T00:00:00.000Z`)+86400000).toISOString().slice(0,10),calendar={provider:'approved-calendar-feed',asOf:new Date(Date.now()-1000).toISOString(),delaySeconds:60,validFrom:today,validThrough:tomorrowDate,validUntil:`${tomorrowDate}T23:59:59.000Z`,sessions:[{venue:'US_EQUITY',tradingDate:today,open:`${today}T13:30:00.000Z`,close:`${today}T20:00:00.000Z`,timezone:'America/New_York',status:'open',authoritative:true}]};
const env={RELEASE_MODE:'production',MARKET_DATA_PROVIDER:'databento',DATABENTO_API_KEY:'test-only-placeholder',DATABENTO_STOCK_DATASET:'EQUS.SUMMARY',DATABENTO_OPTION_DATASET:'OPRA.PILLAR',DATABENTO_FUTURE_DATASET:'GLBX.MDP3',DATABENTO_SCHEMAS:JSON.stringify(schemas),DATABENTO_APPROVED_CAPABILITIES:JSON.stringify({stock:allRights,option:allRights,future:allRights}),DATABENTO_DELAY_SECONDS:'900',DATABENTO_CALENDAR_CONFIG:JSON.stringify(calendar)};
const mappings=[['stock','EQUS.SUMMARY'],['option','OPRA.PILLAR'],['future','GLBX.MDP3']].map(([asset,dataset],index)=>({instrument_id:`00000000-0000-4000-8000-00000000000${index+1}`,asset,dataset,raw_symbol:`TEST.${asset.toUpperCase()}`,metadata_version:1}));
const pool={query:async()=>({rows:mappings})};

test('production provider setup becomes configured with explicit scoped mappings and calendar coverage',async()=>{
  const runtime=await createMarketDataRuntime(pool,env);
  assert.equal(runtime.mode,'databento');assert.equal(runtime.configured,true);
  await assert.rejects(()=>runtime.adapter.getQuoteSnapshot('unmapped-id'));
});

test('production provider setup rejects missing credentials, incomplete approvals, and calendar coverage',async()=>{
  await assert.rejects(()=>createMarketDataRuntime(pool,{...env,DATABENTO_API_KEY:''}),/DATABENTO_API_KEY is required/);
  await assert.rejects(()=>createMarketDataRuntime(pool,{...env,DATABENTO_APPROVED_CAPABILITIES:JSON.stringify({stock:allRights,option:allRights,future:{}})}),/all seven explicit permissions/);
  await assert.rejects(()=>createMarketDataRuntime(pool,{...env,DATABENTO_CALENDAR_CONFIG:''}),/DATABENTO_CALENDAR_CONFIG must contain/);
  const unknownDatasetPool={query:async()=>({rows:mappings.map(row=>row.asset==='stock'?{...row,dataset:'EQ.D'}:row)})};
  await assert.rejects(()=>createMarketDataRuntime(unknownDatasetPool,{...env,DATABENTO_STOCK_DATASET:'EQ.D'}),/Approved provider dataset is not configured/);
  const invalidCalendar={...calendar,sessions:[{...calendar.sessions[0],open:`${today}T21:00:00.000Z`,close:`${today}T20:00:00.000Z`}]};
  await assert.rejects(()=>createMarketDataRuntime(pool,{...env,DATABENTO_CALENDAR_CONFIG:JSON.stringify(invalidCalendar)}),/invalid or non-authoritative session/);
  const runtime=await createMarketDataRuntime(pool,env),hole=await runtime.adapter.getCalendar({venue:'US_EQUITY',from:today,to:tomorrowDate});assert.equal(hole.freshness,'missing');
  const staleCalendar={...calendar,validUntil:new Date(Date.now()-1000).toISOString()},staleRuntime=await createMarketDataRuntime(pool,{...env,DATABENTO_CALENDAR_CONFIG:JSON.stringify(staleCalendar)}),stale=await staleRuntime.adapter.getCalendar({venue:'US_EQUITY',from:today,to:today});assert.equal(stale.freshness,'stale');
});

test('synthetic adapter uses current canonical future metadata for provider envelopes',async()=>{
  const futureId='00000000-0000-4000-8000-000000000202';
  const rows=[{
    id:futureId,vendor_id:'SYN-ESZ26',asset:'future',underlying_id:null,venue:'CME',currency:'USD',enabled:true,
    expiry:'2026-12-18T14:30:00.000Z',strike:null,option_type:null,multiplier:'50',tick_size:'0.25',root:'ES',contract_month:12,contract_year:2026,adjusted:false,session:{label:'CME_GLOBEX'},version:2
  }];
  const runtime=await createMarketDataRuntime({query:async()=>({rows})},{MARKET_DATA_PROVIDER:'synthetic'});
  const end=new Date(),start=new Date(end.getTime()-86400000);
  const bars=await runtime.adapter.getBars({instrumentId:futureId,interval:'1d',from:start.toISOString(),to:end.toISOString(),session:'all',adjustment:'raw'});
  assert.equal(bars.metadataVersion,2);
  const instrument=await runtime.adapter.getInstrument(futureId);
  assert.equal(instrument.metadataVersion,2);
  assert.equal(instrument.data.multiplier,'50');
  assert.equal(instrument.data.tickSize,'0.25');
  assert.equal(instrument.data.session,'CME_GLOBEX');
  const contracts=await runtime.adapter.listFuturesContracts({root:'ES'});
  assert.equal(contracts.data.items.find(item=>item.id===futureId)?.metadataVersion,2);
});
