# P10 Private journal analytics exports watchlists and saved layouts

Use this as a complete milestone assignment inside the repository. Implement the assigned work; do not expand into deferred phases.

## Authority and prerequisites

Read [AGENTS.md](../../AGENTS.md), [documentation index](../README.md), [MVP baseline](../mvp-specification.md), [requirements](../product/requirements.md), and [execution plan](../implementation/execution-plan.md). User instructions take precedence.

Prerequisites: P08, P09 with recorded evidence.
Requirement IDs: REQ-018, REQ-019, REQ-023.

Required detail:
- [docs/product/requirements.md](../product/requirements.md)
- [docs/architecture/data-model.md](../architecture/data-model.md)
- [docs/quality/security-and-privacy.md](../quality/security-and-privacy.md)

## Work

1. Implement owner-only stand-alone/linked journals, private positions/notes/tags/reviews, list/filter/detail and safe edits.
2. Implement Free basic versus Pro analytical views, outcome distribution/mean R/review completion using shared calculation eligibility.
3. Implement watchlist/list-item and private layout management with exact Free/Pro quotas and preserved existing records on limit/downgrade.
4. Implement raw CSV and Pro analytical export jobs, status, owner authorization and expiring downloads; protect formula-leading cells.
5. Link public terms read-only; no private note/edit changes public originals. Seed representative quota and downgrade states.

## Acceptance and evidence

- Two-owner and ordinary-staff isolation through API/HTML/search/media/export/cache; linked/public record cannot reveal private notes.
- Quota boundary/concurrency/UTC-month reset, downgraded oversized records, analytical entitlement checks, export expiry/CSV safety and correct denominators.

Use the relevant AC identifiers in [acceptance](../quality/acceptance.md). Record actual commands/outcomes, browser evidence where applicable, migrations/contracts changed, unresolved failures and external dependencies in docs/implementation/evidence/P10.md. Do not claim a test or supplier approval passed without evidence.

## Completion

Complete private research workspace with tested quotas and export/privacy boundaries.

Update CHANGELOG.md, affected specs/contracts/notices and milestone evidence. Preserve unrelated work and report the final result, checks actually run, unresolved gaps and next milestone. Stop at this milestone's boundary. Routine decisions already covered by the handoff are executable defaults; missing commercial approvals are tracked gates, not permission to silently omit behavior.
