import assert from "node:assert/strict";
import test from "node:test";
import { commentHeaders, flattenComments, idempotencyAttempt, withCommunityQuery, publicationActionPath } from "../src/lib/community.ts";
import fs from 'node:fs';

test('Helpful uses the original-publication reaction contract rather than an invented route',()=>{
 const api=JSON.parse(fs.readFileSync(new URL('../../../contracts/openapi.json',import.meta.url)));
 assert.equal(publicationActionPath('{id}','helpful'),'/publications/{id}/reaction');
 assert.equal(api.paths[publicationActionPath('{id}','helpful')].put.operationId,'setReaction');
 assert.equal(api.paths[publicationActionPath('{id}','bookmark')].put.operationId,'setBookmark');
});

const author = { id: "member-a", handle: "member_a", displayName: "Member A", avatarUrl: null, pro: false };
function comment(id, replyToId, extra = {}) {
  return { id, publicationId: "publication-1", author, body: id, replyToId, rootId: null, replyToAuthorHandle: replyToId ? author.handle : null, mentions: [], tag: null, createdAt: "2026-10-20T12:00:00.000Z", editedAt: null, deleted: false, revision: 1, ...extra };
}

test("flattenComments groups deep replies across cursor pages without changing reply targets", () => {
  const firstPage = [comment("root", null)];
  const secondPage = [comment("reply", "root", { rootId: "root" }), comment("deep-reply", "reply", { rootId: "root" })];

  const [thread] = flattenComments([...firstPage, ...secondPage]);
  assert.equal(thread.root.id, "root");
  assert.deepEqual(thread.replies.map(item => item.id), ["reply", "deep-reply"]);
  assert.equal(thread.replies[1].replyToId, "reply");
  assert.equal(thread.replies[1].rootId, "root");
});

test("flattenComments resolves a missing rootId by walking loaded reply targets", () => {
  const root = comment("root", null);
  const reply = comment("reply", "root");
  const deepReply = comment("deep", "reply");
  delete reply.rootId;
  delete deepReply.rootId;

  const [thread] = flattenComments([root, deepReply, reply]);
  assert.equal(thread.root.id, "root");
  assert.deepEqual(thread.replies.map(item => item.id), ["deep", "reply"]);
  assert.equal(thread.replies[0].replyToId, "reply");
});

test("flattenComments keeps deleted roots and their reply structure", () => {
  const root = comment("root", null, { deleted: true, body: "" });
  const reply = comment("reply", "root", { rootId: "root" });
  const [thread] = flattenComments([root, reply]);
  assert.equal(thread.root.deleted, true);
  assert.equal(thread.replies[0].replyToId, "root");
});

test("community query values are URL encoded and omit absent filters", () => {
  assert.equal(
    withCommunityQuery("/publications", { q: 'SPY & "risk"', feed: "discover", status: undefined }),
    "/publications?q=SPY+%26+%22risk%22&feed=discover",
  );
});

test("idempotency retries reuse a key for identical payload and rotate it for changed payload", () => {
  let issued = 0;
  const nextKey = () => `attempt-${++issued}`;
  const original = idempotencyAttempt(null, '{"body":"hello"}', nextKey);
  const retry = idempotencyAttempt(original, '{"body":"hello"}', nextKey);
  const edited = idempotencyAttempt(retry, '{"body":"edited"}', nextKey);

  assert.equal(retry.key, original.key);
  assert.equal(edited.key, "attempt-2");
  assert.deepEqual(commentHeaders({ ...author, csrfToken: "csrf" }, true, undefined, retry.key), {
    "X-CSRF-Token": "csrf",
    "Idempotency-Key": "attempt-1",
  });
});
