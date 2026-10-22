"use client";

import { useEffect, useRef, useState } from 'react';
import Link from 'next/link';
import { CopyIcon, DownloadSimpleIcon, ShareNetworkIcon, ArrowsClockwiseIcon } from '@phosphor-icons/react';
import type { components } from '@trading/contracts';
import { publicationRequest, writeHeaders } from '@/lib/publications';
import { publicShareUrl, shareImagePath, socialShareLinks } from '@/lib/sharing';
import styles from './ShareMenu.module.css';

type Metadata = components['schemas']['ShareMetadata'];
type Viewer = {id:string;csrfToken:string};
type Props = {publicationId:string;title?:string;authorHandle?:string;viewer?:Viewer|null;onRepostChanged?:()=>void};

export function ShareMenu({publicationId,authorHandle,viewer,onRepostChanged}:Props) {
  const menu=useRef<HTMLDetailsElement>(null), attempt=useRef<{key:string;body:string}|null>(null);
  const [metadata,setMetadata]=useState<Metadata|null>(null),[loading,setLoading]=useState(false),[message,setMessage]=useState(''),[fallback,setFallback]=useState('');
  const [native,setNative]=useState(false),[commentary,setCommentary]=useState(''),[reposted,setReposted]=useState(false),[busy,setBusy]=useState(false);
  useEffect(()=>{
    setNative(typeof navigator.share==='function');
    function dismiss(event:PointerEvent){if(menu.current&&!menu.current.contains(event.target as Node))menu.current.open=false;}
    document.addEventListener('pointerdown',dismiss);return()=>document.removeEventListener('pointerdown',dismiss);
  },[]);
  async function load(){
    if(loading)return;setLoading(true);setMessage('');
    try{
      const {data}=await publicationRequest<Metadata>(`/publications/${publicationId}/share`);
      publicShareUrl(data.canonicalUrl,{publicationId});
      if(data.imageAllowed&&data.imageUrl)shareImagePath(data.imageUrl,publicationId,data.versionId);
      setMetadata(data);
      if(viewer){const state=await publicationRequest<components['schemas']['PublicationCommunity']>(`/publications/${publicationId}/community`);setReposted(state.data.viewer?.reposted??false);setCommentary(state.data.viewer?.commentary??'');}
    }catch(error){setMetadata(null);setMessage(error instanceof Error?error.message:'Sharing is temporarily unavailable.');}finally{setLoading(false);}
  }
  async function copy(){if(!metadata)return;try{await navigator.clipboard.writeText(metadata.canonicalUrl);setMessage('Public link copied.');setFallback('');}catch{setFallback(metadata.canonicalUrl);setMessage('Clipboard access is unavailable. Select and copy the public link below.');}}
  function nativeShare(){
    if(!metadata||typeof navigator.share!=='function')return;
    // Invoke synchronously in the click handler: an awaited fetch would lose user activation.
    void navigator.share({url:metadata.canonicalUrl,title:metadata.title}).then(()=>setMessage('Shared with your device.')).catch(error=>setMessage(error instanceof Error&&error.name==='AbortError'?'Share sheet closed.':'Device sharing is unavailable. Copy the link instead.'));
  }
  async function download(){
    if(!metadata?.imageAllowed||!metadata.imageUrl)return;setBusy(true);
    try{
      const path=shareImagePath(metadata.imageUrl,publicationId,metadata.versionId);
      const response=await fetch(path,{credentials:'same-origin',cache:'no-store',redirect:'error',signal:AbortSignal.timeout(30_000)});
      if(!response.ok||!response.headers.get('Content-Type')?.startsWith('image/webp'))throw new Error('This image is no longer available under its current source rights. Public link sharing remains available when permitted.');
      const blob=await response.blob();if(blob.size>8*1024*1024)throw new Error('The share image exceeded the supported download size.');
      const url=URL.createObjectURL(blob),link=document.createElement('a');link.href=url;link.download=`idea-${publicationId}-${metadata.versionId}.webp`;link.click();setTimeout(()=>URL.revokeObjectURL(url),1000);setMessage('Licensed share image downloaded.');
    }catch(error){setMessage(error instanceof Error?error.message:'Image download failed. You can retry or copy the link.');}finally{setBusy(false);}
  }
  async function repost(event:React.SubmitEvent<HTMLFormElement>){
    event.preventDefault();if(!viewer||busy)return;setBusy(true);
    const body=JSON.stringify({commentary:commentary.trim()});if(!attempt.current||attempt.current.body!==body)attempt.current={key:crypto.randomUUID(),body};
    try{await publicationRequest(`/publications/${publicationId}/reposts`,{method:'POST',headers:writeHeaders(viewer.csrfToken,attempt.current.key),body});setReposted(true);attempt.current=null;setMessage('Reposted with attribution to the original. This creates no trade or outcome.');onRepostChanged?.();}catch(error){setMessage(error instanceof Error?error.message:'Repost failed. Your commentary remains here.');}finally{setBusy(false);}
  }
  async function undo(){if(!viewer||busy)return;setBusy(true);try{await publicationRequest(`/publications/${publicationId}/reposts/mine`,{method:'DELETE',headers:writeHeaders(viewer.csrfToken)});setReposted(false);setCommentary('');attempt.current=null;setMessage('Repost removed.');onRepostChanged?.();}catch(error){setMessage(error instanceof Error?error.message:'Undo failed. Retry when connected.');}finally{setBusy(false);}}
  const links=metadata?socialShareLinks(metadata.canonicalUrl,metadata.title):null;
  const own=Boolean(viewer&&metadata?.author.id===viewer.id);
  return <div className={styles.wrap}><details ref={menu} className={styles.menu} onToggle={event=>{if(event.currentTarget.open)void load();}} onKeyDown={event=>{if(event.key==='Escape'&&menu.current){menu.current.open=false;menu.current.querySelector('summary')?.focus();}}}>
    <summary><ShareNetworkIcon size={18} aria-hidden="true"/>Share</summary><div className={styles.panel}>
      {loading&&<p role="status">Checking public access and image rights…</p>}
      <button type="button" disabled={!metadata||loading} onClick={copy}><CopyIcon size={18} aria-hidden="true"/>Copy link</button>
      {native&&<button type="button" disabled={!metadata||loading} onClick={nativeShare}>Share with device</button>}
      {links&&<><a href={links.x} target="_blank" rel="noopener noreferrer">Share on X</a><a href={links.linkedIn} target="_blank" rel="noopener noreferrer">Share on LinkedIn</a><a href={links.reddit} target="_blank" rel="noopener noreferrer">Share on Reddit</a></>}
      {metadata?.imageAllowed&&metadata.imageUrl?<button type="button" disabled={busy||loading} onClick={download}><DownloadSimpleIcon size={18} aria-hidden="true"/>Download licensed share image</button>:metadata&&<p>Image export is unavailable. Share this public text/link instead.</p>}
      {metadata&&<>{!viewer?<Link href={`/login?returnTo=${encodeURIComponent(`/ideas/${publicationId}/${new URL(metadata.canonicalUrl).pathname.split('/').at(-1)}`)}`}>Sign in to repost</Link>:own?<p>Share your own idea using its public link.</p>:reposted?<button type="button" disabled={busy} onClick={undo}>Undo repost</button>:<form onSubmit={repost}><label>Repost commentary (optional)<textarea maxLength={500} rows={3} value={commentary} onChange={event=>setCommentary(event.target.value)}/></label><button disabled={busy} type="submit"><ArrowsClockwiseIcon size={18} aria-hidden="true"/>{busy?'Saving…':'Repost with original attribution'}</button></form>}</>}
      {!loading&&!metadata&&<button type="button" onClick={load}>Retry public share access</button>}
      <p>Platform reposts follow source visibility. Downloaded images and external social caches cannot be recalled.</p>
      {authorHandle&&<p>Original author @{authorHandle}</p>}
    </div></details><span className={styles.status} role="status">{message}</span>{fallback&&<input className={styles.fallback} aria-label="Public link to copy" readOnly value={fallback} onFocus={event=>event.currentTarget.select()}/>}</div>;
}

