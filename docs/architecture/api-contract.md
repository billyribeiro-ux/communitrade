# API behavior and contracts

The [OpenAPI 3.1 contract](../../contracts/openapi.json) defines methods, paths, request/response types, parameter bounds, operation IDs, requirement mappings, and access intent. The [chart JSON schema](../../contracts/chart-state.schema.json) defines persisted drawing state. P02 supplies [validated/generated types, runtime validation and a typed client](contract-generation.md); business endpoints remain implementation targets for their assigned milestones. Generated definitions are not proof a route exists.

## Global behavior

Base /api/v1, JSON with decimal strings and UTC ISO timestamps ending Z. Private/browser API uses opaque HttpOnly app session plus X-CSRF-Token on state-changing calls. Public reads opt out of cookie authentication in OpenAPI but still enforce content/license visibility. OIDC/Stripe webhooks validate their own protocol signatures and do not require browser CSRF.

P06 uses the existing getBars operation: a maximum of 10,000 bars per page, 90 calendar days intraday or one calendar year daily, with continuation cursors. Stocks require regular sessions; listed futures require exchange sessions. Unsupported session/option-premium history requests fail with 400 instead of being mislabeled or treated as a supplier outage. Actual UTC session-open timestamps are preserved for daily bars. No new endpoint or chart-state write is introduced; see [P06 evidence](../implementation/evidence/P06.md).


P07 implements the seven existing create/list/read/patch/delete draft and read/write chart operations. Chart PUT accepts a direct ChartState body (not a wrapper), requires If-Match `"0"` for initialization, and returns ChartDocument plus a strong quoted revision ETag. Subsequent saves require the acknowledged chart revision; draft title/thesis PATCH uses the separate draft revision. Every chart write increments both revisions and atomically synchronizes underlying overlays; premium/spread entry values remain untouched. Ownership has no administrator bypass. Current displayMember/retainBars and reference identity gate writes; saved authored state remains readable by its owner when rights change. Duplicate drawing IDs/linked fields/EMA periods, out-of-order targets, invalid timezones/viewports and source mismatches fail safely. P08 enables up to three owned ready images bound to the draft; public binding occurs only in successful publication finalization. See [P07 evidence](../implementation/evidence/P07.md).

Return RFC-style problem JSON: type, title, status, code, detail when safe, requestId, optional field errors. No stack traces, secrets, database details, or private-record existence disclosures. Semantics: 401 missing/expired session; 403 known public capability/role failure; 404 unknown or unauthorized private object; 409 stale version/invalid transition/idempotency mismatch; 422 business validation; 429 with Retry-After; 503 supplier unavailable. Invalid body/type/bounds is 400.

Cursor lists default 20/max 50; cursor is opaque and bound to filter/sort, deterministic timestamp+ID ordering. Responses include nextCursor. Apply q <=200 chars, bounded date windows/history, and allowlisted filter enums. GET returns no mutations or billable commands.

Private and mutable-resource reads include ETag where edited. If-Match uses quoted integer revision; stale writes return 409 with current revision and a safe reload hint. No last-write-wins on drafts, charts, profile, comments, journal, watchlist or layout edits. Runtime schema rejects unknown fields and validates cross-field business rules.

Idempotency-Key is required on create/publish/event/checkout/support/export/admin commands where declared. Scope by actor (or signed public-contact session), operation and key; hash normalized input. Retain responses at least 24 hours. Replay same request yields the original resource/result; different payload yields 409. Transactional uniqueness closes race conditions.

## Commands requiring business validation

DraftPlan deliberately allows incomplete fields for incremental autosave; PATCH merges supplied plan fields and leaves absent fields unchanged. Publishing validates the complete TradePlan. For options, plan.instrumentId is the underlying equity/ETF and legs hold the actual option contract IDs (one long leg or two vertical legs); stocks/futures use the actual traded instrument and no option legs. Price kind distinguishes premiums/net spread values from underlying chart levels. Supplied costs must be nonnegative; null means unknown. Position event history is paginated and never silently truncated.

