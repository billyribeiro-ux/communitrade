# P06 Lightweight Charts rendering data sessions and lifecycle

Use this as a complete milestone assignment inside the repository. Implement the assigned work; do not expand into deferred phases.

## Authority and prerequisites

Read [AGENTS.md](../../AGENTS.md), [documentation index](../README.md), [MVP baseline](../mvp-specification.md), [requirements](../product/requirements.md), and [execution plan](../implementation/execution-plan.md). User instructions take precedence.

Prerequisites: P03, P05 with recorded evidence.
Requirement IDs: REQ-007, REQ-028.

Required detail:
- [docs/architecture/chart-engine.md](../architecture/chart-engine.md)
- [docs/mvp-specification.md](../mvp-specification.md)
- [contracts/chart-state.schema.json](../../contracts/chart-state.schema.json)

## Work

1. Implement dedicated Next client ChartHost using Lightweight Charts 5.2.1 v5 APIs, candles, volume, crosshair, zoom/pan, supported intervals and agreed EMAs.
2. Integrate normalized bars/provenance/session/adjustment labels, correct underlying versus futures chart selection, and missing/stale/loading/retry states.
3. Apply CSS token colors, responsive sizing, textual price/plan alternatives and attribution.
4. Implement clean subscribe/unsubscribe/resize/remove lifecycle, including React development remount and route transitions.
5. Do not claim premium-history charts, complete built-in drawings or real-time data.

## Acceptance and evidence

- Chart mount/unmount/repeated route changes without leaked instances/listeners; all intervals, resize/theme and session labels.
- DST/holidays/overnight contracts/history gaps; no fabricated candles; basic keyboard/mobile chart behavior and source display.

Use the relevant AC identifiers in [acceptance](../quality/acceptance.md). Record actual commands/outcomes, browser evidence where applicable, migrations/contracts changed, unresolved failures and external dependencies in docs/implementation/evidence/P06.md. Do not claim a test or supplier approval passed without evidence.

## Completion

Reliable rendered chart engine with source/session correctness and browser evidence, ready for drawing tools.

Update CHANGELOG.md, affected specs/contracts/notices and milestone evidence. Preserve unrelated work and report the final result, checks actually run, unresolved gaps and next milestone. Stop at this milestone's boundary. Routine decisions already covered by the handoff are executable defaults; missing commercial approvals are tracked gates, not permission to silently omit behavior.
