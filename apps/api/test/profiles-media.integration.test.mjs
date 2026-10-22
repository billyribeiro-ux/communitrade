import assert from 'node:assert/strict';
import test from 'node:test';
import { createHash, randomUUID } from 'node:crypto';
import pg from 'pg';
import { createApp } from '../dist/app.js';
import { CommandError } from '../dist/http/problem.js';
import { MediaService } from '../dist/media/service.js';
import { ProfileService } from '../dist/profiles/service.js';

const databaseUrl = process.env.TEST_DATABASE_URL;
const integration = { skip: databaseUrl ? false : 'Set TEST_DATABASE_URL for profile/media PostgreSQL acceptance.' };

test('PostgreSQL profile handles, upload idempotency/rate limits, and media visibility', integration, async (t) => {
  const pool = new pg.Pool({ connectionString: databaseUrl, max: 8, connectionTimeoutMillis: 3000, query_timeout: 15000 });
  pool.on('error', () => {});
  const suffix = randomUUID().replaceAll('-', '').slice(0, 10);
  const ownerA = randomUUID();
  const ownerB = randomUUID();
  const handles = [`p04a${suffix}`, `p04b${suffix}`, `p04new${suffix}`];
  let instrumentId;
  let metadataId;
  const performanceIds = [];
  const profile = new ProfileService(pool);
  const readBytes = Buffer.from('processed webp fixture');
  const storage = {
    putQuarantined: async (id) => `${id}/quarantine.bin`,
    readAuthorized: async (_key, authorization) => {
      assert.ok(authorization.ownerUserId === ownerA);
      return readBytes;
    },
  };
  const media = new MediaService(pool, storage);
  const fakeAuth = {
    authenticate: async (request) => {
      if (request.headers.cookie === 'p04-owner-a') return { userId: ownerA };
      if (request.headers.cookie === 'p04-owner-b') return { userId: ownerB };
      if (request.headers.cookie === 'p04-staff') return { userId: ownerB, roles: ['admin'] };
      throw new CommandError(401, 'AUTHENTICATION_REQUIRED');
    },
    assertCsrf: async () => {},
    assertPublicRead: async () => {},
  };
  let app;

  async function createUser(id, handle, letter) {
    await pool.query(`INSERT INTO user_account(id,oidc_issuer,oidc_subject,email,email_verified,status,created_at,updated_at)
      VALUES($1,'https://p04.profile.integration.invalid',$2,$3,true,'active',now(),now())`,
    [id, `${suffix}-${letter}`, `${suffix}-${letter}@example.invalid`]);
    await pool.query(`INSERT INTO profile(user_id,handle,normalized_handle,display_name,bio,interests,links,revision,created_at,updated_at)
      VALUES($1,$2,$2,$3,NULL,'[]'::jsonb,'[]'::jsonb,1,now(),now())`, [id, handle, `Synthetic ${letter}`]);
  }

  try {
    await createUser(ownerA, handles[0], 'a');
    await createUser(ownerB, handles[1], 'b');
    app = await createApp({ $queryRaw: async () => [] }, null, { auth: fakeAuth, profiles: profile, media });
    await app.listen(0, '127.0.0.1');

    await t.test('public projection, handle conflicts, stale edits, and canonical old-handle redirect', async () => {
      const reference = await pool.query('SELECT instrument_id,id FROM instrument_metadata_version ORDER BY created_at LIMIT 1');
      assert.ok(reference.rowCount, 'the integration database must be seeded with catalog metadata');
      instrumentId = reference.rows[0].instrument_id;
      metadataId = reference.rows[0].id;
      const records = [
        { visibility: 'public', publishedAt: new Date(), eligibility: 'eligible', net: '10' },
        { visibility: 'hidden', publishedAt: new Date(), eligibility: 'eligible', net: '999' },
        { visibility: 'public', publishedAt: new Date(), eligibility: 'retrospective', net: '-5' },
        { visibility: 'public', publishedAt: null, eligibility: 'eligible', net: '500' },
      ];
      for (const record of records) {
        const publicationId = randomUUID();
        const positionId = randomUUID();
        performanceIds.push({ publicationId, positionId });
        await pool.query('INSERT INTO publication(id,author_user_id,kind,visibility,published_at) VALUES($1,$2,\'trade\',$3,$4)', [publicationId, ownerA, record.visibility, record.publishedAt]);
        await pool.query(`INSERT INTO position(id,owner_user_id,public_publication_id,state,plan,instrument_id,metadata_version_id,remaining_quantity,initial_risk,calculation_version)
          VALUES($1,$2,$3,'closed','{}'::jsonb,$4,$5,0,1,'p04-integration')`, [positionId, ownerA, publicationId, instrumentId, metadataId]);
        await pool.query(`INSERT INTO outcome_snapshot(id,position_id,source_event_cutoff,calculation_version,eligibility,net,r_multiple,cost_coverage)
          VALUES($1,$2,now(),'p04-integration',$3,$4,1,'complete')`, [randomUUID(), positionId, record.eligibility, record.net]);
      }
      const initial = await profile.getPublic(handles[0]);
      assert.equal(initial.profile.user.handle, handles[0]);
      assert.equal('email' in initial.profile.user, false);
      assert.equal('email' in initial.profile, false);
      assert.equal(initial.profile.statistics.closedCount, 2, JSON.stringify(initial.profile.statistics));
      assert.equal(initial.profile.statistics.wins, 1);
      assert.equal(initial.profile.statistics.losses, 0);
      assert.equal(initial.profile.statistics.retrospective, 1);
      assert.equal(initial.profile.statistics.winRate, 1);
      assert.equal(initial.profile.statistics.reportedRealizedPnl, '10.0000000000');

      const changed = await profile.update(ownerA, 1, { handle: handles[2], bio: 'public bio' });
      assert.equal(changed.revision, 2);
      const oldHandle = await profile.getPublic(handles[0]);
      assert.equal(oldHandle.redirect, handles[2]);
      assert.equal(oldHandle.profile.user.handle, handles[2]);
      await assert.rejects(profile.update(ownerA, 1, { bio: 'stale write' }), (error) => error.status === 409 && error.code === 'STALE_PROFILE');
      await assert.rejects(profile.update(ownerA, 2, { handle: `p04later${suffix}` }), (error) => error.status === 409 && error.code === 'HANDLE_CHANGE_COOLDOWN' && /after \d{4}-\d\d-\d\dT/.test(error.safeDetail));
      await assert.rejects(profile.update(ownerB, 1, { handle: handles[2] }), (error) => error.status === 409 && error.code === 'HANDLE_TAKEN');
      await assert.rejects(profile.update(ownerB, 1, { handle: 'support' }), (error) => error.status === 422 && error.code === 'HANDLE_RESERVED');

      const origin = await app.getUrl();
      const redirect = await fetch(`${origin}/api/v1/users/${handles[0]}`, { redirect: 'manual' });
      assert.equal(redirect.status, 308);
      assert.equal(redirect.headers.get('location'), `/api/v1/users/${handles[2]}`);
      await pool.query("UPDATE handle_history SET redirect_expires_at=now()-interval '1 second' WHERE old_handle=$1", [handles[0]]);
      await assert.rejects(profile.update(ownerB, 1, { handle: handles[0] }), (error) => error.status === 409 && error.code === 'HANDLE_TAKEN');
    });

    await t.test('upload intent retries are free, expired keys can be reused, and the owner limit is ten per UTC hour', async () => {
      const key = `p04-${suffix}-idem`;
      const input = { purpose: 'avatar', filename: 'avatar.png', mime: 'image/png', sizeBytes: 32 };
      const first = await media.createIntent(ownerA, key, input);
      const replay = await media.createIntent(ownerA, key, input);
      assert.equal(replay.id, first.id);
      await pool.query("UPDATE idempotency_record SET expires_at=now()-interval '1 second' WHERE actor_key=$1 AND route='/uploads' AND key=$2", [ownerA, key]);
      const afterExpiry = await media.createIntent(ownerA, key, input);
      assert.notEqual(afterExpiry.id, first.id);

      for (let i = 0; i < 8; i++) await media.createIntent(ownerA, `p04-${suffix}-${i}`, input);
      await assert.rejects(media.createIntent(ownerA, `p04-${suffix}-over-limit`, input), (error) => error.status === 429 && error.code === 'UPLOAD_RATE_LIMIT');
      await assert.rejects(media.createIntent(ownerA, `p04-${suffix}-still-over-limit`, input), (error) => error.status === 429 && error.code === 'UPLOAD_RATE_LIMIT');
      const counter = await pool.query("SELECT counter FROM rate_limit_bucket WHERE principal_hash=$1 AND route='/uploads'", [createHash('sha256').update(ownerA).digest('hex')]);
      assert.equal(counter.rows[0].counter, 11);
    });

    await t.test('media metadata/content are owner-only until attached, then public only while attached', async () => {
      const mediaId = randomUUID();
      await pool.query(`INSERT INTO media(id,owner_user_id,purpose,version,quarantine_key,processed_key,dimensions,checksum,status,declared_mime,byte_size,created_at,updated_at)
        VALUES($1,$2,'avatar',1,'','${mediaId}/processed.webp','{"width":256,"height":256}'::jsonb,$3,'ready','image/png',32,now(),now())`, [mediaId, ownerA, createHash('sha256').update(readBytes).digest('hex')]);
      await assert.rejects(media.getMeta(ownerB, mediaId), (error) => error.status === 404);
      await assert.rejects(media.content(null, mediaId), (error) => error.status === 404);
      assert.equal((await media.getMeta(ownerA, mediaId)).status, 'ready');
      assert.deepEqual(await media.content(ownerA, mediaId), readBytes);

      await pool.query('UPDATE profile SET avatar_media_id=$2 WHERE user_id=$1', [ownerA, mediaId]);
      assert.equal((await media.getMeta(null, mediaId)).url, `/api/v1/media/${mediaId}/content`);
      assert.deepEqual(await media.content(null, mediaId), readBytes);
      const origin = await app.getUrl();
      const publicResponse = await fetch(`${origin}/api/v1/media/${mediaId}/content`);
      assert.equal(publicResponse.status, 200);
      assert.equal(publicResponse.headers.get('cache-control'), 'private, no-store');
      const ownerResponse = await fetch(`${origin}/api/v1/media/${mediaId}/content`, { headers: { cookie: 'p04-owner-a' } });
      assert.equal(ownerResponse.status, 200);
      assert.equal(ownerResponse.headers.get('cache-control'), 'private, no-store');

      // A hidden author profile suppresses public avatar metadata and bytes, even
      // when the media UUID is known. The owner keeps access to their own media.
      await pool.query('UPDATE profile SET moderation_hidden_at=now() WHERE user_id=$1', [ownerA]);
      await assert.rejects(media.getMeta(null, mediaId), (error) => error.status === 404);
      await assert.rejects(media.content(null, mediaId), (error) => error.status === 404);
      await assert.rejects(media.getMeta(ownerB, mediaId), (error) => error.status === 404);
      await assert.rejects(media.content(ownerB, mediaId), (error) => error.status === 404);
      assert.equal((await media.getMeta(ownerA, mediaId)).status, 'ready');
      assert.deepEqual(await media.content(ownerA, mediaId), readBytes);
      const hiddenPublicResponse = await fetch(`${origin}/api/v1/media/${mediaId}/content`);
      const hiddenOtherOwnerResponse = await fetch(`${origin}/api/v1/media/${mediaId}/content`, { headers: { cookie: 'p04-owner-b' } });
      const hiddenStaffResponse = await fetch(`${origin}/api/v1/media/${mediaId}/content`, { headers: { cookie: 'p04-staff' } });
      const hiddenOwnerResponse = await fetch(`${origin}/api/v1/media/${mediaId}/content`, { headers: { cookie: 'p04-owner-a' } });
      assert.equal(hiddenPublicResponse.status, 404);
      assert.equal(hiddenOtherOwnerResponse.status, 404);
      assert.equal(hiddenStaffResponse.status, 404);
      assert.equal(hiddenOwnerResponse.status, 200);

      await pool.query('UPDATE profile SET moderation_hidden_at=NULL WHERE user_id=$1', [ownerA]);
      assert.equal((await media.getMeta(null, mediaId)).status, 'ready');
      assert.deepEqual(await media.content(null, mediaId), readBytes);
      const restoredPublicResponse = await fetch(`${origin}/api/v1/media/${mediaId}/content`);
      assert.equal(restoredPublicResponse.status, 200);

      await pool.query('UPDATE profile SET avatar_media_id=NULL WHERE user_id=$1', [ownerA]);
      await assert.rejects(media.getMeta(null, mediaId), (error) => error.status === 404);
      await assert.rejects(media.content(null, mediaId), (error) => error.status === 404);
      assert.deepEqual(await media.content(ownerA, mediaId), readBytes);
    });
  } finally {
    if (app) await app.close();
    const userIds = [ownerA, ownerB];
    try {
      await pool.query('DELETE FROM outbox_event WHERE aggregate_type=\'media\' AND aggregate_id IN (SELECT id FROM media WHERE owner_user_id=ANY($1::uuid[]))', [userIds]);
      await pool.query('DELETE FROM outcome_snapshot WHERE position_id=ANY($1::uuid[])', [performanceIds.map(item => item.positionId)]);
      await pool.query('DELETE FROM position WHERE id=ANY($1::uuid[])', [performanceIds.map(item => item.positionId)]);
      await pool.query('DELETE FROM publication WHERE id=ANY($1::uuid[])', [performanceIds.map(item => item.publicationId)]);
      await pool.query('DELETE FROM handle_history WHERE user_id=ANY($1::uuid[])', [userIds]);
      await pool.query('DELETE FROM follow WHERE follower_user_id=ANY($1::uuid[]) OR target_user_id=ANY($1::uuid[])', [userIds]);
      await pool.query('DELETE FROM subscription_entitlement WHERE user_id=ANY($1::uuid[])', [userIds]);
      await pool.query('DELETE FROM idempotency_record WHERE actor_key=ANY($1::text[])', [userIds]);
      await pool.query('DELETE FROM rate_limit_bucket WHERE principal_hash=ANY($1::text[])', [userIds.map(id => createHash('sha256').update(id).digest('hex'))]);
      await pool.query('DELETE FROM profile WHERE user_id=ANY($1::uuid[])', [userIds]);
      await pool.query('DELETE FROM media WHERE owner_user_id=ANY($1::uuid[])', [userIds]);
      await pool.query('DELETE FROM user_account WHERE id=ANY($1::uuid[])', [userIds]);
    } finally { await pool.end(); }
  }
});
