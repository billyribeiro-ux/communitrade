import { billingEntitlementScope, billingEntitlementPredicate } from '@trading/config';
import { createHash, randomUUID } from 'node:crypto';
import type { Pool } from 'pg';
import { CommandError } from '../http/problem.js';
import { executeIdempotentCommand, parseIfMatch, withActorTransaction, withTransaction, type CommandTransaction, type Json, type Transaction } from '../persistence/transactions.js';
import type { PublicationService } from '../publications/service.js';
import type { components } from '@trading/contracts';
import { enqueueNotificationEvent } from '../notifications/service.js';
import { recordActivation, recordProductEvent } from '../measurement/events.js';

type Row = Record<string, any>;
type PageCursor = { createdAt: string; id: string; scope?: string };
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const TAGS = new Set(['question', 'counterargument', 'alternative', 'risk']);
const REPORT_REASONS = new Set(['spam', 'harassment', 'impersonation', 'misleading_performance', 'undisclosed_promotion', 'personal_information', 'other']);
const iso = (value: Date | string) => new Date(value).toISOString();
const invalid = (code: string, status = 422, detail?: string) => new CommandError(status, code, detail);

function requireId(value: string) { if (!UUID.test(value)) throw invalid('INVALID_ID', 400); return value; }
function cursorTimestamp(value: unknown): string {
  if (typeof value === 'string' && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{6}Z$/.test(value)) return value;
  const milliseconds = iso(value as Date | string);
  return milliseconds.replace(/\.(\d{3})Z$/, '.$1000Z');
}
function decodeCursor(value: unknown, scope?: string): PageCursor | null {
  if (value === undefined || value === null || value === '') return null;
  if (typeof value !== 'string' || value.length > 500) throw invalid('INVALID_CURSOR', 400);
  try {
    const cursor = JSON.parse(Buffer.from(value, 'base64url').toString('utf8')) as PageCursor;
    if (!cursor || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{6}Z$/.test(cursor.createdAt) || !Number.isFinite(Date.parse(cursor.createdAt)) || !UUID.test(cursor.id)
      || scope !== undefined && cursor.scope !== scope) throw new Error();
    return cursor;
  } catch { throw invalid('INVALID_CURSOR', 400); }
}
function encodeCursor(row: Row, scope?: string) { return Buffer.from(JSON.stringify({ createdAt: cursorTimestamp(row.cursor_created_at ?? row.created_at), id: row.id, ...(scope === undefined ? {} : { scope }) })).toString('base64url'); }
function checkedLimit(value: unknown) { const limit = value === undefined ? 20 : Number(value); if (!Number.isInteger(limit) || limit < 1 || limit > 50) throw invalid('INVALID_LIMIT', 400); return limit; }
function normalizedBody(value: unknown, max = 2000) {
  if (typeof value !== 'string') throw invalid('INVALID_COMMENT');
  const body = value.trim();
  if (!body || body.length > max || [...body].some(char => { const point = char.codePointAt(0)!; return point < 0x20 && point !== 0x09 && point !== 0x0a && point !== 0x0d || point === 0x7f; })) throw invalid('INVALID_COMMENT', 422, `Text must contain 1–${max} plain-text characters.`);
  return body;
}
function normalizeTag(value: unknown): string | null {
  if (value === undefined || value === null) return null;
  if (typeof value !== 'string' || !TAGS.has(value)) throw invalid('INVALID_COMMENT_TAG');
  return value;
}
function publicAuthor(row: Row) {
  return { id: String(row.user_id), handle: String(row.handle), displayName: String(row.display_name), avatarUrl: row.avatar_media_id ? `/api/v1/media/${row.avatar_media_id}/content` : null, pro: Boolean(row.pro) };
}
async function consumeAccountLimit(tx: CommandTransaction, actorId: string, route: '/comments' | '/reports') {
  const principal = createHash('sha256').update(actorId).digest('hex');
  const hourly = route === '/reports';
  const limit = hourly ? 5 : 10;
  const window = hourly
    ? "date_trunc('hour',now() AT TIME ZONE 'UTC') AT TIME ZONE 'UTC'"
    : "date_bin('1 minute',now(),TIMESTAMPTZ '2000-01-01')";
  const result = await tx.query(`INSERT INTO rate_limit_bucket(id,principal_hash,route,window_start,counter,expires_at)
    VALUES($1,$2,$3,${window},1,now()+interval '${hourly ? '2 hours' : '2 minutes'}')
    ON CONFLICT(principal_hash,route,window_start) DO UPDATE SET counter=rate_limit_bucket.counter+1
    WHERE rate_limit_bucket.counter<$4 RETURNING counter`, [randomUUID(), principal, route, limit]);
  if (!result.rowCount) {
    if (!hourly) throw new CommandError(429, 'COMMENT_RATE_LIMIT', 'Comment limit reached. Try again after the current minute.', undefined, 60);
    const retry = await tx.query<{ retry_after: number }>(`SELECT GREATEST(1,CEIL(EXTRACT(EPOCH FROM (date_trunc('hour',now() AT TIME ZONE 'UTC') AT TIME ZONE 'UTC'+interval '1 hour'-now()))))::int AS retry_after`);
    throw new CommandError(429, 'REPORT_RATE_LIMIT', 'Report limit reached. Try again after the current UTC hour.', undefined, Number(retry.rows[0]?.retry_after ?? 3600));
  }
}
export class CommunityService {
  constructor(private readonly pool: Pool, private readonly publications: PublicationService) {}

