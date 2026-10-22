import assert from 'node:assert/strict';
import test from 'node:test';
import { randomUUID } from 'node:crypto';
import pg from 'pg';
import sharp from 'sharp';
import { processMediaJob, purgeExpiredUploads } from '../dist/media.js';

const databaseUrl = process.env.TEST_DATABASE_URL;
const integration = { skip: databaseUrl ? false : 'Set TEST_DATABASE_URL for worker/media PostgreSQL acceptance.' };

test('PostgreSQL row lock prevents duplicate workers and expiry purger deleting active output', integration, async () => {
  const pool = new pg.Pool({ connectionString: databaseUrl, max: 8, connectionTimeoutMillis: 3000, query_timeout: 15000 });
  pool.on('error', () => {});
  const userId = randomUUID();
  const mediaId = randomUUID();
  const raw = await sharp({ create: { width: 16, height: 12, channels: 3, background: '#446688' } }).png().toBuffer();
  const expiresAt = new Date(Date.now() + 500);
  let readStarted;
  const startedReading = new Promise(resolve => { readStarted = resolve; });
  let resumeRead;
  const blockedRead = new Promise(resolve => { resumeRead = resolve; });
  let reads = 0;
  const objects = new Map([[`${mediaId}/quarantine.bin`, raw]]);
  const storage = {
    readQuarantined: async id => { reads++; readStarted(); await blockedRead; return objects.get(`${id}/quarantine.bin`); },
    putProcessed: async (id, bytes) => { const key = `${id}/processed.webp`; objects.set(key, bytes); return key; },
    deleteObject: async key => { objects.delete(key); },
  };

  try {
    await pool.query(`INSERT INTO user_account(id,oidc_issuer,oidc_subject,email_verified,status,created_at,updated_at)
      VALUES($1,'https://p04.worker.integration.invalid',$2,true,'active',now(),now())`, [userId, mediaId]);
    await pool.query(`INSERT INTO media(id,owner_user_id,purpose,version,quarantine_key,processed_key,status,declared_mime,byte_size,expires_at,created_at,updated_at)
      VALUES($1,$2,'avatar',1,$3,NULL,'processing','image/png',$4,$5,now(),now())`, [mediaId, userId, `${mediaId}/quarantine.bin`, raw.byteLength, expiresAt]);

    const processing = processMediaJob(pool, storage, { mediaId });
    await startedReading;
    const duplicate = processMediaJob(pool, storage, { mediaId });
    while (Date.now() <= expiresAt.getTime()) await new Promise(resolve => setTimeout(resolve, 20));
    assert.equal(await purgeExpiredUploads(pool, storage), 0, 'SKIP LOCKED must leave a row held by an active worker alone');
    assert.equal(reads, 1, 'duplicate delivery waits for the owning row lock');
    resumeRead();
    await Promise.all([processing, duplicate]);

    const result = await pool.query('SELECT status,processed_key,expires_at FROM media WHERE id=$1', [mediaId]);
    assert.equal(result.rows[0].status, 'ready');
    assert.equal(result.rows[0].processed_key, `${mediaId}/processed.webp`);
    assert.equal(result.rows[0].expires_at, null);
    assert.equal(reads, 1);
    assert.ok(objects.has(`${mediaId}/processed.webp`));
  } finally {
    resumeRead?.();
    await pool.query('DELETE FROM media WHERE id=$1', [mediaId]).catch(() => {});
    await pool.query('DELETE FROM user_account WHERE id=$1', [userId]).catch(() => {});
    await pool.end();
  }
});
