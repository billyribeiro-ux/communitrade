import assert from 'node:assert/strict';
import test from 'node:test';
import { randomUUID } from 'node:crypto';
import pg from 'pg';
import { createApp } from '../dist/app.js';
import { CommunityService } from '../dist/community/service.js';
import { CommandError } from '../dist/http/problem.js';
import { cleanupP09Fixtures } from '../scripts/p09-fixture-cleanup.mjs';

const databaseUrl = process.env.TEST_DATABASE_URL;
const integration = { skip: databaseUrl ? false : 'Set TEST_DATABASE_URL for PostgreSQL community acceptance.' };
test('PostgreSQL community interactions preserve reply targets, revisions, visibility, idempotency, and active uniqueness', integration, async () => {
  const pool = new pg.Pool({ connectionString: databaseUrl, max: 8, connectionTimeoutMillis: 3000, query_timeout: 15000 });
  pool.on('error', () => {});
  const author = randomUUID(), member = randomUUID(), other = randomUUID();
  const publicationId = randomUUID(), versionId = randomUUID(), instrumentId = randomUUID();
  const extraPublicationIds = [randomUUID(), randomUUID()];
  const versionByPublication = new Map([[publicationId, versionId]]);
  const suffix = randomUUID().replaceAll('-', '').slice(0, 12);
  let app;
  const handles = new Map([[author, `owner${suffix}`], [member, `member${suffix}`], [other, `other${suffix}`]]);
  const issuer = `https://p09.community.${suffix}.invalid`;
  const publications = {
    async assertPublicInteractionSource(id, tx) {
      const result = await tx.query("SELECT author_user_id,current_version_id FROM publication WHERE id=$1 AND visibility='public' AND published_at IS NOT NULL", [id]);
      if (!result.rows[0]) throw new CommandError(404, 'PUBLICATION_NOT_FOUND');
      return { authorId: result.rows[0].author_user_id, currentVersionId: result.rows[0].current_version_id };
    },
    async getPublication(id) { return { id, versionId: versionByPublication.get(id) ?? versionId, slug: `synthetic-source-${id.slice(0, 8)}`, kind: 'education', author: { id: author, handle: handles.get(author), displayName: `Community ${handles.get(author)}`, avatarUrl: null, pro: false }, title: 'Synthetic source', thesis: 'Synthetic public thesis for community interaction testing.', plan: null, chart: { instrumentId, metadataVersion: 1 }, referenceVersions: [], publishedAt: new Date().toISOString(), state: 'pending', evidence: 'member_reported', thumbnailUrl: null }; },
    async getPublicSummaryInstrument() { return { id: instrumentId, asset: 'stock', symbol: 'P09-SYN', name: 'P09 Synthetic', venue: 'NASDAQ', currency: 'USD', metadataVersion: 1, multiplier: '1', tickSize: '0.01', enabled: true, adjusted: false, session: null, source: 'fixture', meta: {}, availableMetadataVersions: [1], versions: [{ metadataVersion: 1, sourceId: null }] }; },
  };
  try {
    for (const id of [author, member, other]) {
      await pool.query(`INSERT INTO user_account(id,oidc_issuer,oidc_subject,email,email_verified,status,onboarding_version,created_at,updated_at)
        VALUES($1::uuid,$2,$1::text,$3,true,'active','p09-integration',now(),now())`, [id, issuer, `${id}@example.invalid`]);
      const handle = handles.get(id);
      await pool.query('INSERT INTO profile(user_id,handle,normalized_handle,display_name,revision,created_at,updated_at) VALUES($1,$2,$2,$3,1,now(),now())', [id, handle, `Community ${handle}`]);
    }
    await pool.query(`INSERT INTO instrument(id,asset,vendor,vendor_id,venue,currency,enabled,created_at)
      VALUES($1,'stock','fixture','P09-SYN','NASDAQ','USD',true,now())`, [instrumentId]);
    await pool.query(`INSERT INTO publication(id,author_user_id,kind,visibility,published_at,created_at)
      VALUES($1,$2,'education','public',now(),now())`, [publicationId, author]);
    await pool.query(`INSERT INTO publication_version(id,publication_id,sequence,terms,thesis,chart,disclosures,created_at)
      VALUES($1,$2,1,'{"title":"Synthetic source"}','Synthetic public thesis for community interaction testing.','{}','{}',now())`, [versionId, publicationId]);
    await pool.query('UPDATE publication SET original_version_id=$2,current_version_id=$2 WHERE id=$1', [publicationId, versionId]);
    for (const extraPublicationId of extraPublicationIds) {
      const extraVersionId = randomUUID(); versionByPublication.set(extraPublicationId, extraVersionId);
      await pool.query(`INSERT INTO publication(id,author_user_id,kind,visibility,published_at,created_at)
        VALUES($1,$2,'education','public',now(),now())`, [extraPublicationId, author]);
      await pool.query(`INSERT INTO publication_version(id,publication_id,sequence,terms,thesis,chart,disclosures,created_at)
        VALUES($1,$2,1,'{"title":"Synthetic source"}','Synthetic public thesis for community interaction testing.','{}','{}',now())`, [extraVersionId, extraPublicationId]);
      await pool.query('UPDATE publication SET original_version_id=$2,current_version_id=$2 WHERE id=$1', [extraPublicationId, extraVersionId]);
    }
    const community = new CommunityService(pool, publications);
    const sessions = new Map([['owner', author], ['member', member], ['other', other]]);
    const auth = {
      async authenticate(request) {
        const cookie = request.headers.cookie ?? '';
        const session = cookie.match(/(?:^|;\s*)p09sid=([a-z]+)/)?.[1];
        const userId = sessions.get(session);
        if (!userId) throw new CommandError(401, 'AUTHENTICATION_REQUIRED');
        return { userId, sessionId: session, csrfToken: 'p09-csrf' };
      },
      async optionalActor(request) {
        if (!(request.headers.cookie ?? '').includes('p09sid=')) return null;
        return this.authenticate(request);
      },
      async assertCsrf(request) {
        if (request.headers.origin !== 'http://127.0.0.1' || request.headers['x-csrf-token'] !== 'p09-csrf') {
          throw new CommandError(403, 'CSRF_REJECTED');
        }
      },
      async assertPublicRead() {},
    };
    app = await createApp({ $queryRaw: async () => [] }, null, { auth, community });
    await app.listen(0, '127.0.0.1');
    const address = app.getHttpServer().address();
    const baseUrl = `http://127.0.0.1:${address.port}/api/v1`;

    const anonymousState = await fetch(`${baseUrl}/publications/${publicationId}/community`);
    assert.equal(anonymousState.status, 200);
    assert.equal((await anonymousState.json()).viewer, null);
    const httpCreate = await fetch(`${baseUrl}/publications/${publicationId}/comments`, {
      method: 'POST',
      headers: {
        cookie: 'p09sid=member', origin: 'http://127.0.0.1', 'x-csrf-token': 'p09-csrf',
        'content-type': 'application/json', 'idempotency-key': `http-${randomUUID()}`,
      },
      body: JSON.stringify({ body: `HTTP contract mention @${handles.get(other)}` }),
    });
    assert.equal(httpCreate.status, 201);
    assert.equal(httpCreate.headers.get('etag'), '"1"');
    const httpComment = await httpCreate.json();
    assert.equal(httpComment.author.handle, handles.get(member));
    assert.equal(httpComment.rootId, null, 'top-level comments have no reply-group root');
    assert.equal(httpComment.mentions[0].displayName, `Community ${handles.get(other)}`);
    const httpThread = await fetch(`${baseUrl}/publications/${publicationId}/comments?limit=1`);
    assert.equal(httpThread.status, 200);
    assert.equal((await httpThread.json()).items.length, 1, 'HTTP paging honors the requested maximum');

    const idemComment = `comment-${randomUUID()}`;
    const original = await community.createComment(member, publicationId, idemComment, { body: `Useful point for @${handles.get(other)}`, tag: 'question' });
    const replay = await community.createComment(member, publicationId, idemComment, { body: `Useful point for @${handles.get(other)}`, tag: 'question' });
    assert.equal(replay.id, original.id, 'same actor/key/body replays the original comment');
    assert.equal(original.mentions[0]?.handle, handles.get(other));

    const reply = await community.createComment(other, publicationId, `reply-${randomUUID()}`, { body: 'I am replying directly to the first comment.', replyToId: original.id });
    assert.equal(reply.replyToId, original.id);
    assert.equal(reply.rootId, original.id);
    assert.equal(reply.replyToAuthorHandle, handles.get(member));

    const cursorTimes = ['2020-01-01T00:00:00.000001Z', '2020-01-01T00:00:00.000002Z', '2020-01-01T00:00:00.000003Z'];
    for (const [index, commentId] of [httpComment.id, original.id, reply.id].entries()) {
      await pool.query('UPDATE comment SET created_at=$2::timestamptz WHERE id=$1', [commentId, cursorTimes[index]]);
    }
    const commentPages = [];
    let commentCursor = null;
    do {
      const page = await community.listComments(publicationId, undefined, commentCursor, 1);
      commentPages.push(...page.items.map(item => item.id));
      commentCursor = page.nextCursor;
      if (commentCursor && commentPages.length === 1) {
        const encoded = JSON.parse(Buffer.from(commentCursor, 'base64url').toString('utf8'));
        assert.match(encoded.createdAt, /\.\d{6}Z$/, 'keysets preserve PostgreSQL microsecond precision');
      }
    } while (commentCursor);
    assert.deepEqual(commentPages, [httpComment.id, original.id, reply.id], 'limit-one comment pages preserve order with no duplicates or skips');

    await assert.rejects(() => community.editComment(other, original.id, '"1"', { body: 'Cross-owner edit must fail.' }), error => error.status === 404);
    const edited = await community.editComment(member, original.id, '"1"', { body: `Edited with @${handles.get(author)}` });
    assert.equal(edited.revision, 2);
    assert.deepEqual(edited.comment.mentions.map(mention => mention.handle), [handles.get(author)]);
    await assert.rejects(() => community.editComment(member, original.id, '"1"', { body: 'Stale revision must fail.' }), error => error.status === 409);
    const tombstone = await community.deleteComment(member, original.id, '"2"');
    assert.equal(tombstone.deleted, true);
    assert.equal(tombstone.revision, 3);
    assert.equal(await pool.query('SELECT count(*)::int AS count FROM comment_edit_history WHERE comment_id=$1', [original.id]).then(result => result.rows[0].count), 2);
    const thread = await community.listComments(publicationId);
    assert.equal(thread.items.find(item => item.id === original.id).deleted, true);
    assert.equal(thread.items.find(item => item.id === reply.id).replyToId, original.id);
    await pool.query('UPDATE comment SET hidden_at=now() WHERE id=$1', [original.id]);
    const hiddenThread = await community.listComments(publicationId);
    const hiddenRoot = hiddenThread.items.find(item => item.id === original.id);
    assert.equal(hiddenRoot.deleted, true, 'hidden roots remain visible as neutral tombstones for thread structure');
    assert.equal(hiddenRoot.body, '');
    assert.equal(hiddenRoot.tag, null);
    assert.deepEqual(hiddenRoot.mentions, []);
    assert.equal(hiddenThread.items.find(item => item.id === reply.id).replyToAuthorHandle, null, 'replies do not reveal a hidden target author');

    await assert.rejects(() => community.toggleReaction(author, publicationId, true), error => error.status === 422);
    await Promise.all(Array.from({ length: 8 }, () => community.toggleReaction(member, publicationId, true)));
    await Promise.all(Array.from({ length: 8 }, () => community.toggleBookmark(member, publicationId, true)));
    assert.equal(await pool.query('SELECT count(*)::int AS count FROM reaction WHERE user_id=$1 AND publication_id=$2', [member, publicationId]).then(result => result.rows[0].count), 1);
    assert.equal(await pool.query('SELECT count(*)::int AS count FROM bookmark WHERE user_id=$1 AND publication_id=$2', [member, publicationId]).then(result => result.rows[0].count), 1);
    await Promise.all(extraPublicationIds.map(id => community.toggleBookmark(member, id, true)));
    await pool.query('UPDATE bookmark SET created_at=$3::timestamptz WHERE user_id=$1 AND publication_id=$2', [member, publicationId, cursorTimes[0]]);
    await pool.query('UPDATE bookmark SET created_at=$3::timestamptz WHERE user_id=$1 AND publication_id=$2', [member, extraPublicationIds[0], cursorTimes[1]]);
    await pool.query('UPDATE bookmark SET created_at=$3::timestamptz WHERE user_id=$1 AND publication_id=$2', [member, extraPublicationIds[1], cursorTimes[2]]);
    const bookmarkIds = [];
    let bookmarkCursor = null;
    do {
      const page = await community.listBookmarks(member, bookmarkCursor, 1);
      bookmarkIds.push(...page.items.map(item => item.id));
      bookmarkCursor = page.nextCursor;
    } while (bookmarkCursor);
    assert.deepEqual(bookmarkIds, [extraPublicationIds[1], extraPublicationIds[0], publicationId], 'limit-one bookmark pages preserve microsecond order without duplicates or skips');
    await community.setAuthorFollow(member, handles.get(author), true);
    await community.setAuthorFollow(member, handles.get(author), true);
    await community.setInstrumentFollow(member, instrumentId, true);
    await community.setMute(member, handles.get(author), true);
    assert.deepEqual(await community.getRelationship(member, handles.get(author)), { following: true, muted: true });
    assert.equal((await community.listComments(publicationId)).items.length, 3, 'mute does not suppress criticism or replies');

    const limitedCommentKeys = Array.from({ length: 12 }, () => `limit-${randomUUID()}`);
    const limitedComments = await Promise.allSettled(limitedCommentKeys.map((key, index) =>
      community.createComment(author, publicationId, key, { body: `Concurrent rate limit comment ${index}.` })));
    assert.equal(limitedComments.filter(result => result.status === 'fulfilled').length, 10, 'concurrent comment writes stop at ten per account per minute');
    assert.equal(limitedComments.filter(result => result.status === 'rejected' && result.reason.status === 429).length, 2);
    const winningIndex=limitedComments.findIndex(result=>result.status==='fulfilled');
    const firstLimitedComment = limitedComments[winningIndex];
    assert.equal(firstLimitedComment.status, 'fulfilled');
    assert.equal((await community.createComment(author, publicationId, limitedCommentKeys[winningIndex], { body: `Concurrent rate limit comment ${winningIndex}.` })).id, firstLimitedComment.value.id,
      'idempotent comment replay does not spend another rate-limit slot');
    await assert.rejects(() => community.createComment(author, publicationId, `limit-${randomUUID()}`, { body: 'The comment limit remains in force.' }), error => error.status === 429);
    await assert.rejects(() => community.editComment(author, firstLimitedComment.value.id, '"1"', { body: 'Edits share the account comment limit.' }), error => error.status === 429);

    const idemRepost = `repost-${randomUUID()}`;
    const repost = await community.createRepost(member, publicationId, idemRepost, 'Useful public context.');
    assert.equal(repost.commentary, 'Useful public context.');
    await assert.rejects(() => community.createRepost(member, publicationId, `repost-${randomUUID()}`, 'Different commentary.'), error => error.status === 409);
    await assert.rejects(() => community.createRepost(author, publicationId, `repost-${randomUUID()}`), error => error.status === 422);
    const repostPage = await community.listReposts(handles.get(member));
    assert.equal(repostPage.items[0].publication.id, publicationId, 'profile repost retains original source attribution');
    await community.undoRepost(member, publicationId);
    assert.equal((await community.listReposts(handles.get(member))).items.length, 0);
    const activeAfterUndo = await community.createRepost(member, publicationId, `repost-${randomUUID()}`);
    assert.equal(activeAfterUndo.publicationId, publicationId, 'an undone repost can be created again');
    const extraReposts = [];
    for (const extraPublicationId of extraPublicationIds) extraReposts.push(await community.createRepost(member, extraPublicationId, `repost-${randomUUID()}`));
    await pool.query('UPDATE repost SET created_at=$2::timestamptz WHERE id=$1', [activeAfterUndo.id, cursorTimes[0]]);
    await pool.query('UPDATE repost SET created_at=$2::timestamptz WHERE id=$1', [extraReposts[0].id, cursorTimes[1]]);
    await pool.query('UPDATE repost SET created_at=$2::timestamptz WHERE id=$1', [extraReposts[1].id, cursorTimes[2]]);
    const repostIds = [];
    let repostCursor = null;
    do {
      const page = await community.listReposts(handles.get(member), repostCursor, 1);
      repostIds.push(...page.items.map(item => item.id));
      repostCursor = page.nextCursor;
    } while (repostCursor);
    assert.deepEqual(repostIds, [extraReposts[1].id, extraReposts[0].id, activeAfterUndo.id], 'limit-one repost pages preserve microsecond order without duplicates or skips');

    const idemReport = `report-${randomUUID()}`;
    const report = await community.submitReport(member, idemReport, { resourceType: 'publication', resourceId: publicationId, reason: 'misleading_performance', detail: 'Please review the claim.' });
    const reportReplay = await community.submitReport(member, idemReport, { resourceType: 'publication', resourceId: publicationId, reason: 'misleading_performance', detail: 'Please review the claim.' });
    assert.equal(reportReplay.id, report.id);
    assert.equal((await community.getOwnReport(member, report.id)).detail, 'Please review the claim.');
    await assert.rejects(() => community.getOwnReport(other, report.id), error => error.status === 404);
    for (let index = 0; index < 4; index++) {
      const response = await fetch(`${baseUrl}/reports`, {
        method: 'POST',
        headers: {
          cookie: 'p09sid=member', origin: 'http://127.0.0.1', 'x-csrf-token': 'p09-csrf',
          'content-type': 'application/json', 'idempotency-key': `http-report-${randomUUID()}`,
        },
        body: JSON.stringify({ resourceType: 'publication', resourceId: publicationId, reason: 'spam', detail: `Rate limit report ${index}` }),
      });
      assert.equal(response.status, 201);
    }
    const limitedReport = await fetch(`${baseUrl}/reports`, {
      method: 'POST',
      headers: {
        cookie: 'p09sid=member', origin: 'http://127.0.0.1', 'x-csrf-token': 'p09-csrf',
        'content-type': 'application/json', 'idempotency-key': `http-report-${randomUUID()}`,
      },
      body: JSON.stringify({ resourceType: 'publication', resourceId: publicationId, reason: 'spam', detail: 'One report beyond the limit.' }),
    });
    assert.equal(limitedReport.status, 429);
    assert.ok(Number(limitedReport.headers.get('retry-after')) >= 1 && Number(limitedReport.headers.get('retry-after')) <= 3600,
      'HTTP Retry-After reflects the remaining hour and stays bounded');
    assert.equal((await community.submitReport(member, idemReport, { resourceType: 'publication', resourceId: publicationId, reason: 'misleading_performance', detail: 'Please review the claim.' })).id, report.id,
      'idempotent report replay remains available after the account reaches its hourly cap');
    assert.equal((await community.getPublicationCommunity(publicationId, member)).viewer.bookmarked, true);
    assert.equal((await community.listBookmarks(member)).items[0].id, extraPublicationIds[1]);

    await pool.query("UPDATE publication SET visibility='hidden' WHERE id=$1", [publicationId]);
    await assert.rejects(() => community.getPublicationCommunity(publicationId, member), error => error.status === 404);
    await assert.rejects(() => community.createComment(member, publicationId, idemComment, { body: `Useful point for @${handles.get(other)}`, tag: 'question' }), error => error.status === 404, 'a stored comment receipt is not replayed after source visibility is revoked');
    await assert.rejects(() => community.createRepost(member, publicationId, idemRepost, 'Useful public context.'), error => error.status === 404, 'a stored repost receipt is not replayed after source visibility is revoked');
    assert.equal((await community.listReposts(handles.get(member))).items.some(item => item.publicationId === publicationId), false, 'hidden originals disappear from repost profile results');
  } finally {
    try { if (app) await app.close(); }
    finally {
      try { await cleanupP09Fixtures(pool, [author, member, other], [instrumentId]); }
      finally { await pool.end(); }
    }
  }
});
