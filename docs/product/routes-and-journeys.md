# Pages routes and end-to-end journeys

The application is one product with public marketing, public research/community, account/subscription, private workspace, and staff surfaces. Route names below are implementation contracts; dynamic IDs are stable UUIDs and slugs are cosmetic. APIs use /api/v1 and do not collide with these routes.

## Public marketing and policies

| Route | Page and required actions |
| --- | --- |
| / | Hero, three asset classes, publish/discuss/review workflow, labeled product previews, Free/Pro CTA |
| /features | Publishing/drawings, discussion, transparent history, journal, Free/Pro distinctions |
| /how-it-works | Discover -> plan -> annotate -> publish -> discuss -> report -> review; external broker execution explained |
| /pricing | Monthly/annual switch, full comparison, taxes qualifier, Free/Pro CTA, existing-plan routing |
| /faq | Data delays, reported results, supported strategies, cancellation, privacy, launch boundaries |
| /about | Product purpose and operator identity once supplied; no invented team or partnerships |
| /contact | Category, email, message, consent notice, rate-limited request reference |
| /support | Searchable static help topics, account/billing/data/reporting help, authenticated ticket entry |
| /support/requests/[id] | Owner/staff only; status and replies; no public indexing |
| /terms | Approved, versioned terms, effective date and operator contact |
| /privacy | Approved collection/purpose/retention/rights/provider disclosures |
| /risk-disclosure | Trading risk, member-reported evidence, data delays, no execution/custody claims |
| /community-guidelines | Conduct, disclosure, reporting, moderation/appeal rules |
| /accessibility | Accessible-use guidance and monitored issue contact |
| /status | Service/data freshness summary; expose no infrastructure secrets |

Policy copy is draft until legal/operator gates pass. All marketing screens have header, footer, responsive content, login-aware CTA, and honest working product copy. See [content](marketing-and-policy-content.md).

## Public community

| Route | Page and permission |
| --- | --- |
| /ideas | Explore public ideas; asset/symbol/strategy/status search, pagination |
| /ideas/[id]/[slug] | Full publication, chart snapshot/interactive chart, plan, lifecycle, author card, replies, share/report controls |
| /u/[handle] | Avatar, bio, public links, reported statistics, ideas and reposts; follow/share/report |
| /instruments/[id] | Identity, contract details, permitted delayed display, related ideas; follow/watchlist CTA |
| /share/ideas/[id]/[version].png | Licensed public share image generated from that committed version; source restrictions checked |

Visitors read allowed content. Interaction redirects to login with a validated return path; posting requires verified email. Moderated/deleted content returns an appropriate unavailable view and revokes dependent images/reposts. Archived slugs redirect to canonical URLs without changing IDs. Requests for unknown and unauthorized private objects return equivalent 404 behavior.

## Accounts and billing

| Route | Page |
| --- | --- |
| /login | App-branded sign-in entry, provider redirect, safe return path |
| /signup | Free/Pro intent and provider registration entry |
| /auth/callback | Nest endpoint handles protocol; frontend displays success or safe error |
| /verify-email | Explain verification/resend via provider with throttling |
| /recover-account | Provider recovery entry; neutral response to avoid enumeration |
| /onboarding | Handle/display name, experience/interests/timezone, versioned acceptance |
| /subscribe | Authenticated plan choice and hosted checkout launch |
| /subscribe/return | Pending/success/failed/canceled UI; server-reconciled entitlement |
| /app/billing | Current plan, paid-through, invoices, portal, upgrade/cancel/refund-help |

Browser-facing OIDC callback is actually /api/v1/auth/callback; /auth/callback is an optional frontend result page, never a second token-exchange handler. Provider-managed registration/reset/MFA pages must follow accessible product branding or clearly disclose the provider transition.

## Member workspace

