# Data model and business invariants

This is the persistence contract. P02 implements the Prisma models, reviewed additive SQL constraints, calculation fixtures and reusable transactions; see [schema implementation](persistence-schema.md) and [P02 evidence](../implementation/evidence/P02.md). Later route/UI milestones apply these rules to business workflows. Read [requirements](../product/requirements.md), [API](api-contract.md), and the [MVP formulas](../mvp-specification.md).

## Common conventions

UUID primary keys; UTC timestamptz; integer optimistic revision; createdAt/updatedAt; explicit ownerUserId on private aggregates. Money/prices use PostgreSQL numeric(28,10) and decimal strings at API boundaries. Pure calculations use arbitrary-precision decimal arithmetic, round only displayed results, and reject precision/size overflow rather than coerce it. Whole shares/contracts/units are integers 1–1,000,000.

Do not use ticker text as identity. Preserve metadata/calculation versions and source IDs. UTC calendar-month quota boundaries are server-generated. Soft deletion/tombstones apply where history/thread integrity requires them; privacy erasure and lawful holds follow the actual approved policy.

## Tables and constraints

| Aggregate/table | Key fields and constraints |
| --- | --- |
| User | id; unique (oidcIssuer, oidcSubject); private email/verification; status active/suspended/deleting/deleted; onboarding/declaration/policy versions |
| Profile | userId unique FK; unique normalized handle; displayName/bio/interests/links/avatarMediaId; revision |
| HandleHistory | oldHandle unique, userId, changedAt, redirect expiry; reserved handles cannot be claimed |
| RoleGrant | unique (userId, role); grantor/reason/time; administrative changes audited |
| AppSession | hash of opaque token unique; userId; issued/lastSeen/expires/revoked; provider session ID; MFA time/assurance; no raw token in logs |
| AuthTransaction | hashed state, nonce, PKCE verifier encrypted/short-lived, return intent; usedAt, expiresAt |
| Instrument | id, asset, vendor identity, underlyingId, venue, currency; enabled status |
| InstrumentMetadataVersion | unique (instrumentId, version); multiplier/tick/strike/expiry/session/adjustment/source; immutable once referenced |
| DataCapability | supplier/agreement scope, dataset/audience/purpose flags, effective/revoked times; staff changes audited |
| Draft | owner, kind, title/thesis, plan JSON validated, up to three processed attachment IDs, revision, chartRevision; private |
| PublicationJob | owner/draft/publication/version, immutable candidate, render nonce/expiry/claim, bounded attempts/status/failure, immutable artifact checksum/key |
| ChartState | owner/draft FK or immutable publicationVersion FK; schemaVersion, JSON state, provenance, revision |
| Publication | author, kind, originalVersionId, currentVersionId, visibility; stable canonical ID |
| PublicationVersion | publicationId, version sequence, previousVersionId, frozen terms/thesis/chart/disclosures, timestamp; unique (publicationId, sequence) |
| CorrectionRequest | author/publication/sourceVersion; reason/replacement proposal; requested/processing/approved/rejected, reviewer/reason/job reference; cannot mutate original version |
| Position | owner, publicPublicationId OR privateJournalEntryId; plan/metadata version, remaining quantity, state, frozen initialRisk/riskSourceVersionId, calculationVersion, revision |
| PositionLeg | positionId, instrumentId/metadataVersion, side, integer quantity; validated strategy family |
| PositionEvent | positionId, type, receivedAt, claimedAt, quantities/prices/costs, reason, supersedesId, typed resolution/borrowing details; append-only except lawful redaction |
| OutcomeSnapshot | positionId, source event cutoff, calculationVersion, publicationVersionId, eligibility/exclusions/net/R/cost coverage; rebuildable |
| Comment | publicationId, author, replyToId/rootId, body/tag, edited/deleted/hidden timestamps; parent must belong to same publication |
| Reaction | unique (userId, publicationId); type Helpful |
| Follow | unique follower/target where target is author OR instrument; no self-author follow |
| Bookmark | unique (userId, publicationId); owner-only list |
| Mute | unique (userId, authorId); no self-mute |
| Repost | unique active (userId, publicationId); commentary <=500; no self-repost; source visibility checked at read |
| JournalEntry | owner, optional publication link, private position, notes/tags/review, revision; link does not grant public access |
| Watchlist / WatchlistItem | owner/list name/revision; unique (listId, instrumentId); quota transaction |
| SavedLayout | owner, name, versioned chart template, revision; independent from public frozen chart |
| Notification / Preference | owner, category, aggregation/delivery key, safe internal URL, readAt; unique aggregation key |
| Subscription | userId, provider customer/subscription, mode, provider status/version, paidThrough/grace; unique provider identifiers |
| SubscriptionEntitlement | userId unique; Free/Pro effective limits and validity; server-derived |
| BillingEvent | unique (providerAccount, mode, eventId); signature verified timestamp; reconciliation status |
| QuotaBucket | unique (userId, metric, UTC month); count/reservations; transaction or row lock |
| Media | owner, purpose/resource/version, quarantine/processed key, dimensions/checksum/status; no public unprocessed object |
| ExportJob | owner, kind/filters, status/object, expiresAt; authenticated result download |
| SupportTicket / Message | private requester identity/reference/category/status, visibility; staff access reasons |
| PrivacyRequest | owner/type/status, verification/hold reason, due/completed timestamps |
| Report / ModerationAction / Appeal | reporter/resource/reason/status, reviewer/action/reason; audit and access separation |
| EditorialSelection | publicationId, selector, reason, active interval; no paid promotion flag |
| AuditEvent | actor/system principal, action/resource/reason/request ID/time; redacted metadata, immutable writer |
| OutboxEvent | unique event ID/type/aggregate/revision/payload/status; created in domain transaction |
| SideEffectDelivery | unique (channel, businessDeliveryKey); attempts/provider reference/result |
| IdempotencyRecord | unique (actor, route, key); request hash, response status/body/resource, expiry |
| RateLimitBucket | hashed principal/route/window and bounded counter/expiry; no indefinite raw IP retention |