  private async assertSource(publicationId: string, tx: Pick<CommandTransaction, 'query'>) {
    requireId(publicationId);
    return this.publications.assertPublicInteractionSource(publicationId, tx);
  }

  private async author(tx: Transaction, userId: string): Promise<Row> {
    const result = await tx.query(`SELECT p.user_id,p.handle,p.display_name,p.avatar_media_id,
      EXISTS(SELECT 1 FROM subscription_entitlement e WHERE e.user_id=p.user_id AND e.plan='pro' AND e.valid_from<=now() AND (e.valid_until IS NULL OR e.valid_until>now()) AND ${billingEntitlementPredicate('e',2)}) AS pro,
      u.status AS account_status FROM profile p JOIN user_account u ON u.id=p.user_id WHERE p.user_id=$1 AND p.moderation_hidden_at IS NULL`, [userId,...billingEntitlementScope(process.env)]);
    if (!result.rows[0]) throw invalid('PROFILE_NOT_FOUND', 404);
    return result.rows[0];
  }

  private async publicationSummary(id: string): Promise<components['schemas']['PublicationSummary']> {
    const publication = await this.publications.getPublication(id);
    const instrument = await this.publications.getPublicSummaryInstrument(publication.chart.instrumentId, publication.chart.metadataVersion, publication.plan, { referenceVersions: publication.referenceVersions ?? [] });
    const current = await withTransaction(this.pool, tx => this.assertSource(id, tx));
    if (current.currentVersionId !== publication.versionId) throw invalid('PUBLICATION_NOT_FOUND', 404);
    const counts = await this.pool.query<Row>(`SELECT
      (SELECT count(*)::int FROM comment WHERE publication_id=$1 AND deleted_at IS NULL AND hidden_at IS NULL) AS comments,
      (SELECT count(*)::int FROM reaction WHERE publication_id=$1) AS reactions,
      (SELECT count(*)::int FROM repost r JOIN user_account u ON u.id=r.user_id AND u.status='active' JOIN profile rp ON rp.user_id=r.user_id AND rp.moderation_hidden_at IS NULL WHERE r.publication_id=$1 AND r.active AND r.hidden_at IS NULL) AS reposts`, [id]);
    const plan = publication.plan;
    return {
      id: publication.id, versionId: publication.versionId, slug: publication.slug, author: publication.author,
      title: publication.title, excerpt: publication.thesis.slice(0, 220),
      instrument,
      ...(plan?.asset ? { asset: plan.asset } : {}), ...(plan?.strategy ? { strategy: plan.strategy } : {}),
      state: publication.state, thumbnailUrl: publication.thumbnailUrl, publishedAt: publication.publishedAt,
      evidence: 'member_reported', comments: Number(counts.rows[0]?.comments ?? 0), reactions: Number(counts.rows[0]?.reactions ?? 0),
      reposts: Number(counts.rows[0]?.reposts ?? 0), kind: publication.kind,
    };
  }

  private async projectComment(tx: Transaction, row: Row) {
    let author: Row;
    try { author = await this.author(tx, String(row.author_user_id)); }
    catch (error) { if (!(error instanceof CommandError) || error.status !== 404) throw error; author = {}; }
    const tombstone = Boolean(row.deleted_at || row.hidden_at || author.account_status !== 'active' || !author.user_id);
    const authorDto = !tombstone && author.user_id ? publicAuthor(author) : { id: String(row.author_user_id), handle: 'former_member', displayName: 'Former member', avatarUrl: null, pro: false };
    const mentionDetails: Row[] = [];
    if (!tombstone) {
      const mentions = await tx.query('SELECT m.mentioned_user_id AS id,m.handle,p.display_name FROM comment_mention m JOIN profile p ON p.user_id=m.mentioned_user_id AND p.moderation_hidden_at IS NULL JOIN user_account u ON u.id=p.user_id AND u.status=\'active\' WHERE m.comment_id=$1 ORDER BY m.handle', [row.id]);
      for (const mention of mentions.rows) mentionDetails.push({ id: mention.id, handle: mention.handle, displayName: mention.display_name });
    }
    let replyToAuthorHandle: string | null = null;
    if (!tombstone && row.reply_to_id) {
      const parent = await tx.query("SELECT p.handle FROM comment c JOIN profile p ON p.user_id=c.author_user_id AND p.moderation_hidden_at IS NULL JOIN user_account u ON u.id=p.user_id AND u.status='active' WHERE c.id=$1 AND c.deleted_at IS NULL AND c.hidden_at IS NULL", [row.reply_to_id]);
      replyToAuthorHandle = parent.rows[0]?.handle ?? null;
    }
    return {
      id: String(row.id), publicationId: String(row.publication_id), author: authorDto,
      body: tombstone ? '' : String(row.body), replyToId: row.reply_to_id ?? null,
      rootId: row.root_id ?? null, replyToAuthorHandle, mentions: mentionDetails,
      tag: tombstone ? null : row.tag ?? null, createdAt: iso(row.created_at),
      editedAt: row.edited_at ? iso(row.edited_at) : null, deleted: tombstone, revision: Number(row.revision),
    };
  }

