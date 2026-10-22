import assert from 'node:assert/strict';
import test from 'node:test';
import { createHash, randomUUID } from 'node:crypto';
import pg from 'pg';
import { createApp } from '../dist/app.js';
import { DraftService } from '../dist/drafts/service.js';
import { InstrumentService } from '../dist/instruments/service.js';
import { createMarketDataRuntime } from '../dist/instruments/market-data-config.js';
import { PublicationService } from '../dist/publications/service.js';
import { PositionService } from '../dist/positions/service.js';
import { CorrectionService } from '../dist/corrections/service.js';
import { MediaService } from '../dist/media/service.js';
import { CommandError } from '../dist/http/problem.js';
import { cleanupP08Fixtures } from '../scripts/p08-fixture-cleanup.mjs';

const databaseUrl = process.env.TEST_DATABASE_URL;
const integration = { skip: databaseUrl ? false : 'Set TEST_DATABASE_URL for PostgreSQL publication acceptance.' };
const stockId = '00000000-0000-4000-8000-000000000201';
const futureId = '00000000-0000-4000-8000-000000000202';
const contracts = {
  call100: '00000000-0000-4000-8000-000000000221',
  call105: '00000000-0000-4000-8000-000000000222',
  put100: '00000000-0000-4000-8000-000000000223',
  put105: '00000000-0000-4000-8000-000000000224',
};
const iso = value => new Date(value).toISOString();

