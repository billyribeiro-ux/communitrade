# Phase 1 product requirements

Engineering baseline 1.7, October 19, 2026. Read with the [MVP specification](../mvp-specification.md). The founder explicitly confirmed that Phase 1 includes the entire marketing/subscription website, member application, public community, administration, and supporting systems. These requirements close earlier missing detail; they do not claim implementation.

## Requirement registry

| ID | Requirement | Priority | Primary milestone | Acceptance |
| --- | --- | --- | --- | --- |
| REQ-001 | Marketing and subscription entry | P0/P1 | P03 | AC-001 |
| REQ-002 | Identity and onboarding | P0 | P04 | AC-002 |
| REQ-003 | Authorization and sessions | P0 | P04 | AC-003 |
| REQ-004 | Profiles avatars and bios | P0 | P04 | AC-004 |
| REQ-005 | Member dashboard and navigation | P0 | P03 | AC-005 |
| REQ-006 | Instruments and licensed data | P0 | P05 | AC-006 |
| REQ-007 | Price charts and indicators | P0 | P06 | AC-007 |
| REQ-008 | Drawing editor and notes | P0 | P07 | AC-008 |
| REQ-009 | Drafts and publication | P0 | P08 | AC-009 |
| REQ-010 | Frozen history and corrections | P0 | P08 | AC-010 |
| REQ-011 | Trade lifecycle | P0 | P08 | AC-011 |
| REQ-012 | Decimal calculations | P0 | P02 | AC-012 |
| REQ-013 | Reported performance and discovery integrity | P0 | P08 | AC-013 |
| REQ-014 | Feeds explore and search | P0 | P09 | AC-014 |
| REQ-015 | Comments replies and mentions | P0 | P09 | AC-015 |
| REQ-016 | Reactions follows bookmarks and muting | P0 | P09 | AC-016 |
| REQ-017 | External sharing and internal reposts | P0 | P09 | AC-017 |
| REQ-018 | Private journal and exports | P0/P1 | P10 | AC-018 |
| REQ-019 | Watchlists and saved layouts | P1 | P10 | AC-019 |
| REQ-020 | Notifications and preferences | P1 | P11 | AC-020 |
| REQ-021 | Billing and entitlements | P1 | P12 | AC-021 |
| REQ-022 | Moderation and appeals | P0/P1 | P13 | AC-022 |
| REQ-023 | Support privacy export and deletion | P0/P1 | P13 | AC-023 |
| REQ-024 | Media processing and access | P0 | P04 | AC-024 |
| REQ-025 | SEO metadata and public rendering | P1 | P03 | AC-025 |
| REQ-026 | Deployment recovery and observability | P0/P1 | P14 | AC-026 |
| REQ-027 | Security and abuse controls | P0/P1 | P04 | AC-027 |
| REQ-028 | Accessibility performance and browser quality | P0/P1 | P14 | AC-028 |
| REQ-029 | Docker and reproducible builds | P0 | P01 | AC-029 |
| REQ-030 | Commercial and legal release gates | P0/P1 | P14 | AC-030 |
| REQ-031 | Product measurement | P1 | P11 | AC-031 |
| REQ-032 | Administrative data and account controls | P0/P1 | P13 | AC-032 |

P0 must pass before external beta; P1 must pass before public paid launch. Marketing content and Free paths are P0; live paid checkout is P1. No route or permission boundary may be omitted because its screen is not in an early sketch.

## REQ-001 Marketing and subscription entry

Provide Home, Features, How It Works, Pricing, FAQ, About, Contact, Support, and policy pages. The marketing site uses the same design tokens and account state as the application. Main actions: Explore ideas, Create free account, Choose Pro. Pricing states $29/month or $290/year before tax, delayed data for both tiers, member-reported outcomes, and actual product limits. Anonymous Pro selection survives login/onboarding as a server-validated intent; no payment occurs before verified identity and terms acceptance. Existing Pro members go to billing, not a second checkout.