Draft writes can be incomplete, but publishing requires the full supported plan, frozen chart revision, allowed instrument/data capabilities, processed attachments, verified author, and common posting limit. POST publish freezes a candidate and returns 202 PublicationJob; GET /publication-jobs/{id} is owner-scoped. Only successful trusted snapshot completion commits public visibility and publication timestamp. Failure preserves a recoverable draft/candidate and never exposes a partial Publication.

Position events are owner-only (public readership does not grant write access). Entry and partial/final exit require claimedAt, quantity, price and explicit costs null/value; cancel/never_entered/review/resolution require reason. Validate transitions, remaining quantity, chronology, future-clock bounds and supported structures. Entry reporting is one grouped net trade, not legging. Resolution requiring assignment/exercise review must not silently classify a win.

Comment edits can change body/tag only, never author/publication/reply target. Profile avatarMediaId accepts owned ready avatar asset or null. A profile update must never publish an unattached private upload.

Repost is unique per member/source, not a cloned publication; response ID has no Position. Original content permission controls derivative reads/images. Share metadata returns a safe public canonical URL and nullable licensed image URL. Download endpoint rechecks source/version and capability before issuing bytes.

P09 implements these community commands and reads. `GET /publications` supports newest Discover/Following/Editorial with normalized query/filter/viewer-bound keyset cursors, actual stock/option-underlying/futures references and optional personal action state. Following requires a valid session; an absent session is anonymous for other public reads, while invalid supplied credentials are rejected. Reposts are attributed feed records with original publication IDs, not duplicate executions. `GET /publications/{id}/community`, `/users/{handle}/relationship` and `/instruments/{id}/follow` expose no-store viewer state. Comments return rootId and direct reply target plus bounded resolved mentions. DELETE comments also requires If-Match. Create/edit share ten comments per account per minute; new reports are limited to five per UTC hour, with bounded Retry-After. Idempotent replay does not spend another command slot. `/discovery/sitemap` returns bounded currently authorized public records with shard-bound cursors. Licensed `download=true` image responses append attribution while default frozen snapshot bytes remain unchanged. See [ADR 0020](../adr/0020-community-distribution-and-source-visibility.md).

GET /journal-analytics allows Free basic counts/outcomes; requesting advanced strategy/tag/period analysis without Pro returns a clear entitlement error. Journal search/paging remains Free. Watchlist/layout/entry quotas are database-atomic and use the exact MVP limits.

## Provider and file boundaries

Stripe's signed webhook uses the raw provider payload, not the internal normalized schema. Reject invalid signatures/time windows. Persist receipt then reconcile current provider state; a successful acknowledgment is not proof a stale event changed entitlements.

POST /webhooks/oidc/logout accepts the standard form-encoded logout_token and validates issuer/audience/signature/events/issued-time/sid-or-sub/jti replay before revoking sessions. GET /auth/account redirects an authenticated owner only to the configured provider account origin. GET /auth/step-up starts a fresh MFA-assurance transaction. Login screen hints allow login/signup/recover only; callback validates the same OIDC transaction regardless of entry screen.

Upload intent binds owner, purpose, size/type and optional target resource. The returned URL is either a constrained production presigned object URL or local POST /uploads/{id}/content: raw PNG/JPEG/WebP bytes, <=2 MiB, authenticated owner, CSRF/origin checks and exact intent MIME. POST complete queues validation/re-encoding. GET /media/{id}/content serves processed bytes after owner/public-source authorization. No client-chosen fetch URL, path traversal, public quarantine object or unvalidated SVG.

Export creation returns 202/job; the owner retrieves status and GET /exports/{id}/download. Downloads authorize the owner, then stream locally or issue a signed production object URL lasting <=60 seconds; the object expires within 24 hours. Treat that temporary bearer URL as a secret and exclude it from logs. Raw records remain exportable after downgrade; analytical exports require Pro. Encode formula-leading CSV cells safely. Privacy export/deletion requests retain identity, hold and completion status.

## Staff actions

