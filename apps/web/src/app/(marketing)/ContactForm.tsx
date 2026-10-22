"use client";
import { useRef, useState } from "react";
import type { FormEvent } from "react";
import styles from "./marketing.module.css";

export function ContactForm({ csrfToken, accountEmail, canSubmit = true }: { csrfToken?: string; accountEmail?: string; canSubmit?: boolean }) {
  const [pending, setPending] = useState(false);
  const [reference, setReference] = useState("");
  const [error, setError] = useState("");
  const [subjectLength, setSubjectLength] = useState(0);
  const [messageLength, setMessageLength] = useState(0);
  const idempotencyKey = useRef<string | null>(null);
  const busy = useRef(false);
  const resetForEdit = () => { setReference(""); setError(""); idempotencyKey.current = null; };

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (busy.current) return;
    busy.current = true;
    setPending(true); setError(""); setReference("");
    const formElement = event.currentTarget;
    const form = new FormData(formElement);
    idempotencyKey.current ??= crypto.randomUUID();
    try {
      const response = await fetch("/api/v1/support", {
        method: "POST",
        headers: { "Content-Type": "application/json", "Idempotency-Key": idempotencyKey.current, ...(csrfToken ? { "X-CSRF-Token": csrfToken } : {}) },
        body: JSON.stringify({ email: form.get("email"), category: form.get("category"), subject: form.get("subject"), message: form.get("message"), consent: form.get("consent") === "on" })
      });
      const result = await response.json();
      if (!response.ok) throw new Error(result?.detail || result?.title || "We could not submit this request. Please try again.");
      const ticketReference = result?.reference ?? result?.requestId;
      const ticketId = typeof result?.id === "string" ? result.id : "";
      if (typeof ticketReference !== "string" || !ticketReference) throw new Error("The request was received, but a reference could not be displayed. Please contact support when the staffed channel is published.");
      setReference(ticketId ? `${ticketReference}|${ticketId}` : ticketReference); idempotencyKey.current = null; setSubjectLength(0); setMessageLength(0); formElement.reset();
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "The request could not be submitted. Please try again.");
    } finally {
      busy.current = false;
      setPending(false);
    }
  }

  return <form className={styles.contactForm} onSubmit={submit} onChange={resetForEdit}>
    <fieldset disabled={pending || !canSubmit} className={styles.formFields}>
      <label>Email address<input name="email" type="email" required maxLength={254} autoComplete="email" defaultValue={accountEmail} readOnly={!!accountEmail} /></label>
      <label>Category<select name="category" required defaultValue=""><option value="" disabled>Select a category</option><option value="account">Account access</option><option value="billing">Billing</option><option value="data">Market data</option><option value="privacy">Privacy</option><option value="accessibility">Accessibility</option><option value="other">Product question or other</option></select></label>
      <label>Subject<input id="contact-subject" name="subject" required minLength={1} maxLength={120} aria-describedby="subject-count" onChange={event => setSubjectLength(event.target.value.length)} /></label>
      <span id="subject-count" className={styles.fieldCount} aria-live="polite">{subjectLength}/120 characters</span>
      <label>Message<textarea id="contact-message" name="message" required minLength={1} maxLength={5000} rows={6} aria-describedby="message-count" onChange={event => setMessageLength(event.target.value.length)} /></label>
      <span id="message-count" className={styles.fieldCount} aria-live="polite">{messageLength}/5000 characters</span>
      <label className={styles.consent}><input name="consent" type="checkbox" required /><span>I agree that this message and my email may be used to respond to this request under the draft privacy notice, version 2026-10-19.draft-1. Do not include sensitive account or financial information.</span></label>
      <button className={styles.button} type="submit">{pending ? "Sending…" : "Send request"}</button>
    </fieldset>
    {!canSubmit && <p role="status" className={styles.formError}>Verify your email before sending a support request from this account. <a href="/verify-email?returnTo=%2Fcontact">Continue to verification</a></p>}
    {error && <p role="alert" className={styles.formError}>{error}</p>}
    {reference && <p role="status" className={styles.formSuccess}>Request received. Reference: <strong>{reference.split("|")[0]}</strong>. {reference.includes("|") ? <>Use <a href={`/support/requests/${encodeURIComponent(reference.split("|")[1]??"")}${accountEmail?"":"/claim"}`}>your private request page</a> to follow up. If you sent this as a visitor, sign in with the same email and claim the request.</> : "Save this reference for follow-up."}</p>}
  </form>;
}
