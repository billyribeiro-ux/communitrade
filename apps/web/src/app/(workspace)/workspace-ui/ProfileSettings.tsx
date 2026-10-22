"use client";

import { useRef, useState } from "react";
import { Avatar } from "@trading/ui";
import { ArrowClockwise, ImageSquare, Trash } from "@phosphor-icons/react";
import { AVATAR_MAX_BYTES, avatarDimensionsSupported, validateAvatarFile } from "@/lib/profile-image-validation";
import styles from "./profile-settings.module.css";

type Profile = { user: { handle: string; displayName: string; avatarUrl: string | null; pro: boolean }; bio: string; links: string[]; interests: string[]; revision: number };
type Media = { id: string; status: "processing" | "ready" | "rejected"; purpose: string; url: string | null; reason: string | null };

function cropBlob(image: HTMLImageElement, x: number, y: number, zoom: number): Promise<Blob> {
  const side = Math.min(image.naturalWidth, image.naturalHeight) / zoom;
  const maxLeft = image.naturalWidth - side; const maxTop = image.naturalHeight - side;
  const sourceX = Math.max(0, Math.min(maxLeft, maxLeft * x)); const sourceY = Math.max(0, Math.min(maxTop, maxTop * y));
  const canvas = document.createElement("canvas"); canvas.width = 512; canvas.height = 512;
  const context = canvas.getContext("2d"); if (!context) return Promise.reject(new Error("Image crop is unavailable in this browser."));
  context.drawImage(image, sourceX, sourceY, side, side, 0, 0, 512, 512);
  return new Promise((resolve, reject) => canvas.toBlob(blob => blob ? resolve(blob) : reject(new Error("The selected image could not be cropped. Try another image.")), "image/jpeg", 0.9));
}

