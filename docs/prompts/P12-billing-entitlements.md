# P12 Free Pro checkout billing lifecycle and entitlements

Use this as a complete milestone assignment inside the repository. Implement the assigned work; do not expand into deferred phases.

## Authority and prerequisites

Read [AGENTS.md](../../AGENTS.md), [documentation index](../README.md), [MVP baseline](../mvp-specification.md), [requirements](../product/requirements.md), and [execution plan](../implementation/execution-plan.md). User instructions take precedence.

Prerequisites: P04, P10, P11 with recorded evidence.
Requirement IDs: REQ-001, REQ-021.

Required detail:
- [docs/product/requirements.md](../product/requirements.md)
- [docs/architecture/integrations.md](../architecture/integrations.md)
- [docs/handoff/dependencies-and-release-gates.md](../handoff/dependencies-and-release-gates.md)

## Work

1. Implement server-side monthly/annual plan mapping, pricing CTA intent, hosted checkout and customer portal. Use local fake or supplied test credentials until live processor approval.
2. Implement raw-body signature verification, event deduplication, current-state reconciliation and strict test/production/provider-account isolation.
3. Implement active/paid-through cancellation/past_due grace/unpaid states, renewals/refund support and record-preserving downgrade rules.
4. Wire plan/usage/invoice/portal/return states and all API-level entitlement/quota enforcement. A return URL never grants Pro.
5. Keep production tax/price/account/underwriting evidence in the release register; do not make real purchases or fabricate approvals.

## Acceptance and evidence

- AC-021 valid/forged/replayed/out-of-order events, interrupted checkout, existing Pro duplicate subscription prevention, failure grace and cancellation/downgrade.
- Free versus Pro real API enforcement, existing data access after downgrade and provider reconciliation after uncertain refund/cancel outcome.

Use the relevant AC identifiers in [acceptance](../quality/acceptance.md). Record actual commands/outcomes, browser evidence where applicable, migrations/contracts changed, unresolved failures and external dependencies in docs/implementation/evidence/P12.md. Do not claim a test or supplier approval passed without evidence.

## Completion

Complete subscription lifecycle in test mode and documented live acceptance gates.

Update CHANGELOG.md, affected specs/contracts/notices and milestone evidence. Preserve unrelated work and report the final result, checks actually run, unresolved gaps and next milestone. Stop at this milestone's boundary. Routine decisions already covered by the handoff are executable defaults; missing commercial approvals are tracked gates, not permission to silently omit behavior.