export function ProfileShare({handle,displayName,canonicalUrl}:{handle:string;displayName:string;canonicalUrl?:string}){
  const [native,setNative]=useState(false),[message,setMessage]=useState(''),[fallback,setFallback]=useState('');
  useEffect(()=>setNative(typeof navigator.share==='function'),[]);
  const url=()=>publicShareUrl(canonicalUrl??new URL(`/u/${handle}`,window.location.origin).href,{handle});
  async function copy(){try{const link=url();try{await navigator.clipboard.writeText(link);setMessage('Profile link copied.');setFallback('');}catch{setFallback(link);setMessage('Select and copy the public profile link.');}}catch{setMessage('The public profile link is unavailable.');}}
  function share(){try{void navigator.share({url:url(),title:displayName}).catch(()=>setMessage('Device sharing closed or unavailable. Copy the link instead.'));}catch{setMessage('The public profile link is unavailable.');}}
  return <div className={styles.profile}><button type="button" onClick={copy}><CopyIcon size={18} aria-hidden="true"/>Copy profile link</button>{native&&<button type="button" onClick={share}><ShareNetworkIcon size={18} aria-hidden="true"/>Share profile with device</button>}<span role="status" className={styles.status}>{message}</span>{fallback&&<input className={styles.fallback} aria-label="Profile link to copy" readOnly value={fallback} onFocus={event=>event.currentTarget.select()}/>}</div>;
}