pg-boss owns its schema, migrations and job tables; application migrations do not hand-edit its internals. Keycloak owns a separate identity database and credentials; app code does not query provider password tables.

## State transitions

Publication: draft -> publishing (validated state + pending snapshot) -> published; failure returns recoverable draft/publishing error without a public partial publication. Server publication timestamp is established only when the committed version is publicly publishable. Snapshot jobs use the frozen candidate and are idempotent. An unavailable optional attachment cannot silently disappear from a reviewed publication.

Position:
- pending -> entered, canceled, never_entered
- entered -> partially_closed, closed, unresolved
- partially_closed -> partially_closed, closed, unresolved
- unresolved -> reviewed resolution / closed with explicit exception evidence
- closed/canceled/never_entered -> review or correction request; no hidden rewrite

Educational content never creates a Position. Retrospective eligibility is a derived reporting label, not a user-editable state. Quantity decrement and event insert occur in one locked transaction. Max three partial-exit events; a final exit closes all remaining units. A correction reverses/replaces the identified event through a visible superseding event and recomputes projections without deleting the original.

## Invariants

- Supported verticals: two different strikes, same underlying/expiry/type, equal units, valid long/short arrangement and sensible debit/credit bounds.
- Stocks/futures require an initial planned stop for initial-risk calculation; actual losses can exceed that planned risk.
- Long options/vertical initial risk uses theoretical maximum loss; no stock margin or futures margin as denominator.
- Public publication terms and chart anchors never change through journal/profile/layout edits.
- A missing cost is null/incomplete, not zero. Complete-cost headline and incomplete-cost views are separate.
- Supplied costs are nonnegative; negative fee/rebate accounting is outside this baseline. Options plan instrumentId identifies the underlying and PositionLeg identifies actual option contracts; stocks/futures identify the traded instrument directly.
- Forward eligibility uses server clock and frozen entry window. Reject claimed events more than 60 seconds in the future; preserve reporting delays.
- Private positions/journals/media/exports are never returned through public aggregate joins.
- All source-dependent images/reposts/search/sitemaps obey moderation/license changes.
- Quota checks and creation are atomic; two tabs cannot bypass limits.
- Idempotency keys with a different request hash return conflict; never execute both.
- Billing mode/account boundaries prevent test events granting production access.

## Index and migration baseline

Indexes: public publication (visibility, publishedAt, id); author/date; asset/instrument/strategy/status; GIN search vector on public text; owner journal date/tags; comment (publicationId, createdAt, id); active subscription/provider IDs; unresolved positions; undelivered outbox/notifications; report status/date. Use keyset cursors, not large OFFSET scans.

Separate schema migrations from data backfills. Deploy additive compatible changes first, backfill with checkpoints, then remove old fields after compatibility window. Production migration role is separate from runtime; no automatic destructive schema push. Record restore/forward-fix plan and preserve old calculation outputs for comparison.

## Calculation fixture minimums

- 100/105 call debit vertical, 1 unit at 1.50: max loss 150, max profit 350 before costs.
- Credit vertical width 5, credit 1.20, 1 unit: max profit 120, max loss 380 before costs.
- Stock long 10 shares 100 ->105, costs 2: net 48.
- Stock short 10 shares 100 ->95, costs 2: net 48; borrow-cost coverage separately labeled.
- MES long 1 contract 5000 ->5001, multiplier 5: gross 5; minimum increment/metadata validated.
- Long call 2 contracts 1.50 ->2.00, multiplier 100: gross 100.
- Partial exits combine into one outcome; breakeven is separate from wins/losses; missing costs excluded from headline net.
- Expiry/assignment never assumes execution at zero/target without the required resolution.

