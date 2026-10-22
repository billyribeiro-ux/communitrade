# P07 Drawing tools interactions semantic anchors and autosave

Use this as a complete milestone assignment inside the repository. Implement the assigned work; do not expand into deferred phases.

## Authority and prerequisites

Read [AGENTS.md](../../AGENTS.md), [documentation index](../README.md), [MVP baseline](../mvp-specification.md), [requirements](../product/requirements.md), and [execution plan](../implementation/execution-plan.md). User instructions take precedence.

Prerequisites: P04, P06 with recorded evidence.
Requirement IDs: REQ-008, REQ-009, REQ-028.

Required detail:
- [docs/architecture/chart-engine.md](../architecture/chart-engine.md)
- [contracts/chart-state.schema.json](../../contracts/chart-state.schema.json)
- [docs/design/design-system.md](../design/design-system.md)

## Work

1. Implement DrawingController/Store and primitive renderers for horizontal, trendline, rectangle, arrow, text and plan overlays.
2. Implement create/select/hit-test/drag/resize/delete, style settings, cancel, one-gesture undo/redo, keyboard controls and accessible object list.
3. Implement chart document endpoints/revision checking with owned seeded drafts; semantic time/price JSON serialization, 50-object bound, autosave status/retry/conflict.
4. Keep underlying price fields distinct from premium/spread values; keep public chart notes distinct from journal-only notes.
5. Preserve anchors across pan/zoom/resize/interval/history changes. Implement the agreed mobile subset; do not add unsupported drawing families.

## Acceptance and evidence

- AC-008 all families, 50 objects, serialization, undo branching, text safety and accessible edit alternatives.
- Reload/second-device restore, stale-tab conflict, failure recovery and changed intervals/gaps; interact in actual browser/touch viewport.

Use the relevant AC identifiers in [acceptance](../quality/acceptance.md). Record actual commands/outcomes, browser evidence where applicable, migrations/contracts changed, unresolved failures and external dependencies in docs/implementation/evidence/P07.md. Do not claim a test or supplier approval passed without evidence.

## Completion

Complete drawing editor and saved-state behavior on real owned draft records.

Update CHANGELOG.md, affected specs/contracts/notices and milestone evidence. Preserve unrelated work and report the final result, checks actually run, unresolved gaps and next milestone. Stop at this milestone's boundary. Routine decisions already covered by the handoff are executable defaults; missing commercial approvals are tracked gates, not permission to silently omit behavior.