  private async replaceMentions(tx: CommandTransaction, commentId: string, body: string) {
    const handles = [...new Set([...body.matchAll(/(?:^|[^A-Za-z0-9_])@([A-Za-z0-9_]{3,30})/g)].map(match => match[1]!.toLowerCase()))];
    if (handles.length > 20) throw invalid('TOO_MANY_MENTIONS', 422, 'A comment can mention at most 20 members.');
    await tx.query('DELETE FROM comment_mention WHERE comment_id=$1', [commentId]);
    for (const handle of handles) {
      const found = await tx.query('SELECT user_id,handle FROM profile WHERE normalized_handle=$1', [handle]);
      if (found.rows[0]) await tx.query('INSERT INTO comment_mention(id,comment_id,mentioned_user_id,handle) VALUES($1,$2,$3,$4) ON CONFLICT(comment_id,mentioned_user_id) DO NOTHING', [randomUUID(), commentId, found.rows[0].user_id, found.rows[0].handle]);
    }
  }

  async listComments(publicationId: string, viewerId?: string, cursorInput?: unknown, limitInput?: unknown) {
    const take = checkedLimit(limitInput), cursor = decodeCursor(cursorInput, `comments:${publicationId}`);
    return withTransaction(this.pool, async tx => {
      const source = await this.assertSource(publicationId, tx);
      const rows = await tx.query(`SELECT c.*,to_char(c.created_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS cursor_created_at FROM comment c
        WHERE c.publication_id=$1
          AND ($2::timestamptz IS NULL OR (c.created_at,c.id)>($2::timestamptz,$3::uuid))
        ORDER BY c.created_at ASC,c.id ASC LIMIT $4`, [publicationId, cursor?.createdAt ?? null, cursor?.id ?? null, take + 1]);
      const visibleRows = rows.rows.slice(0, take);
      const comments: Row[] = [];
      for (const row of visibleRows) comments.push(await this.projectComment(tx, row));
      // Replies stay at their stored reply target, while rootId gives clients a stable two-level display group.
      return { items: comments, nextCursor: rows.rows.length > take && visibleRows.length ? encodeCursor(visibleRows.at(-1)!, `comments:${publicationId}`) : null, sourceAuthorId: source.authorId, viewerId: viewerId ?? null };
    });
  }

  async createComment(actorId: string, publicationId: string, key: string, input: { body: string; replyToId?: string; tag?: string }) {
    const body = normalizedBody(input.body), tag = normalizeTag(input.tag);
    if (input.replyToId) requireId(input.replyToId);
    const result = await executeIdempotentCommand(this.pool, { actorUserId: actorId, operation: `comment-create:${publicationId}`, idempotencyKey: key, input: { body, replyToId: input.replyToId ?? null, tag } as Json }, async tx => {
      await this.assertSource(publicationId, tx);
      await consumeAccountLimit(tx, actorId, '/comments');
      let rootId: string | null = null;
      if (input.replyToId) {
        const parent = await tx.query<Row>('SELECT id,publication_id,reply_to_id,root_id,deleted_at,hidden_at FROM comment WHERE id=$1 AND publication_id=$2 FOR SHARE', [input.replyToId, publicationId]);
        const target = parent.rows[0];
        if (!target || target.deleted_at || target.hidden_at) throw invalid('COMMENT_TARGET_UNAVAILABLE', 404);
        rootId = target.root_id ?? target.id;
      }
      const id = randomUUID();
      const created = await tx.query<Row>(`INSERT INTO comment(id,publication_id,author_user_id,reply_to_id,root_id,body,tag,revision,created_at)
        VALUES($1,$2,$3,$4,$5,$6,$7,1,now()) RETURNING *`, [id, publicationId, actorId, input.replyToId ?? null, rootId, body, tag]);
      await recordActivation(tx,actorId,'feed');
      await this.replaceMentions(tx, id, body);
      await enqueueNotificationEvent(tx,'notification.comment_activity','comment',id,1,{commentId:id,publicationId,authorUserId:actorId});
      const dto = await this.projectComment(tx, created.rows[0]!);
      return { status: 201, body: dto as unknown as Json, resourceId: id };
    });
    // Idempotency replays bypass the command callback; always reauthorize the
    // derivative source before returning its stored public comment receipt.
    await withTransaction(this.pool, tx => this.assertSource(publicationId, tx));
    return result.body as Row;
  }

  async editComment(actorId: string, commentId: string, ifMatch: unknown, patch: { body?: string; tag?: string | null }) {
    requireId(commentId);
    const expected = parseIfMatch(ifMatch);
    if (!Object.keys(patch).length || Object.keys(patch).some(key => !['body', 'tag'].includes(key))) throw invalid('INVALID_COMMENT_PATCH', 400);
    const body = patch.body === undefined ? undefined : normalizedBody(patch.body);
    const tag = patch.tag === undefined ? undefined : normalizeTag(patch.tag);
    return withActorTransaction(this.pool, actorId, async tx => {
      const found = await tx.query<Row>('SELECT * FROM comment WHERE id=$1 AND author_user_id=$2 FOR UPDATE', [commentId, actorId]);
      const current = found.rows[0]; if (!current) throw invalid('COMMENT_NOT_FOUND', 404);
      if (current.deleted_at || current.hidden_at) throw invalid('COMMENT_DELETED', 409);
      if (Number(current.revision) !== expected) throw invalid('STALE_REVISION', 409, 'Reload the current comment before saving.');
      await this.assertSource(String(current.publication_id), tx);
      await consumeAccountLimit(tx, actorId, '/comments');
      await tx.query('INSERT INTO comment_edit_history(id,comment_id,revision,body,tag,changed_at) VALUES($1,$2,$3,$4,$5,now()) ON CONFLICT(comment_id,revision) DO NOTHING', [randomUUID(), commentId, expected, current.body, current.tag]);
      const saved = await tx.query<Row>(`UPDATE comment SET body=$3,tag=$4,edited_at=now(),revision=revision+1
        WHERE id=$1 AND author_user_id=$2 AND revision=$5 AND deleted_at IS NULL AND hidden_at IS NULL RETURNING *`, [commentId, actorId, body ?? current.body, tag === undefined ? current.tag : tag, expected]);
      if (!saved.rows[0]) throw invalid('STALE_REVISION', 409);
      if (body !== undefined) await this.replaceMentions(tx, commentId, body);
      return { comment: await this.projectComment(tx, saved.rows[0]), revision: Number(saved.rows[0].revision) };
    });
  }

