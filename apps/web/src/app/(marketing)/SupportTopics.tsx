"use client";
import { useMemo, useState } from "react";
import styles from "./marketing.module.css";

const topics = [
  ["Accounts and access", "Registration, email verification, provider sign-in, and account recovery will be available when registration opens."],
  ["Billing and cancellation", "Pro checkout is not active in this preview. The planned policy preserves paid access through the paid period and keeps records accessible after downgrade."],
  ["Market data", "Data is intended to be licensed and delayed. Supported displays should show source, timestamp, delay, and stale-data state."],
  ["Reported results", "Execution reports are member-reported and are not checked against broker records. Cost coverage and unresolved items should be visible."],
  ["Private drafts and journals", "Drafts and personal journal notes are designed to be owner-only. Published chart notes are public with their publication."],
  ["Requesting help", "The Contact form accepts a request and returns a reference. Response coverage is not announced, and the reference does not grant authenticated ticket access."]
];

export function SupportTopics() {
  const [query, setQuery] = useState("");
  const matches = useMemo(() => topics.filter(([title, body]) => `${title} ${body}`.toLowerCase().includes(query.trim().toLowerCase())), [query]);
  return <><label className={styles.searchLabel}>Search help topics<input type="search" value={query} onChange={event => setQuery(event.target.value)} placeholder="Search accounts, data, billing…" /></label><div aria-live="polite" className={styles.prose}>{matches.length ? matches.map(([title, body]) => <section key={title}><h2>{title}</h2><p>{body}</p></section>) : <p>No topics match “{query}”. Try another term or use Contact.</p>}</div></>;
}
