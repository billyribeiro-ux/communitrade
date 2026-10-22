import assert from 'node:assert/strict';
import test from 'node:test';
import { randomUUID } from 'node:crypto';
import pg from 'pg';
import { PositionService, PerformanceService, projectPosition, meanExactRatios } from '../dist/positions/service.js';
import { initializePublishedPosition } from '../dist/positions/persistence.js';
import { CorrectionService } from '../dist/corrections/service.js';
import { CommandError } from '../dist/http/problem.js';
import { cleanupP08Fixtures } from '../scripts/p08-fixture-cleanup.mjs';

const databaseUrl=process.env.TEST_DATABASE_URL;
const integration={skip:databaseUrl?false:'Set TEST_DATABASE_URL for PostgreSQL position lifecycle and correction acceptance.'};
const iso=value=>new Date(value).toISOString();

test('position history preserves each entry event’s original timing eligibility',()=>{
  const publicationAt='2026-01-01T00:00:00.000Z';
  const claimedAt='2026-01-01T00:01:00.000Z';
  const originalId=randomUUID();
  const event=(id,receivedAt,price,supersedes_id=null)=>({id,type:'entry',claimed_at:new Date(claimedAt),received_at:new Date(receivedAt),quantity:1,price,costs:'0',reason:null,supersedes_id,details:{}});
  const row={id:randomUUID(),owner_user_id:randomUUID(),owner_status:'active',public_publication_id:randomUUID(),private_journal_entry_id:null,state:'entered',plan:{asset:'stock',strategy:'long',quantity:1,entryPrice:'10',initialStopPrice:'9',entryFrom:'2026-01-01T00:00:00.000Z',entryUntil:'2026-01-01T01:00:00.000Z'},api_plan:{asset:'stock'},instrument_id:randomUUID(),metadata_version_id:randomUUID(),remaining_quantity:1,initial_risk:'1.0000000000',calculation_version:'1',revision:2,risk_source_version_id:randomUUID(),published_at:new Date(publicationAt),created_at:new Date(publicationAt),current_version_id:randomUUID(),visibility:'public'};
  const projected=projectPosition(row,[
    event(originalId,'2026-01-01T00:01:30.000Z','10'),
    event(randomUUID(),'2026-01-01T00:07:00.000Z','10.50',originalId),
  ]);
  assert.equal(projected.events[0].retrospective,false,'the immutable original entry keeps its on-time receipt status');
  assert.equal(projected.events[1].retrospective,true,'the later correction is labeled using its own server receipt time');
  assert.equal(projected.outcome.eligibility,'retrospective','aggregate eligibility follows the active corrected entry');
});

test('performance mean R combines exact ratios before rounding',()=>{
  const result=(numerator,denominator,rMultiple)=>({rRatio:{numerator,denominator},rMultiple});
  assert.equal(meanExactRatios([
    result('49','1000000000000','0.0000000000'),
    result('49','1000000000000','0.0000000000'),
    result('54','1000000000000','0.0000000001'),
  ]),'0.0000000001');
});

