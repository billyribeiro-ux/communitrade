# ADR 0021 — Private workspace quotas and export jobs

Status: Accepted engineering implementation baseline, October 20, 2026.

## Context

P10 implements REQ-018, REQ-019 and the personal journal export portion of REQ-023. Private research must remain available after a downgrade, without changing a public publication or granting ordinary staff access. Monthly creation allowances and collection limits must hold across concurrent API replicas.

## Decision

Use owner-scoped journal, position, watchlist, layout and export services. All browser mutations require a verified onboarded account and session-bound CSRF. Unknown and other-owner private IDs produce the same 404. Private responses use no-store and application pages remain noindex. Public search, profile statistics, sharing and discovery continue to select public source aggregates only.

Resolve effective Free/Pro entitlement from server validity windows and fixed product allowances: journal creations 30/1,000 per UTC calendar month; watchlists 1/10, items per list 25/100; saved layouts 1/10. Ignore arbitrary stored limits JSON as a way to enlarge allowances. Serialize collection additions with a user-scoped transaction advisory lock; the actor transaction already holds a shared user lock, so avoid a shared-to-exclusive row-lock upgrade. Monthly journal counters use the existing atomic QuotaBucket operation. Deleting an entry does not refund its creation allowance. Read, edit, remove and raw export remain available after quota exhaustion or downgrade.

Stand-alone journal trade plans hydrate supported reference instruments and freeze private position risk using the existing decimal-safe calculator. A link to one's own public trade can refer to that public reported lifecycle; another author's trade requires a separate owner-private position. Notes, tags and reviews never edit publication versions. Owner-private financial corrections append visible superseding events and retain the original fill; public corrections keep the existing reviewed workflow. Linked public source presentation rechecks current visibility and data rights. Layouts copy validated semantic chart state into private templates and apply only to mutable drafts, preserving published evidence.

Free analytics returns basic counts and individual outcomes. Advanced analysis and filtered analytical CSV require current Pro entitlement. Closed, eligible, complete-cost outcomes define headline distributions; R uses frozen positive initial risk, separate denominators and decimal-safe calculations. Review completion reports its qualifying-entry denominator. Raw personal CSV is available without Pro and includes stored journal and position/event records, without exporting supplier quote series.

Export requests create owner-bound asynchronous jobs through the transactional outbox and worker. Authenticated downloads recheck owner, entitlement where applicable, terminal status and expiration. Files expire within 24 hours; storage keys are private identifiers, never public URLs. Formula-leading CSV cells are escaped in addition to standard quoting. Bounded retries, stale-job recovery, attempt fencing and expired-object deletion belong to the job lifecycle. Broader privacy archive/deletion workflows remain P13.

## Consequences and verification

Source visibility and paid validity may change between creation, processing and download; each boundary must reauthorize. Duplicate commands cannot consume multiple quota slots. Existing oversized collections survive downgrade but cannot accept additions above current allowances. Tests must exercise two owners and ordinary staff, concurrent quota boundaries, UTC month rollover, stale revisions, denominator eligibility, formula injection, worker replay/failure and expiry. Local HTTP/SSR evidence does not substitute for rendered browser acceptance or production provider approval. See [P10 evidence](../implementation/evidence/P10.md).