Routes with /admin require explicit staff policy; recent MFA for sensitive admin operations. Allowlist:
- reports: hide/restore/assign/resolve; moderators or admins
- appeals: assign/resolve; reviewers independent where practical
- corrections: approve/reject; create visible version on approval; preserve original evidence
- users: suspend/unsuspend/change_role; admin; never remove/suspend the last active administrator
- instruments: enable/disable; admin, with retained historical metadata
- editorial: select/deselect; admin, reason recorded
- jobs: retry only approved job kinds/failed instances; admin
- billing: refund/reconcile through provider adapter; admin; paymentId must belong to the subscription/provider account/mode; never arbitrary entitlement edits

A generic StaffCommand enum does not mean every action is valid on every resource. Validate the table in the service layer; all commands require reason and audit. Moderators cannot change billing/roles or access journals.

## Endpoint inventory

| Method | Path | Operation | Requirement |
| --- | --- | --- | --- |
| GET | /auth/login | startLogin | REQ-002 |
| GET | /auth/callback | completeLogin | REQ-002 |
| POST | /auth/logout | logout | REQ-003 |
| POST | /auth/logout-all | logoutAll | REQ-003 |
| GET | /me | getMe | REQ-003 |
| POST | /me/onboarding | completeOnboarding | REQ-002 |
| GET | /me/preferences | getPreferences | REQ-020 |
| PATCH | /me/preferences | updatePreferences | REQ-020 |
| GET | /me/sessions | listSessions | REQ-003 |
| DELETE | /me/sessions/{id} | revokeSession | REQ-003 |
| PATCH | /me/profile | updateProfile | REQ-004 |
| GET | /users/{handle} | getProfile | REQ-004 |
| GET | /users/{handle}/performance | getPerformance | REQ-013 |
| GET | /me/dashboard | getDashboard | REQ-005 |
| GET | /instruments | searchInstruments | REQ-006 |
| GET | /instruments/{id} | getInstrument | REQ-006 |
| GET | /instruments/{id}/option-contracts | listOptionContracts | REQ-006 |
| GET | /instruments/{id}/bars | getBars | REQ-007 |
| GET | /instruments/{id}/quote | getQuote | REQ-006 |
| GET | /futures-contracts | listFuturesContracts | REQ-006 |
| GET | /market-data/calendar | getMarketCalendar | REQ-006 |
| POST | /trade-plans/validate-strategy | validateOptionStrategy | REQ-006 |
| POST | /drafts | createDraft | REQ-009 |
| GET | /drafts | listDrafts | REQ-009 |
| GET | /drafts/{id} | getDraft | REQ-009 |
| PATCH | /drafts/{id} | saveDraft | REQ-009 |
| DELETE | /drafts/{id} | deleteDraft | REQ-009 |
| GET | /drafts/{id}/chart | getDraftChart | REQ-008 |
| PUT | /drafts/{id}/chart | saveDraftChart | REQ-008 |
| POST | /drafts/{id}/publish | publishDraft | REQ-009 |
| GET | /publications | listPublications | REQ-014 |
| GET | /publications/{id}/community | getPublicationCommunity | REQ-016 |
| GET | /users/{handle}/relationship | getAuthorRelationship | REQ-016 |
| GET | /instruments/{id}/follow | getInstrumentFollowState | REQ-016 |
| GET | /discovery/sitemap | getPublicDiscovery | REQ-025 |
| GET | /publications/{id} | getPublication | REQ-009 |
| GET | /publications/{id}/revisions | getPublicationRevisions | REQ-010 |
| POST | /publications/{id}/corrections | requestCorrection | REQ-010 |
| GET | /positions/{id}/events | listPositionEvents | REQ-011 |
| POST | /positions/{id}/events | appendPositionEvent | REQ-011 |
| GET | /publications/{id}/comments | listComments | REQ-015 |
| POST | /publications/{id}/comments | createComment | REQ-015 |
| PATCH | /comments/{id} | editComment | REQ-015 |
| DELETE | /comments/{id} | deleteComment | REQ-015 |
| PUT | /publications/{id}/reaction | setReaction | REQ-016 |
| DELETE | /publications/{id}/reaction | removeReaction | REQ-016 |
| PUT | /publications/{id}/bookmark | setBookmark | REQ-016 |
| DELETE | /publications/{id}/bookmark | removeBookmark | REQ-016 |
| PUT | /users/{handle}/follow | setAuthorfollow | REQ-016 |
| DELETE | /users/{handle}/follow | removeAuthorfollow | REQ-016 |
| PUT | /users/{handle}/mute | setAuthormute | REQ-016 |
| DELETE | /users/{handle}/mute | removeAuthormute | REQ-016 |
| PUT | /instruments/{id}/follow | followInstrument | REQ-016 |
| DELETE | /instruments/{id}/follow | unfollowInstrument | REQ-016 |
| GET | /me/bookmarks | listBookmarks | REQ-016 |
| POST | /publications/{id}/reposts | createRepost | REQ-017 |
| DELETE | /publications/{id}/reposts/mine | removeRepost | REQ-017 |
| GET | /users/{handle}/reposts | listReposts | REQ-017 |
| GET | /publications/{id}/share | getShareMetadata | REQ-017 |
| GET | /journal | listJournal | REQ-018 |
| POST | /journal | createJournalEntry | REQ-018 |
| GET | /journal/{id} | getJournalEntry | REQ-018 |
| PATCH | /journal/{id} | saveJournalEntry | REQ-018 |
| DELETE | /journal/{id} | deleteJournalEntry | REQ-018 |
| GET | /journal-analytics | getJournalAnalytics | REQ-018 |
| GET | /watchlists | listWatchlists | REQ-019 |
| POST | /watchlists | createWatchlist | REQ-019 |
| PATCH | /watchlists/{id} | updateWatchlist | REQ-019 |
| DELETE | /watchlists/{id} | deleteWatchlist | REQ-019 |
| GET | /layouts | listLayouts | REQ-019 |
| POST | /layouts | createLayout | REQ-019 |
| PATCH | /layouts/{id} | updateLayout | REQ-019 |
| DELETE | /layouts/{id} | deleteLayout | REQ-019 |
| PUT | /watchlists/{id}/instruments/{instrumentId} | addWatchlistInstrument | REQ-019 |
| DELETE | /watchlists/{id}/instruments/{instrumentId} | removeWatchlistInstrument | REQ-019 |
| GET | /notifications | listNotifications | REQ-020 |
| PUT | /notifications/{id}/read | readNotification | REQ-020 |
| POST | /notifications/read-all | readAllNotifications | REQ-020 |
| GET | /plans | listPlans | REQ-021 |
| GET | /billing/subscription | getSubscription | REQ-021 |
| POST | /billing/checkout | createCheckout | REQ-021 |
| POST | /billing/portal | createBillingPortal | REQ-021 |
| POST | /webhooks/stripe | receiveStripeWebhook | REQ-021 |
| POST | /uploads | createUploadIntent | REQ-024 |
| POST | /uploads/{id}/complete | completeUpload | REQ-024 |
| GET | /media/{id} | getMedia | REQ-024 |
| POST | /exports | requestExport | REQ-023 |
| GET | /exports/{id} | getExport | REQ-023 |
| POST | /privacy/deletion | requestDeletion | REQ-023 |
| POST | /reports | createReport | REQ-022 |
| GET | /reports/{id} | getOwnReport | REQ-022 |
| POST | /reports/{id}/appeals | appealReport | REQ-022 |
| POST | /support | createSupportRequest | REQ-023 |
| GET | /support/{id} | getSupportRequest | REQ-023 |
| POST | /support/{id}/messages | replySupportRequest | REQ-023 |
| GET | /admin/reports | adminListReportreports | REQ-022 |
| GET | /admin/appeals | adminListReportappeals | REQ-022 |
| GET | /admin/support | adminListSupportTicketsupport | REQ-023 |
| GET | /admin/audit | adminListAuditEventaudit | REQ-032 |
| POST | /admin/reports/{id}/actions | adminActreports | REQ-022 |
| POST | /admin/appeals/{id}/actions | adminActappeals | REQ-022 |
| POST | /admin/users/{id}/actions | adminActusers | REQ-032 |
| POST | /admin/instruments/{id}/actions | adminActinstruments | REQ-032 |
| POST | /admin/jobs/{id}/actions | adminActjobs | REQ-026 |
| POST | /admin/editorial/{id}/actions | adminActeditorial | REQ-032 |
| POST | /admin/billing/{id}/actions | adminActbilling | REQ-021 |
| GET | /admin/users | adminListUsers | REQ-032 |
| GET | /admin/data | adminDataStatus | REQ-032 |
| GET | /admin/jobs | adminListJobs | REQ-026 |
| GET | /health/live | healthLive | REQ-026 |
| GET | /health/ready | healthReady | REQ-026 |
| GET | /positions/{id} | getPosition | REQ-011 |
| GET | /privacy/requests | listPrivacyRequests | REQ-023 |
| GET | /publication-jobs/{id} | getPublicationJob | REQ-009 |
| POST | /uploads/{id}/content | uploadLocalBytes | REQ-024 |
| POST | /webhooks/oidc/logout | oidcBackchannelLogout | REQ-003 |
| GET | /auth/account | openProviderAccount | REQ-003 |
| GET | /auth/step-up | startStepUp | REQ-003 |
| GET | /publications/{id}/versions/{versionId} | getPublicationVersion | REQ-010 |
| GET | /admin/corrections | adminListCorrections | REQ-010 |
| POST | /admin/corrections/{id}/actions | adminReviewCorrection | REQ-010 |
| GET | /publications/{id}/correction-requests | listOwnCorrectionRequests | REQ-010 |
| GET | /exports/{id}/download | downloadExport | REQ-023 |
| GET | /media/{id}/content | getMediaContent | REQ-024 |
| GET | /publications/{id}/share/image | getShareImage | REQ-017 |
| GET | /admin/billing | adminListSubscriptions | REQ-021 |
| GET | /admin/instruments | adminListInstruments | REQ-032 |
| GET | /admin/editorial | adminListEditorial | REQ-032 |
| GET | /admin/reports/{id} | adminGetReport | REQ-022 |

