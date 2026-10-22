"use client";

import { useEffect, useRef, useState } from "react";
import { BookmarkSimple, Flag, ThumbsUp, UserPlus, SpeakerSlash, SpeakerHigh } from "@phosphor-icons/react";
import Link from "next/link";
import { communityRequest, commentHeaders, publicationActionPath, type CommunityState, type Viewer } from "@/lib/community";
import styles from "./community.module.css";

type ReportResource = "publication" | "comment" | "profile" | "repost";

export function PublicationActions({ publicationId, viewer, state, signInPath }: { publicationId: string; viewer: Viewer | null; state: CommunityState | null; signInPath: string }) {
  const [communityState, setCommunityState] = useState(state);
  const [loadingState, setLoadingState] = useState(state === null);
  const [stateError, setStateError] = useState("");
  const [stateRetry, setStateRetry] = useState(0);
  const [busy, setBusy] = useState("");
  const [message, setMessage] = useState("");
  const [reportOpen, setReportOpen] = useState(false);
  const login = signInPath;
  const helpful = communityState?.viewer?.helpful ?? false;
  const bookmarked = communityState?.viewer?.bookmarked ?? false;
  const helpfulCount = communityState?.helpfulCount;

  useEffect(() => {
    if (communityState !== null) return;
    let active = true;
    setLoadingState(true); setStateError("");
    communityRequest<CommunityState>(`/publications/${encodeURIComponent(publicationId)}/community`).then(result => {
      if (active) setCommunityState(result);
    }).catch(error => {
      if (active) setStateError(error instanceof Error ? error.message : "Community actions could not be loaded.");
    }).finally(() => { if (active) setLoadingState(false); });
    return () => { active = false; };
  }, [publicationId, communityState, stateRetry]);

  async function toggle(kind: "helpful" | "bookmark") {
    if (!viewer || !communityState) return;
    setBusy(kind); setMessage("");
    const current = kind === "helpful" ? helpful : bookmarked;
    try {
      await communityRequest(publicationActionPath(publicationId, kind), {
        method: current ? "DELETE" : "PUT",
        headers: commentHeaders(viewer),
      });
      setCommunityState(previous => previous && ({
        ...previous,
        helpfulCount: kind === "helpful" ? Math.max(0, previous.helpfulCount + (current ? -1 : 1)) : previous.helpfulCount,
        viewer: { helpful: kind === "helpful" ? !current : helpful, bookmarked: kind === "bookmark" ? !current : bookmarked, reposted: previous.viewer?.reposted ?? false, repostId: previous.viewer?.repostId ?? null, commentary: previous.viewer?.commentary ?? null },
      }));
    } catch (error) { setMessage(error instanceof Error ? error.message : "The action could not be saved."); }
    finally { setBusy(""); }
  }

  return <div className={styles.actionRow}>
    {viewer ? <>
      <button type="button" aria-pressed={communityState ? helpful : undefined} disabled={!!busy || !communityState} onClick={() => void toggle("helpful")}><ThumbsUp size={18} weight={helpful ? "fill" : "regular"}/> {communityState ? <>Helpful <span>{helpfulCount}</span></> : loadingState ? "Loading reactions…" : "Reactions unavailable"}</button>
      <button type="button" aria-pressed={communityState ? bookmarked : undefined} disabled={!!busy || !communityState} onClick={() => void toggle("bookmark")}><BookmarkSimple size={18} weight={bookmarked ? "fill" : "regular"}/> {communityState ? bookmarked ? "Saved" : "Save idea" : loadingState ? "Loading save state…" : "Save state unavailable"}</button>
      <button type="button" onClick={() => setReportOpen(open => !open)}><Flag size={18}/> Report</button>
    </> : <><span className={styles.meta}>{helpfulCount === undefined ? "Helpful count unavailable" : `${helpfulCount} found helpful`}</span><Link className={styles.actionButton} href={login}>Sign in to react or save</Link><Link className={styles.actionButton} href={login}>Report</Link></>}
    <span className={styles.liveStatus} aria-live="polite">{message || stateError || (busy ? "Saving…" : "")}</span>
    {state === null && !loadingState && !communityState && <button type="button" onClick={() => setStateRetry(value => value + 1)}>Retry community state</button>}
    {reportOpen && viewer && <ReportForm resourceType="publication" resourceId={publicationId} viewer={viewer} onClose={() => setReportOpen(false)}/>}
  </div>;
}

