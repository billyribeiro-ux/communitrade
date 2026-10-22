import assert from 'node:assert/strict';
import test from 'node:test';
import { randomUUID } from 'node:crypto';
import pg from 'pg';
import { JournalService } from '../dist/journal/service.js';
import { PositionService } from '../dist/positions/service.js';
import { CommandError } from '../dist/http/problem.js';
import { cleanupP08Fixtures } from '../scripts/p08-fixture-cleanup.mjs';

const databaseUrl=process.env.TEST_DATABASE_URL;
const integration={skip:databaseUrl?false:'Set TEST_DATABASE_URL for PostgreSQL journal privacy, quota and private-position acceptance.'};
const iso=value=>new Date(value).toISOString();

test('PostgreSQL: owner-only journal, atomic monthly quota, private position lifecycle and analytics',integration,async t=>{
  const pool=new pg.Pool({connectionString:databaseUrl,max:8,connectionTimeoutMillis:3000,query_timeout:15000});pool.on('error',()=>{});
  const suffix=randomUUID(),owner=randomUUID(),other=randomUUID(),staff=randomUUID(),instrumentId=randomUUID(),metadataId=randomUUID();
  const entryIds=[],positionIds=[],entitlementIds=[],publicationIds=[],publicationVersionIds=[];const issuer=`https://p10.journal.${suffix}.invalid`;
  const service=new JournalService(pool);const positions=new PositionService(pool);
  const addUser=id=>pool.query(`INSERT INTO user_account(id,oidc_issuer,oidc_subject,email,email_verified,status,created_at,updated_at)
    VALUES($1,$2,$3,$4,true,'active',now(),now())`,[id,issuer,id,`${id}@example.invalid`]);
  const create=(idempotencyKey,input)=>service.create(owner,idempotencyKey,input);
  const basic=(n,{review='',tags=['discipline']}={})=>({title:`Journal ${n}`,thesis:`Private thesis ${n}`,notes:`Private sentinel ${n}`,tags,review});
  try{
    await addUser(owner);await addUser(other);await addUser(staff);
    await pool.query("INSERT INTO role_grant(id,user_id,role,grantor_user_id,reason,granted_at) VALUES($1,$2,'admin',$2,'P10 staff privacy test',now())",[randomUUID(),staff]);
    await pool.query(`INSERT INTO instrument(id,asset,vendor,vendor_id,venue,currency,enabled)
      VALUES($1,'stock','p10-test',$2,'TEST','USD',true)`,[instrumentId,`P10-${suffix.slice(0,8)}`]);
    await pool.query(`INSERT INTO instrument_metadata_version(id,instrument_id,version,multiplier,tick_size,source_id)
      VALUES($1,$2,1,1,0.01,'p10-test')`,[metadataId,instrumentId]);

    await t.test('journal CRUD is owner-scoped, revision-protected and supports search/tag filters',async()=>{
      const created=await create(`${suffix}-journal-one`,basic(1));entryIds.push(created.id);
      const second=await create(`${suffix}-journal-two`,basic(2));entryIds.push(second.id);
      assert.equal(created.revision,1);assert.equal(created.publicationId,null);assert.equal(created.notes,'Private sentinel 1');
      assert.equal(created.positionId,null);
      const listed=await service.list(owner,{q:'sentinel',tag:'discipline'});assert.equal(listed.items.length,2);
      const page=await service.list(owner,{q:'sentinel',tag:'discipline',limit:1});assert.equal(page.items.length,1);assert.ok(page.nextCursor);
      await assert.rejects(service.list(owner,{q:'different',tag:'discipline',cursor:page.nextCursor}),e=>e instanceof CommandError&&e.code==='INVALID_CURSOR');
      await assert.rejects(service.list(other,{q:'sentinel',tag:'discipline',cursor:page.nextCursor}),e=>e instanceof CommandError&&e.code==='INVALID_CURSOR');
      assert.equal((await service.get(owner,created.id)).id,created.id);
      await assert.rejects(service.get(other,created.id),e=>e instanceof CommandError&&e.status===404);
      await assert.rejects(service.get(staff,created.id),e=>e instanceof CommandError&&e.status===404,'staff receives no ordinary journal exception');
      const updated=await service.update(owner,created.id,1,{...basic(1,{review:'Reviewed the result.'}),thesis:'Updated private thesis'});
      assert.equal(updated.revision,2);assert.equal(updated.review,'Reviewed the result.');
      await assert.rejects(service.update(owner,created.id,1,{...basic(1),thesis:'stale'}),e=>e instanceof CommandError&&e.code==='STALE_REVISION');
      await assert.rejects(service.update(other,created.id,2,basic(1)),e=>e instanceof CommandError&&e.status===404);
    });

    await t.test('standalone private positions share lifecycle calculations and remain private',async()=>{
      const now=Date.now();const plan={asset:'stock',strategy:'long',instrumentId,legs:[],quantity:2,entryPrice:'10',priceKind:'underlying',entryFrom:iso(now-1000),entryUntil:iso(now+600000),entryCondition:'Enter near support',initialStopPrice:'9',timeframe:'swing',exitRules:'Exit at target or stop',conflicts:'None'};
      const journal=await create(`${suffix}-journal-position`,{...basic('position'),plan});entryIds.push(journal.id);assert.ok(journal.positionId);positionIds.push(journal.positionId);
      await service.update(owner,journal.id,1,basic('position',{review:'Reviewed after closing.'}));
      let current=await positions.get(journal.positionId,owner);assert.equal(current.visibility,'private');assert.equal(current.plan.instrumentId,instrumentId);assert.equal(current.state,'pending');
      await positions.append(owner,journal.positionId,1,`${suffix}-private-entry`,{type:'entry',claimedAt:iso(Date.now()),quantity:2,price:'10',costs:'0'});
      await positions.append(owner,journal.positionId,2,`${suffix}-private-exit`,{type:'final_exit',claimedAt:iso(Date.now()+1000),quantity:2,price:'11',costs:'0'});
      current=await positions.get(journal.positionId,owner);assert.equal(current.state,'closed');assert.equal(current.outcome.netRealized,'2.0000000000');assert.equal(current.outcome.eligibility,'eligible');
      const events=await positions.listEvents(journal.positionId,owner,undefined,10);const source=events.items.find(event=>event.type==='final_exit');assert.ok(source);
      const replacement={type:'final_exit',claimedAt:iso(Date.now()+1000),quantity:2,price:'10.5',costs:'0'};
      const correction=await positions.correctPrivateEvent(owner,journal.positionId,3,source.id,`${suffix}-private-correction`,replacement);
      assert.equal(correction.state,'closed');assert.equal((await positions.correctPrivateEvent(owner,journal.positionId,3,source.id,`${suffix}-private-correction`,replacement)).id,correction.id);
      current=await positions.get(journal.positionId,owner);assert.equal(current.revision,4);assert.equal(current.outcome.netRealized,'1.0000000000');
      const correctedEvents=await positions.listEvents(journal.positionId,owner,undefined,10);assert.ok(correctedEvents.items.some(event=>event.id===source.id));assert.ok(correctedEvents.items.some(event=>event.supersedesId===source.id));
      await assert.rejects(positions.get(journal.positionId,other),e=>e instanceof CommandError&&e.status===404);
      await assert.rejects(positions.append(other,journal.positionId,3,`${suffix}-other-event`,{type:'review',claimedAt:iso(Date.now()+2000),reason:'no access'}),e=>e instanceof CommandError&&e.status===404);
      await assert.rejects(positions.correctPrivateEvent(other,journal.positionId,3,source.id,`${suffix}-other-correction`,replacement),e=>e instanceof CommandError&&e.status===404);
      const entitlementId=randomUUID();entitlementIds.push(entitlementId);
      await pool.query(`INSERT INTO subscription_entitlement(id,user_id,plan,limits,valid_from,valid_until) VALUES($1,$2,'pro','{}'::jsonb,now(),NULL)`,[entitlementId,owner]);
      const analytics=await service.analytics(owner);
      assert.equal(analytics.openPositions,0);assert.equal(analytics.closedPositions,1);assert.equal(analytics.reviewEligible,1);assert.equal(analytics.reviewCompleted,1);
      assert.equal(analytics.outcomeDistribution.wins,1);assert.equal(analytics.eligibleOutcomes,1);assert.equal(analytics.rDenominator,1);assert.equal(analytics.reviewCompletionRate,'1.0000000000');
      await pool.query('UPDATE subscription_entitlement SET valid_until=CURRENT_TIMESTAMP WHERE id=$1',[entitlementId]);
      const basicAnalytics=await service.analytics(other);assert.equal(basicAnalytics.totalEntries,0);assert.equal(basicAnalytics.outcomeDistribution,null);
    });

    await t.test('linking another author copies its frozen plan privately and rechecks public data rights',async()=>{
      const publicationId=randomUUID(),versionId=randomUUID(),sourcePositionId=randomUUID();publicationIds.push(publicationId);publicationVersionIds.push(versionId);positionIds.push(sourcePositionId);
      const now=Date.now();const apiPlan={asset:'stock',strategy:'long',instrumentId,legs:[],quantity:2,entryPrice:'10',priceKind:'underlying',entryFrom:iso(now-1000),entryUntil:iso(now+600000),entryCondition:'Enter near support',initialStopPrice:'9',timeframe:'swing',exitRules:'Exit at target or stop',conflicts:'None'};
      const domainPlan={asset:'stock',strategy:'long',quantity:2,entryPrice:'10',initialStopPrice:'9',entryFrom:apiPlan.entryFrom,entryUntil:apiPlan.entryUntil,instrument:{asset:'stock',symbol:`P10-${suffix.slice(0,8)}`,currency:'USD',multiplier:'1',tickSize:'0.01',metadataVersion:1,enabled:true}};
      await pool.query(`INSERT INTO publication(id,author_user_id,kind,visibility,published_at,created_at)
        VALUES($1,$2,'trade','public',now(),now())`,[publicationId,owner]);
      await pool.query(`INSERT INTO publication_version(id,publication_id,sequence,terms,thesis,chart,disclosures,created_at)
        VALUES($1,$2,1,$3::jsonb,'Public thesis','{}','{}',now())`,[versionId,publicationId,JSON.stringify({title:'Public source',plan:apiPlan})]);
      await pool.query('UPDATE publication SET original_version_id=$2,current_version_id=$2 WHERE id=$1',[publicationId,versionId]);
      await pool.query(`INSERT INTO position(id,owner_user_id,public_publication_id,state,plan,instrument_id,metadata_version_id,remaining_quantity,initial_risk,calculation_version,revision,risk_source_version_id,created_at,updated_at)
        VALUES($1,$2,$3,'pending',$4::jsonb,$5,$6,2,2,'1',1,$7,now(),now())`,[sourcePositionId,owner,publicationId,JSON.stringify(domainPlan),instrumentId,metadataId,versionId]);
      const linked=await new JournalService(pool,async()=>{}).create(other,`${suffix}-linked-other`,{publicationId,title:'Private title ignored',thesis:'Private thesis ignored',notes:'Private linked note',tags:['source']});
      entryIds.push(linked.id);assert.ok(linked.positionId);assert.notEqual(linked.positionId,sourcePositionId);
      const copied=await pool.query('SELECT owner_user_id,public_publication_id,private_journal_entry_id,plan FROM position WHERE id=$1',[linked.positionId]);positionIds.push(linked.positionId);
      assert.equal(copied.rows[0].owner_user_id,other);assert.equal(copied.rows[0].public_publication_id,null);assert.equal(copied.rows[0].private_journal_entry_id,linked.id);
      assert.equal((await positions.get(linked.positionId,other)).visibility,'private');
      const restricted=new JournalService(pool,async()=>{throw new CommandError(404,'PUBLICATION_NOT_FOUND');});
      await restricted.update(other,linked.id,1,{title:'',thesis:'',notes:'Private note remains editable',tags:['source'],review:''});
      const hidden=await restricted.get(other,linked.id);assert.equal(hidden.title,'');assert.equal(hidden.thesis,'');assert.equal(hidden.plan,null);assert.equal(hidden.notes,'Private note remains editable');
      await assert.rejects(restricted.get(owner,linked.id),e=>e instanceof CommandError&&e.status===404);
    });

    await t.test('Free monthly quota is UTC-bucketed and concurrent creates cannot exceed 30',async()=>{
      const keys=Array.from({length:30},(_,i)=>`${suffix}-quota-${String(i).padStart(2,'0')}`);
      const outcomes=await Promise.allSettled(keys.map((key,i)=>create(key,basic(`quota-${i}`))));
      const successes=outcomes.filter(x=>x.status==='fulfilled');entryIds.push(...successes.map(x=>x.value.id));
      assert.equal(successes.length,27);assert.equal(outcomes.filter(x=>x.status==='rejected').length,3);
      await assert.rejects(create(`${suffix}-quota-overflow`,basic('overflow')),e=>e instanceof CommandError&&e.code==='QUOTA_EXCEEDED');
      const bucket=await pool.query('SELECT count,month_start FROM quota_bucket WHERE user_id=$1 AND metric=$2',[owner,'journal_monthly']);
      assert.equal(Number(bucket.rows[0].count),30,'the bucket records exactly the Free monthly limit');
      assert.equal(new Date(bucket.rows[0].month_start).getUTCDate(),1);
    });

    await t.test('Pro monthly quota admits exactly 1000 and a prior UTC month never consumes the new month',async()=>{
      await pool.query(`UPDATE subscription_entitlement SET plan='pro',valid_from=now(),valid_until=NULL WHERE user_id=$1`,[owner]);
      await pool.query(`UPDATE quota_bucket SET count=999,reserved_count=0 WHERE user_id=$1 AND metric='journal_monthly'
        AND month_start=date_trunc('month',CURRENT_TIMESTAMP AT TIME ZONE 'UTC') AT TIME ZONE 'UTC'`,[owner]);
      const outcomes=await Promise.allSettled([
        create(`${suffix}-pro-limit-a`,basic('pro-limit-a')),
        create(`${suffix}-pro-limit-b`,basic('pro-limit-b')),
      ]);
      const success=outcomes.filter(outcome=>outcome.status==='fulfilled');entryIds.push(...success.map(outcome=>outcome.value.id));
      assert.equal(success.length,1);assert.equal(outcomes.filter(outcome=>outcome.status==='rejected').length,1);
      await assert.rejects(create(`${suffix}-pro-overflow`,basic('pro-overflow')),e=>e instanceof CommandError&&e.code==='QUOTA_EXCEEDED');
      await pool.query(`UPDATE quota_bucket SET month_start=(date_trunc('month',CURRENT_TIMESTAMP AT TIME ZONE 'UTC') AT TIME ZONE 'UTC')-interval '1 month',count=1000
        WHERE user_id=$1 AND metric='journal_monthly' AND month_start=date_trunc('month',CURRENT_TIMESTAMP AT TIME ZONE 'UTC') AT TIME ZONE 'UTC'`,[owner]);
      const afterReset=await create(`${suffix}-pro-new-month`,basic('pro-new-month'));entryIds.push(afterReset.id);
      const buckets=await pool.query(`SELECT count,month_start FROM quota_bucket WHERE user_id=$1 AND metric='journal_monthly' ORDER BY month_start`,[owner]);
      assert.equal(buckets.rows.length,2);assert.equal(Number(buckets.rows[0].count),1000);assert.equal(Number(buckets.rows[1].count),1);
      assert.equal(new Date(buckets.rows[1].month_start).getUTCDate(),1);
    });
  }finally{try{await cleanupP08Fixtures(pool,[owner,other,staff],[instrumentId]);}finally{await pool.end();}}
});