Provide approved factual copy without invented user counts, testimonials, exchange partnerships, win rates, or product capabilities. Working brand name is “Trading Community”; keep it centralized. Legal company/domain identity is a launch dependency. See [routes](routes-and-journeys.md) and [content](marketing-and-policy-content.md).

## REQ-002 Identity and onboarding

OIDC Authorization Code + PKCE with local Keycloak is the engineering reference. Identity provider owns passwords, reset, verification, and MFA enrollment. Nest exchanges codes server-side and creates an opaque application session. No app-stored passwords or browser-stored bearer/refresh tokens.

Provide sign-up/sign-in entry pages, callback/error states, verification-required screen, recovery link, onboarding, logout, and session management. Onboarding collects display name, unique handle, experience, stock/options/futures interests, timezone, and applicable declarations/terms version. Unverified accounts can manage authentication and read public pages, but cannot publish, comment, maintain journal records, or purchase Pro. Verified Free is the default entitlement. An identity verified email badge must never imply trading verification.

## REQ-003 Authorization and sessions

Roles: visitor, unverified account, verified member, moderator, administrator. Free/Pro is an entitlement, not a role with moderation powers. Every private read/write is owner-scoped. Moderator access does not include journals. Administrative exceptional support access requires purpose, expiry, step-up authentication, and audit.

Session/CSRF policy is in [security](../quality/security-and-privacy.md). Account suspension invalidates sessions and blocks writes immediately. Login return paths are relative allowlisted product routes. Subscription changes never grant admin permissions.

## REQ-004 Profiles avatars and bios

Public profile: circular avatar; display name; @handle; bio; join month/year; chosen asset interests; follower/following counts; member-reported statistics with exclusions; ideas, updates, and repost tabs. Show a Pro badge only as a paid-plan marker. No verified trader badge.

Display name: 2–60 characters. Handle: 3–30 lowercase letters/digits/underscores; case-insensitive uniqueness; reserve route/system names; serialize handle updates under the profile revision lock and permit one change per 30 days. A second change before the cooldown expires returns HTTP 409 `HANDLE_CHANGE_COOLDOWN` with the next allowed UTC timestamp. Preserve an audited redirect from each old handle for one year; after redirect expiry, keep that historical handle permanently reserved and return no redirect. Bio: up to 500 plain-text characters. Up to three HTTPS profile links, rendered with nofollow/ugc/noopener and safe labels. Never expose email, billing identity, private journal totals, or device/location information.

Avatar: PNG/JPEG/WebP up to 2 MB; crop UI with square preview; worker re-encodes to 512px square and removes metadata; circular display via CSS. Initials fallback, remove/reset action, alt text derived from display name. Public profile updates do not rewrite author identity snapshots in historical audit records.

## REQ-005 Member dashboard and navigation

Dashboard /app shows the member's drafts, open/unresolved reported positions, recent followed activity, watchlist shortcuts, journal review reminders, notification count, and plan usage. Include a useful first-use empty state. Do not invent recommendations or portfolio/account equity.

Application navigation: Dashboard, Feed, Explore, Publish, Journal, Profile; Watchlists, Bookmarks, Notifications, Settings, Billing in the shell/secondary navigation. Show active state, avatar/account menu, asset context, search, and responsive mobile access. Visitor header shows login/create-account actions; authenticated header shows application/account actions.

## REQ-006 Instruments and data

Use exact supported instruments/strategies, histories, delays, calendars, and exceptions in the MVP. Symbol lookup is not a scanner. Option selection uses actual contract IDs and a call/put strike/expiration selector; valid verticals show both legs and net debit/credit. Futures selection always identifies the actual contract month.

Every quote/bar response carries source, as-of, delay, freshness, and allowed-use capabilities. Missing/stale/unlicensed states are explicit. Contracts gate anonymous versus authenticated display, retained chart history, thumbnails, and external share images independently. Fixture mode uses synthetic symbols/data clearly marked “Demo data”; production startup rejects fixture mode. See [integrations](../architecture/integrations.md).

## REQ-007 and REQ-008 Charts and drawings