export function ProfileSettings({ profile, csrfToken, etag }: { profile: Profile; csrfToken: string; etag: string }) {
  const inputRef = useRef<HTMLInputElement>(null);
  const imageRef = useRef<HTMLImageElement>(null);
  const [file, setFile] = useState<File | null>(null); const [preview, setPreview] = useState("");
  const [cropX, setCropX] = useState(.5); const [cropY, setCropY] = useState(.5); const [zoom, setZoom] = useState(1);
  const [removeAvatar, setRemoveAvatar] = useState(false); const [busy, setBusy] = useState(false); const [message, setMessage] = useState(""); const [error, setError] = useState(""); const [conflict, setConflict] = useState(false);

  function chooseFile(next: File | undefined) {
    setMessage(""); setError(""); setRemoveAvatar(false);
    if (!next) return;
    const fileProblem = validateAvatarFile(next.type, next.size);
    if (fileProblem === 'type') { setError("Choose a JPEG, PNG, or WebP image. The current avatar has not changed."); if (inputRef.current) inputRef.current.value = ""; return; }
    if (fileProblem === 'size') { setError("Choose an image no larger than 2 MiB. The current avatar has not changed."); if (inputRef.current) inputRef.current.value = ""; return; }
    const objectUrl = URL.createObjectURL(next); const image = new Image();
    image.onload = () => { if (!avatarDimensionsSupported(image.naturalWidth, image.naturalHeight)) { URL.revokeObjectURL(objectUrl); setError("This image's dimensions are outside the supported range. Choose another image; your current avatar is unchanged."); return; } setFile(next); setPreview(objectUrl); setCropX(.5); setCropY(.5); setZoom(1); };
    image.onerror = () => { URL.revokeObjectURL(objectUrl); setError("This image could not be opened. Your current avatar is unchanged."); }; image.src = objectUrl;
  }
  function resetCrop() { setCropX(.5); setCropY(.5); setZoom(1); }
  function cancelNewImage() { if (preview) URL.revokeObjectURL(preview); setPreview(""); setFile(null); resetCrop(); if (inputRef.current) inputRef.current.value = ""; }
  async function uploadAvatar(): Promise<string | null> {
    const image = imageRef.current;
    if (!file || !image) return null;
    await image.decode();
    const blob = await cropBlob(image, cropX, cropY, zoom);
    if (blob.size > AVATAR_MAX_BYTES) throw new Error("The cropped image is larger than 2 MiB. Reduce the crop or choose a smaller image.");
    const intentResponse = await fetch("/api/v1/uploads", { method: "POST", credentials: "same-origin", cache: "no-store", headers: { "Content-Type": "application/json", "X-CSRF-Token": csrfToken, "Idempotency-Key": crypto.randomUUID() }, body: JSON.stringify({ purpose: "avatar", filename: file.name.slice(0, 190), mime: "image/jpeg", sizeBytes: blob.size }) });
    if (!intentResponse.ok) throw new Error(await problemDetail(intentResponse, "We could not prepare this image upload."));
    const upload = await intentResponse.json() as { id: string; uploadUrl: string };
    if (!/^[0-9a-f-]{36}$/i.test(upload.id)) throw new Error("The upload service returned an invalid upload reference.");
    const bytesResponse = await fetch(`/api/v1/uploads/${upload.id}/content`, { method: "POST", credentials: "same-origin", cache: "no-store", headers: { "Content-Type": "image/jpeg", "X-CSRF-Token": csrfToken }, body: blob });
    if (!bytesResponse.ok) throw new Error(await problemDetail(bytesResponse, "The image could not be uploaded. Your current avatar is unchanged."));
    const completeResponse = await fetch(`/api/v1/uploads/${upload.id}/complete`, { method: "POST", credentials: "same-origin", cache: "no-store", headers: { "X-CSRF-Token": csrfToken, "Idempotency-Key": crypto.randomUUID() } });
    if (!completeResponse.ok && completeResponse.status !== 202) throw new Error(await problemDetail(completeResponse, "The image could not be processed. Your current avatar is unchanged."));
    const initial = await completeResponse.json().catch(() => null) as Media | null;
    const mediaId = initial?.id ?? upload.id;
    for (let attempt = 0; attempt < 24; attempt++) {
      const response = await fetch(`/api/v1/media/${mediaId}`, { credentials: "same-origin", cache: "no-store" });
      if (response.status === 401) { window.location.assign(`/login?returnTo=${encodeURIComponent("/app/profile")}`); throw new Error("Your session expired. Sign in again to continue."); }
      if (!response.ok) throw new Error("The image processing result is unavailable. Your current avatar is unchanged.");
      const media = await response.json() as Media;
      if (media.status === "ready" && media.purpose === "avatar") return media.id;
      if (media.status === "rejected") throw new Error(media.reason || "This image was rejected. Choose a different image; your current avatar is unchanged.");
      await new Promise(resolve => setTimeout(resolve, 750));
    }
    throw new Error("Image processing is taking longer than expected. Your current avatar is unchanged; retry after processing completes.");
  }
  async function problemDetail(response: Response, fallback: string) { if (response.status === 401) { window.location.assign(`/login?returnTo=${encodeURIComponent("/app/profile")}`); return "Your session expired. Sign in again to continue."; } const body = await response.json().catch(() => null); return typeof body?.detail === "string" ? body.detail : fallback; }
  async function save(form: FormData) {
    setError(""); setMessage(""); setConflict(false); setBusy(true);
    try {
      const avatarMediaId = removeAvatar ? null : preview ? await uploadAvatar() : undefined;
      const bio = String(form.get("bio") ?? "");
      const displayName = String(form.get("displayName") ?? "").trim();
      const handle = String(form.get("handle") ?? "").trim().toLowerCase();
      const link = String(form.get("link") ?? "").trim();
      const interests = form.getAll("interests").map(String);
      const payload: Record<string, unknown> = { bio, displayName, handle, links: link ? [link] : [], interests };
      if (avatarMediaId !== undefined) payload.avatarMediaId = avatarMediaId;
      const response = await fetch("/api/v1/me/profile", { method: "PATCH", credentials: "same-origin", cache: "no-store", headers: { "Content-Type": "application/json", "X-CSRF-Token": csrfToken, "If-Match": etag }, body: JSON.stringify(payload) });
      if (response.status === 401) { window.location.assign(`/login?returnTo=${encodeURIComponent("/app/profile")}`); return; }
      if (response.status === 409) { setConflict(true); setError("Your profile changed in another session. Reload the current profile before saving; your edits were not applied."); return; }
      if (!response.ok) { setError(await problemDetail(response, "The profile could not be saved. Your existing public profile and avatar are unchanged.")); return; }
      setMessage("Profile saved."); window.location.assign("/app/profile?updated=1");
    } catch (cause) { setError(cause instanceof Error ? cause.message : "The profile could not be saved."); }
    finally { setBusy(false); }
  }
  return <div className={styles.columns}>
    <form className={styles.card} action={save}>
      <h2>Edit your public profile</h2><p>These fields appear on your public author page. Your email and account security details stay private.</p>
      <div className={styles.avatarLine}><Avatar name={profile.user.displayName} src={removeAvatar ? null : preview || profile.user.avatarUrl} size="large"/><div><button type="button" onClick={() => inputRef.current?.click()}><ImageSquare aria-hidden="true" size={18}/>Choose image</button><button type="button" disabled={!profile.user.avatarUrl && !preview} onClick={() => { cancelNewImage(); setRemoveAvatar(true); setError(""); }}><Trash aria-hidden="true" size={18}/>Remove</button><input ref={inputRef} hidden accept="image/jpeg,image/png,image/webp" type="file" onChange={event => chooseFile(event.currentTarget.files?.[0])}/><small>JPEG, PNG, or WebP · up to 2 MiB</small></div></div>
      {preview && <section className={styles.cropBox} aria-labelledby="crop-title"><h3 id="crop-title">Adjust square crop</h3><p>Move the image horizontally and vertically, then adjust zoom. This preview is not saved until you save the profile.</p><div className={styles.cropPreview}><img ref={imageRef} src={preview} alt="Selected image crop preview" style={{ objectPosition: `${cropX * 100}% ${cropY * 100}%`, transform: `scale(${zoom})` }}/></div><label>Horizontal position<input type="range" min="0" max="100" value={Math.round(cropX * 100)} onChange={event => setCropX(Number(event.target.value) / 100)}/></label><label>Vertical position<input type="range" min="0" max="100" value={Math.round(cropY * 100)} onChange={event => setCropY(Number(event.target.value) / 100)}/></label><label>Zoom<input type="range" min="100" max="250" value={Math.round(zoom * 100)} onChange={event => setZoom(Number(event.target.value) / 100)}/></label><button type="button" onClick={resetCrop}><ArrowClockwise aria-hidden="true" size={18}/>Reset crop</button><button type="button" onClick={cancelNewImage}>Discard selected image</button></section>}
      <label>Display name<input name="displayName" required minLength={2} maxLength={60} defaultValue={profile.user.displayName}/></label>
      <label>Handle<input name="handle" required minLength={3} maxLength={30} pattern="[a-z0-9_]{3,30}" defaultValue={profile.user.handle}/><small>Handles can be changed once every 30 days.</small></label>
      <label>Bio<textarea name="bio" maxLength={500} rows={5} defaultValue={profile.bio}/></label>
      <label>Public website (HTTPS)<input name="link" type="url" pattern="https://.*" defaultValue={profile.links[0] ?? ""} placeholder="https://example.com"/></label>
      <fieldset><legend>Interests</legend>{([{value:"stock",label:"Stocks"},{value:"option",label:"Options"},{value:"future",label:"Futures"}] as const).map(({value,label})=><label className={styles.check} key={value}><input type="checkbox" name="interests" value={value} defaultChecked={profile.interests.includes(value)}/>{label}</label>)}</fieldset>
      {error && <p role="alert" className={styles.error}>{error}</p>}{conflict && <button type="button" onClick={() => window.location.reload()}>Reload current profile</button>}{message && <p role="status" className={styles.success}>{message}</p>}
      <button disabled={busy} type="submit">{busy ? "Saving profile…" : "Save profile"}</button>
    </form>
    <aside className={styles.card}><h2>Public profile</h2><div className={styles.publicHeader}><Avatar name={profile.user.displayName} src={removeAvatar ? null : preview || profile.user.avatarUrl} size="large"/><div><strong>{profile.user.displayName}</strong><p>@{profile.user.handle}</p></div></div><p>{profile.bio || "Add a short bio to introduce your research process."}</p>{profile.links.map(url => <p key={url}><a href={url} rel="noopener noreferrer">{url}</a></p>)}<p><a href={`/u/${profile.user.handle}`}>View public profile</a></p><p className={styles.privateNote}>Only your processed, ready avatar is shown publicly. Failed uploads leave your current avatar in place.</p></aside>
  </div>;
}