  async deleteComment(actorId: string, commentId: string, ifMatch: unknown) {
    requireId(commentId); const expected = parseIfMatch(ifMatch);
    return withActorTransaction(this.pool, actorId, async tx => {
      const found = await tx.query<Row>('SELECT * FROM comment WHERE id=$1 AND author_user_id=$2 FOR UPDATE', [commentId, actorId]);
      const current = found.rows[0]; if (!current) throw invalid('COMMENT_NOT_FOUND', 404);
      if (current.deleted_at || current.hidden_at) return { deleted: true, revision: Number(current.revision) };
      if (Number(current.revision) !== expected) throw invalid('STALE_REVISION', 409, 'Reload the current comment before deleting it.');
      await this.assertSource(String(current.publication_id), tx);
      await tx.query('INSERT INTO comment_edit_history(id,comment_id,revision,body,tag,changed_at) VALUES($1,$2,$3,$4,$5,now()) ON CONFLICT(comment_id,revision) DO NOTHING', [randomUUID(), commentId, expected, current.body, current.tag]);
      const result = await tx.query<Row>(`UPDATE comment SET body='',tag=NULL,deleted_at=now(),edited_at=now(),revision=revision+1
        WHERE id=$1 AND author_user_id=$2 AND revision=$3 AND deleted_at IS NULL RETURNING revision`, [commentId, actorId, expected]);
      if (!result.rows[0]) throw invalid('STALE_REVISION', 409);
      await tx.query('DELETE FROM comment_mention WHERE comment_id=$1', [commentId]);
      return { deleted: true, revision: Number(result.rows[0].revision) };
    });
  }

  async getPublicationCommunity(publicationId: string, viewerId?: string) {
    return withTransaction(this.pool, async tx => {
      await this.assertSource(publicationId, tx);
      const counts = await tx.query<Row>(`SELECT (SELECT count(*)::int FROM reaction WHERE publication_id=$1) AS helpful_count,
        (SELECT count(*)::int FROM comment WHERE publication_id=$1 AND deleted_at IS NULL AND hidden_at IS NULL) AS comment_count`, [publicationId]);
      let viewer: Row | null = null;
      if (viewerId) {
        const state = await tx.query<Row>(`SELECT EXISTS(SELECT 1 FROM reaction WHERE user_id=$2 AND publication_id=$1) AS helpful,
          EXISTS(SELECT 1 FROM bookmark WHERE user_id=$2 AND publication_id=$1) AS bookmarked,
          (SELECT r.id FROM repost r WHERE r.user_id=$2 AND r.publication_id=$1 AND r.active LIMIT 1) AS repost_id,
          (SELECT r.commentary FROM repost r WHERE r.user_id=$2 AND r.publication_id=$1 AND r.active LIMIT 1) AS commentary`, [publicationId, viewerId]);
        const row = state.rows[0] ?? {};
        viewer = { helpful: Boolean(row.helpful), bookmarked: Boolean(row.bookmarked), reposted: Boolean(row.repost_id), repostId: row.repost_id ?? null, commentary: row.commentary ?? null };
      }
      return { helpfulCount: Number(counts.rows[0]?.helpful_count ?? 0), commentCount: Number(counts.rows[0]?.comment_count ?? 0), viewer };
    });
  }

  async toggleReaction(actorId: string, publicationId: string, active: boolean) {
    return withActorTransaction(this.pool, actorId, async tx => {
      const source = await this.assertSource(publicationId, tx);
      if (source.authorId === actorId) throw invalid('SELF_REACTION', 422, 'You cannot react to your own publication.');
      if (active) await tx.query("INSERT INTO reaction(id,user_id,publication_id,type) VALUES($1,$2,$3,'helpful') ON CONFLICT(user_id,publication_id) DO NOTHING", [randomUUID(), actorId, publicationId]);
      else await tx.query('DELETE FROM reaction WHERE user_id=$1 AND publication_id=$2', [actorId, publicationId]);
      return { active };
    });
  }

  async toggleBookmark(actorId: string, publicationId: string, active: boolean) {
    return withActorTransaction(this.pool, actorId, async tx => {
      await this.assertSource(publicationId, tx);
      if (active) await tx.query('INSERT INTO bookmark(id,user_id,publication_id,created_at) VALUES($1,$2,$3,now()) ON CONFLICT(user_id,publication_id) DO NOTHING', [randomUUID(), actorId, publicationId]);
      else await tx.query('DELETE FROM bookmark WHERE user_id=$1 AND publication_id=$2', [actorId, publicationId]);
      return { active };
    });
  }

