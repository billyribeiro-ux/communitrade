import pg from 'pg';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
const {Pool}=pg;
const loadRun=process.env.P14_LOAD_RUN??'';
if(!/^[a-f0-9]{20}$/.test(loadRun)||process.env.P14_LOAD_DB!==`p14_load_${loadRun}`)throw new Error('GENERATED_LOAD_DATABASE_GUARD_FAILED');
const poolMax=Number(process.env.P14_LOAD_POOL_MAX??8);
if(![8,20].includes(poolMax))throw new Error('LOAD_POOL_MAX_MUST_BE_8_OR_20');
const u=new URL(process.env.DATABASE_URL);u.pathname='/'+process.env.P14_LOAD_DB;
const pool=new Pool({connectionString:u.href,max:poolMax,connectionTimeoutMillis:30000,query_timeout:30000,idleTimeoutMillis:10000});
const poolCheckoutWaits=[];
const originalConnect=pool.connect.bind(pool);
pool.connect=(...args)=>{
 const requestedAt=performance.now(),callbackIndex=args.findIndex(value=>typeof value==='function');
 if(callbackIndex>=0){const callback=args[callbackIndex];args[callbackIndex]=(...values)=>{if(!values[0])poolCheckoutWaits.push(performance.now()-requestedAt);callback(...values);};return originalConnect(...args);}
 return originalConnect(...args).then(client=>{poolCheckoutWaits.push(performance.now()-requestedAt);return client;});
};
 const users=5000, activeMonthly=1000, publications=50000, comments=250000;
