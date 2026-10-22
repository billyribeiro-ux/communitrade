# P13 Staff tools moderation appeals support privacy and operational control

Use this as a complete milestone assignment inside the repository. Implement the assigned work; do not expand into deferred phases.

## Authority and prerequisites

Read [AGENTS.md](../../AGENTS.md), [documentation index](../README.md), [MVP baseline](../mvp-specification.md), [requirements](../product/requirements.md), and [execution plan](../implementation/execution-plan.md). User instructions take precedence.

Prerequisites: P08, P09, P11, P12 with recorded evidence.
Requirement IDs: REQ-010, REQ-022, REQ-023, REQ-027, REQ-032.

Required detail:
- [docs/product/routes-and-journeys.md](../product/routes-and-journeys.md)
- [docs/quality/security-and-privacy.md](../quality/security-and-privacy.md)
- [docs/architecture/api-contract.md](../architecture/api-contract.md)

## Work

1. Implement every staff route: reports/appeals/corrections/users/instruments/data/billing/editorial/support/jobs/audit, with exact role/action allowlists and reasoned audit.
2. Implement report/hide/restore/suspend notices/appeals, structured-correction review and derivative invalidation; do not let authors erase criticism or staff fabricate scores.
3. Implement contact/support tickets/receipts/owner read and staff response, billing support and monitored-contact configuration.
4. Implement verified personal export/deletion requests, retention/hold/status, object/cache/search erasure and deletion-suppression ledger for restores.
5. Implement purpose-limited exceptional support access with expiry/MFA/audit; no general journal browser.

## Acceptance and evidence

- Moderator/admin separation, recent MFA, last-admin protection, invalid action/resource combinations, support ownership and audited escalation expiry.
- End-to-end report/appeal/correction, hiding original derivatives, deletion/export lifecycle and restored backup suppression.

Use the relevant AC identifiers in [acceptance](../quality/acceptance.md). Record actual commands/outcomes, browser evidence where applicable, migrations/contracts changed, unresolved failures and external dependencies in docs/implementation/evidence/P13.md. Do not claim a test or supplier approval passed without evidence.

## Completion

Operationally usable administration and support/privacy workflows, not a decorative admin dashboard.

Update CHANGELOG.md, affected specs/contracts/notices and milestone evidence. Preserve unrelated work and report the final result, checks actually run, unresolved gaps and next milestone. Stop at this milestone's boundary. Routine decisions already covered by the handoff are executable defaults; missing commercial approvals are tracked gates, not permission to silently omit behavior.
