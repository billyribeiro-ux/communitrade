# External dependencies and release gates

A build-ready engineering plan can coexist with unsigned commercial dependencies. This register separates work agents can complete locally from approvals/credentials they cannot fabricate. Every gate starts **open / evidence not supplied**.

| Gate | Owner | Needed evidence | Blocks |
| --- | --- | --- | --- |
| G01 Business identity/domain | Founder | Legal operator, brand/domain, contact addresses and entity/IP ownership | Public marketing/policy publication |
| G02 Repository governance | Founder + engineering lead | GitHub remote, reviewer handles, private reporting, branch protections/checks | Team collaboration enforcement |
| G03 Commercial data | Founder + supplier | Signed coverage for stocks/options/ES-MES-NQ-MNQ; public/member display, retention, images, exports and costs | External beta and corresponding data surfaces |
| G04 Legal product/policy review | Founder + counsel | Reviewed actual publishing/metrics/subscription/moderation/privacy flows and approved copy/retention | External beta/paid launch as applicable |
| G05 Processor acceptance | Founder + processor | Acceptance of business, production account, prices/tax/refund setup | Charging users |
| G06 Production infrastructure | Engineering lead + founder | Vercel/Render/R2/identity/email accounts, supported versions, tiers/regions, secrets and backup policy | Deployment |
| G07 Sender/support/security contacts | Founder/operations | Verified mail domain, monitored contacts, coverage, urgent escalation | External beta |
| G08 Implementation evidence | Engineering lead | P01–P14 acceptance, privacy/calculation/browser/load checks, no critical/high blockers | Beta/public gates |
| G09 Restore/release rehearsal | Operations + reviewer | RPO/RTO, objects/deletion suppression, rollback/supplier outage/billing replay drills | Beta/public gates |
| G10 Content/community readiness | Founder | 20 founding contributors, 50 useful original posts, >=10 per asset class, four weeks beta evidence | Public launch |
| G11 Licensing and IP | Founder + engineering lead | Actual lockfile/container inventory/notices, business rights holder and contributor assignments | Distribution/public release |
| G12 Visual and content review | Founder + designer/lead | Rendered representative public/member/staff flows; approved actual branding/copy | Public launch |

## Engineering defaults already closed

CSS Modules/design token baseline; Phosphor; Next/Nest/Postgres/Prisma; OIDC local Keycloak; pg-boss; local filesystem objects/Mailpit; reference production adapters; exact routes/profile/share/repost semantics; API/schema/state model; milestone/test structure. Engineers should not stop to ask for ordinary styling, folder, field or retry choices covered by the handoff.

The founder approved the core stack, CSS-only constraint, Vercel frontend and Docker development. Supporting providers, visual defaults and protocol details are engineering-selected defaults, not retroactively claimed founder approvals. They are reversible implementation choices; purchase/contract/visual release evidence remains explicit.

## Release stages

Local development: deterministic fixtures, local OIDC/mail, fake billing adapter; no external gate is marked passed.
Invited beta: P0 criteria plus G03/G04/G07/G09 and critical security/calculation checks; all three asset classes.
Public paid launch: all P0/P1, all applicable gates, production billing/data truth and beta observation.

No deadline or credential absence authorizes changing scope silently. If a commercial provider fails, use the fixed adapter contract to evaluate alternatives and record cost/schedule impact.

## Budget/timeline treatment

The MVP's 24–28-week two-engineer reference and cost allowances remain planning assumptions, not a staffed commitment or current supplier quote. The earlier single specification under-described surfaces; review estimates against the complete requirements before hiring or spending. Do not assert that added detail has zero engineering cost or that AI removes supplier/testing/operations work.

## Remaining inputs are not implementation placeholders

No TODO credentials, fictional company contacts, fabricated legal approvals, fake provider data or invented production URLs may ship. Configured fixture defaults allow local implementation; external gates require actual evidence before release. Track each gate in implementation evidence with date, owner, artifact and expiry/review date.

## P04 identity ingress and provider extensions

Before production, the operator must deploy the tested credential-revocation Keycloak provider with matching pinned server compatibility, hardened HTTPS realm/client/MFA/recovery policy and approved email delivery. Public/login IP limits behind the local Next proxy currently aggregate at that proxy's internal address. P14 implements signed ingress/client-IP derivation and adversarial spoofing tests locally. Production Vercel/edge conformance still must be recorded before launch; do not trust arbitrary `X-Forwarded-For` values. Per-account limits remain database-backed. See [P04 evidence](../implementation/evidence/P04.md) and [ADR 0015](../adr/0015-identity-profile-media.md).