| Route | Page and acceptance detail |
| --- | --- |
| /app | Dashboard: own drafts/positions/reviews, followed activity, usage, notifications |
| /app/feed | Following/Discover, filters, card actions, repost attribution |
| /app/explore | Authenticated search/discovery; shares canonical public results |
| /app/publish | New draft; choose trade idea or education; complete composer |
| /app/drafts | Owner-only draft list, recovery state, last saved |
| /app/drafts/[id] | Resume composer, drawings, preview, revision conflict handling |
| /app/journal | Owner-only searchable records, statuses/tags, quotas |
| /app/journal/new | Stand-alone or linked entry |
| /app/journal/[id] | Private notes, lifecycle/report review, edit/export |
| /app/journal/analytics | Basic versus Pro analysis; explicit eligibility and incomplete costs |
| /app/watchlists | Lists, item limits, stable instrument links |
| /app/bookmarks | Saved public ideas with hidden-source handling |
| /app/layouts | Saved private chart templates; plan limits |
| /app/notifications | Aggregated events, read state, preferences link |
| /app/profile | Edit avatar, bio, display name, handle, links; preview public profile |
| /app/settings | Account summary and settings navigation |
| /app/settings/security | Sessions, MFA/provider account entry, logout everywhere |
| /app/settings/preferences | Theme, timezone, interests, notifications/digest |
| /app/settings/privacy | Personal export, deletion request/status, policy acceptance |
| /app/reports/[id] | Own report/appeal status; no other reporter details |

Use nested layouts with session checks, accessible navigation and account avatar. Shell links cannot be the only access to authorization enforcement. No Live/Scanners navigation.

## Staff workspace

| Route | Capability |
| --- | --- |
| /admin | Role-scoped operational summary |
| /admin/reports | Moderation queue, reasons, assignments, hide/restore |
| /admin/appeals | Independent review and reasoned resolution |
| /admin/corrections | Review structured correction proposals; preserve and compare original versions |
| /admin/users | Account status, roles, session revocation; admin step-up |
| /admin/instruments | Catalog metadata versions, disabled-new-publishing state |
| /admin/data | Provider freshness/license capability status; no secret values |
| /admin/billing | Read/reconcile entitlements and authorized portal/refund actions |
| /admin/editorial | Labeled selections with reason and audit |
| /admin/support | Support request management and purpose-limited escalation |
| /admin/jobs | Failed jobs, bounded retry, job-specific authorization |
| /admin/audit | Read-only role-scoped audit search and export |

Moderators only see report/appeal/content actions within their assigned role. Admin access does not expose a journal browser. Staff step-up is required before sensitive actions.

## Required journeys

1. Visitor reads marketing/pricing -> chooses Free -> OIDC -> verification -> onboarding -> dashboard -> follows interests -> first public or journal action.
2. Visitor selects annual Pro -> same identity path -> authenticated checkout -> webhook reconciliation -> Pro usage visible -> portal cancellation -> paid-through access -> record-preserving downgrade.
3. Member selects each supported trade family -> validates references -> annotates chart -> previews public content -> publishes -> another account reads/replies -> author reports entry/partial/final close -> metrics update with original evidence.
4. Member uploads/crops avatar -> processed asset ready -> profile/bio/public card update -> source attribution appears on idea/share surfaces.
5. Visitor/member shares canonical idea externally or reposts internally -> original remains attribution/statistical source -> moderation of original hides every derivative display.
6. Member creates private note/export -> second member and ordinary moderator cannot retrieve it through IDs, media, caches, search, or downloaded export.
7. Data provider fails -> saved explanation/history stays readable where licensed -> freshness error displayed -> background retry -> recovery without duplicate bars/events.
8. Member reports harmful content -> queue -> reasoned moderation -> member notice -> appeal -> audit; support exception is isolated.
9. Operator deploys migration/app -> health/readiness -> restores backup in staging -> rollback/forward-fix rehearsal -> release evidence.

Every route needs loading, populated, first-use/empty, validation, permission, unknown/missing, dependency-failure, retry, and responsive keyboard states where applicable. Never render a disabled button without explaining the required action.