  async setAuthorFollow(actorId: string, handle: string, active: boolean) {
    const normalized = handle.toLowerCase();
    if (!/^[a-z0-9_]{3,30}$/.test(normalized)) throw invalid('INVALID_HANDLE', 400);
    return withActorTransaction(this.pool, actorId, async tx => {
      const target = await tx.query<Row>("SELECT p.user_id FROM profile p JOIN user_account u ON u.id=p.user_id AND u.status='active' WHERE p.normalized_handle=$1 AND p.moderation_hidden_at IS NULL", [normalized]);
      if (!target.rows[0]) throw invalid('PROFILE_NOT_FOUND', 404);
      const userId = String(target.rows[0].user_id);
      if (actorId === userId) throw invalid('SELF_FOLLOW', 422, 'You cannot follow yourself.');
      if (active) await tx.query('INSERT INTO follow(id,follower_user_id,target_user_id,instrument_id,created_at) VALUES($1,$2,$3,NULL,now()) ON CONFLICT(follower_user_id,target_user_id) WHERE target_user_id IS NOT NULL DO NOTHING', [randomUUID(), actorId, userId]);
      else await tx.query('DELETE FROM follow WHERE follower_user_id=$1 AND target_user_id=$2', [actorId, userId]);
      return { following: active };
    });
  }

  async setInstrumentFollow(actorId: string, instrumentId: string, active: boolean) {
    requireId(instrumentId);
    return withActorTransaction(this.pool, actorId, async tx => {
      const target = await tx.query("SELECT 1 FROM instrument WHERE id=$1 AND enabled=true", [instrumentId]);
      if (!target.rowCount) throw invalid('INSTRUMENT_NOT_FOUND', 404);
      if (active) await tx.query('INSERT INTO follow(id,follower_user_id,target_user_id,instrument_id,created_at) VALUES($1,$2,NULL,$3,now()) ON CONFLICT(follower_user_id,instrument_id) WHERE instrument_id IS NOT NULL DO NOTHING', [randomUUID(), actorId, instrumentId]);
      else await tx.query('DELETE FROM follow WHERE follower_user_id=$1 AND instrument_id=$2', [actorId, instrumentId]);
      return { following: active };
    });
  }

  async setMute(actorId: string, handle: string, active: boolean) {
    const normalized = handle.toLowerCase();
    if (!/^[a-z0-9_]{3,30}$/.test(normalized)) throw invalid('INVALID_HANDLE', 400);
    return withActorTransaction(this.pool, actorId, async tx => {
      const target = await tx.query("SELECT p.user_id FROM profile p JOIN user_account u ON u.id=p.user_id AND u.status='active' WHERE p.normalized_handle=$1 AND p.moderation_hidden_at IS NULL", [normalized]);
      if (!target.rows[0]) throw invalid('PROFILE_NOT_FOUND', 404);
      const userId = String(target.rows[0].user_id);
      if (actorId === userId) throw invalid('SELF_MUTE', 422, 'You cannot mute yourself.');
      if (active) await tx.query('INSERT INTO mute(id,user_id,author_id,created_at) VALUES($1,$2,$3,now()) ON CONFLICT(user_id,author_id) DO NOTHING', [randomUUID(), actorId, userId]);
      else await tx.query('DELETE FROM mute WHERE user_id=$1 AND author_id=$2', [actorId, userId]);
      return { muted: active };
    });
  }

  async getRelationship(actorId: string | undefined, handle: string) {
    const target = await this.pool.query("SELECT p.user_id FROM profile p JOIN user_account u ON u.id=p.user_id AND u.status='active' WHERE p.normalized_handle=$1 AND p.moderation_hidden_at IS NULL", [handle.toLowerCase()]);
    if (!target.rows[0]) throw invalid('PROFILE_NOT_FOUND', 404);
    if (!actorId) return { following: false, muted: false };
    const relations = await this.pool.query(`SELECT EXISTS(SELECT 1 FROM follow WHERE follower_user_id=$1 AND target_user_id=$2) AS following,
      EXISTS(SELECT 1 FROM mute WHERE user_id=$1 AND author_id=$2) AS muted`, [actorId, target.rows[0].user_id]);
    return { following: Boolean(relations.rows[0]?.following), muted: Boolean(relations.rows[0]?.muted) };
  }

  async getInstrumentFollow(actorId: string | undefined, instrumentId: string) {
    requireId(instrumentId);
    const instrument = await this.pool.query('SELECT id FROM instrument WHERE id=$1 AND enabled=true', [instrumentId]);
    if (!instrument.rowCount) throw invalid('INSTRUMENT_NOT_FOUND', 404);
    if (!actorId) return { following: false };
    const followed = await this.pool.query('SELECT 1 FROM follow WHERE follower_user_id=$1 AND instrument_id=$2', [actorId, instrumentId]);
    return { following: Boolean(followed.rowCount) };
  }