| GET | /reports | listOwnReports | REQ-022 |
| GET | /support | listOwnSupportRequests | REQ-023 |
| GET | /admin/overview | adminOverview | REQ-032 |
| GET | /admin/audit/export | adminExportAudit | REQ-032 |
| GET | /support/configuration | supportConfiguration | REQ-023 |
| POST | /support/{id}/claim | claimSupportRequest | REQ-023 |
| POST | /support/{id}/access-requests | requestSupportAccess | REQ-023 |
| POST | /admin/support/{id}/actions | adminSupportAction | REQ-023 |
| POST | /admin/support/{id}/access-actions | adminSupportAccessAction | REQ-023 |
| GET | /admin/support/access/{id}/resource | adminReadSupportResource | REQ-023 |
| GET | /admin/privacy/requests | adminListPrivacyRequests | REQ-023 |
| POST | /admin/privacy/requests/{id}/actions | adminActPrivacyRequest | REQ-023 |
| POST | /support/{id}/access-revocations | revokeOwnSupportAccess | REQ-023 |

## Contract maintenance

P01/P02 validate schema compatibility, regenerate typed client contracts, and add exact response fixtures. Implementation cannot silently drop a route or accept an arbitrary payload because OpenAPI is documentation. OIDC, media, async publish, historical versions, correction review and download transports are defined here and in the machine contract; vendor-specific protocol refinements must preserve these semantics and update contracts/tests in the same PR.

