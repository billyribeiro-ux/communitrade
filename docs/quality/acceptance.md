# Acceptance testing and completion evidence

Requirement IDs map to one primary scenario below and additional cross-cutting checks. The repository has P01–P14 local engineering evidence, but this is a local acceptance candidate, not a release approval. A checkbox or test file alone is not evidence of a pass. The milestone records ([P01](../implementation/evidence/P01.md) through [P14](../implementation/evidence/P14.md)) describe commands actually run and their scope; the [P14 AC matrix](p14-acceptance-matrix.md) maps each scenario to existing automated evidence and its remaining gaps. Automated HTTP, domain, and PostgreSQL coverage does not establish rendered browser/assistive-technology acceptance, real-provider approval, legal/commercial approval, or production recovery. The P14 accessibility source review explicitly leaves manual browser checks not run, and the release status remains NO_GO until the applicable acceptance and external gates are evidenced. P05/P06 mocks do not close supplier/legal approvals.

| Acceptance | Scenario and expected outcome |
| --- | --- |
| AC-001 | Marketing -> pricing -> Free/annual Pro entry preserves intent; already-Pro user routes to billing; no fictional claims; all footer pages exist. |
| AC-002 | Register through local OIDC, verify email, onboard, recover access; unverified and invalid callback/state/nonce cannot participate. |
| AC-003 | Test visitor, unverified, Free, Pro, moderator, admin and suspended accounts. Owner B cannot read/write owner A's private objects; revocation/step-up/CSRF enforced. |
| AC-004 | Upload/crop/remove avatar, update bio/handle/links, inspect public cards and profile; rejected image/duplicate handle/private email leakage cases. |
| AC-005 | Dashboard shows only own draft/journal/usage data, useful empty states, keyboard/mobile navigation and stable deep links. |
| AC-006 | Search valid stock, option contracts and each futures root; contract validation, dataset licensing capabilities, stale/missing data and production fixture refusal. |
| AC-007 | Render candles/volume/EMAs/intervals/sessions; pan/zoom/resize, DST/holiday/overnight and React remount cleanup; no data invention. |
| AC-008 | Create/edit/move/delete all drawing families, 50-object bound, undo/redo, text/keyboard alternatives and serialization round trip. |
| AC-009 | Draft autosave/reload, concurrent tab conflict, failed upload preservation, publish retry, required snapshot completion and second-device readback. |
| AC-010 | Original snapshot/terms immutable; approved correction is visible/versioned, rejected proposal not silently applied; historical versions and derivative images remain consistent. |
| AC-011 | Pending/entry/partial/final/cancel/never-entered/unresolved transitions; quantity bounds, max partials, invalid chronology, expiry and assignment exception review. |
| AC-012 | Execute every signed/partial/cost/rounding fixture in data model; property checks for quantity/cashflow conservation; no floating-point money drift. |
| AC-013 | Verify wins/(wins+losses), separate breakevens/unresolved/retrospective/incomplete costs, one position per outcome and no paid/unverified ranking boost. |
| AC-014 | Following/Discover/editorial filters, public full-text query, keyset pagination, author/asset/strategy/status; private records never indexed into public results. |
| AC-015 | Reply flattening preserves target; edit/delete tombstones, mentions and report controls; spam/length/XSS/private-ID misuse rejected. |
| AC-016 | Concurrent duplicate toggles yield one row; follow/mute/bookmark effects correct; mute cannot erase criticism; self-follow/reaction rejected. |
| AC-017 | Copy/native/X/LinkedIn/Reddit sharing, licensed image versus text fallback, internal repost/undo/attribution; hiding source removes every derivative; no extra trade outcome. |
| AC-018 | Private journal lifecycle, raw/analytical export, missing-cost labels, formula-safe CSV, owner-only expiring downloads, Free quota read/edit preservation. |
| AC-019 | Atomic watchlist/item/layout quotas, concurrent creation, valid instruments, downgraded oversized lists preserve read/export while limiting additions. |
| AC-020 | Event aggregation/dedupe, read state/preferences, DST-aware daily digest/quiet hours, unsubscribes, transactional security/billing messages and email failure retry. |
| AC-021 | Checkout monthly/annual, success pending webhook, duplicate/out-of-order/forged test and production events, renew/failure grace/cancel/refund/dispute and downgrade. |
| AC-022 | Report -> assignment -> reasoned hide/restore -> member notice -> appeal; self-review separation, ban/session refresh enforcement, no journal browsing. |
| AC-023 | Contact/support receipt, private ticket access, verified export/delete request, retention/hold review, restore suppression of deleted data, monitored contact configuration. |
| AC-024 | Intent/bytes/complete/processing/ready, size/type/decompression limits, metadata removal, no public quarantine, expired intent and cross-owner asset assignment rejection. |
| AC-025 | Public canonical/SSR/social metadata/sitemap; hidden-source purge; noindex private/auth/admin/preview; robots not relied on for authorization. |
| AC-026 | CI/build/migrations/readiness, bounded job retries/idempotency/outbox crash recovery, redacted telemetry, DB/object restore and application rollback drill. |
| AC-027 | Session fixation/CSRF/IDOR/upload abuse/rate limits/secret exposure/provider signature checks and maintained dependency review; no critical/high open finding. |
| AC-028 | Keyboard/screen-reader core journeys, focus/contrast/320px/200% zoom, desktop/mobile browser matrix, meaningful load and timing measurements. |
| AC-029 | Clean checkout -> documented Docker command -> healthy web/API/worker/DB/identity/mail; restart persists data; no global tool modifications or committed secrets. |
| AC-030 | Recorded data/legal/processor/provider/identity/support approvals and reviewed content; local fakes cannot turn these gates green. |
| AC-031 | First-party activation/return/publish/review/report/conversion/churn events with consent boundaries, no private thesis/notes/credentials in analytics. |
| AC-032 | Role/instrument/editorial/data/job/billing controls enforce action allowlists, recent admin MFA, reason/audit, and no score fabrication. |