  async listBookmarks(actorId: string, cursorInput?: unknown, limitInput?: unknown): Promise<components['schemas']['PublicationPage']> {
    const take = checkedLimit(limitInput), scope = `bookmarks:${actorId}`, cursor = decodeCursor(cursorInput, scope);
    const selected = await withTransaction(this.pool, async tx => {
      const available: Row[] = [];
      let scan = cursor, lastScanned: Row | undefined, hasMore = false, bounded = false;
      for (let batch = 0; batch < 5 && available.length <= take; batch++) {
        const rows = await tx.query<Row>(`SELECT b.id,b.created_at,b.publication_id,to_char(b.created_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS cursor_created_at FROM bookmark b
          WHERE b.user_id=$1 AND ($2::timestamptz IS NULL OR (b.created_at,b.id)<($2::timestamptz,$3::uuid))
          ORDER BY b.created_at DESC,b.id DESC LIMIT $4`, [actorId, scan?.createdAt ?? null, scan?.id ?? null, take + 1]);
        if (!rows.rows.length) break;
        for (const row of rows.rows) {
          lastScanned = row;
          try { await this.assertSource(String(row.publication_id), tx); available.push(row); }
          catch (error) { if (!(error instanceof CommandError) || error.status !== 404) throw error; }
          if (available.length > take) { hasMore = true; break; }
        }
        if (hasMore || rows.rows.length < take + 1) break;
        const last = rows.rows.at(-1)!;
        scan = { createdAt: cursorTimestamp(last.cursor_created_at), id: last.id };
        if (batch === 4) bounded = true;
      }
      const pageRows = available.slice(0, take);
      const cursorRow = hasMore ? pageRows.at(-1) : bounded ? lastScanned : undefined;
      return { rows: pageRows, nextCursor: cursorRow ? encodeCursor(cursorRow, scope) : null };
    });
    const items = await Promise.all(selected.rows.map(row => this.publicationSummary(String(row.publication_id))));
    return { items, nextCursor: selected.nextCursor };
  }