Domain invariants, privacy labels, provider capabilities and calculation rules remain authoritative even where JSON schema cannot express them. Contract tests must prove agreement between generated API and the checked-in contract, then exercise real authorization and transitions.

## P03 public contact implementation

`POST /support` is implemented with exact-origin checking, generated request validation, an affirmative `consent: true` field, Idempotency-Key, durable private intake and a reference receipt. Email is bounded to 254 characters. Three new requests per connection principal per UTC hour; unchanged retries are replayable for 24 hours and altered payloads conflict. Responses are no-store. The receipt does not authorize `GET /support/{id}`; authenticated ticket access and staff handling remain P13. See [ADR 0014](../adr/0014-preview-shell-contact-intent.md).

## P04 identity/profile/media implementation

Implemented identity, onboarding, public profile, preferences/session and local avatar endpoints follow the canonical OpenAPI. Callback accepts bounded standard `iss`, `session_state` and provider error-description fields; provider descriptions are never echoed. `Me.security` reports server-derived `mfaVerified` and `mfaRecent` booleans, not provider tokens. Historical public handles return 308 to the canonical profile API path. Private and media responses are no-store. Raw upload uses supported binary image transport, a 2 MiB parser cap and owner-bound intent; completion returns processing state until the separate worker commits ready/rejected. See [P04 evidence](../implementation/evidence/P04.md) and [ADR 0015](../adr/0015-identity-profile-media.md).

