import assert from 'node:assert/strict';
import test from 'node:test';
import { randomUUID } from 'node:crypto';
import pg from 'pg';

const databaseUrl = process.env.TEST_DATABASE_URL;
const integration = { skip: databaseUrl ? false : 'Set TEST_DATABASE_URL for immutable privacy-redaction PostgreSQL acceptance.' };

test('PostgreSQL immutable publication history rejects ordinary edits and permits only scoped nested personal-text redaction', integration, async () => {
  const pool = new pg.Pool({ connectionString: databaseUrl, max: 2, connectionTimeoutMillis: 3000, query_timeout: 15000 });
  const client = await pool.connect();
  const owner = randomUUID(), request = randomUUID(), publication = randomUUID(), version = randomUUID(), chart = randomUUID();
  try {
    await client.query('BEGIN');
    await client.query(`INSERT INTO user_account(id,oidc_issuer,oidc_subject,email,email_verified,status,created_at,updated_at)
      VALUES($1,$2,$3,$4,true,'active',now(),now())`, [owner, `https://p13-redaction.${owner}.invalid`, owner, `${owner}@example.invalid`]);
    await client.query(`INSERT INTO privacy_request(id,owner_user_id,type,status,requested_at,due_at,stage,progress,created_at,updated_at)
      VALUES($1,$2,'deletion','processing',now(),now(),'public_derivatives','{}'::jsonb,now(),now())`, [request, owner]);
    await client.query(`INSERT INTO publication(id,author_user_id,kind,visibility,created_at) VALUES($1,$2,'trade','public',now())`, [publication, owner]);
    await client.query(`INSERT INTO publication_version(id,publication_id,sequence,terms,thesis,chart,disclosures,created_at)
      VALUES($1,$2,1,$3::jsonb,'personal thesis','{"notes":"personal chart note"}'::jsonb,'{"author":"personal disclosure"}'::jsonb,now())`, [version, publication,
      JSON.stringify({ title: 'personal title', attachmentIds: ['private-media-id'], arbitrary: 'personal top-level text', plan: { asset: 'stock', strategy: 'long', quantity: 2, privateNote: 'nested personal text', legs: [{ side: 'long', quantity: 1, strike: '10', memo: 'private leg note' }], instrument: { asset: 'stock', symbol: 'XYZ', multiplier: '100', tickSize: '0.01', metadataVersion: 2, memo: 'private instrument note' } } })]);
    await client.query(`INSERT INTO chart_state(id,owner_user_id,publication_version_id,schema_version,state,provenance,revision,created_at)
      VALUES($1,NULL,$2,1,'{"annotations":["personal annotation"]}'::jsonb,'{"sourceNote":"personal provenance"}'::jsonb,1,now())`, [chart, version]);

    await client.query('SAVEPOINT immutable_version_check');
    await assert.rejects(client.query(`UPDATE publication_version SET thesis=NULL WHERE id=$1`, [version]), /immutable/);
    await client.query('ROLLBACK TO SAVEPOINT immutable_version_check');
    await client.query('SAVEPOINT immutable_chart_check');
    await assert.rejects(client.query(`UPDATE chart_state SET state='{}'::jsonb WHERE id=$1`, [chart]), /immutable/);
    await client.query('ROLLBACK TO SAVEPOINT immutable_chart_check');
    await client.query(`SELECT set_config('app.privacy_erasure_request',$1,true)`, [request]);
    await client.query(`UPDATE publication_version SET terms=privacy_redacted_publication_terms(terms),thesis=NULL,chart=NULL,disclosures='{}'::jsonb WHERE id=$1`, [version]);
    await client.query(`UPDATE chart_state SET state='{"redacted":"privacy_erasure"}'::jsonb,provenance='{"redacted":"privacy_erasure"}'::jsonb WHERE id=$1`, [chart]);
    const redacted = await client.query(`SELECT terms,thesis,chart,disclosures FROM publication_version WHERE id=$1`, [version]);
    assert.deepEqual(redacted.rows[0].terms, { title: 'Deleted member', plan: { asset: 'stock', strategy: 'long', quantity: 2, legs: [{ side: 'long', quantity: 1, strike: '10' }], instrument: { asset: 'stock', symbol: 'XYZ', multiplier: '100', tickSize: '0.01', metadataVersion: 2 } } });
    assert.equal(redacted.rows[0].thesis, null); assert.equal(redacted.rows[0].chart, null); assert.deepEqual(redacted.rows[0].disclosures, {});
    const redactedChart = await client.query(`SELECT state,provenance FROM chart_state WHERE id=$1`, [chart]);
    assert.deepEqual(redactedChart.rows[0].state, { redacted: 'privacy_erasure' });
    assert.deepEqual(redactedChart.rows[0].provenance, { redacted: 'privacy_erasure' });
    await client.query('ROLLBACK');
  } catch (error) {
    await client.query('ROLLBACK').catch(() => {});
    throw error;
  } finally {
    client.release(); await pool.end();
  }
});