The native Keycloak credential action can redirect with a success status even after the listener rolls its database transaction back. The security rollback and subject-wide revocation passed live tests, but provider failure messaging requires rendered UI review before production. Keep public subjects and tested local storage until pairwise/federated subject-event behavior is validated. Operators must explicitly revoke sessions before the eventless `disable-credential-types` operation.

## P05 commercial data evidence required

G03 remains open. No stock/options/futures dataset purchase, commercial account credentials or signed supplier/venue agreement has been supplied. Obtain dataset-specific coverage for all three launch asset classes and separately document anonymous display, member display, retained bars, retained snapshots/thumbnails, externally shared images and personal-record exports, including the approved delay and attribution. An API key or boolean configuration flag alone does not prove those rights.

Before enabling production, import approved immutable reference metadata and authoritative session/holiday calendars, map internal UUIDs to the supplier's actual dataset/symbol identities, provide approved schema/capability configuration and effective database agreement grants, then run supplier conformance with authorized samples. Verify partial/missing data, corrections, contract expiry, unexpected schema changes and revocation without erasing history. Synthetic tests cannot satisfy this gate. [P05 evidence](../implementation/evidence/P05.md) distinguishes the executable local boundary from these outstanding inputs.

P05 supplies session-aware 1h/1d normalization from approved 1-minute records with injected-transport tests. P14 must validate that path against authorized real supplier samples and complete calendar/rights coverage before claiming production chart acceptance. Split-adjusted requests, stock extended hours and regular-only futures aggregation are outside the launch baseline and fail explicitly. Synthetic development supports the planned intervals; mock protocol tests do not establish live supplier coverage.


## P11 sender and delivery evidence required

G06/G07 remain open for production SMTP. Local Nodemailer/Mailpit acceptance does not verify domain ownership, authenticated production TLS, SPF/DKIM/DMARC, provider quotas or recipient deliverability. Supply approved SMTP credentials and verified sender configuration, complete authenticated provider bounce/complaint webhook integration and suppression acceptance, and test lost acknowledgments with the chosen provider. The local RCPT550 suppression path is implemented; no production webhook or commercial sender approval is claimed. G04 must review actual consent version/copy and 90-day first-party analytics retention. G08/G12 still require rendered notification/preferences/saved-search/admin-job/unsubscribe flows because saved localhost browser policy blocks tool inspection.

## P12 processor evidence required

G05 remains open. Local synthetic processor acceptance and mocked Stripe protocol tests do not establish underwriting, approved production account, real product/price/tax/portal configuration, supported payment methods, actual refund/dispute behavior or live-key conformance. Record those artifacts with the founder/processor before charging users. Live configuration flags are guards for recorded evidence, not approval artifacts themselves. No actual payment or external processor credential is used by P12 acceptance.

Stripe account, fixed USD price intervals/amounts and selected portal configuration are server-side; raw webhook signatures and provider account/mode isolation are tested locally. Complete an authorized real test-key monthly/annual purchase/cancel/refund/dispute and lost-ack rehearsal before a paid release. G04 still owns legal/policy copy, and G08/G12 require rendered checkout/return/member billing/demo portal/admin support keyboard/visual acceptance. The browser origin setting continues to block localhost inspection; automated SSR/API acceptance is recorded separately in [P12 evidence](../implementation/evidence/P12.md).


## P13 operational evidence required

G04 still requires approved retention/hold/redaction and provider-side identity/billing policy. G07 requires real monitored support/security contacts, coverage and escalation; environment flags alone do not establish staffing. G08/G12 still require rendered staff/support/privacy flows, keyboard/focus review and actual approved copy. G09 requires the newer suppression ledger and stable key to survive a measured production database/object restore before traffic returns, including provider-side identity linkage and billing reconciliation. Local PostgreSQL/Mailpit/suppression drills do not close those external gates. See [P13 evidence](../implementation/evidence/P13.md).

## P14 candidate decision

The [P14 evidence](../implementation/evidence/P14.md), [32-scenario matrix](../quality/p14-acceptance-matrix.md) and [machine-readable register](../implementation/p14-release-status.json) record local implementation and acceptance limits. All G01–G12 remain open. Passing local signed ingress/R2/Svix protocol tests and generated-database recovery does not supply commercial credentials, license grants, production backup restoration, legal approval, monitored staffing, branding approval or rendered browser acceptance. No accounts were purchased and no services were deployed. `pnpm check:p14:release` reports NO_GO; it never changes live billing or deploys.