Profile handle changes serialize on the profile row: at most one per 30 days; an early retry returns 409 `HANDLE_CHANGE_COOLDOWN` with the next allowed UTC time. Old handles remain reserved after their one-year redirect expires. Public profile/media reads use the documented 120/minute hashed-source bucket; authenticated writes use 60/minute per account, in addition to upload/login/support limits.

## P05 catalog and market-data boundary

Instrument results retain canonical UUID identities, `asset`, `venue` and `enabled` fields. Each record has source/as-of/delay/freshness/demo/metadata-version/use-rights metadata; details expose retained metadata versions. A disabled catalog record remains readable where current data rights permit it. Search and contract pages use keyset continuation and must scan past restricted records without incorrectly declaring the end of visible results.

`GET /futures-contracts` selects actual ES/MES/NQ/MNQ quarterly contract months; continuous symbols are excluded. The option-contract route selects standard actual contract IDs by expiration/type. `POST /trade-plans/validate-strategy` validates those IDs and equal leg quantities against trusted metadata, with quote-derived buy-ask/sell-bid debit/credit values. Invalid, stale, unavailable, disabled or restricted selections cannot be marked valid. The calculation is a reference estimate, not broker execution. Later draft/publication code must recheck eligibility at commit time.

Effective capabilities are independently derived for the audience and purpose. Matching active agreement rows use the conservative intersection of their flags; provider/configuration permissions are another upper bound. Different purposes supply their respective flags rather than accidentally nullifying each other. Caller-supplied audience flags cannot grant access. Explicit denial is 403 and an otherwise permitted provider outage is 503. Quotes/bars remain uncached, including after permissions change.

Instrument enable/disable accepts only the canonical actions, reason, Idempotency-Key and CSRF token. Administrators need recent MFA for these routes. The command returns the persisted AuditEvent with HTTP 201; identical retry returns the same receipt, changed input conflicts and expired keys may be reused. No generic staff command can change reference history or reported performance.

## P08 implemented semantics

Canonical inventory remains 125 operations / 106 named schemas. Additive inline fields cover revision/remaining quantity/frozen risk, risk and outcome source-version references, calculation exclusions/cost coverage, editorial completeness, exception/resolution and short-stock borrowing costs, correction replacement events and processing job references. Original revision history has a nullable previousVersionId.

`POST /drafts/{id}/publish` uses `If-Match`, `Idempotency-Key` and `{draftRevision, chartRevision}`. The 202 owner-only job becomes succeeded only after a trusted signed worker completion. UploadIntent's optional `resourceType` explicitly distinguishes draft/publication attachment ownership; the composer sends `draft`. A client chart_snapshot upload is rejected. Attachment removal is revision protected; public reads authorize the containing publication and current source rights.