export function AuthorActions({ handle, viewer, initialFollowing, initialMuted, profileId }: { handle: string; viewer: Viewer | null; initialFollowing?: boolean; initialMuted?: boolean; profileId?: string }) {
  const [following, setFollowing] = useState(initialFollowing ?? false);
  const [muted, setMuted] = useState(initialMuted ?? false);
  const [relationshipReady, setRelationshipReady] = useState(initialFollowing !== undefined && initialMuted !== undefined);
  const [relationshipFailed, setRelationshipFailed] = useState(false);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState("");
  const [reportOpen, setReportOpen] = useState(false);
  const login = `/login?returnTo=${encodeURIComponent(`/u/${handle}`)}`;
  const self = viewer?.handle === handle;
  useEffect(() => {
    if (!viewer || relationshipReady) return;
    let active = true;
    communityRequest<{ following: boolean; muted: boolean }>(`/users/${encodeURIComponent(handle)}/relationship`).then(result => {
      if (active) { setFollowing(result.following); setMuted(result.muted); setRelationshipReady(true); setRelationshipFailed(false); }
    }).catch(() => { if (active) { setRelationshipReady(true); setRelationshipFailed(true); } });
    return () => { active = false; };
  }, [handle, viewer, relationshipReady]);
  async function update(kind: "follow" | "mute") {
    if (!viewer) return;
    const active = kind === "follow" ? following : muted;
    setBusy(true); setMessage("");
    try {
      await communityRequest(`/users/${encodeURIComponent(handle)}/${kind}`, { method: active ? "DELETE" : "PUT", headers: commentHeaders(viewer) });
      if (kind === "follow") setFollowing(!active);
      else setMuted(!active);
    } catch (error) { setMessage(error instanceof Error ? error.message : "The action could not be saved."); }
    finally { setBusy(false); }
  }
  return <div className={styles.actionRow}>
    {!self && (viewer ? <>
      <button type="button" disabled={busy || !relationshipReady || relationshipFailed} aria-pressed={following} onClick={() => void update("follow")}><UserPlus size={18}/>{!relationshipReady ? "Checking…" : relationshipFailed ? "Follow state unavailable" : following ? "Following" : "Follow"}</button>
      <button type="button" disabled={busy || !relationshipReady || relationshipFailed} aria-pressed={muted} onClick={() => void update("mute")}>{muted ? <SpeakerSlash size={18}/> : <SpeakerHigh size={18}/>} {!relationshipReady ? "Checking…" : relationshipFailed ? "Mute state unavailable" : muted ? "Muted" : "Mute"}</button>
    </> : <Link className={styles.actionButton} href={login}>Sign in to follow</Link>)}
    {!self && (viewer && profileId ? <button type="button" onClick={() => setReportOpen(open => !open)}><Flag size={18}/> Report profile</button> : !viewer && <Link className={styles.actionButton} href={login}>Sign in to report profile</Link>)}
    <span className={styles.liveStatus} aria-live="polite">{message || (relationshipFailed ? "Relationship controls could not load. Refresh to retry." : "")}</span>
    {reportOpen && viewer && profileId && <ReportForm resourceType="profile" resourceId={profileId} viewer={viewer} onClose={() => setReportOpen(false)}/>}
  </div>;
}