test('PostgreSQL publication acceptance freezes validated candidates and commits visibility only after snapshot success', integration, async t => {
  const pool = new pg.Pool({ connectionString: databaseUrl, max: 8, connectionTimeoutMillis: 3000, query_timeout: 15000 });
  pool.on('error', () => {});
  const suffix = randomUUID();
  const owner = randomUUID(), otherOwner = randomUUID(), attachmentOwner = randomUUID(), completionOwner = randomUUID(), rightsOwner = randomUUID(), quotaOwner = randomUUID();
  const userIds = [owner, otherOwner, attachmentOwner, completionOwner, rightsOwner, quotaOwner];
  const draftIds = [], jobIds = [], publicationIds = [], mediaIds = [];
  const capabilityIds = [];
  const idemKeys = [];
  const issuer = `https://p08.publications.${suffix}.invalid`;
  const owners = new Map([['owner', owner], ['other', otherOwner], ['attachments', attachmentOwner], ['complete', completionOwner], ['rights', rightsOwner], ['quota', quotaOwner]]);
  const auth = {
    authenticate: async req => {
      const token = String(req.headers.cookie ?? '').split(';').map(x => x.trim()).find(x => x.startsWith('p08sid='))?.slice(7);
      const userId = owners.get(token);
      if (!userId) throw new CommandError(401, 'AUTHENTICATION_REQUIRED');
      return { userId, sessionId: `session-${token}`, status: 'active', roles: token === 'other' ? ['admin'] : [], emailVerified: true, onboarded: true, csrfToken: 'p08-csrf' };
    },
    assertCsrf: async req => {
      if (req.headers.origin !== 'http://127.0.0.1' || req.headers['x-csrf-token'] !== 'p08-csrf') throw new CommandError(403, 'CSRF_REJECTED');
    },
    optionalActor: async () => null,
    assertPublicRead: async () => {},
  };
  let app;
  try {
    for (const id of userIds) {
      const handle = `pub${id.replaceAll('-', '').slice(0, 12)}`;
      await pool.query(`INSERT INTO user_account(id,oidc_issuer,oidc_subject,email,email_verified,status,onboarding_version,created_at,updated_at)
        VALUES($1::uuid,$2,$1::text,$3,true,'active','p08-integration',now(),now())`, [id, issuer, `${id}@example.invalid`]);
      await pool.query(`INSERT INTO profile(user_id,handle,normalized_handle,display_name,revision,created_at,updated_at)
        VALUES($1,$2,$2,$3,1,now(),now())`, [id, handle, `Publication tester ${handle}`]);
    }
    const market = await createMarketDataRuntime(pool, {});
    const instruments = new InstrumentService(pool, market.adapter, market.mode, market.configured);
    const drafts = new DraftService(pool, market.adapter);
    const publications = new PublicationService(pool, instruments);
    app = await createApp({ $queryRaw: async () => [] }, null, { auth, drafts, publications, media: new MediaService(pool, {}) });
    await app.listen(0, '127.0.0.1');
    const base = `${await app.getUrl()}/api/v1`;
    async function request(path, { actor = 'owner', method = 'GET', body, headers = {} } = {}, expected = 200) {
      const h = new Headers(headers);
      h.set('Cookie', `p08sid=${actor}`);
      if (body !== undefined) h.set('Content-Type', 'application/json');
      if (['POST', 'PUT', 'PATCH', 'DELETE'].includes(method)) { h.set('Origin', 'http://127.0.0.1'); h.set('X-CSRF-Token', 'p08-csrf'); }
      const response = await fetch(`${base}${path}`, { method, headers: h, ...(body === undefined ? {} : { body: JSON.stringify(body) }), signal: AbortSignal.timeout(15000) });
      const text = await response.text();
      if (expected !== null) assert.equal(response.status, expected, `${method} ${path}: ${text.slice(0, 500)}`);
      return { response, body: text ? JSON.parse(text) : null };
    }

    const start = Date.now() - 7 * 86400000;
    const end = Date.now() - 60000;
    const stateFor = async (instrumentId, asset) => {
      const { rows } = await pool.query(`SELECT m.version,i.vendor FROM instrument i JOIN instrument_metadata_version m ON m.instrument_id=i.id
        WHERE i.id=$1 AND m.version=(SELECT max(v.version) FROM instrument_metadata_version v WHERE v.instrument_id=i.id)`, [instrumentId]);
      assert.ok(rows[0], `fixture metadata exists for ${instrumentId}`);
      return { schemaVersion: 1, instrumentId, metadataVersion: Number(rows[0].version), interval: '1d', timezone: asset === 'future' ? 'America/Chicago' : 'America/New_York', session: asset === 'future' ? 'exchange' : 'regular', adjustment: 'unadjusted',
        viewport: { from: iso(start), to: iso(end) }, indicators: [],
        provenance: { provider: rows[0].vendor, asOf: iso(end), delaySeconds: 900, demo: true }, drawings: [] };
    };
    const baseTerms = () => ({ entryFrom: iso(Date.now() - 86400000), entryUntil: iso(Date.now() + 86400000), entryCondition: 'Enter after a confirmed move through the planned level.', timeframe: 'swing', exitRules: 'Exit at the stop or target; review at the end of the session.', conflicts: 'None known.', quantity: 1 });
    const leg = (instrumentId, side) => ({ instrumentId, side, quantity: 1 });
    const planFor = (strategy, instrumentId, legs = [], asset = 'option') => ({ ...baseTerms(), asset, strategy, instrumentId, legs,
      priceKind: asset === 'future' ? 'futures' : asset === 'stock' ? 'underlying' : ['bull_call_debit', 'bear_put_debit'].includes(strategy) ? 'spread_debit' : ['bull_put_credit', 'bear_call_credit'].includes(strategy) ? 'spread_credit' : 'option_premium',
      entryPrice: asset === 'future' ? '6000' : asset === 'stock' ? '100' : '1.50',
      ...(asset === 'future' ? { initialStopPrice: '5999' } : asset === 'stock' ? { initialStopPrice: strategy === 'short' ? '101' : '99' } : {}) });
    async function makeDraft({ actorId = owner, ownerToken = 'owner', kind = 'trade', asset = 'stock', strategy = 'long', legs = [], attachments = [], planOverride } = {}) {
      const draftId = randomUUID(); draftIds.push(draftId);
      const instrumentId = asset === 'future' ? futureId : stockId;
      const plan = kind === 'education' ? { asset: 'stock', instrumentId: stockId } : planOverride ?? planFor(strategy, instrumentId, legs, asset);
      const chart = await stateFor(instrumentId, asset);
      await pool.query(`INSERT INTO draft(id,owner_user_id,kind,title,thesis,plan,attachment_ids,revision,chart_revision,created_at,updated_at)
        VALUES($1,$2,$3,$4,$5,$6::jsonb,$7::jsonb,1,1,now(),now())`, [draftId, actorId, kind, `P08 ${strategy} candidate`, 'This is a member-reported test thesis describing the setup and its relevant risk.', JSON.stringify(plan), JSON.stringify(attachments)]);
      await pool.query(`INSERT INTO chart_state(id,owner_user_id,draft_id,schema_version,state,provenance,revision,created_at)
        VALUES($1,$2,$3,1,$4::jsonb,$5::jsonb,1,now())`, [randomUUID(), actorId, draftId, JSON.stringify(chart), JSON.stringify(chart.provenance)]);
      return { id: draftId, actor: ownerToken };
    }
    async function publish(draft, actor = draft.actor, key = `${suffix}-${randomUUID()}`, expectedStatus = 202) {
      idemKeys.push(key);
      const result = await request(`/drafts/${draft.id}/publish`, { actor, method: 'POST', headers: { 'If-Match': '"1"', 'Idempotency-Key': key }, body: { draftRevision: 1, chartRevision: 1 } }, expectedStatus);
      if (result.body?.id) jobIds.push(result.body.id);
      return result;
    }

    await t.test('all supported trade families plus education validate and freeze private candidates', async () => {
      const memberDisplayId = randomUUID(); capabilityIds.push(memberDisplayId);
      await pool.query(`INSERT INTO data_capability(id,supplier,agreement_id,dataset,audience,purpose,effective_at,flags)
        VALUES($1,'synthetic-fixture',$2,'stock','member','display',now(),$3::jsonb)`, [memberDisplayId, `p08-member-display-${suffix}`, JSON.stringify({ displayPublic: false, displayMember: true, retainBars: false, retainSnapshot: false, exportImage: false, exportPersonalRecord: false, newPublishing: false })]);
      const cases = [
        ['stock long', 'trade', 'stock', 'long', []],
        ['stock short', 'trade', 'stock', 'short', []],
        ['long call', 'trade', 'option', 'long_call', [leg(contracts.call100, 'buy')]],
        ['long put', 'trade', 'option', 'long_put', [leg(contracts.put100, 'buy')]],
        ['bull call debit', 'trade', 'option', 'bull_call_debit', [leg(contracts.call100, 'buy'), leg(contracts.call105, 'sell')]],
        ['bear put debit', 'trade', 'option', 'bear_put_debit', [leg(contracts.put105, 'buy'), leg(contracts.put100, 'sell')]],
        ['bull put credit', 'trade', 'option', 'bull_put_credit', [leg(contracts.put105, 'sell'), leg(contracts.put100, 'buy')]],
        ['bear call credit', 'trade', 'option', 'bear_call_credit', [leg(contracts.call100, 'sell'), leg(contracts.call105, 'buy')]],
        ['dated future', 'trade', 'future', 'long', []],
        ['education', 'education', 'stock', 'education', []],
      ];
      const publishedStock = await makeDraft();
      const duplicateKey = `${suffix}-duplicate-publish`; idemKeys.push(duplicateKey);
      const [first, replay] = await Promise.all([
        publish(publishedStock, 'owner', duplicateKey),
        publish(publishedStock, 'owner', duplicateKey),
      ]);
      assert.deepEqual(first.body, replay.body, 'concurrent same-key publish returns one job');
      const sourceJob = (await pool.query('SELECT publication_id,publication_version_id,candidate,status FROM publication_job WHERE id=$1', [first.body.id])).rows[0];
      assert.equal(sourceJob.status, 'pending');
      assert.equal(sourceJob.candidate.plan.strategy, 'long');
      assert.equal(sourceJob.candidate.series.capabilities.displayMember, true);
      assert.equal(sourceJob.candidate.series.capabilities.displayPublic, true, 'renderer capabilities come from the independent public audience grant');
      const hidden = await request(`/publications/${sourceJob.publication_id}`, { actor: 'other' }, 404);
      assert.equal(hidden.body.code, 'PUBLICATION_NOT_FOUND', 'admins do not bypass unpublished owner isolation');

      for (const [name, kind, asset, strategy, legs] of cases.slice(1)) {
        const draft = await makeDraft({ kind, asset, strategy, legs });
        const result = await publish(draft);
        assert.equal(result.body.status, 'pending', `${name} queued for trusted capture`);
        const job = (await pool.query('SELECT status,candidate,publication_id FROM publication_job WHERE id=$1', [result.body.id])).rows[0];
        assert.equal(job.status, 'pending');
        assert.equal(job.candidate.kind, kind);
        assert.equal(job.candidate.series.asset, asset === 'option' ? 'stock' : asset, 'option chart uses its stock underlying');
        assert.equal(job.candidate.series.adjustment, 'unadjusted');
        assert.equal(job.candidate.disclosures.providerVerified, false);
        const publication = (await pool.query('SELECT visibility,published_at FROM publication WHERE id=$1', [job.publication_id])).rows[0];
        assert.equal(publication.visibility, 'private', `${name} remains private until worker success`);
        publicationIds.push(job.publication_id);
      }
      publicationIds.push(sourceJob.publication_id);
      await pool.query('DELETE FROM data_capability WHERE id=$1', [memberDisplayId]);
    });

    await t.test('worker failure keeps publication private and unlocks draft without losing real processed attachments', async () => {
      const draft = await makeDraft({ actorId: attachmentOwner, ownerToken: 'attachments' });
      const attachmentId = randomUUID(); mediaIds.push(attachmentId);
      const checksum = createHash('sha256').update(`attachment-${suffix}`).digest('hex');
      await pool.query(`INSERT INTO media(id,owner_user_id,purpose,resource_id,resource_type,version,quarantine_key,processed_key,dimensions,checksum,status,declared_mime,created_at,updated_at)
        VALUES($1,$2,'publication_attachment',$3,'draft',1,'quarantine/test',$4,'{"width":640,"height":480}'::jsonb,$5,'ready','image/webp',now(),now())`, [attachmentId, attachmentOwner, draft.id, `fixtures/${attachmentId}.webp`, checksum]);
      await pool.query('UPDATE draft SET attachment_ids=$2::jsonb WHERE id=$1', [draft.id, JSON.stringify([attachmentId])]);
      const queued = await publish(draft);
      const row = (await pool.query('SELECT render_nonce,publication_version_id FROM publication_job WHERE id=$1', [queued.body.id])).rows[0];
      const expiry = iso(Date.now() + 90000);
      await pool.query("UPDATE publication_job SET status='running',render_nonce_expires_at=$2,attempts=1 WHERE id=$1", [queued.body.id, expiry]);
      const failed = await publications.failPublicationSnapshot(queued.body.id, 'BROWSER_CAPTURE_FAILED', false, { jobId: queued.body.id, publicationVersionId: row.publication_version_id, nonce: row.render_nonce, expiresAt: expiry });
      assert.equal(failed.status, 'failed');
      const attachment = (await pool.query('SELECT resource_type,resource_id,status,processed_key FROM media WHERE id=$1', [attachmentId])).rows[0];
      assert.equal(attachment.resource_type, 'draft'); assert.equal(attachment.resource_id, draft.id); assert.equal(attachment.status, 'ready');
      assert.equal(attachment.processed_key, `fixtures/${attachmentId}.webp`);
      const currentDraft = (await pool.query('SELECT plan,attachment_ids FROM draft WHERE id=$1', [draft.id])).rows[0];
      assert.equal(currentDraft.plan.locked, undefined); assert.deepEqual(currentDraft.attachment_ids, [attachmentId]);
      const draftDto = await request(`/drafts/${draft.id}`, { actor: 'attachments' });
      assert.equal(draftDto.body.publicationStatus, 'failed');
      assert.equal(draftDto.body.publicationJobId, queued.body.id);
      assert.equal(draftDto.body.publicationId, null);
      assert.equal(draftDto.body.plan.locked, undefined);
      assert.equal(draftDto.body.plan.published, undefined);
      const job = (await pool.query('SELECT publication_id FROM publication_job WHERE id=$1', [queued.body.id])).rows[0];
      publicationIds.push(job.publication_id);
      assert.equal((await pool.query('SELECT visibility FROM publication WHERE id=$1', [job.publication_id])).rows[0].visibility, 'private');
    });

    await t.test('completion atomically publishes an immutable chart snapshot and creates the position', async () => {
      const draft = await makeDraft({ actorId: completionOwner, ownerToken: 'complete' });
      const queued = await publish(draft);
      const job = (await pool.query('SELECT render_nonce,publication_version_id,publication_id FROM publication_job WHERE id=$1', [queued.body.id])).rows[0];
      const expiry = iso(Date.now() + 90000);
      await pool.query("UPDATE publication_job SET status='running',render_nonce_expires_at=$2,attempts=1,render_claimed_at=now() WHERE id=$1", [queued.body.id, expiry]);
      const checksum = createHash('sha256').update(`snapshot-${queued.body.id}`).digest('hex');
      const completed = await publications.completePublicationSnapshot(queued.body.id, { objectKey: `${job.publication_version_id}/processed.webp`, checksum, width: 1200, height: 760, mime: 'image/webp' }, { jobId: queued.body.id, publicationVersionId: job.publication_version_id, nonce: job.render_nonce, expiresAt: expiry });
      assert.equal(completed.completed, true); assert.ok(completed.positionId);
      publicationIds.push(job.publication_id);
      const publication = await request(`/publications/${job.publication_id}`);
      assert.equal(publication.body.id, job.publication_id);
      assert.equal(publication.body.evidence, 'member_reported');
      assert.equal(publication.body.positionId, completed.positionId);
      assert.equal(publication.body.thumbnailUrl, `/api/v1/media/${job.publication_version_id}/content`);
      assert.deepEqual(publication.body.referenceVersions, [{ instrumentId: stockId, metadataVersion: publication.body.chart.metadataVersion }]);
      assert.equal(Object.hasOwn(publication.body.referenceVersions[0], 'metadataVersionId'), false, 'public DTO omits provider/internal metadata identifiers');
      const draftDto = await request(`/drafts/${draft.id}`, { actor: 'complete' });
      assert.equal(draftDto.body.publicationStatus, 'published');
      assert.equal(draftDto.body.publicationJobId, queued.body.id);
      assert.equal(draftDto.body.publicationId, job.publication_id);
      assert.equal(draftDto.body.plan.locked, undefined);
      assert.equal(draftDto.body.plan.published, undefined);
      const exportDenyId = randomUUID(); capabilityIds.push(exportDenyId);
      await pool.query(`INSERT INTO data_capability(id,supplier,agreement_id,dataset,audience,purpose,effective_at,flags)
        VALUES($1,'synthetic-fixture',$2,'stock','public','export',now(),$3::jsonb)`, [exportDenyId, `p08-export-deny-${suffix}`, JSON.stringify({ displayPublic: true, displayMember: false, retainBars: false, retainSnapshot: false, exportImage: false, exportPersonalRecord: false, newPublishing: false })]);
      const exported = await request(`/publications/${job.publication_id}/share/image?versionId=${job.publication_version_id}`, {}, 403);
      assert.equal(exported.body.code, 'DATA_EXPORT_NOT_LICENSED', 'public viewing does not imply data export permission');
      await pool.query('DELETE FROM data_capability WHERE id=$1', [exportDenyId]);
      const snapshot = (await pool.query("SELECT purpose,resource_type,resource_id,status,checksum FROM media WHERE id=$1", [job.publication_version_id])).rows[0];
      assert.deepEqual(snapshot, { purpose: 'chart_snapshot', resource_type: 'publication', resource_id: job.publication_id, status: 'ready', checksum });
      const position = (await pool.query('SELECT risk_source_version_id,initial_risk FROM position WHERE id=$1', [completed.positionId])).rows[0];
      assert.equal(position.risk_source_version_id, job.publication_version_id);
      assert.ok(Number(position.initial_risk) > 0);
      const pendingVersionId = randomUUID(), pendingJobId = randomUUID(); jobIds.push(pendingJobId);
      const currentVersion = (await pool.query('SELECT terms,thesis,chart,disclosures FROM publication_version WHERE id=$1', [job.publication_version_id])).rows[0];
      const pendingTerms = { ...currentVersion.terms, title: 'Unpublished structured correction secret' };
      await pool.query(`INSERT INTO publication_version(id,publication_id,sequence,previous_version_id,terms,thesis,chart,disclosures,created_at)
        VALUES($1,$2,2,$3,$4::jsonb,$5,$6::jsonb,$7::jsonb,now())`, [pendingVersionId, job.publication_id, job.publication_version_id, JSON.stringify(pendingTerms), currentVersion.thesis, JSON.stringify(currentVersion.chart), JSON.stringify(currentVersion.disclosures)]);
      await pool.query(`INSERT INTO chart_state(id,publication_version_id,schema_version,state,provenance,revision,created_at)
        VALUES($1,$2,1,$3::jsonb,$4::jsonb,1,now())`, [randomUUID(), pendingVersionId, JSON.stringify(currentVersion.chart), JSON.stringify(currentVersion.chart.provenance)]);
      await pool.query(`INSERT INTO publication_job(id,owner_user_id,draft_id,publication_id,publication_version_id,status,candidate,render_nonce,render_nonce_expires_at,created_at,updated_at)
        VALUES($1,$2,$3,$4,$5,'pending','{}'::jsonb,$6,now()+interval '2 minutes',now(),now())`, [pendingJobId, completionOwner, draft.id, job.publication_id, pendingVersionId, randomUUID()]);
      await request(`/publications/${job.publication_id}/versions/${pendingVersionId}`, {}, 404);
      const history = await request(`/publications/${job.publication_id}/revisions`);
      assert.deepEqual(history.body.items.map(item => item.versionId), [job.publication_version_id], 'pending correction candidates are not public history');
      const search = await request(`/publications?q=unpublished%20structured%20correction%20secret`);
      assert.equal(search.body.items.some(item => item.title === pendingTerms.title), false, 'pending correction terms cannot appear in discovery');
    });

    await t.test('event-only history corrections preserve source data when an option is no longer publishable', async () => {
      const draft = await makeDraft({ actorId: completionOwner, ownerToken: 'complete', asset: 'option', strategy: 'long_call', legs: [leg(contracts.call100, 'buy')] });
      const queued = await publish(draft);
      const source = (await pool.query('SELECT render_nonce,publication_version_id,publication_id,candidate FROM publication_job WHERE id=$1', [queued.body.id])).rows[0];
      const expiry = iso(Date.now() + 90000);
      await pool.query("UPDATE publication_job SET status='running',render_nonce_expires_at=$2,attempts=1,render_claimed_at=now() WHERE id=$1", [queued.body.id, expiry]);
      const checksum = createHash('sha256').update(`option-source-${queued.body.id}`).digest('hex');
      await publications.completePublicationSnapshot(queued.body.id, { objectKey: `${source.publication_version_id}/processed.webp`, checksum, width: 1200, height: 760, mime: 'image/webp' }, { jobId: queued.body.id, publicationVersionId: source.publication_version_id, nonce: source.render_nonce, expiresAt: expiry });
      publicationIds.push(source.publication_id);

      // A failed immutable candidate can reserve a sequence above the current
      // pointer. Text-only revisions must allocate after it, and event-only
      // corrections must find the nearest rendered ancestor after that revision.
      const initialVersion = (await pool.query('SELECT terms,thesis,chart,disclosures FROM publication_version WHERE id=$1', [source.publication_version_id])).rows[0];
      const failedVersionId = randomUUID();
      const failedTerms = { ...initialVersion.terms, title: 'Failed immutable candidate' };
      await pool.query(`INSERT INTO publication_version(id,publication_id,sequence,previous_version_id,terms,thesis,chart,disclosures,created_at)
        VALUES($1,$2,2,$3,$4::jsonb,$5,$6::jsonb,$7::jsonb,now())`, [failedVersionId, source.publication_id, source.publication_version_id, JSON.stringify(failedTerms), initialVersion.thesis, JSON.stringify(initialVersion.chart), JSON.stringify(initialVersion.disclosures)]);
      const correctionService = new CorrectionService(pool, new PositionService(pool));
      const textCorrection = await correctionService.request(completionOwner, source.publication_id, `${suffix}-text-after-failed`, {
        reason: 'Clarify the title after review.', replacementTitle: 'Current corrected option title', replacementThesis: 'This corrected thesis is the current author-approved explanation for the option setup and its risks.',
      });
      assert.equal(textCorrection.status, 'approved');
      const textVersion = (await pool.query('SELECT id,sequence,terms,thesis,chart,disclosures FROM publication_version WHERE publication_id=$1 AND id=(SELECT current_version_id FROM publication WHERE id=$1)', [source.publication_id])).rows[0];
      assert.equal(Number(textVersion.sequence), 3, 'text correction allocates after a failed immutable sequence');
      assert.equal(textVersion.terms.title, 'Current corrected option title');
      assert.equal(textVersion.thesis, 'This corrected thesis is the current author-approved explanation for the option setup and its risks.');

      const originalGet = instruments.get.bind(instruments);
      let optionPublishabilityChecks=0;
      instruments.get = async (id, version, audience, queryable) => {
        if (id === contracts.call100 && audience === 'member') {
          optionPublishabilityChecks++;
          throw new CommandError(403,'DATA_NOT_LICENSED_FOR_PUBLISHING','Expired option metadata is no longer eligible for new publishing.');
        }
        return originalGet(id,version,audience,queryable);
      };
      try {
        const client = await pool.connect(); let correction;
        try {
          await client.query('BEGIN');
          correction = await publications.queueCorrectionSnapshot(client, { publicationId: source.publication_id, ownerUserId: completionOwner, sourceVersionId: textVersion.id, correctionRequestId: randomUUID(), reason: 'Document the final contract history.', patch: {}, replacementEvent: { sourceEventId: randomUUID(), event: { type: 'exception', reason: 'contract expired' } } });
          await client.query('COMMIT');
        } catch (error) { await client.query('ROLLBACK'); throw error; }
        finally { client.release(); }
        jobIds.push(correction.jobId);
        const candidate = (await pool.query('SELECT candidate FROM publication_job WHERE id=$1', [correction.jobId])).rows[0].candidate;
        assert.equal(candidate.eventOnlyCorrection, true);
        assert.equal(candidate.sourceVersionId, textVersion.id);
        assert.equal(candidate.title, textVersion.terms.title, 'event-only candidate retains current text after a text-only correction');
        assert.equal(candidate.thesis, textVersion.thesis, 'event-only candidate retains current thesis after a text-only correction');
        assert.deepEqual(candidate.plan, textVersion.terms.plan, 'event-only candidate retains the current frozen plan');
        assert.equal(candidate.referenceVersions.find(reference => reference.instrumentId === contracts.call100).metadataVersion, source.candidate.referenceVersions.find(reference => reference.instrumentId === contracts.call100).metadataVersion, 'the correction keeps the exact source metadata revision');
        assert.equal(candidate.series.instrumentId, stockId, 'option corrections keep the actual stock underlying as the chart series');
        assert.ok(candidate.bars.length > 0, 'the trusted renderer receives the frozen source bars');
        assert.deepEqual(candidate.chartState, source.candidate.chartState, 'event-only correction retains the rendered ancestor chart');
        const queuedVersion = (await pool.query('SELECT sequence,previous_version_id FROM publication_version WHERE id=$1', [correction.publicationVersionId])).rows[0];
        assert.equal(Number(queuedVersion.sequence), 4);
        assert.equal(queuedVersion.previous_version_id, textVersion.id);
      } finally {
        instruments.get=originalGet;
      }
      assert.equal(optionPublishabilityChecks,0,'history corrections do not revalidate expired option publication eligibility');
    });

    await t.test('completion rechecks author status and current provider/data rights after candidate freeze', async () => {
      const draft = await makeDraft({ actorId: rightsOwner, ownerToken: 'rights' });
      const queued = await publish(draft);
      const job = (await pool.query('SELECT render_nonce,publication_version_id,publication_id FROM publication_job WHERE id=$1', [queued.body.id])).rows[0];
      const expiry = iso(Date.now() + 90000);
      await pool.query("UPDATE publication_job SET status='running',render_nonce_expires_at=$2,attempts=1,render_claimed_at=now() WHERE id=$1", [queued.body.id, expiry]);
      const deniedId = randomUUID(); capabilityIds.push(deniedId);
      await pool.query(`INSERT INTO data_capability(id,supplier,agreement_id,dataset,audience,purpose,effective_at,flags)
        VALUES($1,'synthetic-fixture',$2,'stock','member','publishing',now(),$3::jsonb)`, [deniedId, `p08-revocation-${suffix}`, JSON.stringify({ displayPublic: false, displayMember: true, retainBars: true, retainSnapshot: true, exportImage: false, exportPersonalRecord: false, newPublishing: false })]);
      const checksum = createHash('sha256').update(`revoked-snapshot-${queued.body.id}`).digest('hex');
      await assert.rejects(publications.completePublicationSnapshot(queued.body.id, { objectKey: `${job.publication_version_id}/processed.webp`, checksum, width: 1200, height: 760, mime: 'image/webp' }, { jobId: queued.body.id, publicationVersionId: job.publication_version_id, nonce: job.render_nonce, expiresAt: expiry }), error => error.code === 'DATA_NOT_LICENSED_FOR_PUBLISHING');
      assert.equal((await pool.query('SELECT status FROM publication_job WHERE id=$1', [queued.body.id])).rows[0].status, 'running', 'failed completion transaction does not partially publish');
      assert.equal((await pool.query('SELECT count(*)::int AS count FROM media WHERE id=$1', [job.publication_version_id])).rows[0].count, 0, 'failed completion does not persist the snapshot reference');
      await pool.query('DELETE FROM data_capability WHERE id=$1', [deniedId]);
      const failed = await publications.failPublicationSnapshot(queued.body.id, 'CAPABILITY_REVOKED', false, { jobId: queued.body.id, publicationVersionId: job.publication_version_id, nonce: job.render_nonce, expiresAt: expiry });
      assert.equal(failed.status, 'failed');
      publicationIds.push(job.publication_id);
    });

    await t.test('ownership, CSRF, malformed plans, non-image chart proof, and daily quota are enforced', async () => {
      const foreign = await makeDraft({ actorId: otherOwner, ownerToken: 'other' });
      await publish(foreign, 'owner', `${suffix}-foreign`, 404);
      const csrfDraft = await makeDraft();
      const noCsrf = await fetch(`${base}/drafts/${csrfDraft.id}/publish`, { method: 'POST', headers: { Cookie: 'p08sid=owner', 'Content-Type': 'application/json', 'If-Match': '"1"', 'Idempotency-Key': `${suffix}-csrf` }, body: JSON.stringify({ draftRevision: 1, chartRevision: 1 }) });
      assert.equal(noCsrf.status, 403);

      const malformed = await makeDraft({ planOverride: { ...planFor('long', stockId, [], 'stock'), entryUntil: iso(Date.now() - 10000) } });
      await publish(malformed, 'owner', `${suffix}-expired-entry`, 422);
      const badImage = await makeDraft();
      const fakeMedia = randomUUID(); mediaIds.push(fakeMedia);
      await pool.query(`INSERT INTO media(id,owner_user_id,purpose,resource_id,resource_type,version,quarantine_key,processed_key,dimensions,checksum,status,declared_mime,created_at,updated_at)
        VALUES($1,$2,'chart_snapshot',$3,'draft',1,'quarantine/fake','fake/processed.webp','{"width":1200,"height":760}'::jsonb,$4,'ready','image/webp',now(),now())`, [fakeMedia, owner, badImage.id, '0'.repeat(64)]);
      await request(`/drafts/${badImage.id}`, { actor: 'owner', method: 'PATCH', headers: { 'If-Match': '"1"' }, body: { attachmentIds: [fakeMedia] } }, 422);
      assert.deepEqual((await pool.query('SELECT attachment_ids FROM draft WHERE id=$1', [badImage.id])).rows[0].attachment_ids, []);

      await request('/uploads', { method: 'POST', body: { purpose: 'chart_snapshot', resourceType: 'publication', resourceId: randomUUID(), filename: 'forged.webp', mime: 'image/webp', sizeBytes: 12 }, headers: { 'Idempotency-Key': `${suffix}-forged-snapshot` } }, 422);

      const quotaDrafts = [];
      for (let i = 0; i < 11; i++) quotaDrafts.push(await makeDraft({ actorId: quotaOwner, ownerToken: 'quota', kind: 'education' }));
      const results = await Promise.all(quotaDrafts.map((draft, index) => publish(draft, 'quota', `${suffix}-quota-${index}`, null)));
      const accepted = results.filter(result => result.response.status === 202);
      const limited = results.filter(result => result.response.status === 429);
      assert.equal(accepted.length, 10, `concurrent quota accounting admits only ten new posts (${results.map(item => `${item.response.status}:${item.body?.code ?? item.body?.status}`).join(', ')})`); assert.equal(limited.length, 1, 'concurrent quota accounting admits only ten new posts');
      for (const result of accepted) jobIds.push(result.body.id);
    });
  } finally {
    await app?.close().catch(() => {});
    if (capabilityIds.length) await pool.query('DELETE FROM data_capability WHERE id=ANY($1::uuid[])', [capabilityIds]);
    await cleanupP08Fixtures(pool,userIds);
    await pool.end();
  }
});
