# P05 Stocks options futures reference data and provider adapters

Use this as a complete milestone assignment inside the repository. Implement the assigned work; do not expand into deferred phases.

## Authority and prerequisites

Read [AGENTS.md](../../AGENTS.md), [documentation index](../README.md), [MVP baseline](../mvp-specification.md), [requirements](../product/requirements.md), and [execution plan](../implementation/execution-plan.md). User instructions take precedence.

Prerequisites: P02, P04 with recorded evidence.
Requirement IDs: REQ-006, REQ-030, REQ-032.

Required detail:
- [docs/architecture/integrations.md](../architecture/integrations.md)
- [docs/product/requirements.md](../product/requirements.md)
- [docs/handoff/dependencies-and-release-gates.md](../handoff/dependencies-and-release-gates.md)

## Work

1. Implement instrument/catalog/reference metadata and MarketDataPort, source/as-of/delay/freshness/capability envelope, session calendar and pagination.
2. Implement synthetic stock/options chain/ES-MES-NQ-MNQ contract adapters and option strategy/actual-contract selectors.
3. Build instrument lookup/detail surfaces and staff disable-new-publishing behavior while retaining history.
4. Implement typed production provider adapter boundary against documented supplier protocols. Use actual credentials/datasets only when supplied and authorized; record procurement gaps without scraping or inventing approvals.
5. Production configuration rejects fixtures/unlicensed capabilities; separately gate public/member display, stored bars, images and exports.

## Acceptance and evidence

- All three asset classes, valid and invalid verticals, actual contract months, metadata versions and stale/missing/provider-failure cases.
- Fixture labels everywhere; no production fake mode; absent Greeks not invented; supplier restriction prevents affected display/publish without erasing history.

Use the relevant AC identifiers in [acceptance](../quality/acceptance.md). Record actual commands/outcomes, browser evidence where applicable, migrations/contracts changed, unresolved failures and external dependencies in docs/implementation/evidence/P05.md. Do not claim a test or supplier approval passed without evidence.

## Completion

Working reference catalog and fixture-backed adapter contracts, with external data rights status explicitly tracked.

Update CHANGELOG.md, affected specs/contracts/notices and milestone evidence. Preserve unrelated work and report the final result, checks actually run, unresolved gaps and next milestone. Stop at this milestone's boundary. Routine decisions already covered by the handoff are executable defaults; missing commercial approvals are tracked gates, not permission to silently omit behavior.
