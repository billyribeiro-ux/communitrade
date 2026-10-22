"use client";

import Link from "next/link";
import { useEffect, useMemo, useRef, useState } from "react";
import { Avatar } from "@trading/ui";
import { ArrowBendUpLeft, Flag, PencilSimple, Trash } from "@phosphor-icons/react";
import { commentHeaders, communityDate, communityRequest, flattenComments, idempotencyAttempt, type CommentPage, type CommunityComment, type IdempotencyAttempt, type Viewer } from "@/lib/community";
import { ReportForm } from "./CommunityActions";
import styles from "./community.module.css";

export function Discussion({ publicationId, returnPath, viewer, initialComments, initialError }: { publicationId: string; returnPath: string; viewer: Viewer | null; initialComments?: CommentPage | null; initialError?: string }) {
  const [comments, setComments] = useState(initialComments?.items ?? []);
  const [nextCursor, setNextCursor] = useState(initialComments?.nextCursor ?? null);
  const [error, setError] = useState(initialError ?? "");
  const [loading, setLoading] = useState(!initialComments && !initialError);
  const [busy, setBusy] = useState(false);
  const [body, setBody] = useState("");
  const [tag, setTag] = useState("");
  const [replyToId, setReplyToId] = useState<string | null>(null);
  const [editTarget, setEditTarget] = useState<CommunityComment | null>(null);
  const [reportTarget, setReportTarget] = useState<CommunityComment | null>(null);
  const [message, setMessage] = useState("");
  const createAttempt = useRef<IdempotencyAttempt | null>(null);
  const loginReturnPath = returnPath;
  const grouped = useMemo(() => flattenComments(comments), [comments]);

  useEffect(() => {
    if (initialComments || initialError) return;
    let active = true;
    communityRequest<CommentPage>(`/publications/${publicationId}/comments?limit=50`).then(page => {
      if (active) { setComments(page.items); setNextCursor(page.nextCursor); setLoading(false); }
    }).catch(reason => { if (active) { setError(reason instanceof Error ? reason.message : "Comments could not be loaded."); setLoading(false); } });
    return () => { active = false; };
  }, [publicationId, initialComments, initialError]);

  function resetComposer() { setBody(""); setTag(""); setReplyToId(null); setEditTarget(null); }
  async function submit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault(); if (!viewer || !body.trim()) return;
    setBusy(true); setMessage(""); setError("");
    try {
      if (editTarget) {
        const updated = await communityRequest<CommunityComment>(`/comments/${editTarget.id}`, { method: "PATCH", headers: commentHeaders(viewer, false, editTarget.revision), body: JSON.stringify({ body: body.trim(), tag: tag || null }) });
        setComments(items => items.map(item => item.id === updated.id ? updated : item));
        setMessage("Comment updated.");
      } else {
        const payload = JSON.stringify({ body: body.trim(), ...(replyToId ? { replyToId } : {}), ...(tag ? { tag } : {}) });
        createAttempt.current = idempotencyAttempt(createAttempt.current, payload);
        const created = await communityRequest<CommunityComment>(`/publications/${publicationId}/comments`, { method: "POST", headers: commentHeaders(viewer, true, undefined, createAttempt.current.key), body: payload });
        setComments(items => [...items, created]); setMessage("Comment posted.");
        createAttempt.current = null;
      }
      resetComposer();
    } catch (reason) { setMessage(reason instanceof Error ? reason.message : "The comment could not be saved."); }
    finally { setBusy(false); }
  }
  async function loadMore() {
    if (!nextCursor || busy) return;
    setBusy(true); setError("");
    try { const page = await communityRequest<CommentPage>(`/publications/${publicationId}/comments?${new URLSearchParams({ limit: "50", cursor: nextCursor })}`); setComments(items => [...items, ...page.items]); setNextCursor(page.nextCursor); }
    catch (reason) { setError(reason instanceof Error ? reason.message : "More comments could not be loaded."); }
    finally { setBusy(false); }
  }
  async function remove(comment: CommunityComment) {
    if (!viewer || !window.confirm("Delete this comment? Replies will remain in the discussion.")) return;
    setBusy(true); setMessage("");
    try {
      await communityRequest(`/comments/${comment.id}`, { method: "DELETE", headers: commentHeaders(viewer, false, comment.revision) });
      setComments(items => items.map(item => item.id === comment.id ? { ...item, body: "", deleted: true } : item));
      setMessage("Comment deleted. Replies remain attached to this thread.");
    } catch (reason) { setMessage(reason instanceof Error ? reason.message : "The comment could not be deleted."); }
    finally { setBusy(false); }
  }
  function beginReply(comment: CommunityComment) {
    setEditTarget(null); setReplyToId(comment.id); setBody(comment.deleted ? "" : `@${comment.author.handle} `); setTag("");
    document.getElementById("community-comment-body")?.focus();
  }
  function beginEdit(comment: CommunityComment) { setReplyToId(null); setEditTarget(comment); setBody(comment.body); setTag(comment.tag ?? ""); document.getElementById("community-comment-body")?.focus(); }

  return <section className={styles.discussion} aria-labelledby="discussion-heading">
    <div><h2 id="discussion-heading">Discussion</h2><p className={styles.meta}>Comments are plain text. Replies keep their original target and appear in a two-level thread.</p></div>
    {viewer ? <form className={styles.commentForm} onSubmit={submit}>
      <label htmlFor="community-comment-body">{editTarget ? "Edit comment" : replyToId ? `Replying to @${comments.find(item => item.id === replyToId)?.author.handle ?? "member"}` : "Add a comment"}</label>
      <textarea id="community-comment-body" maxLength={2000} required value={body} onChange={event => setBody(event.target.value)} placeholder="Share a question, risk, or alternative view…" aria-describedby="community-comment-help" />
      <span id="community-comment-help" className={styles.meta}>Mention an existing member with @handle. Images are not supported in comments.</span>
      {!editTarget && <label>Response tag<select value={tag} onChange={event => setTag(event.target.value)}><option value="">No tag</option><option value="question">Question</option><option value="counterargument">Counterargument</option><option value="alternative">Alternative</option><option value="risk">Risk</option></select></label>}
      <footer><span>{body.length}/2,000{replyToId ? ` · Reply target preserved` : ""}</span><span><button type="submit" disabled={busy || !body.trim()}>{busy ? "Saving…" : editTarget ? "Save edit" : "Post comment"}</button> {(replyToId || editTarget) && <button type="button" onClick={resetComposer}>Cancel</button>}</span></footer>
      <p role="status" aria-live="polite">{message}</p>
    </form> : <section className={styles.empty}><p>Sign in with a verified account to join the discussion.</p><Link href={`/login?returnTo=${encodeURIComponent(loginReturnPath)}`}>Sign in</Link></section>}
    {loading && <p role="status">Loading comments…</p>}
    {error && <p className={styles.failure} role="alert">{error}</p>}
    {!loading && !error && grouped.length === 0 && <section className={styles.empty}><p>No comments yet. The discussion is open for questions and risk notes.</p></section>}
    <div className={styles.commentList}>{grouped.map(({ root, replies }) => <article className={styles.comment} key={root.id}>
      <CommentItem returnPath={loginReturnPath} comment={root} viewer={viewer} busy={busy} onReply={beginReply} onEdit={beginEdit} onDelete={remove} onReport={setReportTarget}/>
      {replies.map(reply => <div className={styles.reply} key={reply.id}><CommentItem returnPath={loginReturnPath} comment={reply} viewer={viewer} busy={busy} onReply={beginReply} onEdit={beginEdit} onDelete={remove} onReport={setReportTarget} /></div>)}
    </article>)}</div>
    {nextCursor && <div className={styles.pagination}><button type="button" className={styles.loadMore} disabled={busy} onClick={() => void loadMore()}>{busy ? "Loading…" : "Load more comments"}</button></div>}
    {reportTarget && viewer && <ReportForm resourceType="comment" resourceId={reportTarget.id} viewer={viewer} onClose={() => setReportTarget(null)}/>}
  </section>;
}