Implement the complete [chart contract](../architecture/chart-engine.md) and MVP drawing behavior. One chart per publication, 50 objects maximum, chart notes plain text. Custom CSS/Phosphor toolbar supports all agreed drawing operations. Preserve semantic anchors, originals, and provenance.

Options use an underlying price chart plus contract/strategy details and expiration payoff. Underlying levels, option premiums, and net spread prices are distinct values. Futures use actual listed-contract bars. A text alternative exposes important levels and plan fields outside the canvas.

## REQ-009 Publication

Composer steps: instrument/strategy; plan fields; chart and thesis; review/publish. Require title <=120 characters, thesis <=10,000, timeframe, explicit UTC entry-window start/end, direction/strategy, entry condition/price, initial invalidation/risk, intended exits, and conflicts. Entry window must have start < end and cannot extend past an instrument's trading/expiry boundary. Explain limitations before publishing.

Allow one chart and up to three processed attachments, each <=2 MB. Autosave private drafts with revision conflict handling. Publication freezes the original terms, drawing state, thesis, disclosures, timestamps, and snapshot reference in one transaction. Idempotent retries return the same publication. Educational posts are explicitly typed and have no position/statistics.

## REQ-010 through REQ-013 Evidence and calculations

Implement the MVP state machine and decimal formulas without broadening supported strategies. Server received time and member-claimed fill time are separate fields. Forward-report eligibility requires original publication before claimed entry, entry within the frozen window, and server receipt within five minutes of claimed entry. Invalid chronology is rejected; late but chronologically valid reporting is retained as retrospective. Clock discrepancies do not manufacture verification.

One entry, up to three proportional partial exits. Final closure cannot leave a residual quantity. Corrections preserve original events and create audited replacements/recalculation versions. A changed informal plan is labeled rather than silently mutating the frozen risk denominator. Expired/assignment/settlement exceptions remain unresolved until member resolution/review.

Show denominators, costs coverage, retrospective exclusions, breakevens, and unresolved counts. No broker verification, portfolio return, account equity curve, or cross-asset dollar leaderboard. Discovery uses newest/followed interests/editorial completeness; automatic high-win-rate promotion is deferred. This is a recorded deviation from the original brainstorming idea, not an omitted engineering task.

## REQ-014 through REQ-016 Community

Following/Discover feeds; asset tabs; symbol/strategy/status filters; Newest sort; separately labeled editorial collection. Full-text public title/thesis/author search, cursor pagination, sanitized query limits, no private-journal leakage. Empty search and unavailable instruments have clear states.

One reaction type (“Helpful”), bookmarks, author and instrument follows. All toggles are idempotent. Self-follow/self-reaction are rejected; bookmarks can include one's own publication. Muting hides the other author's feed items and nonessential activity notifications for the muting member; it does not remove public criticism.

Comments <=2,000 characters, plain text; direct replies flatten to two visible levels while preserving reply target. Edit labels and tombstone deletion preserve thread structure. Mentions resolve existing handles; comments have no image uploads. Report actions remain visible. Optional response tags from the MVP are stored as a bounded enum.

## REQ-017 Sharing and reposts

Each public idea has a Share action in its card and detail view. Menu: Copy link; native device share when supported; X, LinkedIn, Reddit; download chart/share image when licensed; Repost internally. Profiles support Copy profile link/native share. External destinations open only after a user click with safely encoded public canonical URLs; no third-party tracking widgets or automatic social posting.

Share images include author attribution, instrument/actual futures month, publication date, strategy, member-reported label, and data-delay/source requirements. Do not put private drafts/journals or unlicensed quote images into an external share action. When images are not permitted, public text/link sharing remains available if allowed.

Internal repost: one active repost per member/publication, optional plain-text commentary <=500 characters, attribution/link to original, visible “reposted by” label, undo action. Reject self-reposts; use external sharing for one's own idea. Reposts never create a new trade, win, or publication execution timestamp. Reactions/comments resolve to the original; repost commentary has report/delete controls. If the source is hidden/deleted/restricted, its content is also unavailable through platform-controlled reposts, caches, and share-image routes. Previously downloaded images and third-party social caches cannot be recalled by the platform; do not promise global deletion of external copies.

