# P02 Domain model database contracts and calculation fixtures

Use this as a complete milestone assignment inside the repository. Implement the assigned work; do not expand into deferred phases.

## Authority and prerequisites

Read [AGENTS.md](../../AGENTS.md), [documentation index](../README.md), [MVP baseline](../mvp-specification.md), [requirements](../product/requirements.md), and [execution plan](../implementation/execution-plan.md). User instructions take precedence.

Prerequisites: P01 with recorded evidence.
Requirement IDs: REQ-006, REQ-011, REQ-012, REQ-013.

Required detail:
- [docs/architecture/data-model.md](../architecture/data-model.md)
- [docs/architecture/api-contract.md](../architecture/api-contract.md)
- [contracts/openapi.json](../../contracts/openapi.json)

## Work

1. Implement Prisma schema and reviewed migrations for the documented aggregates, ownership, versions, quota/idempotency/outbox constraints and indexes.
2. Create pure decimal financial value objects/calculators and state-transition validators for stocks, six option structures and four futures roots.
3. Create deterministic synthetic fixtures/personas with known expected values, missing costs, unresolved expiry and metadata correction cases.
4. Validate OpenAPI/chart schema, generate typed API client types, define runtime request schemas and error mapping. Preserve documented route semantics.
5. Implement reusable transaction/idempotency/revision/outbox infrastructure; never put network side effects inside record transactions.

## Acceptance and evidence

- All worked fixtures, signs, partial exits, rounding, frozen risk denominator and eligibility/exclusion cases.
- Real PostgreSQL uniqueness/locking/rollback/atomic quota races and migration-from-empty. Schema/type generation agrees with contracts.

Use the relevant AC identifiers in [acceptance](../quality/acceptance.md). Record actual commands/outcomes, browser evidence where applicable, migrations/contracts changed, unresolved failures and external dependencies in docs/implementation/evidence/P02.md. Do not claim a test or supplier approval passed without evidence.

## Completion

Reviewable data schema, pure calculation package, typed contracts and real PostgreSQL invariant evidence.

Update CHANGELOG.md, affected specs/contracts/notices and milestone evidence. Preserve unrelated work and report the final result, checks actually run, unresolved gaps and next milestone. Stop at this milestone's boundary. Routine decisions already covered by the handoff are executable defaults; missing commercial approvals are tracked gates, not permission to silently omit behavior.