function CommentItem({ returnPath, comment, viewer, busy, onReply, onEdit, onDelete, onReport }: { returnPath: string; comment: CommunityComment; viewer: Viewer | null; busy: boolean; onReply: (comment: CommunityComment) => void; onEdit: (comment: CommunityComment) => void; onDelete: (comment: CommunityComment) => void; onReport: (comment: CommunityComment) => void }) {
  const own = viewer?.id === comment.author.id;
  return <div>
    <div className={styles.author}><Avatar name={comment.author.displayName} src={comment.author.avatarUrl} size="small"/><span>{comment.deleted?<span>Deleted or unavailable member</span>:<Link className={styles.authorLink} href={`/u/${comment.author.handle}`}>{comment.author.displayName} · @{comment.author.handle}</Link>}<br/><time className={styles.meta} dateTime={comment.createdAt}>{communityDate(comment.createdAt)}</time>{comment.editedAt && <> · <span className={styles.meta}>edited</span></>}{comment.tag && <> · <span className={styles.badge}>{comment.tag}</span></>}</span></div>
    <p className={styles.commentBody}>{comment.deleted ? <em>This comment was deleted or is unavailable. Its replies are preserved.</em> : renderMentions(comment.body, comment.mentions)}</p>
    <div className={styles.commentActions}>
      {!comment.deleted && <button type="button" disabled={!viewer || busy} onClick={() => onReply(comment)}><ArrowBendUpLeft size={16}/> Reply</button>}
      {!comment.deleted && own && <><button type="button" disabled={busy} onClick={() => onEdit(comment)}><PencilSimple size={16}/> Edit</button><button type="button" disabled={busy} onClick={() => void onDelete(comment)}><Trash size={16}/> Delete</button></>}
      {!comment.deleted && !own && (viewer ? <button type="button" onClick={() => onReport(comment)}><Flag size={16}/> Report</button> : <Link href={`/login?returnTo=${encodeURIComponent(returnPath)}`}>Sign in to report</Link>)}
    </div>
  </div>;
}

function renderMentions(body: string, mentions?: CommunityComment["mentions"]) {
  if (!mentions?.length) return body;
  const tokens: Array<string | React.ReactNode> = [];
  const handleMap = new Map(mentions.map(item => [item.handle.toLowerCase(), item.handle]));
  const regex = /@([a-z0-9_]{3,30})/gi;
  let cursor = 0; let match: RegExpExecArray | null;
  while ((match = regex.exec(body))) {
    const handle = handleMap.get((match[1] ?? "").toLowerCase()); if (!handle) continue;
    tokens.push(body.slice(cursor, match.index), <Link key={`${match.index}-${handle}`} href={`/u/${handle}`}>@{handle}</Link>);
    cursor = match.index + match[0].length;
  }
  if (!tokens.length) return body;
  tokens.push(body.slice(cursor)); return tokens;
}