## REQ-018 through REQ-020 Member tools

Journal and plan allowances are the exact Free/Pro table in the MVP. Owner-only entries may be stand-alone or linked to public ideas; private notes never alter public evidence. At quota, existing entries remain readable/editable/exportable. Monthly quotas use UTC calendar months and atomic counters. Pro analytics respect the same calculation eligibility rules.

Watchlists use stable instrument IDs; enforce list/item limits transactionally. Saved layouts are private templates and cannot rewrite a published chart. Bookmarks preserve public content access rules. Raw personal CSV export is Free; filtered analytical CSV requires Pro. Export jobs create expiring authenticated downloads, defend spreadsheet formula injection, and preserve user privacy.

Notifications: reply/mention, followed-author publication, bookmarked-idea material update, moderation, billing/account. Aggregate duplicates, mark read individually/all, and store preferences. Optional digests run daily at 08:00 user-local time (DST-aware; at most one per local date), with chosen quiet hours default 22:00–08:00. Security/billing notices are transactional. No push/SMS or urgent price-alert promise.

## REQ-021 Billing

Stripe is the implementation target, subject to business underwriting. Hosted Checkout and Customer Portal; fixed server-side plan-price mapping. Monthly/annual options, invoices, taxes configuration, renewals, cancellation, refunds, failure states, and record-preserving downgrade. “Paid” return URLs never grant entitlement; only authenticated provider reconciliation does.

Initial rules: access while active/trialing (no trial offered by default); paid access through paid-through time on cancellation; past_due displays a warning and preserves existing paid access for 72 hours after first failed renewal, then Free; unpaid/incomplete_expired becomes Free. Refund does not automatically cancel a subscription; authorized support chooses both actions explicitly. Reconcile disputes and subscription changes, dedupe provider events, fetch current subscription when events arrive out of order. Preserve processor status and reason.

## REQ-022 through REQ-024 Administration support and media

P0 moderation includes report queue, reasoned hide/restore, suspension, member notice, appeal, and audit. P1 adds filtering, staff assignment, escalation, and support tooling. Authors cannot moderate their own criticism. Admins manage roles, instrument enablement, supplier status, editorial selections, entitlements support, and job failures. No editable admin field may fabricate reported performance.

Support forms create a reference and queue a receipt without disclosing account existence. Account deletion/export/recovery workflow and retention schedules are in [security](../quality/security-and-privacy.md). Policy/legal pages are implemented with draft controls; actual approval blocks publication until release gates pass.

Uploads use an intent -> upload -> validation/re-encode -> ready sequence. Never serve unprocessed bytes publicly. Bind every asset to owner/purpose/resource; server verifies size/type/pixel bounds and strips metadata. Reject SVG and executable formats from user uploads; bundled reviewed Phosphor/brand SVG assets are a separate trusted build resource.

## REQ-025 through REQ-032 Cross-cutting delivery

Canonical URLs, public SSR metadata, robots/sitemap/Open Graph, noindex private/admin/preview content. Implement responsive loading/empty/error/denied/offline states across [route catalog](routes-and-journeys.md). Use the [design system](../design/design-system.md) and [acceptance plan](../quality/acceptance.md).

Operations include durable jobs, outbox, provider timeouts, audit/log redaction, backup/restore, metrics, incident response, CI and production rollback. Keep release gates for data, counsel, processor, staffing, branding, and credentials explicit. Codex implements adapters and local fixtures without pretending those external gates passed.

## Change control

No silent omission of an entire surface, asset class, or acceptance requirement. New Phase 1 scope changes its requirement/ADR, implementation estimate, and release checklist. [MVP costs/timeline](../mvp-specification.md) remain planning assumptions; reconfirm estimates against this fuller handoff before staffing or spending.

Deferred: livestreaming/screen share/voice/live chat, scanners/institutional-flow analysis, broker verification/execution/copy trading, creator payouts, complex unsupported options, real-time exchange entitlements, native apps, arbitrary scripts, and full proprietary TradingView parity.