P12 billing lifecycle and provider-truth checks are recorded in [P12 evidence](../implementation/evidence/P12.md). P13 assigned moderation, independent appeals, scoped support access, personal archives and staged erasure/restore suppression are recorded in [P13 evidence](../implementation/evidence/P13.md). These local checks do not close rendered browser or production release gates.

## Evidence per milestone

Store implementation evidence in docs/implementation/evidence/Pxx.md when the milestone runs: commit/revision, environment, requirement/scenario IDs, exact commands and outcomes, relevant browser screenshots, seed dataset and simulated dependency failures, unresolved defects, and reviewer result. Never fabricate historical passes. Do not commit secrets, customer content or unlicensed data.

Use pure domain tests for financial fixtures/state transitions; real PostgreSQL integration tests for transactions/ownership/quotas/idempotency; adapter contract tests for providers; browser tests for actual user journeys, drawing interaction and image capture. Avoid brittle tests that merely repeat component implementation. Production supplier/legal approval is separate from synthetic contract tests.

## Required synthetic personas/data

Visitor; unverified account; two independent Free owners; Pro monthly/annual; canceled paid-through; past_due within/after grace; moderator; administrator with/without fresh MFA; suspended user. Synthetic equities, long call/put, all four verticals and ES/MES/NQ/MNQ contracts, including missing/stale/expired/reference-correction cases. Private sentinel strings must never appear in another account's HTML/API/search/media/export/cache.

## Nonfunctional thresholds

Test 5,000 accounts, 1,000 MAU, 100 concurrent sessions, 50,000 publications and 250,000 comments. Document the representative mix (reads, chart opens, writes), seed distribution and network conditions. This is not 100 independent live market streams.

Targets from MVP: 99.5% monthly availability objective; p75 LCP <2.5s on the agreed mobile profile; ordinary API p95 <750ms excluding supplier retrieval; cached search p95 <1s; no lost/duplicate publication under retry tests; RPO <=1h and RTO <=8h. Define a reproducible mobile profile before claiming timings. Profile chart interaction at 50 objects and verify export is complete.

Browser matrix: current stable Chrome/Edge/Firefox/Safari, iOS Safari and Android Chrome for the mobile subset. Keyboard/screen-reader, reduced motion, theme contrast, 200% zoom and 320 CSS-pixel overflow checks. Accessibility target WCAG 2.2 AA core flows; chart data has textual alternatives.

## CI requirements after scaffolding

Typecheck/lint/production builds; domain and PostgreSQL integration tests; API/schema conformance and migration checks; critical browser journeys; dependency/license/secret scanning with triage. Run focused tests per PR and full release matrix at candidate release. Configure required status checks after the GitHub remote exists; a template does not enforce them.

Documentation CI already has a separate integrity checker. It validates links/contracts/traceability, not product functionality.

## First-party event vocabulary

page_view (approved public routes only), signup_started/completed, onboarding_completed, interest_followed, draft_created, publication_completed, comment_created, journal_created, position_resolved, review_completed, report_created/resolved, checkout_started, entitlement_changed, subscription_canceled. Include pseudonymous actor/event/time/version and bounded categorical metadata. No email, private notes/thesis, precise IP, credentials, or raw uploaded text. Honor approved consent/retention policy; no third-party tracking widget.

Activation definition and business experiment thresholds remain those in MVP. Revenue/conversion events must reconcile provider truth; redirects do not count as paid subscriptions.
