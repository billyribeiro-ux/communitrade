# Security privacy and authorization contract

This document defines engineering controls; actual legal policy and retention exceptions require the release gates. All rules apply equally to marketing entry paths, application APIs, staff tools, images, exports and caches.

## Permissions

| Resource/action | Visitor/unverified | Verified Free/Pro | Moderator | Administrator |
| --- | --- | --- | --- | --- |
| Visible public ideas/profiles | Read if supplier/content rules permit | Same | Same | Same |
| Publish/comment/social writes | No | Own actions within common limits | Same plus assigned moderation | Same plus admin |
| Journal/draft/watchlist/export | No | Owner only | Own only | Own only; exceptional support procedure separate |
| Billing | No | Own checkout/portal/status | Own only | Audited support operations; no card details |
| Reports/appeals | Public support entry; no arbitrary case read | Own case | Assigned queue/decision | Queue/oversight |
| Roles/data/editorial/jobs | No | No | Explicit assigned moderation only | Allowlisted actions, reason, recent MFA |
| Unprocessed/private media | No | Owner/purpose-bound | No ordinary journal access | Exceptional access only |

Pro is an entitlement, not a trust/verification/administrative role. Enforce server policies at aggregate/service level; SQL filters and object storage access must not rely on UI visibility. Unauthorized private IDs return 404 consistently.

## Authentication and cookies

OIDC Authorization Code + PKCE, state/nonce and configured issuer/audience/key/time validation. Confidential client secrets stay on server. Application opaque session tokens: 256-bit cryptographic randomness, hashed at rest, rotated after login/step-up/privilege change. Production __Host-tc_session; Secure, HttpOnly, SameSite=Lax, Path=/, no Domain. Local HTTP uses a distinctly named development cookie and cannot enable those settings in production.

Member session idle timeout 30 minutes, absolute 12 hours; no remember-me in initial implementation. Staff session idle 15 minutes, absolute 8 hours; sensitive admin actions require verified MFA within five minutes. Keycloak authentication flow maps required MFA assurance; do not accept an asserted browser flag. DB/session revocation checked on every request; suspend/logout-all revoke immediately.

CSRF: secret-bound session token in X-CSRF-Token, strict allowed Origin for state changes, and no state-changing GET. Login callback uses protocol state rather than a browser CSRF header. OIDC logout verifies provider-signed logout token, event type, sid/sub and replay. Provider recovery/security changes revoke sessions through configured provider events/backchannel behavior and tested recovery flow.

## Input upload and API controls

Runtime schemas plus domain invariants; parameterized queries; escaped plain text and safe HTTPS links; no arbitrary HTML. Strict MIME/byte/dimension/decompression limits; process/re-encode images; reject active formats and path traversal. A client-supplied snapshot cannot become trusted public evidence without rendering/checking the committed chart state.

Default limits: public reads 120/minute per hashed IP with cache-aware tuning; authenticated writes 60/minute per account; login starts 10/10min per IP; comments 10/minute/account; reports 5/hour/account; support contact 3/hour/IP; uploads 10/hour/account. Posting baseline remains 10 public publications/day. Shared database-backed buckets must handle API replicas; separate provider limits apply. Record operational tuning with evidence; avoid logging raw IP indefinitely.

Use a restrictive CSP without unsafe-eval for production; allow only required assets/provider redirects. Use secure transport, HSTS after domain verification, bounded body sizes/timeouts, clickjacking protection and referrer policy. Implement webhook routes before JSON parsing when raw bytes are needed for signatures.

## Private data and support

Private responses no-store; no private React/server caches, public search joins or public image/export URLs. Validate visibility on original and derivative resources. Export downloads owner-authenticated, expiry <=24h; no permanent public bucket links. Browser/storage logs do not hold bearer tokens or private content.

Ordinary moderation sees public content and case data only. Support exception requires verified user request or documented incident purpose, admin step-up, named staff principal, specific resource scope, <=1 hour expiry, and audit; no global “view all journals” role.

## Retention implementation defaults for review

| Record | Engineering default |
| --- | --- |
| Auth transactions | <=10 minutes; purge expired rows within 24h |
| Idempotency responses | 24h minimum; purge at 48h unless investigation hold |
| Upload quarantine/unattached failures | Purge within 24h |
| Generated exports | Expire at 24h |
| App sessions | Revoke on logout; purge expired hashes within 30 days |
| Operational application logs | 30 days, redacted |
| Product events | 90 days pseudonymous; aggregate thereafter |
| Moderation/audit/support | 1 year operational default; counsel may require a narrower/longer justified schedule |
| Public publication/history | While lawfully published; privacy/moderation may require erasure/redaction |
| Private user records | Until user deletion; deletion workflow targets 30 days absent documented hold |
| Backups | Paid-provider recovery window plus approved export policy; default rolling 7-day recovery, maximum routine export retention 30 days |

These values are configuration defaults for engineering, not a published promise before counsel/operator approval. Do not collect payment card data or broker credentials. Data supplier retention restrictions can be shorter and override permission to retain quotes/snapshots.

Deletion records a minimal suppression ledger so restored backups do not resurrect erased users/assets. Remove/pseudonymize public attribution/content as approved, revoke sessions/provider linkage, expire exports, purge objects/caches/search, and handle billing records/holds under documented purpose. Do not promise immutable personal data.

## Release evidence

Cross-owner tests at every retrieval path; session/CSRF/provider replay tests; malicious upload/link/plain-text tests; staff escalation audit; secret/dependency review; deletion-after-restore drill. Critical/high unresolved privacy/security findings block external release. Reporting and staffing follow [SECURITY.md](../../SECURITY.md) and [gates](../handoff/dependencies-and-release-gates.md).


## P11 implemented collection and delivery boundary

Product measurement defaults off and requires the current `2026-10-20.v1` consent version. Stored data remains pseudonymous and owner-linked: enum-only asset/strategy/plan/surface properties, hashed business source keys and bounded event names. Private notes, thesis, titles, handles, URLs, credentials and email addresses are not permitted properties. Withdrawal deletes retained owner events atomically; a bounded hourly sweep removes events older than 90 days. Browser return events require current opt-in; activation and other contribution events originate in domain transactions. Conversion/churn requires P12 billing reconciliation. Legal review and the approved production consent copy remain G04 gates.

SMTP templates escape HTML and restrict destinations to a single mailbox, with no file/URL attachment access. Local SMTP targets Mailpit/synthetic recipients only. Digest suppression differs from transport bounce suppression, and optional preferences cannot disable mandatory account/security/billing notices. Lost SMTP acknowledgments are quarantined. Job DTOs exclude recipients, payloads and private text; unclassified snapshot SDK errors are reduced to safe stage codes before API/queue persistence so signed renderer URLs are not retained as raw queue errors. See [P11 evidence](../implementation/evidence/P11.md).


## P13 operational enforcement

Assigned moderation, independent appeals, last-admin protection, named expiring support grants, private archives and staged privacy erasure are implemented; see [P13 evidence](../implementation/evidence/P13.md). Deletion requests require explicit confirmation and recently verified identity. Finite documented holds and recoverable object checkpoints govern processing. Narrow owning-request database guards redact personal fields in frozen history while ordinary mutations remain blocked. The separately backed-up v1 HMAC suppression ledger denies both new and restored sessions before identity recreation and queues restored data for erasure. Minimal billing/audit/case evidence is retained only for its reviewed operational purpose/default retention; support records and private content are erased. Counsel and production restore evidence remain gates.