Each fixture states source terms, expected signed cash flows, quantities, costs, eligibility, denominator and rounding. Use synthetic instruments and dates.

## P08 reporting interpretation

The frozen planned entry and stop define initial risk. Reported actual entry price independently drives realized cash; a fill crossing the original stop is still a valid report and never changes frozen risk. Resolution.netResult describes unresolved remaining units including attributable acquisition/settlement costs; add prior partial realized results once and recompute R exactly. Original and superseding reports keep their distinct receipts and visible chronology. A reviewed corrected display plan is labeled; the original position terms/risk remain separately identifiable. Outcome snapshots record their calculation source version and event cutoff, distinct from risk provenance. See [ADR 0019](../adr/0019-publication-snapshots-reported-lifecycle.md).

Claimed entry at/after contract expiry is rejected, while delayed receipt of a pre-expiry entry remains a retrospective-report possibility. Only one active unresolved resolution is accepted before review; subsequent changes supersede through a correction. Resolution/review claimed times cannot precede existing lifecycle events. Failed publication candidates retain their reserved version sequence; later text/structured versions allocate a higher sequence and visible lineage excludes the failed branch.

## P09 community interpretation

Comments retain direct reply target and original root independently. Prior text/tag revisions are retained in CommentEditHistory; current mentions resolve at write time to bounded member IDs/handles and are not raw HTML. Tombstones preserve replies, and personal mute does not authorize moderation. Active repost uniqueness is per member/source with optional bounded commentary, original attribution and no financial event. Reports persist reporter-only receipts. Every derived public read rechecks source visibility and data rights; see [ADR 0020](../adr/0020-community-distribution-and-source-visibility.md).

## P10 private research interpretation

JournalEntry adds private title/thesis and a deletion tombstone; an active owner/publication link is unique. Linking another author copies supported frozen terms into an independently owned private Position, while one’s own public position can be linked read-only. Private event corrections append superseding evidence and recompute using frozen risk; they cannot use the public staff correction workflow to obtain another member’s records. Both public and private lifecycle histories use exact microsecond cursors bound to the position.

Watchlists and SavedLayout have updated timestamps and revision controls. Private chart templates apply only to mutable drafts. ExportJob has persisted status, claim/attempt metadata, timestamps, byte size/checksum and private per-attempt object references. Quotas use fixed server allowances and atomic UTC-month counters; downgrade never deletes records. See [ADR 0021](../adr/0021-private-workspace-and-export-jobs.md).


## P11 notification and measurement boundaries

Inboxes and saved searches belong exclusively to their owner, including against ordinary staff access. Public source links require current visibility and exact data rights; stored activity text remains generic. SideEffectDelivery separates optional digest suppression from SMTP bounce suppression and records uncertain sends without automatic replay. ProductEvent stores consented enum properties and hashed business keys only, deletes events on withdrawal, and purges after 90 days. See [ADR 0022](../adr/0022-notifications-delivery-and-consent.md) and [persistence details](persistence-schema.md).

## P12 billing projection and recovery

BillingCustomer binds one owner to the configured provider account/mode. BillingInvoice, BillingRefund and BillingDispute preserve processor truth separately from effective access. BillingOperation records the authorized request and stable processor key before a mutation; a refund retains its resolved integer minor-unit amount and operation ID across uncertainty. Raw signed webhook payloads are normalized behind BillingPort; BillingEvent retains bounded event identity/type/status and retry evidence rather than private provider bodies.

SubscriptionEntitlement is a bounded server projection. Every API and worker reader applies provider namespace/account/mode and validity checks, including profiles, feeds, session state, quotas, analytics and exports. Expired access becomes Free without a scheduler-dependent authorization window. An owner can still read/edit preserved records and request permitted raw exports after downgrade. Fake provider truth lives in separate local-only tables, never in a browser fixture or production adapter. [P12 evidence](../implementation/evidence/P12.md) records actual acceptance.


## P13 operational ownership

Reports and appeals retain explicit assignment, independent reviewer and visible decisions. Support ticket ownership is attached to verified identity; anonymous references require an explicit verified-email claim. SupportAccessGrant binds owner/ticket/resource/purpose/named staff/expiry and revocation. Privacy requests and deletion-object checkpoints separate intent, hold, claim and recoverable erasure. A keyed suppression ledger survives older restores; secret keys remain external to data snapshots. Personal archives reuse expiring owner exports. See [P13 persistence](persistence-schema.md) and [ADR 0024](../adr/0024-staff-support-privacy-control.md).