  async createRepost(actorId: string, publicationId: string, key: string, commentaryInput?: string) {
    const commentary = commentaryInput === undefined ? null : commentaryInput.trim() === '' ? null : normalizedBody(commentaryInput, 500);
    const result = await executeIdempotentCommand(this.pool, { actorUserId: actorId, operation: `repost-create:${publicationId}`, idempotencyKey: key, input: { commentary } as Json }, async tx => {
      const source = await this.assertSource(publicationId, tx);
      if (source.authorId === actorId) throw invalid('SELF_REPOST', 422, 'You cannot repost your own publication.');
      await tx.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))', [`repost-active:${actorId}:${publicationId}`]);
      const existing = await tx.query<Row>('SELECT * FROM repost WHERE user_id=$1 AND publication_id=$2 AND active FOR UPDATE', [actorId, publicationId]);
      if (existing.rows[0]) {
        if (existing.rows[0].commentary !== commentary) throw invalid('REPOST_ALREADY_ACTIVE', 409, 'Undo the current repost before changing its commentary.');
        return { status: 200, body: await this.projectRepost(tx, existing.rows[0]) as unknown as Json, resourceId: existing.rows[0].id };
      }
      const created = await tx.query<Row>(`INSERT INTO repost(id,user_id,publication_id,commentary,active,created_at) VALUES($1,$2,$3,$4,true,now()) RETURNING *`, [randomUUID(), actorId, publicationId, commentary]);
      return { status: 201, body: await this.projectRepost(tx, created.rows[0]!) as unknown as Json, resourceId: created.rows[0]!.id };
    });
    await withTransaction(this.pool, tx => this.assertSource(publicationId, tx));
    return result.body as Row;
  }

  private async projectRepost(tx: Transaction, row: Row) {
    const author = await this.author(tx, String(row.user_id));
    return { id: String(row.id), publicationId: String(row.publication_id), author: publicAuthor(author), commentary: row.commentary ?? '', createdAt: iso(row.created_at) };
  }

  async undoRepost(actorId: string, publicationId: string) {
    requireId(publicationId);
    return withActorTransaction(this.pool, actorId, async tx => {
      await tx.query('UPDATE repost SET active=false WHERE user_id=$1 AND publication_id=$2 AND active', [actorId, publicationId]);
      return { active: false };
    });
  }

  async listReposts(handle: string, cursorInput?: unknown, limitInput?: unknown) {
    const take = checkedLimit(limitInput), normalized = handle.toLowerCase(), scope = `reposts:${normalized}`, cursor = decodeCursor(cursorInput, scope);
    const selected = await withTransaction(this.pool, async tx => {
      const profile = await tx.query("SELECT user_id FROM profile WHERE normalized_handle=$1 AND moderation_hidden_at IS NULL", [normalized]);
      if (!profile.rows[0]) throw invalid('PROFILE_NOT_FOUND', 404);
      const items: Row[] = [];
      let scan = cursor, lastScanned: Row | undefined, hasMore = false, bounded = false;
      for (let batch = 0; batch < 5 && items.length <= take; batch++) {
      const rows = await tx.query<Row>(`SELECT r.*,to_char(r.created_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS cursor_created_at FROM repost r WHERE r.user_id=$1 AND r.active AND r.hidden_at IS NULL
          AND ($2::timestamptz IS NULL OR (r.created_at,r.id)<($2::timestamptz,$3::uuid))
          ORDER BY r.created_at DESC,r.id DESC LIMIT $4`, [profile.rows[0].user_id, scan?.createdAt ?? null, scan?.id ?? null, take + 1]);
        if (!rows.rows.length) break;
        for (const row of rows.rows) {
          lastScanned = row;
          try {
            await this.assertSource(String(row.publication_id), tx);
            const dto = await this.projectRepost(tx, row);
            items.push({ dto, publicationId: String(row.publication_id), created_at: row.created_at, cursor_created_at: row.cursor_created_at, id: row.id });
          } catch (error) { if (!(error instanceof CommandError) || error.status !== 404) throw error; }
          if (items.length > take) { hasMore = true; break; }
        }
        if (hasMore || rows.rows.length < take + 1) break;
        const last = rows.rows.at(-1)!;
        scan = { createdAt: cursorTimestamp(last.cursor_created_at), id: last.id };
        if (batch === 4) bounded = true;
      }
      const pageItems = items.slice(0, take);
      const cursorRow = hasMore ? pageItems.at(-1) : bounded ? lastScanned : undefined;
      return { items: pageItems, nextCursor: cursorRow ? encodeCursor(cursorRow, scope) : null };
    });
    const items = await Promise.all(selected.items.map(async row => ({ ...row.dto, publication: await this.publicationSummary(row.publicationId) })));
    return { items, nextCursor: selected.nextCursor };
  }

  async submitReport(actorId: string, key: string, input: { resourceType: string; resourceId: string; reason: string; detail: string }) {
    requireId(input.resourceId);
    if (!['publication', 'comment', 'profile', 'repost'].includes(input.resourceType) || !REPORT_REASONS.has(input.reason)) throw invalid('INVALID_REPORT');
    const detail = input.detail;
    if (typeof detail !== 'string' || detail.length > 2000) throw invalid('INVALID_REPORT_DETAIL');
    const result = await executeIdempotentCommand(this.pool, { actorUserId: actorId, operation: `report:${input.resourceType}:${input.resourceId}`, idempotencyKey: key, input: { ...input, detail } as Json }, async tx => {
      await this.assertReportTarget(tx, input.resourceType, input.resourceId);
      await consumeAccountLimit(tx, actorId, '/reports');
      const id = randomUUID();
      await tx.query("INSERT INTO report(id,reporter_user_id,resource_type,resource_id,reason,detail,status,created_at) VALUES($1,$2,$3,$4,$5,$6,'open',now())", [id, actorId, input.resourceType, input.resourceId, input.reason, detail]);
      await recordProductEvent(tx,actorId,'report',id,{surface:'feed'});
      return { status: 201, body: { id, resourceType: input.resourceType, resourceId: input.resourceId, reason: input.reason, detail, status: 'open', decision: null, createdAt: new Date().toISOString(), appeals: [] } as unknown as Json, resourceId: id };
    });
    return result.body as Row;
  }

  private async assertReportTarget(tx: CommandTransaction, type: string, id: string) {
    if (type === 'publication') { await this.assertSource(id, tx); return; }
    if (type === 'comment') {
      const row = await tx.query<Row>('SELECT publication_id FROM comment WHERE id=$1 AND hidden_at IS NULL', [id]);
      if (!row.rows[0]) throw invalid('REPORT_TARGET_NOT_FOUND', 404);
      await this.assertSource(String(row.rows[0].publication_id), tx); return;
    }
    if (type === 'profile') {
      const row = await tx.query("SELECT 1 FROM profile p JOIN user_account u ON u.id=p.user_id AND u.status='active' WHERE p.user_id=$1 AND p.moderation_hidden_at IS NULL", [id]);
      if (!row.rowCount) throw invalid('REPORT_TARGET_NOT_FOUND', 404); return;
    }
    const row = await tx.query<Row>('SELECT publication_id FROM repost WHERE id=$1 AND active', [id]);
    if (!row.rows[0]) throw invalid('REPORT_TARGET_NOT_FOUND', 404);
    await this.assertSource(String(row.rows[0].publication_id), tx);
  }

  async getOwnReport(actorId: string, reportId: string) {
    requireId(reportId);
    const row = await this.pool.query<Row>(`SELECT r.id,r.reporter_user_id,r.resource_type,r.resource_id,r.reason,r.detail,r.status,r.decision,r.created_at,
      COALESCE((SELECT json_agg(json_build_object('id',a.id,'reason',a.reason,'status',a.status,'createdAt',to_char(a.created_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"')) ORDER BY a.created_at,a.id) FROM appeal a WHERE a.report_id=r.id),'[]'::json) appeals,
      CASE r.resource_type WHEN 'publication' THEN (SELECT author_user_id FROM publication WHERE id=r.resource_id)
        WHEN 'comment' THEN (SELECT author_user_id FROM comment WHERE id=r.resource_id)
        WHEN 'repost' THEN (SELECT user_id FROM repost WHERE id=r.resource_id)
        WHEN 'profile' THEN r.resource_id ELSE (SELECT id FROM user_account WHERE id=r.resource_id) END resource_owner_id,
      (SELECT action FROM moderation_action m WHERE m.report_id=r.id ORDER BY m.created_at DESC,m.id DESC LIMIT 1) last_action,
      EXISTS(SELECT 1 FROM appeal a WHERE a.report_id=r.id AND a.appellant_user_id=$2) appeal_exists
      FROM report r WHERE r.id=$1 AND (r.reporter_user_id=$2 OR (
        CASE r.resource_type WHEN 'publication' THEN (SELECT author_user_id FROM publication WHERE id=r.resource_id)
          WHEN 'comment' THEN (SELECT author_user_id FROM comment WHERE id=r.resource_id)
          WHEN 'repost' THEN (SELECT user_id FROM repost WHERE id=r.resource_id)
          WHEN 'profile' THEN r.resource_id ELSE (SELECT id FROM user_account WHERE id=r.resource_id) END=$2 AND r.status IN ('resolved','appealed','closed')
      ))`, [reportId, actorId]);
    if (!row.rows[0]) throw invalid('REPORT_NOT_FOUND', 404);
    const ownReporter=String(row.rows[0].reporter_user_id)===actorId;
    const ownerView=!ownReporter&&String(row.rows[0].resource_owner_id)===actorId;
    if(ownerView&&!['hide','appeal_restore'].includes(row.rows[0].last_action))throw invalid('REPORT_NOT_FOUND',404);
    const safeOwnerDecision=row.rows[0].last_action==='appeal_restore'?'The item was restored after independent appeal review.':'The item was hidden after moderation review.';
    const appeals=(row.rows[0].appeals??[]).map((appeal:Row)=>ownReporter?{id:appeal.id,status:appeal.status,createdAt:appeal.createdAt}:appeal);
    return { id: String(row.rows[0].id), resourceType: row.rows[0].resource_type, resourceId: String(row.rows[0].resource_id), reason: ownReporter?row.rows[0].reason:'moderation_decision', detail: ownReporter?(row.rows[0].detail??''):'', status: row.rows[0].status, decision: ownerView?safeOwnerDecision:(row.rows[0].decision??null), createdAt: iso(row.rows[0].created_at), appeals,caseKind:ownerView?'moderation_notice':'report',viewerCanAppeal:ownerView&&row.rows[0].last_action==='hide'&&!row.rows[0].appeal_exists };
  }

  async listOwnReports(actorId:string,cursorInput:unknown,limitInput:unknown){
    const limit=checkedLimit(limitInput),scope=`reports:${actorId}`,cursor=decodeCursor(cursorInput,scope);
    const rows=await this.pool.query<Row>(`SELECT r.id,r.resource_type,r.resource_id,r.reason,r.detail,r.status,r.decision,r.created_at,
      COALESCE((SELECT json_agg(json_build_object('id',a.id,'reason',a.reason,'status',a.status,'createdAt',to_char(a.created_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"')) ORDER BY a.created_at,a.id) FROM appeal a WHERE a.report_id=r.id),'[]'::json) appeals,
      to_char(r.created_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"') cursor_created_at
      FROM report r WHERE r.reporter_user_id=$1 AND ($2::timestamptz IS NULL OR (r.created_at,r.id)<($2::timestamptz,$3::uuid))
      ORDER BY r.created_at DESC,r.id DESC LIMIT $4`,[actorId,cursor?.createdAt??null,cursor?.id??null,limit+1]);
    const more=rows.rows.length>limit,items=rows.rows.slice(0,limit).map(row=>({id:String(row.id),resourceType:row.resource_type,resourceId:String(row.resource_id),reason:row.reason,detail:row.detail??'',status:row.status,decision:row.decision??null,createdAt:iso(row.created_at),appeals:(row.appeals??[]).map((appeal:Row)=>({id:appeal.id,status:appeal.status,createdAt:appeal.createdAt})),caseKind:'report',viewerCanAppeal:false}));
    return {items,nextCursor:more&&items.length?encodeCursor(rows.rows[limit-1]!,scope):null};
  }

  async appealReport(actorId:string,reportId:string,key:string,reasonInput:string){
    requireId(reportId);const reason=typeof reasonInput==='string'?reasonInput.trim():'';if(!reason||reason.length>2000)throw invalid('INVALID_APPEAL_REASON');
    const result=await executeIdempotentCommand(this.pool,{actorUserId:actorId,operation:`report-appeal:${reportId}`,idempotencyKey:key,input:{reason} as Json},async tx=>{
      const found=await tx.query<Row>(`SELECT r.*,CASE r.resource_type WHEN 'publication' THEN (SELECT author_user_id FROM publication WHERE id=r.resource_id)
        WHEN 'comment' THEN (SELECT author_user_id FROM comment WHERE id=r.resource_id) WHEN 'repost' THEN (SELECT user_id FROM repost WHERE id=r.resource_id)
        WHEN 'profile' THEN r.resource_id ELSE (SELECT id FROM user_account WHERE id=r.resource_id) END resource_owner_id,
        (SELECT action FROM moderation_action m WHERE m.report_id=r.id ORDER BY m.created_at DESC,m.id DESC LIMIT 1) last_action
        FROM report r WHERE r.id=$1 FOR UPDATE`,[reportId]);const report=found.rows[0];
      if(!report||String(report.resource_owner_id)!==actorId||report.last_action!=='hide'||report.status!=='resolved')throw invalid('APPEAL_NOT_AVAILABLE',404);
      const previous=await tx.query("SELECT id FROM appeal WHERE report_id=$1 AND appellant_user_id=$2 LIMIT 1",[reportId,actorId]);if(previous.rowCount)throw invalid('APPEAL_ALREADY_FILED',409);
      const appealId=randomUUID();await tx.query("INSERT INTO appeal(id,report_id,appellant_user_id,status,reason,created_at) VALUES($1,$2,$3,'open',$4,CURRENT_TIMESTAMP)",[appealId,reportId,actorId,reason]);
      await tx.query("UPDATE report SET status='appealed' WHERE id=$1",[reportId]);
      const body={id:appealId,reportId,status:'open',reason,createdAt:new Date().toISOString()};
      return {status:201,body:body as unknown as Json,resourceId:appealId};
    });return result.body;
  }
}
