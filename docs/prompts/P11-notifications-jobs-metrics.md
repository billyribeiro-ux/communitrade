# P11 Notifications preferences durable delivery and product measurement

Use this as a complete milestone assignment inside the repository. Implement the assigned work; do not expand into deferred phases.

## Authority and prerequisites

Read [AGENTS.md](../../AGENTS.md), [documentation index](../README.md), [MVP baseline](../mvp-specification.md), [requirements](../product/requirements.md), and [execution plan](../implementation/execution-plan.md). User instructions take precedence.

Prerequisites: P09, P10 with recorded evidence.
Requirement IDs: REQ-020, REQ-026, REQ-031.

Required detail:
- [docs/architecture/integrations.md](../architecture/integrations.md)
- [docs/quality/acceptance.md](../quality/acceptance.md)
- [docs/operations/runbooks.md](../operations/runbooks.md)

## Work

1. Implement transactional outbox dispatcher, pg-boss job handlers and stable side-effect delivery IDs for notifications/email/export/media refresh tasks.
2. Implement in-app aggregation/read states, preferences, followed/reply/bookmark/material-update/account events and safe internal links.
3. Implement optional daily digest at 08:00 user-local time with quiet-hour/DST behavior, one-per-local-date uniqueness, unsubscribe/suppression and Mailpit delivery.
4. Implement first-party activation/return/publication/review/report/conversion event vocabulary without private text or nonessential tracking before approved consent.
5. Add failed-job visibility, retry budgets, backlog telemetry and staff-safe retry interfaces.

## Acceptance and evidence

- Crash between enqueue/dispatch acknowledgment, duplicate deliveries and failed SMTP/provider timeout with no rolled-back publication.
- Digest timezone/DST/quiet-hours, preference changes, unsubscribed versus transactional notices, safe metadata and no private content in metrics.

Use the relevant AC identifiers in [acceptance](../quality/acceptance.md). Record actual commands/outcomes, browser evidence where applicable, migrations/contracts changed, unresolved failures and external dependencies in docs/implementation/evidence/P11.md. Do not claim a test or supplier approval passed without evidence.

## Completion

Reliable notification and background delivery workflows with observable failure/retry behavior.

Update CHANGELOG.md, affected specs/contracts/notices and milestone evidence. Preserve unrelated work and report the final result, checks actually run, unresolved gaps and next milestone. Stop at this milestone's boundary. Routine decisions already covered by the handoff are executable defaults; missing commercial approvals are tracked gates, not permission to silently omit behavior.