test('PostgreSQL: position lifecycle, costs, provenance, metrics, and reviewed correction',integration,async t=>{
  const pool=new pg.Pool({connectionString:databaseUrl,max:8,connectionTimeoutMillis:3000,query_timeout:15000});pool.on('error',()=>{});
  const suffix=randomUUID();const owner=randomUUID(),staff=randomUUID(),instrumentId=randomUUID(),metadataId=randomUUID();
  const publicationIds=[],positionIds=[],draftIds=[],jobIds=[],correctionIds=[];
  const issuer=`https://p08.positions.${suffix}.invalid`;
  const ownerHandle=`p08${suffix.replaceAll('-','').slice(0,20)}`;
  const insertUser=async id=>pool.query(`INSERT INTO user_account(id,oidc_issuer,oidc_subject,email,email_verified,status,created_at,updated_at)
    VALUES($1,$2,$3,$4,true,'active',now(),now())`,[id,issuer,id,`${id}@example.invalid`]);
  const basePlan=(strategy='long',entryPrice='10',stop='9',quantity=10,entryFrom,entryUntil)=>({
    asset:'stock',strategy,entryPrice,initialStopPrice:stop,quantity,
    entryFrom:entryFrom??iso(Date.now()-60_000),entryUntil:entryUntil??iso(Date.now()+600_000),
    instrument:{asset:'stock',symbol:`T${suffix.slice(0,7)}`,currency:'USD',multiplier:'1',tickSize:'0.01',metadataVersion:1,enabled:true},
  });
  const makePublication=async(plan,{publishedAt=iso(Date.now()-30_000),title='P08 position test'}={})=>{
    const publicationId=randomUUID(),versionId=randomUUID();publicationIds.push(publicationId);
    const publicPlan={asset:plan.asset,strategy:plan.strategy,instrumentId,legs:[],quantity:plan.quantity,entryPrice:plan.entryPrice,priceKind:'underlying',entryFrom:plan.entryFrom,entryUntil:plan.entryUntil,entryCondition:'Member-reported entry condition',...(plan.initialStopPrice===undefined?{}:{initialStopPrice:plan.initialStopPrice}),timeframe:'swing',exitRules:'Member-reported exit rules',conflicts:'No additional conflicts reported'};
    const terms={kind:'trade',title,slug:`p08-${publicationId.slice(0,8)}`,plan:publicPlan,evidence:'member_reported',attachmentIds:[]};
    await pool.query(`INSERT INTO publication(id,author_user_id,kind,visibility,published_at,created_at)
      VALUES($1,$2,'trade','public',$3,now())`,[publicationId,owner,publishedAt]);
    await pool.query(`INSERT INTO publication_version(id,publication_id,sequence,terms,thesis,chart,disclosures,created_at)
      VALUES($1,$2,1,$3::jsonb,'A test thesis','{}','{"evidence":"member_reported"}',now())`,[versionId,publicationId,JSON.stringify(terms)]);
    await pool.query('UPDATE publication SET original_version_id=$2,current_version_id=$2 WHERE id=$1',[publicationId,versionId]);
    return {publicationId,versionId,publishedAt};
  };
  const createPosition=async(plan,options)=>{
    const publication=await makePublication(plan,options);const client=await pool.connect();
    try{
      await client.query('BEGIN');
      const created=await initializePublishedPosition(client,{ownerUserId:owner,publicationId:publication.publicationId,sourceVersionId:publication.versionId,
        primaryInstrumentId:instrumentId,primaryMetadataVersionId:metadataId,plan,legReferences:[]});
      await client.query('COMMIT');positionIds.push(created.positionId);return {...publication,...created};
    }catch(error){await client.query('ROLLBACK').catch(()=>undefined);throw error;}finally{client.release();}
  };
  const claimed=()=>iso(Date.now());
  const service=new PositionService(pool);
  let jobForCorrection=null;
  try{
    await insertUser(owner);await insertUser(staff);
    await pool.query('INSERT INTO profile(user_id,handle,normalized_handle,display_name,revision,created_at,updated_at) VALUES($1,$2,$2,$3,1,now(),now())',[owner,ownerHandle,`P08 ${ownerHandle}`]);
    await pool.query(`INSERT INTO instrument(id,asset,vendor,vendor_id,venue,currency,enabled)
      VALUES($1,'stock','p08-test',$2,'TEST','USD',true)`,[instrumentId,`P08-${suffix.slice(0,8)}`]);
    await pool.query(`INSERT INTO instrument_metadata_version(id,instrument_id,version,multiplier,tick_size,source_id)
      VALUES($1,$2,1,1,0.01,'p08-test')`,[metadataId,instrumentId]);

    const assertPublicVersion=async(publicationId,versionId,queryable=pool)=>{
      const visible=await queryable.query(`SELECT 1 FROM publication p JOIN profile pr ON pr.user_id=p.author_user_id AND pr.moderation_hidden_at IS NULL
        JOIN user_account u ON u.id=p.author_user_id AND u.status='active'
        WHERE p.id=$1 AND p.current_version_id=$2 AND p.visibility='public' AND p.published_at IS NOT NULL`,[publicationId,versionId]);
      if(!visible.rowCount)throw new CommandError(404,'PUBLICATION_NOT_FOUND');
    };
    const guardedPositions=new PositionService(pool,assertPublicVersion);
    const guardedPerformance=new PerformanceService(pool,assertPublicVersion);

    await t.test('full/partial fills enforce revisions and idempotency and preserve complete-cost performance',async()=>{
      const position=await createPosition(basePlan());const entryTime=claimed();
      const entry={type:'entry',claimedAt:entryTime,quantity:10,price:'10',costs:'0'};
      const first=await service.append(owner,position.positionId,1,`${suffix}-entry`,entry);
      const replay=await service.append(owner,position.positionId,1,`${suffix}-entry`,entry);
      assert.deepEqual(replay,first,'idempotent replay must precede stale-revision checks');
      await assert.rejects(service.append(owner,position.positionId,1,`${suffix}-stale`,{...entry,price:'10.1'}),e=>e instanceof CommandError&&e.code==='STALE_POSITION');
      await service.append(owner,position.positionId,2,`${suffix}-partial`,{type:'partial_exit',claimedAt:iso(Date.now()+1000),quantity:4,price:'11',costs:'0'});
      await service.append(owner,position.positionId,3,`${suffix}-final`,{type:'final_exit',claimedAt:iso(Date.now()+2000),quantity:6,price:'12',costs:'0'});
      const read=await service.get(position.positionId,owner);
      assert.equal(read.state,'closed');assert.equal(read.remainingQuantity,0);assert.equal(read.outcome.netRealized,'16.0000000000');
      assert.equal(read.outcome.costCoverage,'complete');assert.equal(read.outcome.publicationVersionId,position.versionId);assert.equal(read.riskSourceVersionId,position.versionId);
      const page=await service.listEvents(position.positionId,owner,undefined,2);
      assert.equal(page.items.length,2);assert.ok(page.nextCursor,'position events expose a continuation cursor');
      const token=JSON.parse(Buffer.from(page.nextCursor,'base64url').toString('utf8'));
      assert.equal(token.positionId,position.positionId);assert.match(token.receivedAt,/\.\d{6}Z$/,'cursor preserves PostgreSQL microseconds');
      const next=await service.listEvents(position.positionId,owner,page.nextCursor,2);
      assert.equal(next.items.length,1);assert.equal(next.nextCursor,null);
      const otherPosition=await createPosition(basePlan());
      await assert.rejects(service.listEvents(otherPosition.positionId,owner,page.nextCursor,2),e=>e instanceof CommandError&&e.code==='INVALID_CURSOR');
      const metrics=await new PerformanceService(pool).getForUser(owner);
      assert.equal(metrics.closedCount,1);assert.equal(metrics.wins,1);assert.equal(metrics.reportedRealizedPnl,'16.0000000000');
      assert.equal(metrics.completeCostClosedCount,1);
    });

    await t.test('short-stock borrow costs are counted once; missing costs exclude headline metrics',async()=>{
      const short=await createPosition(basePlan('short','10','11',1));
      await service.append(owner,short.positionId,1,`${suffix}-short-entry`,{type:'entry',claimedAt:claimed(),quantity:1,price:'10',costs:'0',borrowCosts:'1.25'});
      await service.append(owner,short.positionId,2,`${suffix}-short-exit`,{type:'final_exit',claimedAt:iso(Date.now()+1000),quantity:1,price:'9',costs:'0.25'});
      const shortRead=await service.get(short.positionId,owner);
      assert.equal(shortRead.outcome.netRealized,'-0.5000000000');assert.equal(shortRead.outcome.borrowCostCoverage,'included');

      const missing=await createPosition(basePlan('long','10','9',1));
      await service.append(owner,missing.positionId,1,`${suffix}-missing-entry`,{type:'entry',claimedAt:claimed(),quantity:1,price:'10',costs:null});
      await service.append(owner,missing.positionId,2,`${suffix}-missing-exit`,{type:'final_exit',claimedAt:iso(Date.now()+1000),quantity:1,price:'11',costs:null});
      const missingRead=await service.get(missing.positionId,owner);
      assert.equal(missingRead.outcome.netRealized,null);assert.equal(missingRead.outcome.costCoverage,'incomplete');
      const metrics=await new PerformanceService(pool).getForUser(owner);
      assert.equal(metrics.incompleteCostClosedCount,1);assert.equal(metrics.reportedRealizedPnl,'15.5000000000');
    });

    await t.test('exception and resolution keep an explicit unresolved path and never create a fabricated fill',async()=>{
      const position=await createPosition(basePlan('long','10','9',2));const entered=claimed();
      await service.append(owner,position.positionId,1,`${suffix}-resolve-entry`,{type:'entry',claimedAt:entered,quantity:2,price:'10',costs:'0'});
      const exceptionAt=iso(Date.now()+1000);
      await service.append(owner,position.positionId,2,`${suffix}-exception`,{type:'exception',claimedAt:exceptionAt,reason:'Contract status requires review'});
      const unresolved=await service.get(position.positionId,owner);assert.equal(unresolved.state,'unresolved');assert.equal(unresolved.remainingQuantity,2);assert.equal(unresolved.outcome.netRealized,null);
      await service.append(owner,position.positionId,3,`${suffix}-resolution`,{type:'resolution',claimedAt:iso(Date.now()+2000),reason:'Member-reported settlement statement',resolution:'cash_settled',netResult:'3.50',costs:'0'});
      await service.append(owner,position.positionId,4,`${suffix}-resolution-review`,{type:'review',claimedAt:iso(Date.now()+3000),reason:'Settlement record reviewed'});
      const closed=await service.get(position.positionId,owner);assert.equal(closed.state,'closed');assert.equal(closed.remainingQuantity,0);
      assert.equal(closed.outcome.netRealized,'3.5000000000');assert.equal(closed.outcome.costCoverage,'complete');
      assert.deepEqual(closed.events.map(event=>event.type),['entry','exception','resolution','review']);
    });

    await t.test('reported fills drive cash P&L while original planned risk remains the R denominator',async()=>{
      const position=await createPosition(basePlan('long','100','90',2));
      await service.append(owner,position.positionId,1,`${suffix}-fill-entry`,{type:'entry',claimedAt:claimed(),quantity:2,price:'101',costs:'0'});
      await service.append(owner,position.positionId,2,`${suffix}-fill-partial`,{type:'partial_exit',claimedAt:iso(Date.now()+1000),quantity:1,price:'105',costs:'0'});
      await service.append(owner,position.positionId,3,`${suffix}-fill-exception`,{type:'exception',claimedAt:iso(Date.now()+2000),reason:'Remaining contract requires settlement review'});
      await service.append(owner,position.positionId,4,`${suffix}-fill-resolution`,{type:'resolution',claimedAt:iso(Date.now()+3000),resolution:'cash_settled',netResult:'6.00',reason:'Member reported net for remaining unit'});
      await service.append(owner,position.positionId,5,`${suffix}-fill-review`,{type:'review',claimedAt:iso(Date.now()+4000),reason:'Resolution reviewed'});
      const closed=await service.get(position.positionId,owner);
      assert.equal(closed.initialRisk,'20.0000000000');
      assert.equal(closed.outcome.netRealized,'10.0000000000');
      assert.equal(closed.outcome.rMultiple,'0.5000000000');
      assert.equal(closed.outcome.costCoverage,'complete');
    });

    await t.test('reviewer cannot self-approve; corrected events append, remain visible, and carry captured-version provenance',async()=>{
      const position=await createPosition(basePlan('long','10','9',1));const entryTime=claimed();
      await service.append(owner,position.positionId,1,`${suffix}-corr-entry`,{type:'entry',claimedAt:entryTime,quantity:1,price:'10',costs:'0'});
      const correctionQueue=async(tx,input)=>{
        const publicationVersionId=randomUUID(),jobId=randomUUID();jobForCorrection=jobId;
        await tx.query(`INSERT INTO publication_version(id,publication_id,sequence,previous_version_id,terms,thesis,chart,disclosures,created_at)
          SELECT $1,$2,2,$3,terms,thesis,chart,disclosures,now() FROM publication_version WHERE id=$3`,[publicationVersionId,input.publicationId,input.sourceVersionId]);
        const draftId=randomUUID();draftIds.push(draftId);jobIds.push(jobId);
        await tx.query(`INSERT INTO draft(id,owner_user_id,kind,title,thesis,plan,revision,chart_revision,created_at,updated_at)
          VALUES($1,$2,'trade','Correction candidate','Candidate','{}',1,0,now(),now())`,[draftId,owner]);
        await tx.query(`INSERT INTO publication_job(id,owner_user_id,draft_id,publication_id,publication_version_id,status,candidate,render_nonce,render_nonce_expires_at)
          VALUES($1,$2,$3,$4,$5,'pending',$6::jsonb,$7,now()+interval '15 minutes')`,[jobId,owner,draftId,input.publicationId,publicationVersionId,JSON.stringify({correctionRequestId:input.correctionRequestId,replacementEvent:input.replacementEvent??null}),randomUUID()]);
        return {jobId,publicationVersionId};
      };
      const corrections=new CorrectionService(pool,service,correctionQueue);
      const correction=await corrections.request(owner,position.publicationId,`${suffix}-correction`,{reason:'Correct the member-reported entry price',replacementEvent:{sourceEventId:(await service.get(position.positionId,owner)).events[0].id,event:{type:'entry',claimedAt:entryTime,quantity:1,price:'10.50',costs:'0'}}});
      correctionIds.push(correction.id);
      await assert.rejects(corrections.review(owner,correction.id,`${suffix}-self-review`,'approve','Self review'),e=>e instanceof CommandError&&e.code==='SELF_REVIEW_FORBIDDEN');
      const queued=await corrections.review(staff,correction.id,`${suffix}-staff-review`,'approve','Source verified for correction');
      assert.equal(queued.action,'correction_processing');assert.ok(jobForCorrection);
      const pending=await pool.query('SELECT status,publication_job_id FROM correction_request WHERE id=$1',[correction.id]);assert.equal(pending.rows[0].status,'processing');assert.equal(pending.rows[0].publication_job_id,jobForCorrection);
      const job=await pool.query('SELECT publication_version_id FROM publication_job WHERE id=$1',[jobForCorrection]);
      const finalizeClient=await pool.connect();
      try{await finalizeClient.query('BEGIN');await corrections.finalizeCorrection(finalizeClient,correction.id,jobForCorrection,job.rows[0].publication_version_id);await finalizeClient.query('UPDATE publication SET current_version_id=$2 WHERE id=$1',[position.publicationId,job.rows[0].publication_version_id]);await finalizeClient.query('COMMIT');}
      catch(error){await finalizeClient.query('ROLLBACK').catch(()=>undefined);throw error;}finally{finalizeClient.release();}
      const corrected=await service.get(position.positionId,owner);
      assert.equal(corrected.outcome.publicationVersionId,job.rows[0].publication_version_id);
      assert.equal(corrected.riskSourceVersionId,position.versionId,'reviewed plan/event changes cannot rewrite the original risk denominator');
      assert.equal(corrected.events.length,2);assert.equal(corrected.events[0].supersedesId,null);assert.equal(corrected.events[1].supersedesId,corrected.events[0].id);
      assert.equal(corrected.events[0].price,'10.0000000000');assert.equal(corrected.events[1].price,'10.5000000000');
      assert.equal((await pool.query('SELECT status FROM correction_request WHERE id=$1',[correction.id])).rows[0].status,'approved');
    });

    await t.test('late entry is visible but excluded from eligible headline counts',async()=>{
      const publishedAt=iso(Date.now()-10*60_000);const start=iso(Date.now()-15*60_000),end=iso(Date.now()+5*60_000);
      const late=await createPosition(basePlan('long','10','9',1,start,end),{publishedAt});
      await service.append(owner,late.positionId,1,`${suffix}-late-entry`,{type:'entry',claimedAt:iso(Date.now()-8*60_000),quantity:1,price:'10',costs:'0'});
      await service.append(owner,late.positionId,2,`${suffix}-late-exit`,{type:'final_exit',claimedAt:iso(Date.now()-7*60_000),quantity:1,price:'11',costs:'0'});
      const read=await service.get(late.positionId,owner);assert.equal(read.outcome.eligibility,'retrospective');
      const metrics=await new PerformanceService(pool).getForUser(owner);assert.equal(metrics.retrospective,1);assert.equal(metrics.wins,3,'late reported outcome is excluded from eligible wins');
    });

    await t.test('hidden author profile suppresses public position and performance while retaining owner access',async()=>{
      const baselineClosed=(await guardedPerformance.get(ownerHandle)).closedCount;
      const position=await createPosition(basePlan('long','10','9',1));
      await service.append(owner,position.positionId,1,`${suffix}-hidden-entry`,{type:'entry',claimedAt:claimed(),quantity:1,price:'10',costs:'0'});
      await service.append(owner,position.positionId,2,`${suffix}-hidden-exit`,{type:'final_exit',claimedAt:iso(Date.now()+1000),quantity:1,price:'11',costs:'0'});
      assert.equal((await guardedPositions.get(position.positionId)).state,'closed');
      assert.equal((await guardedPerformance.get(ownerHandle)).closedCount,baselineClosed+1);

      await pool.query('UPDATE profile SET moderation_hidden_at=now() WHERE user_id=$1',[owner]);
      await assert.rejects(guardedPositions.get(position.positionId),error=>error instanceof CommandError&&error.code==='POSITION_NOT_FOUND');
      await assert.rejects(guardedPositions.listEvents(position.positionId,undefined,undefined,20),error=>error instanceof CommandError&&error.code==='POSITION_NOT_FOUND');
      await assert.rejects(guardedPerformance.get(ownerHandle),error=>error instanceof CommandError&&error.code==='PROFILE_NOT_FOUND');
      assert.equal((await guardedPerformance.getForUser(owner)).closedCount,0);
      assert.equal((await guardedPositions.get(position.positionId,owner)).state,'closed','the hidden author retains owner access');
      assert.equal((await guardedPositions.listEvents(position.positionId,owner,undefined,20)).items.length,2);

      await pool.query('UPDATE profile SET moderation_hidden_at=NULL WHERE user_id=$1',[owner]);
      assert.equal((await guardedPositions.get(position.positionId)).state,'closed');
      assert.equal((await guardedPerformance.get(ownerHandle)).closedCount,baselineClosed+1);
    });
  }finally{
    try { await cleanupP08Fixtures(pool,[owner,staff],[instrumentId]); }
    finally {
      await pool.end();
    }
  }
});