const durationByOperation={sessionAuthentication:[],privateRead:[],privateWrite:[],plainFeed:[],publicationSearch:[],chartHistory:[],authenticatedPrivateRead:[],authenticatedPrivateWrite:[]};
const timed=async (operation,fn)=>{const t=performance.now();try{return await fn();}finally{durationByOperation[operation].push(performance.now()-t);}};
const percentile=(xs,p)=>{const s=[...xs].sort((a,b)=>a-b);return s[Math.min(s.length-1,Math.ceil(s.length*p)-1)]??0;};
try {
 if(process.env.P14_LOAD_PHASE==='migrate-seed'){
  for(const name of ['db:migrate','db:seed']){const r=spawnSync('pnpm',[name],{cwd:'/workspace',env:{...process.env,DATABASE_URL:u.href},stdio:'inherit'});if(r.status!==0)throw new Error('LOAD_DB_MIGRATION_OR_SEED_FAILED');}
  process.exit(0);
 }
 const refsResult=await pool.query(`SELECT i.id,i.asset,i.vendor_id AS symbol,i.currency,i.enabled,i.underlying_id,
  m.id AS metadata_id,m.version,m.multiplier,m.tick_size,m.expiry,m.strike,m.option_type,m.root,m.contract_month,m.contract_year,m.adjusted
  FROM instrument i JOIN instrument_metadata_version m ON m.instrument_id=i.id AND m.version=(SELECT max(x.version) FROM instrument_metadata_version x WHERE x.instrument_id=i.id)
  WHERE i.vendor='synthetic-fixture' ORDER BY i.asset,i.vendor_id`);
 const references=new Map(refsResult.rows.map(row=>[row.id,{id:row.id,asset:row.asset,symbol:row.symbol,currency:row.currency,enabled:row.enabled,underlyingId:row.underlying_id,metadata:{id:row.metadata_id,version:Number(row.version),multiplier:row.multiplier,tickSize:row.tick_size,expiry:row.expiry?.toISOString?.()??(row.expiry?new Date(row.expiry).toISOString():null),strike:row.strike,optionType:row.option_type,root:row.root,contractMonth:row.contract_month,contractYear:row.contract_year,adjusted:row.adjusted}}]));
 const stockRef=[...references.values()].find(ref=>ref.asset==='stock'&&ref.symbol==='SYN-XYZ');
 const futures=[...references.values()].filter(ref=>ref.asset==='future'&&['ES','MES','NQ','MNQ'].includes(ref.metadata.root)&&ref.metadata.contractYear===2026).sort((a,b)=>['ES','MES','NQ','MNQ'].indexOf(a.metadata.root)-['ES','MES','NQ','MNQ'].indexOf(b.metadata.root));
 const options=new Map([...references.values()].filter(ref=>ref.asset==='option').map(ref=>[ref.symbol,ref]));
 if(!stockRef||futures.length!==4||!['SYN-XYZ-20261120-C100','SYN-XYZ-20261120-C105','SYN-XYZ-20261120-P100','SYN-XYZ-20261120-P105'].every(symbol=>options.has(symbol)))throw new Error('SEEDED_MIXED_ASSET_REFERENCES_INCOMPLETE');
 const rightsPreflight=await pool.query(`WITH required(dataset,audience,purpose,flags) AS (VALUES
  ('stock','public','display','{"displayPublic":true}'::jsonb),('stock','public','chart','{"retainBars":true}'::jsonb),('stock','public','snapshot','{"retainSnapshot":true}'::jsonb),('stock','member','publishing','{"displayMember":true,"retainBars":true,"retainSnapshot":true,"newPublishing":true}'::jsonb),
  ('future','public','display','{"displayPublic":true}'::jsonb),('future','public','chart','{"retainBars":true}'::jsonb),('future','public','snapshot','{"retainSnapshot":true}'::jsonb),('future','member','publishing','{"displayMember":true,"retainBars":true,"retainSnapshot":true,"newPublishing":true}'::jsonb),
  ('option','public','display','{"displayPublic":true}'::jsonb),('option','public','chart','{"retainBars":true}'::jsonb),('option','public','snapshot','{"retainSnapshot":true}'::jsonb),('option','member','publishing','{"displayMember":true,"retainBars":true,"retainSnapshot":true,"newPublishing":true}'::jsonb))
  SELECT count(*)::int AS satisfied FROM required r WHERE EXISTS(SELECT 1 FROM data_capability c WHERE c.supplier='synthetic-fixture' AND c.agreement_id='synthetic-fixture-v1' AND c.dataset=r.dataset AND c.audience=r.audience AND c.purpose=r.purpose AND c.effective_at<=now() AND c.revoked_at IS NULL AND c.flags @> r.flags)`);
 if(rightsPreflight.rows[0].satisfied!==12)throw new Error('SEEDED_SYNTHETIC_CAPABILITY_PREFLIGHT_FAILED');
 const instrument={id:stockRef.id,version:stockRef.metadata.version}, issuer='https://p14-load.'+process.env.P14_LOAD_RUN+'.invalid';
 // 5,000 synthetic accounts. A valid recent app session is the explicit MAU proxy.
 await pool.query(`INSERT INTO user_account(id,oidc_issuer,oidc_subject,email,email_verified,synthetic,status,onboarding_version,created_at,updated_at)
  SELECT md5($1||':u:'||n)::uuid,$2,md5($1||':subject:'||n),md5($1||':u:'||n)||'@example.invalid',true,true,'active','p14-load',CASE WHEN n<=1000 THEN now()-interval '20 days' ELSE now()-interval '400 days' END,now() FROM generate_series(1,$3) n`,[process.env.P14_LOAD_RUN,issuer,users]);
 await pool.query(`INSERT INTO profile(user_id,handle,normalized_handle,display_name,bio,created_at,updated_at)
  SELECT id,'ld_'||substr(md5(id::text),1,20),'ld_'||substr(md5(id::text),1,20),'P14 load '||substr(id::text,1,8),'Synthetic load profile',now(),now() FROM user_account WHERE oidc_issuer=$1`,[issuer]);
 await pool.query(`WITH seq AS (SELECT n,md5($1||':p:'||n)::uuid AS pid,md5($1||':v:'||n)::uuid AS vid,md5($1||':u:'||(1+((n-1)%$2)))::uuid AS uid FROM generate_series(1,$3) n)
 INSERT INTO publication(id,author_user_id,kind,original_version_id,current_version_id,visibility,published_at,created_at)
 SELECT pid,uid,'trade',NULL,NULL,'private',NULL,now() FROM seq`,[loadRun,users,publications]);
 const {hydrateTradePlan}=await import('/workspace/apps/api/dist/domain/reference-plan.js');
 const {calculatePosition}=await import('/workspace/packages/domain/dist/index.js');
 const entryFrom='2026-10-22T13:30:00.000Z',entryUntil='2026-10-22T20:00:00.000Z';
 const mkPlan=(asset,strategy,instrumentId,legs,priceKind,entryPrice,initialStopPrice)=>({asset,strategy,instrumentId,legs,quantity:1,entryPrice,priceKind,entryFrom,entryUntil,entryCondition:'Enter only after the published setup confirms.',...(initialStopPrice?{initialStopPrice}:{}),timeframe:'swing',exitRules:'Exit at the stated target or invalidation.',conflicts:'Synthetic fixture; no broker verification.'});
 const freeze=(input,chartInstrument)=>{const hydrated=hydrateTradePlan(input,references,'2026-10-22T00:00:00.000Z');const calculation=calculatePosition({plan:hydrated.plan,entryCosts:null,exits:[]});if(!calculation.initialRisk||Number(calculation.initialRisk)<=0)throw new Error('MIXED_TRADE_INITIAL_RISK_UNAVAILABLE');return {plan:input,positionPlan:hydrated.plan,initialRisk:calculation.initialRisk,chart:{instrumentId:chartInstrument.id,metadataVersion:chartInstrument.metadata.version,interval:'1d',session:chartInstrument.asset==='future'?'exchange':'regular',adjustment:'unadjusted',viewport:{from:'2026-10-01T00:00:00.000Z',to:'2026-10-20T00:00:00.000Z'},provenance:{provider:'synthetic-fixture',asOf:'2026-10-20T00:00:00.000Z',delaySeconds:900,demo:true},drawings:[]},disclosures:{evidence:'member_reported',providerVerified:false,demo:true,delaySeconds:900,asOf:'2026-10-20T00:00:00.000Z',referenceVersions:hydrated.referenceVersions}};};
 const stockTemplate=freeze(mkPlan('stock','long',stockRef.id,[],'underlying','100.00','95.00'),stockRef);
 const futureTemplates=futures.map(ref=>freeze(mkPlan('future','long',ref.id,[],'futures','6000.00','5990.00'),ref));
 const call100=options.get('SYN-XYZ-20261120-C100'),call105=options.get('SYN-XYZ-20261120-C105'),put100=options.get('SYN-XYZ-20261120-P100'),put105=options.get('SYN-XYZ-20261120-P105');
 const optionSpecs=[
  ['long_call','option_premium','2.50',[{instrumentId:call100.id,side:'buy',quantity:1}]],
  ['long_put','option_premium','2.50',[{instrumentId:put100.id,side:'buy',quantity:1}]],
  ['bull_call_debit','spread_debit','1.25',[{instrumentId:call100.id,side:'buy',quantity:1},{instrumentId:call105.id,side:'sell',quantity:1}]],
  ['bear_put_debit','spread_debit','1.25',[{instrumentId:put105.id,side:'buy',quantity:1},{instrumentId:put100.id,side:'sell',quantity:1}]],
  ['bull_put_credit','spread_credit','1.25',[{instrumentId:put105.id,side:'sell',quantity:1},{instrumentId:put100.id,side:'buy',quantity:1}]],
  ['bear_call_credit','spread_credit','1.25',[{instrumentId:call100.id,side:'sell',quantity:1},{instrumentId:call105.id,side:'buy',quantity:1}]],
 ];
 const optionTemplates=optionSpecs.map(([strategy,kind,price,legs])=>freeze(mkPlan('option',strategy,stockRef.id,legs,kind,price),stockRef));
 await pool.query(`WITH seq AS (SELECT n,md5($1||':p:'||n)::uuid AS pid,md5($1||':v:'||n)::uuid AS vid FROM generate_series(1,$2) n),
  distribution AS (SELECT n,pid,vid,CASE WHEN (n-1)%10<4 THEN 'stock' WHEN (n-1)%10<7 THEN 'future' ELSE 'option' END AS asset_kind,
   CASE WHEN (n-1)%10<4 THEN 0 WHEN (n-1)%10<7 THEN floor((n-1)::numeric/10)::int%4 ELSE (floor((n-1)::numeric/10)::int*3+((n-1)%10-7))%6 END AS template_index FROM seq),
  chosen AS (SELECT d.*,CASE WHEN asset_kind='stock' THEN $3::jsonb WHEN asset_kind='future' THEN $4::jsonb->template_index ELSE $5::jsonb->template_index END AS fixture FROM distribution d)
 INSERT INTO publication_version(id,publication_id,sequence,terms,thesis,chart,disclosures,created_at)
 SELECT vid,pid,1,jsonb_build_object('kind','trade','title','P14 recovery telescope '||asset_kind||' '||template_index||' '||n,'slug','p14-recovery-'||asset_kind||'-'||n,'plan',fixture->'plan','disclosures',fixture->'plan'->>'conflicts'),
  'Synthetic recovery and load search body '||n,fixture->'chart',fixture->'disclosures',now() FROM chosen`,[loadRun,publications,JSON.stringify(stockTemplate),JSON.stringify(futureTemplates),JSON.stringify(optionTemplates)]);
 await pool.query(`UPDATE publication p SET original_version_id=v.id,current_version_id=v.id,visibility='public',published_at=now() FROM publication_version v WHERE p.id=v.publication_id AND v.sequence=1 AND p.author_user_id IN (SELECT id FROM user_account WHERE oidc_issuer=$1)`,[issuer]);
 await pool.query(`WITH seq AS (SELECT n,md5($1||':p:'||n)::uuid AS pid,md5($1||':v:'||n)::uuid AS vid,md5($1||':u:'||(1+((n-1)%$2)))::uuid AS uid FROM generate_series(1,$3) n),
  distribution AS (SELECT n,pid,vid,uid,CASE WHEN (n-1)%10<4 THEN 'stock' WHEN (n-1)%10<7 THEN 'future' ELSE 'option' END AS asset_kind,
   CASE WHEN (n-1)%10<4 THEN 0 WHEN (n-1)%10<7 THEN floor((n-1)::numeric/10)::int%4 ELSE (floor((n-1)::numeric/10)::int*3+((n-1)%10-7))%6 END AS template_index FROM seq),
  chosen AS (SELECT d.*,CASE WHEN asset_kind='stock' THEN $4::jsonb WHEN asset_kind='future' THEN $5::jsonb->template_index ELSE $6::jsonb->template_index END AS fixture FROM distribution d),
  inserted AS (INSERT INTO position(id,owner_user_id,public_publication_id,private_journal_entry_id,state,plan,instrument_id,metadata_version_id,remaining_quantity,initial_risk,calculation_version,revision,risk_source_version_id,created_at,updated_at)
   SELECT md5($1||':position:'||n)::uuid,uid,pid,NULL,'pending',fixture->'positionPlan',(fixture->'plan'->>'instrumentId')::uuid,((fixture->'disclosures'->'referenceVersions'->0)->>'metadataVersionId')::uuid,
    (fixture->'positionPlan'->>'quantity')::int,(fixture->>'initialRisk')::numeric,'1',1,vid,now(),now() FROM chosen RETURNING id,public_publication_id,plan)
 INSERT INTO position_leg(id,position_id,instrument_id,metadata_version_id,side,quantity)
 SELECT md5($1||':position-leg:'||c.n||':'||leg.ordinality)::uuid,i.id,(ref.item->>'instrumentId')::uuid,(ref.item->>'metadataVersionId')::uuid,leg.value->>'side',(leg.value->>'quantity')::int
 FROM inserted i JOIN chosen c ON c.pid=i.public_publication_id CROSS JOIN LATERAL jsonb_array_elements(i.plan->'legs') WITH ORDINALITY AS leg(value,ordinality)
 CROSS JOIN LATERAL (SELECT c.fixture->'disclosures'->'referenceVersions'->(leg.ordinality::int) AS item) ref`,[loadRun,users,publications,JSON.stringify(stockTemplate),JSON.stringify(futureTemplates),JSON.stringify(optionTemplates)]);
 await pool.query(`WITH seq AS (SELECT n,md5($1||':c:'||n)::uuid AS cid,md5($1||':p:'||(1+((n-1)/5)))::uuid AS pid,md5($1||':u:'||(1+((n-1)%$2)))::uuid AS uid FROM generate_series(1,$3) n)
 INSERT INTO comment(id,publication_id,author_user_id,body,revision,created_at) SELECT cid,pid,uid,'Synthetic load comment '||n,1,now() FROM seq`,[loadRun,users,comments]);
 const tokenFor=n=>createHash('sha256').update(`p14-load-session:${loadRun}:${n}`).digest('base64url');
 const sessionHashes=Array.from({length:activeMonthly},(_,i)=>createHash('sha256').update(tokenFor(i+1)).digest('hex'));
 const sessionRows=await pool.query(`INSERT INTO app_session(id,token_hash,user_id,issued_at,last_seen_at,expires_at) SELECT md5($1||':s:'||n)::uuid,token_hash,md5($1||':u:'||n)::uuid,now(),now(),now()+interval '1 day' FROM unnest($2::text[]) WITH ORDINALITY AS t(token_hash,n) RETURNING id`,[loadRun,sessionHashes]);
 const assertCounts=await pool.query(`SELECT (SELECT count(*) FROM user_account WHERE oidc_issuer=$1)::int accounts,(SELECT count(*) FROM user_account WHERE oidc_issuer=$1 AND synthetic)::int synthetic_accounts,(SELECT count(DISTINCT s.user_id) FROM app_session s JOIN user_account u ON u.id=s.user_id WHERE u.oidc_issuer=$1 AND s.last_seen_at>now()-interval '30 days' AND s.expires_at>now() AND s.revoked_at IS NULL)::int mau,(SELECT count(*) FROM publication p JOIN user_account u ON u.id=p.author_user_id WHERE u.oidc_issuer=$1)::int publications,(SELECT count(*) FROM comment c JOIN publication p ON p.id=c.publication_id JOIN user_account u ON u.id=p.author_user_id WHERE u.oidc_issuer=$1)::int comments,(SELECT count(*) FROM position x JOIN user_account u ON u.id=x.owner_user_id WHERE u.oidc_issuer=$1)::int positions,(SELECT count(*) FROM position x JOIN user_account u ON u.id=x.owner_user_id JOIN publication p ON p.id=x.public_publication_id AND p.author_user_id=x.owner_user_id AND p.kind='trade' AND p.visibility='public' AND p.current_version_id=x.risk_source_version_id WHERE u.oidc_issuer=$1 AND x.state='pending')::int pending_public_positions,(SELECT count(*) FROM position_leg l JOIN position x ON x.id=l.position_id JOIN user_account u ON u.id=x.owner_user_id WHERE u.oidc_issuer=$1)::int position_legs,(SELECT count(*) FROM position_event e JOIN position x ON x.id=e.position_id JOIN user_account u ON u.id=x.owner_user_id WHERE u.oidc_issuer=$1)::int position_events,(SELECT count(*) FROM outcome_snapshot o JOIN position x ON x.id=o.position_id JOIN user_account u ON u.id=x.owner_user_id WHERE u.oidc_issuer=$1)::int outcomes`,[issuer]);
 if(assertCounts.rows[0].accounts!==users||assertCounts.rows[0].synthetic_accounts!==users||assertCounts.rows[0].mau!==activeMonthly||assertCounts.rows[0].publications!==publications||assertCounts.rows[0].comments!==comments||assertCounts.rows[0].positions!==publications||assertCounts.rows[0].pending_public_positions!==publications||assertCounts.rows[0].position_legs!==25000||assertCounts.rows[0].position_events!==0||assertCounts.rows[0].outcomes!==0)throw new Error('LOAD_FIXTURE_COUNTS_MISMATCH');
 const distributionCounts=await pool.query(`SELECT v.terms->'plan'->>'asset' AS asset,v.terms->'plan'->>'strategy' AS strategy,count(*)::int AS count FROM publication_version v JOIN publication p ON p.id=v.publication_id JOIN user_account u ON u.id=p.author_user_id WHERE u.oidc_issuer=$1 GROUP BY 1,2`,[issuer]);
 const distribution=distributionCounts.rows.filter(row=>row.asset==='stock'||row.asset==='future'||row.asset==='option');
 const countsByAsset=Object.fromEntries(['stock','future','option'].map(asset=>[asset,distribution.filter(row=>row.asset===asset).reduce((sum,row)=>sum+row.count,0)]));
 const optionStrategyCounts=Object.fromEntries(optionSpecs.map(([strategy])=>[strategy,distribution.find(row=>row.asset==='option'&&row.strategy===strategy)?.count??0]));
 if(countsByAsset.stock!==20000||countsByAsset.future!==15000||countsByAsset.option!==15000||Object.values(optionStrategyCounts).some(count=>count!==2500))throw new Error('MIXED_ASSET_DISTRIBUTION_MISMATCH');
 const positionDistribution=(await pool.query(`SELECT plan->>'asset' AS asset,plan->>'strategy' AS strategy,count(*)::int AS count FROM position x JOIN user_account u ON u.id=x.owner_user_id WHERE u.oidc_issuer=$1 GROUP BY 1,2`,[issuer])).rows;
 const positionStrategyCounts=Object.fromEntries(distribution.map(row=>[`${row.asset}:${row.strategy}`,positionDistribution.find(position=>position.asset===row.asset&&position.strategy===row.strategy)?.count??0]));
 if(distribution.some(row=>positionStrategyCounts[`${row.asset}:${row.strategy}`]!==row.count))throw new Error('POSITION_PLAN_DISTRIBUTION_MISMATCH');
 const {PublicationService}=await import('/workspace/apps/api/dist/publications/service.js');
 const {JournalService}=await import('/workspace/apps/api/dist/journal/service.js');
 const {AuthService,authConfigFromEnv}=await import('/workspace/apps/api/dist/auth/service.js');
 const {InstrumentService}=await import('/workspace/apps/api/dist/instruments/service.js');
 const {createMarketDataRuntime}=await import('/workspace/apps/api/dist/instruments/market-data-config.js');
 const market=await createMarketDataRuntime(pool,{});
 const instruments=new InstrumentService(pool,market.adapter,market.mode,market.configured);
 const publicationService=new PublicationService(pool,instruments);
 const journalService=new JournalService(pool);
 const authService=new AuthService(pool,authConfigFromEnv(process.env));
 const owners=(await pool.query(`SELECT id FROM user_account WHERE oidc_issuer=$1 ORDER BY id LIMIT 100`,[issuer])).rows.map(r=>r.id);
 const monthlyActiveUserIds=new Set((await pool.query(`SELECT id FROM user_account WHERE oidc_issuer=$1 AND id IN (SELECT user_id FROM app_session WHERE last_seen_at>now()-interval '30 days' AND revoked_at IS NULL AND expires_at>now())`,[issuer])).rows.map(r=>r.id));
 const ownerA=owners[0], ownerB=owners[1];
 await pool.query('ANALYZE user_account, profile, app_session, data_capability, publication, publication_version, comment, journal_entry');
 const warm=await publicationService.listPublications({q:'telescope',limit:20});
 if(warm.items.length===0)throw new Error('PUBLICATION_SERVICE_SEARCH_RETURNED_NO_ROWS');
 const writeStart=performance.now();
 const writePoolWaitStart=poolCheckoutWaits.length;
 const writes=await Promise.all(owners.map((owner,n)=>timed('privateWrite',()=>journalService.create(owner,`p14-load-${process.env.P14_LOAD_RUN}-${n}`,{title:`P14 load journal ${n}`,thesis:'Synthetic service write',notes:'Load harness only',tags:['synthetic'],review:''}))));
 const writeMs=performance.now()-writeStart;
 const writePoolWaits=poolCheckoutWaits.slice(writePoolWaitStart);
 const ownerRead=await timed('privateRead',()=>journalService.list(ownerA,{limit:50}));
 const otherRead=await timed('privateRead',()=>journalService.list(ownerB,{limit:50}));
 if(ownerRead.items.length!==1||otherRead.items.length!==1||ownerRead.items[0].id===otherRead.items[0].id)throw new Error('PRIVATE_OWNER_ISOLATION_FAILED');
 const search=await timed('publicationSearch',()=>publicationService.listPublications({q:'telescope',limit:20}));
 if(!search.items.length)throw new Error('PUBLICATION_SERVICE_SEARCH_FAILED');
 // Representative 40% feed / 20% search / 20% chart-history / 10% private-read / 10% write mix.
 const concurrentStart=performance.now();
 const mixedPoolWaitStart=poolCheckoutWaits.length;
 await Promise.all(Array.from({length:100},async(_,n)=>{
   const actor=await timed('sessionAuthentication',()=>authService.authenticate({headers:{cookie:`tc_session_dev=${tokenFor(n+1)}`} }));
   if(!monthlyActiveUserIds.has(actor.userId))throw new Error('LOAD_FIXTURE_SESSION_OWNER_MISMATCH');
   const bucket=n%10;
   if(bucket<4)return timed('plainFeed',()=>publicationService.listPublications({limit:20}));
   if(bucket<6)return timed('publicationSearch',()=>publicationService.listPublications({q:n%2?'telescope':'recovery',limit:20}));
   if(bucket<8)return timed('chartHistory',()=>instruments.bars(instrument.id,{interval:'1d',from:'2026-10-01T00:00:00.000Z',to:'2026-10-20T00:00:00.000Z',session:'regular',adjustment:'unadjusted',limit:20},'public'));
   if(bucket===8)return timed('authenticatedPrivateRead',()=>journalService.list(n%2?ownerA:ownerB,{limit:10}));
   return timed('authenticatedPrivateWrite',()=>journalService.create(actor.userId,`p14-load-mixed-${process.env.P14_LOAD_RUN}-${n}`,{title:`P14 mixed write ${n}`,thesis:'Synthetic service write',notes:'Load harness only',tags:['synthetic'],review:''}));
 }));
 const concurrentMs=performance.now()-concurrentStart;
 const mixedPoolWaits=poolCheckoutWaits.slice(mixedPoolWaitStart);
 const requestDurationMs=Object.fromEntries(Object.entries(durationByOperation).map(([name,samples])=>[name,{p50:percentile(samples,.50),p95:percentile(samples,.95),samples:samples.length}]));
 process.stdout.write(JSON.stringify({fixture:{accounts:users,syntheticAccounts:assertCounts.rows[0].synthetic_accounts,monthlyActiveAccounts:assertCounts.rows[0].mau,concurrentSessions:100,sessionRows:sessionRows.rowCount,publications,comments,positions:assertCounts.rows[0].positions,pendingPublicPositions:assertCounts.rows[0].pending_public_positions,positionLegs:assertCounts.rows[0].position_legs,positionEvents:assertCounts.rows[0].position_events,outcomes:assertCounts.rows[0].outcomes,assetDistribution:countsByAsset,optionStrategyDistribution:optionStrategyCounts,positionStrategyDistribution:positionStrategyCounts,seededReferences:{stock:1,futures:futures.length,options:options.size,hydratedTemplates:1+futureTemplates.length+optionTemplates.length},syntheticRightsPreflight:'passed_existing_seed_rows_only'},measurements:{poolMax,apiConfiguredPoolMax:8,concurrentAuthenticatedRequests:100,concurrentMix:{plainFeedPercent:40,publicationSearchPercent:20,chartHistoryPercent:20,privateReadPercent:10,privateWritePercent:10},serviceWriteCount:writes.length,serviceWriteElapsedMs:writeMs,mixedServiceElapsedMs:concurrentMs,requestDurationMs,poolCheckoutWaitMs:{writeBatch:{p50:percentile(writePoolWaits,.50),p95:percentile(writePoolWaits,.95),samples:writePoolWaits.length},concurrentMix:{p50:percentile(mixedPoolWaits,.50),p95:percentile(mixedPoolWaits,.95),samples:mixedPoolWaits.length}},searchResultCount:search.items.length,privateIsolation:'passed',thresholds:{ordinaryServiceP95Ms:750,searchServiceP95Ms:1000}},scope:poolMax===8?'local API service + PostgreSQL timings using the API-configured pool; no browser LCP or production capacity claim':'local API service + PostgreSQL timings using a 20-connection pool larger than API configuration; no browser LCP or production capacity claim'}));
} finally { await pool.end(); }
