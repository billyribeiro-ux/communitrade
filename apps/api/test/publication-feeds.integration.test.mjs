import assert from 'node:assert/strict';
import test from 'node:test';
import { randomUUID } from 'node:crypto';
import pg from 'pg';
import { PublicationService } from '../dist/publications/service.js';
import { InstrumentService } from '../dist/instruments/service.js';
import { createMarketDataRuntime } from '../dist/instruments/market-data-config.js';
import { DiscoveryService } from '../dist/discovery/service.js';
import { CommandError } from '../dist/http/problem.js';
import { cleanupP09Fixtures } from '../scripts/p09-fixture-cleanup.mjs';

const databaseUrl = process.env.TEST_DATABASE_URL;
const integration = { skip: databaseUrl ? false : 'Set TEST_DATABASE_URL for PostgreSQL publication feed acceptance.' };
const iso = value => new Date(value).toISOString();

test('PostgreSQL public feeds bind cursors, search public text, attribute reposts, and apply viewer follows/mutes', integration, async t => {
  const pool = new pg.Pool({ connectionString: databaseUrl, max: 4, connectionTimeoutMillis: 3000, query_timeout: 15000 });
  pool.on('error', () => {});
  const suffix = randomUUID();
  const authorId = randomUUID(), reposterId = randomUUID(), reposter2Id = randomUUID(), viewerId = randomUUID();
  const users = [authorId, reposterId, reposter2Id, viewerId];
  const capabilityIds = [];
  const discoveryShard = Number.parseInt(randomUUID()[0], 16);
  const fixtureUuid = () => `${discoveryShard.toString(16)}${randomUUID().slice(1)}`;
  const issuer = `https://p09.feed.${suffix}.invalid`;
  try {
    const stock = await pool.query(`SELECT i.id,m.version,i.vendor,i.vendor_id FROM instrument i JOIN instrument_metadata_version m ON m.instrument_id=i.id
      WHERE i.vendor='synthetic-fixture' AND i.asset='stock' AND m.version=(SELECT max(x.version) FROM instrument_metadata_version x WHERE x.instrument_id=i.id) ORDER BY i.id LIMIT 1`);
    assert.ok(stock.rows[0], 'seeded synthetic stock exists');
    const instrumentId = stock.rows[0].id, metadataVersion = Number(stock.rows[0].version);
    const future = await pool.query(`SELECT i.id,m.version,i.vendor_id,m.contract_month,m.contract_year FROM instrument i JOIN instrument_metadata_version m ON m.instrument_id=i.id
      WHERE i.vendor='synthetic-fixture' AND i.asset='future' AND m.version=(SELECT max(x.version) FROM instrument_metadata_version x WHERE x.instrument_id=i.id) AND m.contract_month IS NOT NULL ORDER BY i.id LIMIT 1`);
    assert.ok(future.rows[0], 'seeded synthetic future with a contract month exists');
    const publicFlags = { displayPublic: true, displayMember: false, retainBars: false, retainSnapshot: false, exportImage: false, exportPersonalRecord: false, newPublishing: false };
    const snapshotFlags = { displayPublic: false, displayMember: false, retainBars: false, retainSnapshot: true, exportImage: false, exportPersonalRecord: false, newPublishing: false };
    const exportFlags = { displayPublic: false, displayMember: false, retainBars: false, retainSnapshot: false, exportImage: false, exportPersonalRecord: false, newPublishing: false };
    for (const [purpose, flags] of [['display', publicFlags], ['snapshot', snapshotFlags], ['export', exportFlags]]) {
      const id = randomUUID(); capabilityIds.push(id);
      await pool.query(`INSERT INTO data_capability(id,supplier,agreement_id,dataset,audience,purpose,effective_at,flags)
        VALUES($1,$2,$3,'stock','public',$4,now(),$5::jsonb)`, [id, stock.rows[0].vendor, `p09-feed-${suffix}`, purpose, JSON.stringify(flags)]);
    }
    for (const [index, id] of users.entries()) {
      const handle = `feed${suffix.replaceAll('-', '').slice(index * 4, index * 4 + 10)}${index}`.slice(0, 30);
      await pool.query(`INSERT INTO user_account(id,oidc_issuer,oidc_subject,email,email_verified,status,onboarding_version,created_at,updated_at)
        VALUES($1,$2,$1::uuid::text,$3,true,'active','p09-integration',now(),now())`, [id, issuer, `${id}@example.invalid`]);
      await pool.query(`INSERT INTO profile(user_id,handle,normalized_handle,display_name,bio,revision,created_at,updated_at)
        VALUES($1,$2,$2,$3,$4,1,now(),now())`, [id, handle, index === 0 ? `QuasarSignal ${suffix.slice(0, 8)}` : `Feed tester ${index}`, `Public bio ${index}`]);
    }
    const makePublication = async (title, thesis, publishedAt, reference = { id: instrumentId, version: metadataVersion, asset: 'stock' }) => {
      const id = fixtureUuid(), versionId = randomUUID();
      const chart = { instrumentId: reference.id, metadataVersion: reference.version, interval: '1d', session: 'regular', adjustment: 'unadjusted', viewport: { from: '2026-10-01T00:00:00.000Z', to: '2026-10-20T00:00:00.000Z' }, provenance: { provider: stock.rows[0].vendor, asOf: '2026-10-20T00:00:00.000Z', delaySeconds: 900, demo: true }, drawings: [] };
      const terms = { title, slug: title.toLowerCase().replaceAll(' ', '-'), plan: { asset: reference.asset, strategy: 'long', instrumentId: reference.id } };
      await pool.query(`INSERT INTO publication(id,author_user_id,kind,original_version_id,current_version_id,visibility,published_at,created_at)
        VALUES($1,$2,'education',NULL,NULL,'private',NULL,now())`, [id, authorId]);
      await pool.query(`INSERT INTO publication_version(id,publication_id,sequence,previous_version_id,terms,thesis,chart,disclosures,created_at)
        VALUES($1,$2,1,NULL,$3::jsonb,$4,$5::jsonb,$6::jsonb,$7)`, [versionId, id, JSON.stringify(terms), thesis, JSON.stringify(chart), JSON.stringify({ referenceVersions: [] }), publishedAt]);
      await pool.query(`INSERT INTO chart_state(id,owner_user_id,draft_id,publication_version_id,schema_version,state,provenance,revision,created_at)
        VALUES($1,NULL,NULL,$2,1,$3::jsonb,$4::jsonb,1,now())`, [randomUUID(), versionId, JSON.stringify(chart), JSON.stringify(chart.provenance)]);
      await pool.query(`UPDATE publication SET visibility='public',published_at=$2,original_version_id=$3,current_version_id=$3 WHERE id=$1`, [id, publishedAt, versionId]);
      return { id, versionId };
    };
    const older = await makePublication(`Quasar calls ${suffix.slice(0, 8)}`, `Thesis describes the Nebula setup ${suffix.slice(0, 8)} with a planned risk boundary.`, iso(Date.now() - 60000));
    const newer = await makePublication(`Orion momentum ${suffix.slice(0, 8)}`, `A second public thesis for pagination ${suffix.slice(0, 8)}.`, iso(Date.now() - 30000));
    const futurePost = await makePublication(`Future month ${suffix.slice(0, 8)}`, `A futures contract-month reference ${suffix.slice(0, 8)}.`, iso(Date.now() - 20000), { id: future.rows[0].id, version: Number(future.rows[0].version), asset: 'future' });
    const precisionPost = await makePublication(`Precision cursor ${suffix.slice(0, 8)}`, `Precision cursor traversal ${suffix.slice(0, 8)}.`, '2026-10-20T12:00:00.123900Z');
    const precisionPost2 = await makePublication(`Precision cursor second ${suffix.slice(0, 8)}`, `Precision cursor second source ${suffix.slice(0, 8)}.`, '2026-10-20T12:00:00.123600Z');
    const repostId = randomUUID();
    await pool.query(`INSERT INTO repost(id,user_id,publication_id,commentary,active,created_at) VALUES($1,$2,$3,$4,true,now())`, [repostId, reposterId, older.id, 'Reposted with additional context.']);
    const precisionRepostId = randomUUID(), precisionRepost2Id = randomUUID();
    await pool.query(`INSERT INTO repost(id,user_id,publication_id,commentary,active,created_at) VALUES($1,$2,$3,'Precision repost A',true,'2026-10-20T12:00:00.123800Z'),($4,$5,$3,'Precision repost B',true,'2026-10-20T12:00:00.123700Z')`, [precisionRepostId, reposterId, precisionPost.id, precisionRepost2Id, reposter2Id]);
    const selectionId = randomUUID();
    await pool.query(`INSERT INTO editorial_selection(id,publication_id,selector_user_id,reason,active_from,active_until) VALUES($1,$2,$3,'Complete and useful context.',now()-interval '1 minute',NULL)`, [selectionId, newer.id, viewerId]);
    const followId = randomUUID();
    await pool.query('INSERT INTO follow(id,follower_user_id,target_user_id,instrument_id,created_at) VALUES($1,$2,$3,NULL,now())', [followId, viewerId, reposterId]);

    const market = await createMarketDataRuntime(pool, {});
    const service = new PublicationService(pool, new InstrumentService(pool, market.adapter, market.mode, market.configured));
    const discovery = new DiscoveryService(pool, service, new InstrumentService(pool, market.adapter, market.mode, market.configured));
    await t.test('a source hidden during reference hydration is excluded by the final page authorization',async()=>{
      const references=new InstrumentService(pool,market.adapter,market.mode,market.configured);let changed=false;
      const racing=new PublicationService(pool,{get:async(...args)=>{
        const reference=await references.get(...args);
        if(!changed){changed=true;await pool.query("UPDATE publication SET visibility='moderation_hidden' WHERE id=$1",[newer.id]);}
        return reference;
      }});
      try{
        const page=await racing.listPublications({q:`Orion momentum ${suffix.slice(0,8)}`});
        assert.equal(changed,true);assert.ok(!page.items.some(item=>item.id===newer.id));
      }finally{await pool.query("UPDATE publication SET visibility='public' WHERE id=$1",[newer.id]);}
      assert.ok((await service.listPublications({q:`Orion momentum ${suffix.slice(0,8)}`})).items.some(item=>item.id===newer.id));
    });
    await t.test('Discover searches title, thesis, and author full text; cursor is filter-bound', async () => {
      const byThesis = await service.listPublications({ q: `Nebula ${suffix.slice(0, 8)}` }, undefined);
      assert.ok(byThesis.items.some(item => item.id === older.id));
      const byAuthor = await service.listPublications({ q: `QuasarSignal ${suffix.slice(0, 8)}` }, undefined);
      assert.ok(byAuthor.items.some(item => item.id === older.id));
      const page = await service.listPublications({ limit: 1 }, undefined);
      assert.equal(page.items.length, 1);
      assert.ok(page.nextCursor);
      await assert.rejects(() => service.listPublications({ limit: 1, author: 'different_handle', cursor: page.nextCursor }), error => error instanceof CommandError && error.status === 400 && error.code === 'INVALID_CURSOR');
    });
    await t.test('Newest cursor preserves PostgreSQL microseconds across originals and reposts', async () => {
      let cursor;
      const visited = [];
      for (let pageNumber = 0; pageNumber < 8; pageNumber++) {
        const page = await service.listPublications({ q: `Precision cursor ${suffix.slice(0, 8)}`, limit: 1, ...(cursor ? { cursor } : {}) }, undefined);
        if (!page.items.length) break;
        assert.equal(page.items.length, 1);
        const item = page.items[0];
        visited.push(`${item.id}:${item.repost?.id ?? 'original'}`);
        cursor = page.nextCursor;
        if (!cursor) break;
      }
      assert.deepEqual(visited, [
        `${precisionPost.id}:original`,
        `${precisionPost.id}:${precisionRepostId}`,
        `${precisionPost.id}:${precisionRepost2Id}`,
        `${precisionPost2.id}:original`,
      ]);
      assert.equal(new Set(visited).size, visited.length, 'no entry appears twice');
    });
    await t.test('Following includes a followed reposter derivative and muting either source hides the derivative', async () => {
      const following = await service.listPublications({ feed: 'following', q: `Nebula ${suffix.slice(0, 8)}` }, viewerId);
      assert.equal(following.items.length, 1);
      assert.equal(following.items[0].id, older.id);
      assert.equal(following.items[0].instrument.id, instrumentId);
      assert.equal(following.items[0].instrument.symbol, stock.rows[0].vendor_id);
      assert.equal(following.items[0].repost.id, repostId);
      assert.equal(following.items[0].repost.author.id, reposterId);
      const muteId = randomUUID();
      await pool.query('INSERT INTO mute(id,user_id,author_id,created_at) VALUES($1,$2,$3,now())', [muteId, viewerId, reposterId]);
      const mutedReposter = await service.listPublications({ feed: 'discover' }, viewerId);
      assert.ok(mutedReposter.items.some(item => item.id === older.id && !item.repost));
      assert.ok(!mutedReposter.items.some(item => item.repost?.id === repostId));
      await pool.query('DELETE FROM mute WHERE id=$1', [muteId]);
      const sourceMute = randomUUID();
      await pool.query('INSERT INTO mute(id,user_id,author_id,created_at) VALUES($1,$2,$3,now())', [sourceMute, viewerId, authorId]);
      const mutedSource = await service.listPublications({ feed: 'discover' }, viewerId);
      assert.ok(!mutedSource.items.some(item => item.id === older.id));
    });
    await t.test('Editorial returns only active selections and source authorization uses the caller transaction', async () => {
      const editorial = await service.listPublications({ feed: 'editorial' }, undefined);
      assert.deepEqual(editorial.items.map(item => item.id), [newer.id]);
      const client = await pool.connect();
      try {
        await client.query('BEGIN');
        const source = await service.assertPublicInteractionSource(older.id, { query: (sql, values) => client.query(sql, values) });
        assert.equal(source.authorId, authorId);
        assert.equal(source.currentVersionId, older.versionId);
        await client.query('ROLLBACK');
      } finally { client.release(); }
    });
    await t.test('Share metadata uses the configured canonical origin and withholds unauthorized image exports', async () => {
      const metadata = await service.getShareMetadata(older.id, 'https://ideas.example.invalid');
      assert.equal(metadata.canonicalUrl, `https://ideas.example.invalid/ideas/${older.id}/quasar-calls-${suffix.slice(0, 8)}`);
      assert.equal(metadata.imageAllowed, false);
      assert.equal(metadata.imageUrl, null);
      assert.equal(metadata.versionId, older.versionId);
    });
    await t.test('Feed cards carry the frozen actual futures reference and contract month', async () => {
      const result = await service.listPublications({ q: `Future month ${suffix.slice(0, 8)}` }, undefined);
      const card = result.items.find(item => item.id === futurePost.id);
      assert.ok(card);
      assert.equal(card.instrument.id, future.rows[0].id);
      assert.equal(card.instrument.asset, 'future');
      assert.equal(card.instrument.symbol, future.rows[0].vendor_id);
      assert.equal(card.instrument.contractMonth, `${future.rows[0].contract_year}-${String(future.rows[0].contract_month).padStart(2, '0')}`);
    });
    await t.test('Sitemap discovery rechecks live visibility and data rights; cursors are shard-bound', async () => {
      const page = await discovery.list({ shard: discoveryShard, limit: 200 });
      assert.ok(page.items.some(item => item.path.startsWith(`/ideas/${newer.id}/`)));
      assert.ok(page.items.some(item => item.path.startsWith(`/ideas/${older.id}/`)));
      const firstPage = await discovery.list({ shard: discoveryShard, limit: 1 });
      assert.ok(firstPage.nextCursor, 'two same-shard public ideas require a continuation');
      await assert.rejects(() => discovery.list({ shard: (discoveryShard + 1) % 16, limit: 1, cursor: firstPage.nextCursor }), error => error instanceof CommandError && error.status === 400 && error.code === 'INVALID_CURSOR');
      await pool.query("UPDATE publication SET visibility='private' WHERE id=$1", [older.id]);
      const hidden = await discovery.list({ shard: discoveryShard, limit: 200 });
      assert.ok(!hidden.items.some(item => item.path.startsWith(`/ideas/${older.id}/`)), 'hidden source is removed from sitemap discovery');
      await assert.rejects(() => service.assertPublicInteractionSource(older.id, pool), error => error instanceof CommandError && error.status === 404);
      const denyId = randomUUID(); capabilityIds.push(denyId);
      await pool.query(`INSERT INTO data_capability(id,supplier,agreement_id,dataset,audience,purpose,effective_at,flags)
        VALUES($1,$2,$3,'stock','public','display',clock_timestamp(),$4::jsonb)`, [denyId, stock.rows[0].vendor, `p09-feed-deny-${suffix}`, JSON.stringify({ displayPublic: false, displayMember: false, retainBars: false, retainSnapshot: false, exportImage: false, exportPersonalRecord: false, newPublishing: false })]);
      const denied = await discovery.list({ shard: discoveryShard, limit: 200 });
      assert.ok(!denied.items.some(item => item.path.startsWith(`/ideas/${newer.id}/`)), 'revoked public display rights remove discovery entries');
      const deniedFeed=await service.listPublications({q:`Orion momentum ${suffix.slice(0,8)}`});
      assert.ok(!deniedFeed.items.some(item=>item.id===newer.id),'request-local reference reuse must not cache permission across requests');
    });
  } finally {
    try {
      await pool.query('DELETE FROM data_capability WHERE id=ANY($1::uuid[])', [capabilityIds]);
      await cleanupP09Fixtures(pool, users);
    } finally { await pool.end(); }
  }
});
