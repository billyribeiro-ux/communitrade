import assert from 'node:assert/strict';
import test from 'node:test';
import { randomUUID } from 'node:crypto';
import pg from 'pg';
import { cleanupP08Fixtures } from '../../api/scripts/p08-fixture-cleanup.mjs';
import { createSmtpEmailPort, EmailDeliveryError } from '../dist/email.js';
import { dispatchSideEffectDeliveries, processEmailDelivery, reconcileSideEffectDeliveries, scheduleDailyDigests, zonedLocalTimeToUtc } from '../dist/delivery.js';

const databaseUrl = process.env.TEST_DATABASE_URL ?? process.env.DATABASE_URL;
const isMailpit = (process.env.SMTP_HOST ?? '') === 'mailpit';
const integration = { skip: databaseUrl && isMailpit && process.env.RELEASE_MODE==='local' && process.env.NODE_ENV!=='production' ? false : 'Run in the local worker container with PostgreSQL and SMTP_HOST=mailpit for real delivery acceptance.' };
const fixtureOptionId = '00000000-0000-4000-8000-000000000221';

test('PostgreSQL delivery covers daily digest policy, bounce suppression, retry budgets and enqueue replay', integration, async () => {
  const pool = new pg.Pool({ connectionString: databaseUrl, max: 5, connectionTimeoutMillis: 3000, query_timeout: 15000 });
  pool.on('error', () => {});
  const owners = [];
  const fixtureEmails = new Set();
  const mailpitIds = new Set();
  const from = process.env.EMAIL_FROM ?? 'local@example.test';
  const appOrigin = process.env.APP_ORIGIN ?? process.env.WEB_ORIGIN ?? 'http://localhost:3000';
  const sessionSecret = process.env.SESSION_SECRET ?? 'local-p11-test-secret-that-is-long-enough';
  const emailPort = createSmtpEmailPort({ ...process.env, RELEASE_MODE: 'local', SMTP_HOST: 'mailpit', EMAIL_FROM: from });
  const authorizeSource = async id => ({ available:true, title:sourceTitles.get(id) ?? 'Authorized public idea', url:`/ideas/${id}/synthetic-public-idea` });
  const sourceTitles = new Map();
  const config = { appOrigin,sessionSecret,releaseMode:'local',emailFrom:from,authorizeSource };
  const localParts=Object.fromEntries(new Intl.DateTimeFormat('en-US',{timeZone:'America/New_York',year:'numeric',month:'2-digit',day:'2-digit'}).formatToParts(new Date()).map(part=>[part.type,part.value]));
  const localDate=`${localParts.year}-${localParts.month}-${localParts.day}`;
  const laterToday = zonedLocalTimeToUtc(localDate,10,0,'America/New_York');

  async function owner(label, settings = {}) {
    const id = randomUUID();
    const email = `${id}@example.invalid`;
    fixtureEmails.add(email);
    await pool.query(`INSERT INTO user_account(id,oidc_issuer,oidc_subject,email,email_verified,status,synthetic,created_at,updated_at)
      VALUES($1::uuid,$2,$1::text,$3,true,'active',true,now(),now())`, [id,`https://p11.delivery.${id}.invalid`,email]);
    await pool.query(`INSERT INTO preference(id,user_id,settings,updated_at) VALUES($1,$2,$3::jsonb,now())`, [randomUUID(),id,JSON.stringify(settings)]);
    owners.push(id);
    return {id,email,label};
  }

  async function delivery(recipient, channel, template, category, localDay = localDate, values = {}) {
    const id = randomUUID();
    const payload = {
      version:1,template,recipientUserId:recipient.id,category,
      subject:'P11 synthetic delivery',title:'Synthetic delivery',body:'Synthetic acceptance notice.',
      ...(template==='daily_digest'?{localDate:localDay,timezone:'America/New_York'}:{}),
      ...values,
    };
    await pool.query(`INSERT INTO side_effect_delivery(id,channel,business_delivery_key,status,payload,attempts,max_attempts,next_attempt_at,owner_user_id,category,created_at,updated_at)
      VALUES($1,$2,$3,'pending',$4::jsonb,0,5,now(),$5,$6,now(),now())`, [id,channel,`p11.delivery.integration:${id}`,JSON.stringify(payload),recipient.id,category]);
    return id;
  }

  async function captureAndDeleteMailpitMessages() {
    const base = (process.env.MAILPIT_URL ?? 'http://mailpit:8025').replace(/\/$/, '');
    for (const email of fixtureEmails) {
      const response = await fetch(`${base}/api/v1/search?query=${encodeURIComponent(`to:${email}`)}&limit=100`, { signal:AbortSignal.timeout(10000) });
      assert.ok(response.ok, 'Exact-recipient Mailpit lookup must succeed before cleanup.');
      const data = await response.json();
      for (const message of data.messages ?? []) {
        const recipients = [...(message.To ?? []),...(message.to ?? [])].map(value => String(value.Address ?? value.address ?? value).toLowerCase());
        if (!recipients.includes(email.toLowerCase())) continue;
        const id = message.ID ?? message.id;
        if (id) mailpitIds.add(id);
      }
    }
    if (!mailpitIds.size) return;
    const response = await fetch(`${base}/api/v1/messages`, { method:'DELETE',headers:{'Content-Type':'application/json'},body:JSON.stringify({IDs:[...mailpitIds]}),signal:AbortSignal.timeout(10000) });
    assert.ok(response.ok, 'Cleanup must delete only generated fixture-recipient Mailpit IDs.');
  }

  try {
    const option = await pool.query('SELECT id FROM instrument WHERE id=$1 AND vendor=\'synthetic-fixture\'', [fixtureOptionId]);
    assert.equal(option.rowCount,1,'The acceptance DB must be seeded with the synthetic option fixture.');
    const metadata = await pool.query('SELECT version FROM instrument_metadata_version WHERE instrument_id=$1 ORDER BY version DESC LIMIT 1',[fixtureOptionId]);
    assert.ok(metadata.rows[0]?.version);
    const authorFollowed = await owner('followed author');
    const authorSearch = await owner('search author');
    const pro = await owner('Pro reader',{digestEnabled:true,digestHour:22,quietFrom:'22:00',quietUntil:'09:00',timezone:'America/New_York',publicationNotices:false});
    const free = await owner('Free reader',{digestEnabled:true,digestHour:4,quietFrom:'22:00',quietUntil:'09:00',timezone:'America/New_York'});
    const bounceOwner = await owner('bounce recipient');
    const authOwner = await owner('auth recipient');
    const invalidRecipientOwner = await owner('invalid recipient');
    const retryOwner = await owner('retry recipient');
    const suppressedOwner = await owner('digest suppressed recipient',{digestEnabled:true,quietFrom:'22:00',quietUntil:'09:00',timezone:'America/New_York',accountNotices:false,billingNotices:false,securityNotices:false});
    await pool.query("INSERT INTO subscription_entitlement(id,user_id,plan,limits,valid_from,valid_until) VALUES($1,$2,'pro','{}',now()-interval '1 day',now()+interval '1 day')",[randomUUID(),pro.id]);
    await pool.query('INSERT INTO saved_search(id,owner_user_id,name,filters,revision,created_at,updated_at) VALUES($1,$2,$3,$4::jsonb,1,now(),now())',[
      randomUUID(),pro.id,'Synthetic author search',JSON.stringify({author:`p11_${authorSearch.id.replaceAll('-','').slice(0,16)}`}),
    ]);
    await pool.query('INSERT INTO profile(user_id,handle,normalized_handle,display_name,interests,links,revision,created_at,updated_at) VALUES($1,$2,$2,$3,\'[]\',\'{}\',1,now(),now())',[
      authorFollowed.id,`p11_${authorFollowed.id.replaceAll('-','').slice(0,16)}`,'P11 followed author',
    ]);
    await pool.query('INSERT INTO profile(user_id,handle,normalized_handle,display_name,interests,links,revision,created_at,updated_at) VALUES($1,$2,$2,$3,\'[]\',\'{}\',1,now(),now())',[
      authorSearch.id,`p11_${authorSearch.id.replaceAll('-','').slice(0,16)}`,'P11 search author',
    ]);
    await pool.query('INSERT INTO follow(id,follower_user_id,target_user_id,created_at) VALUES($1,$2,$3,now()),($4,$5,$3,now())',[
      randomUUID(),pro.id,authorFollowed.id,randomUUID(),free.id,
    ]);

    async function publication(author, title) {
      const publicationId=randomUUID(),versionId=randomUUID();
      await pool.query(`INSERT INTO publication(id,author_user_id,kind,visibility,published_at,created_at) VALUES($1,$2,'trade','public',now()-interval '5 minutes',now())`,[publicationId,author.id]);
      const terms={title,slug:'synthetic-public-idea',plan:{asset:'option',strategy:'long_call',instrumentId:fixtureOptionId,legs:[{instrumentId:fixtureOptionId,side:'buy',quantity:1}]}};
      await pool.query(`INSERT INTO publication_version(id,publication_id,sequence,terms,thesis,chart,disclosures,created_at)
        VALUES($1,$2,1,$3::jsonb,'Synthetic public thesis','{}',$4::jsonb,now())`,[
        versionId,publicationId,JSON.stringify(terms),JSON.stringify({referenceVersions:[{instrumentId:fixtureOptionId,metadataVersion:Number(metadata.rows[0].version)}]}),
      ]);
      await pool.query('UPDATE publication SET original_version_id=$2,current_version_id=$2 WHERE id=$1',[publicationId,versionId]);
      sourceTitles.set(publicationId,title);
      return publicationId;
    }
    const followedPublication=await publication(authorFollowed,'Synthetic followed idea');
    const savedSearchPublication=await publication(authorSearch,'Synthetic saved search idea');

    const scheduleNow=zonedLocalTimeToUtc(localDate,9,30,'America/New_York');
    const schedulerPool={query:(sql,values)=>{
      if(sql.includes('SELECT u.id,p.settings FROM user_account')) return pool.query(sql.replace('AND ($1::uuid IS NULL OR u.id>$1::uuid)','AND ($1::uuid IS NULL OR u.id>$1::uuid) AND u.id=ANY($3::uuid[])'),[...values,[pro.id,free.id]]);
      return pool.query(sql,values);
    }};
    assert.equal(await scheduleDailyDigests(schedulerPool,scheduleNow,50),2,'Pro and Free eligible recipients should schedule after the 09:00 quiet-hour end.');
    assert.equal(await scheduleDailyDigests(schedulerPool,scheduleNow,50),0,'The same owner/local-date digest key must not duplicate.');
    const scheduled=await pool.query("SELECT id,owner_user_id,payload FROM side_effect_delivery WHERE channel='digest_email' AND owner_user_id=ANY($1::uuid[]) ORDER BY owner_user_id",[[pro.id,free.id]]);
    assert.equal(scheduled.rowCount,2);
    assert.ok(scheduled.rows.every(row=>row.payload.localDate===localDate&&row.payload.timezone==='America/New_York'));
    const proDelivery=String(scheduled.rows.find(row=>row.owner_user_id===pro.id).id);
    const freeDelivery=String(scheduled.rows.find(row=>row.owner_user_id===free.id).id);

    await pool.query("UPDATE preference SET settings=settings || '{\"quietUntil\":\"12:00\"}'::jsonb,updated_at=now() WHERE user_id=$1",[pro.id]);
    await processEmailDelivery(pool,{send:async()=>{assert.fail('Digest inside newly updated quiet hours must defer before SMTP.');},close(){}},{deliveryId:proDelivery},config,laterToday);
    let proState=(await pool.query('SELECT status,attempts,next_attempt_at FROM side_effect_delivery WHERE id=$1',[proDelivery])).rows[0];
    assert.equal(proState.status,'pending');assert.equal(proState.attempts,0);
    assert.ok(new Date(proState.next_attempt_at).getTime()>=zonedLocalTimeToUtc(localDate,12,0,'America/New_York').getTime());
    await pool.query("UPDATE preference SET settings=settings || '{\"quietUntil\":\"09:00\"}'::jsonb,updated_at=now() WHERE user_id=$1",[pro.id]);
    await processEmailDelivery(pool,emailPort,{deliveryId:proDelivery},config,laterToday);
    await processEmailDelivery(pool,emailPort,{deliveryId:freeDelivery},config,laterToday);
    const digestStates=await pool.query('SELECT id,status FROM side_effect_delivery WHERE id=ANY($1::uuid[])',[ [proDelivery,freeDelivery] ]);
    assert.ok(digestStates.rows.every(row=>row.status==='succeeded'));
    const digestEmails=await pool.query('SELECT email FROM user_account WHERE id=ANY($1::uuid[])',[[pro.id,free.id]]);
    const proMessage=await readMailpitFor(digestEmails.rows.find(row=>row.email===pro.email)?.email);
    const freeMessage=await readMailpitFor(digestEmails.rows.find(row=>row.email===free.email)?.email);
    assert.ok(!/Synthetic followed idea/.test(proMessage),'publicationNotices=false must suppress followed-author digest sources.');assert.ok(/Synthetic saved search idea/.test(proMessage),'The separate Pro saved-search digest remains eligible.');
    assert.ok(/Synthetic followed idea/.test(freeMessage),'Free followed item missing.');assert.ok(!/Synthetic saved search idea/.test(freeMessage),'Free digest must exclude paid search results.');
    assert.ok(!proMessage.includes(`${appOrigin}/ideas/${followedPublication}/synthetic-public-idea`));
    assert.ok(freeMessage.includes(`${appOrigin}/ideas/${followedPublication}/synthetic-public-idea`));
    assert.ok(proMessage.includes(`${appOrigin}/ideas/${savedSearchPublication}/synthetic-public-idea`));
    assert.ok(!proMessage.includes(`${appOrigin}https://`)&&!proMessage.includes(`${appOrigin}http://`));

    await pool.query('INSERT INTO digest_suppression(owner_user_id,suppressed_at,updated_at) VALUES($1,now(),now())',[suppressedOwner.id]);
    const suppressedDigest=await delivery(suppressedOwner,'digest_email','daily_digest','digest');
    await processEmailDelivery(pool,emailPort,{deliveryId:suppressedDigest},config,laterToday);
    assert.equal((await pool.query('SELECT status FROM side_effect_delivery WHERE id=$1',[suppressedDigest])).rows[0].status,'suppressed');
    const txnDelivery=await delivery(suppressedOwner,'email','notification','billing',localDate,{internalUrl:'/app/settings'});
    await processEmailDelivery(pool,emailPort,{deliveryId:txnDelivery},config,laterToday);
    assert.equal((await pool.query('SELECT status FROM side_effect_delivery WHERE id=$1',[txnDelivery])).rows[0].status,'succeeded','Digest unsubscribe and stored false notice toggles must not suppress mandatory billing mail.');

    async function failingDelivery(recipient, id, failure) {
      const failureId=id??await delivery(recipient,'email','transactional_security','security',localDate,{internalUrl:'/app/settings'});
      const port={send:async()=>{throw failure;},close(){}};
      await processEmailDelivery(pool,port,{deliveryId:failureId},config,new Date());
      return (await pool.query('SELECT status,attempts FROM side_effect_delivery WHERE id=$1',[failureId])).rows[0];
    }
    const bounce=await failingDelivery(bounceOwner,null,new EmailDeliveryError('SMTP_RECIPIENT_REJECTED'));
    const authFailure=await failingDelivery(authOwner,null,new EmailDeliveryError('SMTP_AUTH_FAILED'));
    assert.equal(bounce.status,'failed');assert.equal(authFailure.status,'failed');
    assert.equal((await pool.query('SELECT reason FROM email_suppression WHERE owner_user_id=$1',[bounceOwner.id])).rows[0]?.reason,'bounce');
    assert.equal((await pool.query('SELECT 1 FROM email_suppression WHERE owner_user_id=$1',[authOwner.id])).rowCount,0);
    const malformedEmail='reader@example.invalid,other@example.invalid';
    await pool.query('UPDATE user_account SET email=$2 WHERE id=$1',[invalidRecipientOwner.id,malformedEmail]);
    const invalidRecipientDelivery=await delivery(invalidRecipientOwner,'email','transactional_security','security',localDate,{internalUrl:'/app/settings'});
    await processEmailDelivery(pool,emailPort,{deliveryId:invalidRecipientDelivery},config,new Date());
    const invalidRecipientState=(await pool.query('SELECT status,last_error_code FROM side_effect_delivery WHERE id=$1',[invalidRecipientDelivery])).rows[0];
    assert.equal(invalidRecipientState.status,'failed');assert.equal(invalidRecipientState.last_error_code,'INVALID_RECIPIENT_ADDRESS');
    assert.equal((await pool.query('SELECT 1 FROM email_suppression WHERE owner_user_id=$1',[invalidRecipientOwner.id])).rowCount,0,'Malformed address is terminal but is not treated as a recipient bounce.');

    const retryDelivery=await delivery(retryOwner,'email','transactional_security','security',localDate,{internalUrl:'/app/settings'});
    await pool.query("UPDATE side_effect_delivery SET attempts=4,first_attempt_at=now()-interval '2 minutes' WHERE id=$1",[retryDelivery]);
    await processEmailDelivery(pool,{send:async()=>{throw new EmailDeliveryError('SMTP_TEMPORARY_FAILURE');},close(){}},{deliveryId:retryDelivery},config,new Date());
    const budget=(await pool.query('SELECT status,attempts FROM side_effect_delivery WHERE id=$1',[retryDelivery])).rows[0];
    assert.equal(budget.status,'failed');assert.equal(budget.attempts,5);
    const agedDelivery=await delivery(retryOwner,'email','transactional_security','security',localDate,{internalUrl:'/app/settings'});
    await pool.query("UPDATE side_effect_delivery SET first_attempt_at=now()-interval '25 hours' WHERE id=$1",[agedDelivery]);
    await processEmailDelivery(pool,{send:async()=>{assert.fail('A delivery older than 24 hours must not be sent.');},close(){}},{deliveryId:agedDelivery},config,new Date());
    const aged=(await pool.query('SELECT status,attempts FROM side_effect_delivery WHERE id=$1',[agedDelivery])).rows[0];
    assert.equal(aged.status,'failed');assert.equal(aged.attempts,0);
    const staleDelivery=await delivery(retryOwner,'email','transactional_security','security',localDate,{internalUrl:'/app/settings'});
    await pool.query("UPDATE side_effect_delivery SET status='processing',attempts=1,first_attempt_at=now(),claimed_at=now()-interval '11 minutes' WHERE id=$1",[staleDelivery]);
    const recoveryPool={connect:async()=>{
      const client=await pool.connect();
      return {query:(sql,values)=>sql.includes('SELECT id,status,attempts,max_attempts,first_attempt_at FROM side_effect_delivery')
        ?client.query(sql.replace('ORDER BY updated_at,id LIMIT $5','AND id=$6 ORDER BY updated_at,id LIMIT $5'),[...values,staleDelivery])
        :client.query(sql,values),release:()=>client.release()};
    }};
    const recovered=await reconcileSideEffectDeliveries(recoveryPool,50,new Date());
    assert.ok(recovered.uncertain>=1);
    assert.equal((await pool.query('SELECT status FROM side_effect_delivery WHERE id=$1',[staleDelivery])).rows[0].status,'uncertain');

    const replayDelivery=await delivery(retryOwner,'email','transactional_security','security',localDate,{internalUrl:'/app/settings'});
    // PostgreSQL now() has finer precision than JS Date; make the fixture unambiguously due.
    await pool.query("UPDATE side_effect_delivery SET next_attempt_at=now()-interval '1 minute' WHERE id=$1",[replayDelivery]);
    const jobs=new Map(),seenIds=[];
    let failAcknowledgment=true,selectedReplayRows=0,acknowledgmentInjected=false;
    const wrappedPool={connect:async()=>{
      const client=await pool.connect();
      return {query:async(sql,values)=>{
        if(sql.includes('SELECT id,channel,attempts FROM side_effect_delivery')) {
          const result=await client.query(sql.replace('ORDER BY next_attempt_at,created_at,id LIMIT $3','AND id=$4 ORDER BY next_attempt_at,created_at,id LIMIT $3'),[...values,replayDelivery]);
          selectedReplayRows+=result.rowCount;
          return result;
        }
        if(failAcknowledgment&&sql.includes("SET status='queued'")){failAcknowledgment=false;acknowledgmentInjected=true;throw new Error('injected DB acknowledgment failure');}
        return client.query(sql,values);
      },release:()=>client.release()};
    }};
    let ackError;
    try { await dispatchSideEffectDeliveries(wrappedPool,async(_queue,_data,options)=>{seenIds.push(options.id);jobs.set(options.id,true);return options.id;}); } catch(error) { ackError=error; }
    assert.match(String(ackError),/injected DB acknowledgment failure/,`Expected DB ACK injection after selecting ${selectedReplayRows} row(s), enqueueing ${seenIds.length} job(s), and intercepting ACK=${acknowledgmentInjected}.`);
    const pendingAfterAckFailure=(await pool.query('SELECT status,attempts FROM side_effect_delivery WHERE id=$1',[replayDelivery])).rows[0];
    assert.equal(pendingAfterAckFailure.status,'pending');assert.equal(pendingAfterAckFailure.attempts,0);assert.equal(jobs.size,1);
    assert.equal(await dispatchSideEffectDeliveries(wrappedPool,async(_queue,_data,options)=>{seenIds.push(options.id);jobs.set(options.id,true);return options.id;}),1);
    assert.equal(seenIds.length,2);assert.equal(seenIds[0],seenIds[1],'Queue replay must resend the same stable pg-boss job UUID.');
    const replayState=(await pool.query('SELECT status,queue_job_id FROM side_effect_delivery WHERE id=$1',[replayDelivery])).rows[0];
    assert.equal(replayState.status,'queued');assert.equal(replayState.queue_job_id,seenIds[1]);
  } finally {
    emailPort.close();
    try {
      await captureAndDeleteMailpitMessages();
      await cleanupP08Fixtures(pool,owners);
      assert.equal((await pool.query('SELECT count(*)::int AS count FROM user_account WHERE id=ANY($1::uuid[])',[owners])).rows[0].count,0,'All generated P11 owner fixtures must be removed.');
    } finally {
      await pool.end();
    }
  }

  async function readMailpitFor(email) {
    const base=(process.env.MAILPIT_URL??'http://mailpit:8025').replace(/\/$/,'');
    const response=await fetch(`${base}/api/v1/search?query=${encodeURIComponent(`to:${email}`)}&limit=20`,{signal:AbortSignal.timeout(10000)});
    assert.ok(response.ok,'Mailpit exact-recipient search must succeed.');
    const result=await response.json();
    const message=(result.messages??[]).find(item=>[...(item.To??[]),...(item.to??[])].some(address=>String(address.Address??address.address??address).toLowerCase()===email.toLowerCase()));
    assert.ok(message,'Expected a locally delivered fixture email.');
    const id=message.ID??message.id;assert.ok(id);mailpitIds.add(id);
    const detailResponse=await fetch(`${base}/api/v1/message/${encodeURIComponent(id)}`,{signal:AbortSignal.timeout(10000)});
    assert.ok(detailResponse.ok,'Mailpit generated-message read must succeed.');
    const detail=await detailResponse.json();
    return `${detail.Text??''}\n${detail.HTML??''}`;
  }
});
