# P09 Feeds search discussion social actions sharing and reposts

Use this as a complete milestone assignment inside the repository. Implement the assigned work; do not expand into deferred phases.

## Authority and prerequisites

Read [AGENTS.md](../../AGENTS.md), [documentation index](../README.md), [MVP baseline](../mvp-specification.md), [requirements](../product/requirements.md), and [execution plan](../implementation/execution-plan.md). User instructions take precedence.

Prerequisites: P04, P08 with recorded evidence.
Requirement IDs: REQ-014, REQ-015, REQ-016, REQ-017, REQ-025.

Required detail:
- [docs/product/requirements.md](../product/requirements.md)
- [docs/product/routes-and-journeys.md](../product/routes-and-journeys.md)
- [docs/architecture/api-contract.md](../architecture/api-contract.md)

## Work

1. Implement Following/Discover/editorial feeds, asset/instrument/strategy/status filters, newest keyset pagination and public full-text search.
2. Implement comments/reply targets/flattening, mentions/tags, edit/tombstone/report interfaces and public author cards.
3. Implement Helpful reaction, bookmark, author/instrument follow and per-viewer mute with idempotent constraints.
4. Implement visible Share menus, canonical Copy/native/X/LinkedIn/Reddit actions, licensed image download/text fallback, internal repost/commentary/undo and original attribution.
5. Source visibility/capabilities govern reposts/share images/search/sitemaps/caches; interactions never generate duplicate trade performance.

## Acceptance and evidence

- Thread/reply/edit/report and cross-owner access; self-action rejection, concurrent toggles and mute cannot suppress criticism.
- Actual browser share/clipboard fallback, safe URL encoding/user gesture, one active repost, hidden source derivative purge and statistics unchanged.

Use the relevant AC identifiers in [acceptance](../quality/acceptance.md). Record actual commands/outcomes, browser evidence where applicable, migrations/contracts changed, unresolved failures and external dependencies in docs/implementation/evidence/P09.md. Do not claim a test or supplier approval passed without evidence.

## Completion

Complete public trading community and social distribution journeys with access and attribution evidence.

Update CHANGELOG.md, affected specs/contracts/notices and milestone evidence. Preserve unrelated work and report the final result, checks actually run, unresolved gaps and next milestone. Stop at this milestone's boundary. Routine decisions already covered by the handoff are executable defaults; missing commercial approvals are tracked gates, not permission to silently omit behavior.
