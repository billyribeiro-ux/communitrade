"use client";

import { useEffect, useRef, useState } from "react";
import styles from "./ShareLink.module.css";

export function ShareLink({ path, imagePath, label = "Share" }: { path: string; imagePath?: string; label?: string }) {
  const menu = useRef<HTMLDetailsElement>(null);
  const [message, setMessage] = useState("");
  const [fallback, setFallback] = useState("");
  const [nativeAvailable, setNativeAvailable] = useState(false);
  const [origin, setOrigin] = useState("");
  useEffect(() => { setNativeAvailable(typeof navigator.share === "function"); setOrigin(window.location.origin); }, []);
  useEffect(() => {
    function dismiss(event: PointerEvent) { if (menu.current && !menu.current.contains(event.target as Node)) menu.current.open = false; }
    document.addEventListener('pointerdown', dismiss);
    return () => document.removeEventListener('pointerdown', dismiss);
  }, []);
  function publicationUrl() { return new URL(path, origin || "http://localhost").toString(); }
  async function share() {
    const url = publicationUrl();
    try {
      await navigator.clipboard.writeText(url); setMessage("Link copied.");
    } catch {
      setFallback(url);
      setMessage("Clipboard access was unavailable. Copy the link below.");
    }
  }
  async function nativeShare() { try { await navigator.share({ url: publicationUrl() }); setMessage("Share sheet opened."); } catch { setMessage("The share sheet was closed."); } }
  const encodedUrl = encodeURIComponent(origin ? publicationUrl() : path);
  return <div className={styles.wrap}><details ref={menu} className={styles.menu} onKeyDown={event=>{if(event.key==='Escape'&&menu.current){menu.current.open=false;menu.current.querySelector('summary')?.focus();}}}><summary className={styles.button}>{label}</summary><div className={styles.choices}><button type="button" onClick={share}>Copy link</button>{nativeAvailable && <button type="button" onClick={nativeShare}>Share with device</button>}<a target="_blank" rel="noopener noreferrer" href={`https://twitter.com/intent/tweet?url=${encodedUrl}`}>Share on X</a><a target="_blank" rel="noopener noreferrer" href={`https://www.linkedin.com/sharing/share-offsite/?url=${encodedUrl}`}>Share on LinkedIn</a><a target="_blank" rel="noopener noreferrer" href={`https://www.reddit.com/submit?url=${encodedUrl}`}>Share on Reddit</a>{imagePath && <a href={imagePath}>Open synthetic share image</a>}<button type="button" disabled title="Internal reposting needs attribution, access control, and persistence integration">Repost unavailable · integration required</button></div></details><span className={styles.status} aria-live="polite">{message}</span>{fallback && <input className={styles.fallback} aria-label="Publication link to copy" readOnly value={fallback} onFocus={(event) => event.currentTarget.select()} />}</div>;
}
