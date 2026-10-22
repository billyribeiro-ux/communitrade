import assert from 'node:assert/strict';
import test from 'node:test';
import { randomUUID } from 'node:crypto';
import pg from 'pg';
import { NotificationService, saveNotification } from '../dist/notifications/service.js';
import { withActorTransaction } from '../dist/persistence/transactions.js';

const databaseUrl = process.env.TEST_DATABASE_URL;
const integration = { skip: databaseUrl ? false : 'Set TEST_DATABASE_URL for PostgreSQL notification privacy and concurrency acceptance.' };

test('PostgreSQL notifications are owner-only, aggregate atomically, hide unavailable sources, and race safely with read-all', integration, async () => {
  const pool = new pg.Pool({ connectionString: databaseUrl, max: 8, connectionTimeoutMillis: 3000, query_timeout: 15000 });
  pool.on('error', () => {});
  const suffix = randomUUID();
  const owner = randomUUID(), member = randomUUID(), staff = randomUUID();
  const issuer = `https://p11.notifications.${suffix}.invalid`;
  const service = new NotificationService(pool, 'notification-test-secret-long-enough-for-hmac', async () => false);
  try {
    for (const [id, email] of [[owner, 'owner'], [member, 'member'], [staff, 'staff']]) {
      await pool.query(`INSERT INTO user_account(id,oidc_issuer,oidc_subject,email,email_verified,status,created_at,updated_at)
        VALUES($1::uuid,$2,$3,$4,true,'active',now(),now())`, [id, issuer, id, `${email}-${suffix}@example.invalid`]);
    }
    const sourceId = randomUUID();
    const aggregateKey = `p11-aggregate:${suffix}`;
    for (let n = 0; n < 5; n++) {
      await withActorTransaction(pool, owner, tx => saveNotification(tx, {
        ownerUserId: owner, category: 'reply', aggregationKey: aggregateKey,
        internalUrl: `/ideas/${sourceId}`, sourceId, text: 'There is new reply activity on an idea.',
      }));
    }

    const ownPage = await service.listNotifications(owner, undefined, 20);
    assert.equal(ownPage.items.length, 1);
    assert.equal(ownPage.items[0].eventCount, 5);
    assert.equal(ownPage.items[0].sourceId, null, 'unavailable source identifiers are not exposed');
    assert.equal(ownPage.items[0].url, '/app/notifications', 'unavailable source links are replaced');
    assert.equal((await service.listNotifications(member)).items.length, 0, 'another member cannot read the owner inbox');
    assert.equal((await service.listNotifications(staff)).items.length, 0, 'staff identity does not bypass inbox ownership');

    const duplicateWrites = Array.from({ length: 6 }, () => withActorTransaction(pool, owner, tx => saveNotification(tx, {
      ownerUserId: owner, category: 'reply', aggregationKey: aggregateKey,
      internalUrl: `/ideas/${sourceId}`, sourceId, text: 'There is new reply activity on an idea.',
    })));
    await Promise.all([service.readAll(owner), ...duplicateWrites]);
    const afterRace = await service.listNotifications(owner, undefined, 20);
    assert.equal(afterRace.items.length, 1);
    assert.equal(afterRace.items[0].eventCount, 11, 'concurrent duplicate fanout increments exactly once per committed event');
    assert.ok(afterRace.items[0].readAt === null || typeof afterRace.items[0].readAt === 'string', 'read-all and concurrent insert leave a valid read state');
    await service.readAll(owner);
    assert.equal((await service.listNotifications(owner)).unreadCount, 0);
  } finally {
    await pool.query('DELETE FROM notification WHERE owner_user_id=ANY($1::uuid[])', [[owner, member, staff]]);
    await pool.query('DELETE FROM preference WHERE user_id=ANY($1::uuid[])', [[owner, member, staff]]);
    await pool.query('DELETE FROM user_account WHERE id=ANY($1::uuid[])', [[owner, member, staff]]);
    await pool.end();
  }
});

