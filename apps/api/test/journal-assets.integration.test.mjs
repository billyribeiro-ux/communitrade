import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import pg from 'pg';
import {JournalService} from '../dist/journal/service.js';
import {PositionService,PerformanceService} from '../dist/positions/service.js';
import {cleanupP08Fixtures} from '../scripts/p08-fixture-cleanup.mjs';
const url=process.env.TEST_DATABASE_URL;
test('P10 private stock, six supported option structures and futures use shared exact calculations',{skip:url?false:'Requires TEST_DATABASE_URL'},async()=>{
 const pool=new pg.Pool({connectionString:url,max:4}),owner=randomUUID(),suffix=randomUUID(),stock='00000000-0000-4000-8000-000000000201',mes='00000000-0000-4000-8000-000000000203';
 const contract=n=>`00000000-0000-4000-8000-${String(n).padStart(12,'0')}`;
 try{
  await pool.query("INSERT INTO user_account(id,oidc_issuer,oidc_subject,email,email_verified,status,onboarding_version,created_at,updated_at) VALUES($1::uuid,$2,$1::text,$3,true,'active','p10',now(),now())",[owner,`https://p10.journal.${suffix}.invalid`,`${owner}@example.invalid`]);
  const journals=new JournalService(pool),positions=new PositionService(pool);
  const cases=[
   {asset:'stock',strategy:'long',instrumentId:stock,legs:[],entry:'100',exit:'105',stop:'95',net:'5.0000000000'},
   {asset:'stock',strategy:'short',instrumentId:stock,legs:[],entry:'100',exit:'95',stop:'105',net:'5.0000000000',borrowCosts:'0'},
   {asset:'option',strategy:'long_call',instrumentId:stock,legs:[[221,'buy']],entry:'1.50',exit:'2.00',net:'50.0000000000'},
   {asset:'option',strategy:'long_put',instrumentId:stock,legs:[[223,'buy']],entry:'1.50',exit:'2.00',net:'50.0000000000'},
   {asset:'option',strategy:'bull_call_debit',instrumentId:stock,legs:[[221,'buy'],[222,'sell']],entry:'1.50',exit:'2.00',net:'50.0000000000'},
   {asset:'option',strategy:'bear_put_debit',instrumentId:stock,legs:[[224,'buy'],[223,'sell']],entry:'1.50',exit:'2.00',net:'50.0000000000'},
   {asset:'option',strategy:'bull_put_credit',instrumentId:stock,legs:[[224,'sell'],[223,'buy']],entry:'1.20',exit:'0.70',net:'50.0000000000'},
   {asset:'option',strategy:'bear_call_credit',instrumentId:stock,legs:[[221,'sell'],[222,'buy']],entry:'1.20',exit:'0.70',net:'50.0000000000'},
   {asset:'future',strategy:'long',instrumentId:mes,legs:[],entry:'6000',exit:'6001',stop:'5998',net:'5.0000000000'},
   {asset:'future',strategy:'short',instrumentId:mes,legs:[],entry:'6000',exit:'5999',stop:'6002',net:'5.0000000000'},
  ];
  for(const row of cases){
   const now=Date.now(),plan={asset:row.asset,strategy:row.strategy,instrumentId:row.instrumentId,legs:row.legs.map(([id,side])=>({instrumentId:contract(id),side,quantity:1})),quantity:1,entryPrice:row.entry,priceKind:row.asset==='stock'?'underlying':row.asset==='future'?'futures':row.strategy.endsWith('debit')?'spread_debit':row.strategy.endsWith('credit')?'spread_credit':'option_premium',...(row.stop?{initialStopPrice:row.stop}:{}),entryFrom:new Date(now-60000).toISOString(),entryUntil:new Date(now+3600000).toISOString(),entryCondition:'Synthetic private plan',timeframe:'swing',exitRules:'Synthetic exit report',conflicts:'Synthetic acceptance'};
   const journal=await journals.create(owner,randomUUID(),{title:`Synthetic ${row.asset} ${row.strategy}`,notes:'Private',tags:['synthetic'],plan});
   await positions.append(owner,journal.positionId,1,randomUUID(),{type:'entry',quantity:1,price:row.entry,costs:'0',claimedAt:new Date().toISOString(),...(row.borrowCosts?{borrowCosts:row.borrowCosts}:{})});
   await positions.append(owner,journal.positionId,2,randomUUID(),{type:'final_exit',quantity:1,price:row.exit,costs:'0',claimedAt:new Date().toISOString()});
   const result=await positions.get(journal.positionId,owner);assert.equal(result.state,'closed');assert.equal(result.outcome.netRealized,row.net,`${row.asset} ${row.strategy}`);assert.equal(result.outcome.eligibility,'eligible');assert.equal(result.outcome.costCoverage,'complete');
   const legs=await pool.query('SELECT count(*)::int AS count FROM position_leg WHERE position_id=$1',[journal.positionId]);assert.equal(legs.rows[0].count,row.legs.length);
  }
  const publicPerformance=await new PerformanceService(pool).getForUser(owner);assert.equal(publicPerformance.closedCount,0);assert.equal(publicPerformance.wins,0);
 }finally{await cleanupP08Fixtures(pool,[owner]);await pool.end();}
});