export function InstrumentFollow({ instrumentId, viewer, initialFollowing }: { instrumentId: string; viewer: Viewer | null; initialFollowing?: boolean | null }) {
  const [following, setFollowing] = useState(initialFollowing ?? false);
  const [relationshipReady, setRelationshipReady] = useState(initialFollowing !== undefined && initialFollowing !== null);
  const [relationshipFailed, setRelationshipFailed] = useState(false);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState("");
  useEffect(() => {
    if (!viewer || relationshipReady) return;
    let active = true;
    communityRequest<{ following: boolean }>(`/instruments/${encodeURIComponent(instrumentId)}/follow`).then(result => {
      if (active) { setFollowing(result.following); setRelationshipReady(true); setRelationshipFailed(false); }
    }).catch(() => { if (active) { setRelationshipReady(true); setRelationshipFailed(true); } });
    return () => { active = false; };
  }, [instrumentId, relationshipReady, viewer]);
  if (!viewer) return <Link className={styles.actionButton} href={`/login?returnTo=${encodeURIComponent(`/instruments/${instrumentId}`)}`}>Sign in to follow instrument</Link>;
  if (!relationshipReady || relationshipFailed) return <div className={styles.inlineAction}><button type="button" disabled>{relationshipFailed ? "Follow state unavailable" : "Checking follow state…"}</button><span role="status">{relationshipFailed ? "Instrument follow state could not load. Refresh to retry." : ""}</span></div>;
  async function toggle() {
    setBusy(true); setMessage("");
    try { await communityRequest(`/instruments/${instrumentId}/follow`, { method: following ? "DELETE" : "PUT", headers: commentHeaders(viewer!) }); setFollowing(!following); }
    catch (error) { setMessage(error instanceof Error ? error.message : "The action could not be saved."); }
    finally { setBusy(false); }
  }
  return <div className={styles.inlineAction}><button type="button" disabled={busy} aria-pressed={following} onClick={() => void toggle()}>{following ? "Following instrument" : "Follow instrument"}</button><span aria-live="polite">{message}</span></div>;
}

export function RepostActions({ publicationId, returnPath, repostId, repostAuthorId, viewer }: { publicationId: string; returnPath: string; repostId: string; repostAuthorId: string; viewer: Viewer | null }) {
  const [busy, setBusy] = useState(false);
  const [open, setOpen] = useState(false);
  const [message, setMessage] = useState("");
  if (!viewer) return <Link className={styles.actionButton} href={`/login?returnTo=${encodeURIComponent(returnPath)}`}>Sign in to report repost</Link>;
  if (viewer.id === repostAuthorId) return <div className={styles.inlineAction}><button type="button" disabled={busy} onClick={async () => {
    setBusy(true); setMessage("");
    try { await communityRequest(`/publications/${publicationId}/reposts/mine`, { method: "DELETE", headers: commentHeaders(viewer) }); setMessage("Your repost was removed. Reload this feed to refresh attribution."); }
    catch (error) { setMessage(error instanceof Error ? error.message : "Undo failed."); }
    finally { setBusy(false); }
  }}>Undo your repost</button><span role="status">{message}</span></div>;
  return <div className={styles.inlineAction}><button type="button" onClick={() => setOpen(value => !value)}><Flag size={18}/> Report repost</button>{open && <ReportForm resourceType="repost" resourceId={repostId} viewer={viewer} onClose={() => setOpen(false)}/>}</div>;
}

export function ReportForm({ resourceType, resourceId, viewer, onClose }: { resourceType: ReportResource; resourceId: string; viewer: Viewer; onClose: () => void }) {
  const [reason, setReason] = useState("misleading_performance");
  const [detail, setDetail] = useState("");
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState("");
  const [reportId,setReportId]=useState("");
  const attempt = useRef<{ payload: string; key: string } | null>(null);
  async function submit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault(); setBusy(true); setMessage("");
    try {
      const payload = JSON.stringify({ resourceType, resourceId, reason, detail });
      if (!attempt.current || attempt.current.payload !== payload) attempt.current = { payload, key: crypto.randomUUID() };
      const created = await communityRequest<{ id: string }>("/reports", { method: "POST", headers: commentHeaders(viewer, true, undefined, attempt.current.key), body: payload });
      attempt.current = null;
      setReportId(created.id);
      setMessage("Report submitted for review.");
    } catch (error) { setMessage(error instanceof Error ? error.message : "The report could not be submitted."); }
    finally { setBusy(false); }
  }
  return <form className={styles.reportForm} onSubmit={submit}>
    <label>Reason<select value={reason} onChange={event => setReason(event.target.value)}><option value="spam">Spam</option><option value="harassment">Harassment</option><option value="impersonation">Impersonation</option><option value="misleading_performance">Misleading performance claim</option><option value="undisclosed_promotion">Undisclosed promotion</option><option value="personal_information">Personal information</option><option value="other">Other</option></select></label>
    <label>Details (optional)<textarea maxLength={2000} value={detail} onChange={event => setDetail(event.target.value)} /></label>
    <div><button type="submit" disabled={busy}>{busy ? "Submitting…" : "Submit report"}</button> <button type="button" onClick={onClose}>Close</button></div><p role="status" aria-live="polite">{message}{reportId && <> <Link href={`/app/reports/${reportId}`}>View your report and appeal status</Link></>}</p>
  </form>;
}