`POST /positions/{id}/events` now explicitly requires strong `If-Match` in addition to CSRF and idempotency. Exact replay is resolved before revision validation. The optional `borrowCosts` decimal/null is accepted only on a short-stock entry; omitted/null remains unknown. Resolution `netResult` applies to remaining units including attributable costs, not the whole position; partial realized results are added once. Position events and public revisions have forward cursors; public version reads exclude uncommitted correction candidates.

Text corrections append a reasoned visible version. Reviewed structured changes expose `processing` and owner-only publicationJobId while existing public evidence remains current. Completion advances the visible version and applies any superseding event atomically. Failure preserves the old current version and returns the request to reviewable status. No author-controlled event can directly provide supersedesId. Internal claim/complete/fail routes are trusted infrastructure authenticated by expiring HMAC claims, not additional public client operations. See [ADR 0019](../adr/0019-publication-snapshots-reported-lifecycle.md).

## P10 private workspace implementation

P10 adds `GET /workspace-usage` (`getWorkspaceUsage`), `GET /watchlists/{id}` (`getWatchlist`), `GET /layouts/{id}` (`getLayout`), and `GET /exports` (`listExports`). Journal analytics has a distinct JournalAnalytics response with explicit eligibility and R denominators, nullable paid analysis on Free and visible exclusions. Export commands/status use ExportJob and ExportJobPage, with private authenticated download paths. The broader personal_archive command remains reserved for P13 and returns an explicit unsupported error in P10. See [ADR 0021](../adr/0021-private-workspace-and-export-jobs.md).

| Operation | Method/path | Access |
| --- | --- | --- |
| getWorkspaceUsage | GET /workspace-usage | Verified owner |
| getWatchlist | GET /watchlists/{id} | Verified owner |
| getLayout | GET /layouts/{id} | Verified owner |
| listExports | GET /exports | Verified owner |

| correctPrivatePositionEvent | POST /journal/{id}/position-corrections | Verified journal and private position owner; If-Match is position revision |

Private corrections use `{sourceEventId,event}` with the existing PositionEvent schema, CSRF and idempotency. The 201 EventReceipt identifies the appended superseding event; ETag carries the new position revision. Public correction review remains separate.


## P11 notifications, delivery operations and measurement

Notification pages expose generic activity, aggregation counts, safe internal links, unread totals and owner/filter-bound cursors. Read-one/all are CSRF protected. Preferences include optional digest/category controls and current analytics consent; account/billing flags and consent timestamps/version are read-only. Pro saved public searches are owner-private, capped atomically at five, support optimistic revision updates, and survive downgrade for viewing/removal. Staff job reads/actions require current admin role and recent MFA; DTOs exclude payloads/recipients. See [ADR 0022](../adr/0022-notifications-delivery-and-consent.md).

| Operation | Method/path | Access |
| --- | --- | --- |
| listSavedSearches | GET /me/saved-searches | Verified owner |
| createSavedSearch | POST /me/saved-searches | Verified Pro owner; CSRF/idempotency |
| updateSavedSearch | PATCH /me/saved-searches/{id} | Verified Pro owner; CSRF/If-Match |
| deleteSavedSearch | DELETE /me/saved-searches/{id} | Verified owner; CSRF/If-Match |
| unsubscribeDigest | POST /digest/unsubscribe | Purpose-bound expiring signed token; no GET mutation |
| recordProductEvent | POST /product-events | Verified owner, CSRF; return only, consented no-op otherwise |
| authorizeNotificationSource | POST /internal/notifications/source | ID/purpose/time-bound HMAC service credential; exact public source authorization |

The internal source endpoint returns only public availability/title/canonical path, never private data. Its credential expires within 30 seconds and is never returned to browsers. Generated inventory: 141 operations, 124 named schemas.

## P12 billing and entitlement implementation

`getSubscription` returns BillingSummary: the owner-only effective plan, limits and usage, invoices, configured provider/mode, synthetic label, paid-through/grace/cancellation state and pending operation. `createCheckout` accepts only the fixed Pro interval and accepted terms version; return URLs and provider price IDs are server configuration. `createBillingPortal` is bodyless. Redirect DTOs contain only the provider URL. `adminActbilling` uses BillingAction, a current administrator with recent MFA, CSRF, command idempotency and an immutable support reason. Refund alone does not cancel; explicit cancellation is at period end. A payment must belong to that subscription/customer/account/mode. No command can directly set a local entitlement.