test('PostgreSQL saved searches enforce concurrent Pro limit, revisions and preserved downgrade ownership',integration,async()=>{
 const pool=new pg.Pool({connectionString:databaseUrl,max:10}),owner=randomUUID(),other=randomUUID(),staff=randomUUID(),ids=[owner,other,staff],service=new NotificationService(pool,'synthetic-p11-search-secret-at-least-32-characters');
 try{
  for(const id of ids)await pool.query("INSERT INTO user_account(id,oidc_issuer,oidc_subject,email,email_verified,status,created_at,updated_at) VALUES($1::uuid,$2,$1::text,$3,true,'active',now(),now())",[id,`https://p11.notifications.${owner}.invalid`,`${id}@example.invalid`]);
  await pool.query("INSERT INTO role_grant(id,user_id,role,grantor_user_id,reason,granted_at) VALUES($1,$2,'admin',$2,'Synthetic saved search ownership',now())",[randomUUID(),staff]);
  await assert.rejects(service.createSavedSearch(owner,randomUUID(),{name:'Free denied',filters:{asset:'option'}}),{code:'PRO_REQUIRED'});
  const entitlement=randomUUID();await pool.query("INSERT INTO subscription_entitlement(id,user_id,plan,limits,valid_from,valid_until) VALUES($1,$2,'pro','{}',now()-interval '1 day',now()+interval '1 day')",[entitlement,owner]);
  const firstKey=randomUUID(),first=await service.createSavedSearch(owner,firstKey,{name:'Option ideas',filters:{asset:'option',q:'  long   call  '}});assert.equal(first.filters.q,'long call');assert.equal((await service.createSavedSearch(owner,firstKey,{name:'Option ideas',filters:{asset:'option',q:'  long   call  '}})).id,first.id);
  await assert.rejects(service.createSavedSearch(owner,randomUUID(),{name:'OPTION IDEAS',filters:{}}),{code:'SAVED_SEARCH_NAME_EXISTS'});
  const writes=await Promise.allSettled(Array.from({length:7},(_,i)=>service.createSavedSearch(owner,randomUUID(),{name:`Search ${i}`,filters:{asset:'future'}})));assert.equal(writes.filter(result=>result.status==='fulfilled').length,4);for(const result of writes.filter(result=>result.status==='rejected'))assert.equal(result.reason.code,'SAVED_SEARCH_LIMIT');
  const page=await service.listSavedSearches(owner,undefined,2);assert.equal(page.items.length,2);assert.ok(page.nextCursor);await assert.rejects(service.listSavedSearches(other,page.nextCursor),{code:'INVALID_CURSOR'});
  for(const id of [other,staff]){await assert.rejects(service.updateSavedSearch(id,first.id,'"1"',{name:'Not mine'}),{code:'SAVED_SEARCH_NOT_FOUND'});await assert.rejects(service.deleteSavedSearch(id,first.id,'"1"'),{code:'SAVED_SEARCH_NOT_FOUND'});}
  const updated=await service.updateSavedSearch(owner,first.id,'"1"',{name:'Updated option ideas'});assert.equal(updated.revision,2);await assert.rejects(service.updateSavedSearch(owner,first.id,'"1"',{name:'Stale'}),{code:'STALE_REVISION'});
  await pool.query("UPDATE subscription_entitlement SET valid_until=now()-interval '1 second' WHERE id=$1",[entitlement]);assert.equal((await service.listSavedSearches(owner)).items.length,5);
  await assert.rejects(service.updateSavedSearch(owner,first.id,'"2"',{filters:{asset:'stock'}}),{code:'PRO_REQUIRED'});
  await service.deleteSavedSearch(owner,first.id,'"2"');assert.equal((await service.listSavedSearches(owner)).items.length,4);
 }finally{const {cleanupP08Fixtures}=await import('../scripts/p08-fixture-cleanup.mjs');await cleanupP08Fixtures(pool,ids);await pool.end();}
});

test('signed digest unsubscribe is purpose-bound, expires, repeats safely and clears on explicit opt-in',integration,async()=>{
 const {AuthService,authConfigFromEnv}=await import('../dist/auth/service.js'),pool=new pg.Pool({connectionString:databaseUrl,max:3}),owner=randomUUID(),secret='synthetic-p11-unsubscribe-secret-at-least-32-characters',service=new NotificationService(pool,secret),auth=new AuthService(pool,authConfigFromEnv()),actor={userId:owner,roles:[],emailVerified:true,status:'active',onboarded:true};
 try{
  await pool.query("INSERT INTO user_account(id,oidc_issuer,oidc_subject,email,email_verified,status,created_at,updated_at) VALUES($1::uuid,$2,$1::text,$3,true,'active',now(),now())",[owner,`https://p11.notifications.${owner}.invalid`,`${owner}@example.invalid`]);
  await auth.updatePreferences(actor,{digestEnabled:true});const expiry=Math.floor(Date.now()/1000)+86400,token=service.makeUnsubscribeToken(owner,expiry);
  await service.unsubscribeDigest(token);await service.unsubscribeDigest(token);assert.equal((await auth.getPreferences(actor)).digestSuppressed,true);
  const parts=token.split('.');parts[0]=randomUUID();await assert.rejects(service.unsubscribeDigest(parts.join('.')),{code:'INVALID_UNSUBSCRIBE_TOKEN'});
  await assert.rejects(service.unsubscribeDigest(service.makeUnsubscribeToken(owner,Math.floor(Date.now()/1000)-1)),{code:'INVALID_UNSUBSCRIBE_TOKEN'});
  await assert.rejects(new NotificationService(pool,'different-synthetic-secret-at-least-32-characters').unsubscribeDigest(token),{code:'INVALID_UNSUBSCRIBE_TOKEN'});
  await auth.updatePreferences(actor,{digestEnabled:true});assert.equal((await auth.getPreferences(actor)).digestSuppressed,false);assert.equal((await auth.getPreferences(actor)).accountNotices,true);assert.equal((await auth.getPreferences(actor)).billingNotices,true);
 }finally{const {cleanupP08Fixtures}=await import('../scripts/p08-fixture-cleanup.mjs');await cleanupP08Fixtures(pool,[owner]);await pool.end();}
});