| Operation | Method/path | Access |
| --- | --- | --- |
| getDemoBillingSession | GET /billing/demo/{sessionId} | Verified owner; local fake provider only |
| actDemoBillingSession | POST /billing/demo/{sessionId}/actions | Verified owner; CSRF/idempotency; explicit synthetic confirmation |
| reconcileBillingProviderState | POST /internal/billing/reconcile | Purpose/time-bound service HMAC; bounded server-selected sweep |

Raw webhook bytes are retained before JSON parsing. Valid signatures, current configured mode/account, deduplication and current provider truth precede entitlement projection. Browser return parameters are never evidence of payment. All API/worker entitlement reads apply the shared account/mode/validity predicate. See [ADR 0023](../adr/0023-billing-provider-truth-and-recovery.md). Generated inventory: 144 operations, 132 named schemas.

## P13 implemented staff, support and privacy semantics

Current inventory: **157 operations / 146 named schemas**. Staff report, appeal, user and editorial commands have separate exact schemas; invalid action/resource combinations are rejected. Moderators see assigned cases and corresponding audit rows. Administrators need recent MFA for sensitive staff reads/actions. Reporters retain their report detail but see only appeal status for another member; target authors receive a sanitized moderation notice and independent appeal capability. AdminUser uses a private reduced identity DTO, including nullable email/handle for deleted or incomplete accounts, rather than asserting that every account has a public profile.

`GET /reports` and `/admin/overview` are role/owner scoped. `GET /admin/audit/export` returns a bounded authenticated CSV without private payload metadata. Existing corrections, catalog/data, billing and jobs remain separate allowlisted services.

`GET /support`, `GET /support/{id}`, reply, explicit claim, owner access-request/revocation and admin support action/access/read routes implement the ticket workflow. Public receipt responses do not grant access. A claim needs the verified exact requester email. Access approval binds one requested resource/purpose to the approving administrator for <=60 minutes; every read verifies the active grant and audits without content. Ticket resolution revokes approved grants. `GET /support/configuration` exposes only safe contact readiness.

`POST /exports` adds `personal_archive`, a private asynchronous JSON archive; CSV remains available under its existing kinds. Owner downloads remain authenticated/no-store with <=24-hour expiry. `POST /privacy/deletion` requires canonical confirmation, a command key, CSRF and recent server-derived identity; optional reason is bounded to 500 characters. `/privacy/requests` is owner-only. `/admin/privacy/requests` and its action route require administrator/recent MFA, exact finite hold/release/process commands and immutable reasoned audit. Deletion/restore suppression is implemented by the worker; redirects or browser state never grant privacy/staff permissions.

## P14 production transport and delivery

Current inventory: **158 operations / 146 named schemas**.

| Method | Route | Operation | Requirement |
| --- | --- | --- | --- |
| POST | /webhooks/resend | receiveResendWebhook | REQ-027 |

The Resend endpoint verifies raw bytes, bounded Svix ID/timestamp/signature and configured sender before durable deduplication and hard-bounce/complaint suppression. Transient bounces do not permanently suppress an address. No raw message/recipient payload is retained in its replay ledger. API and worker use the stable purpose-separated suppression digest for account and anonymous recipients.

Production browser requests use the fixed same-origin Next route handler, which signs exact method/path/query/body bytes, nonce/time and the provider-overwritten client IP. Server rendering uses a separate service principal. PostgreSQL consumes nonces across replicas; arbitrary forwarded headers cannot alter API rate-limit identity. Exact health and independently signed provider/internal endpoints retain their own authentication. Errors and private responses remain no-store. Private R2 media/export reads remain server-authorized; no new public bucket or bearer export URL is introduced. See [ADR 0025](../adr/0025-production-boundaries-and-release-evidence.md).
