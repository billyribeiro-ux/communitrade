# P01 Reproducible workspace Docker and CI

Use this as a complete milestone assignment inside the repository. Implement the assigned work; do not expand into deferred phases.

## Authority and prerequisites

Read [AGENTS.md](../../AGENTS.md), [documentation index](../README.md), [MVP baseline](../mvp-specification.md), [requirements](../product/requirements.md), and [execution plan](../implementation/execution-plan.md). User instructions take precedence.

Prerequisites: None; inspect the existing documentation-only workspace first.
Requirement IDs: REQ-029, REQ-026.

Required detail:
- [docs/architecture/system-design.md](../architecture/system-design.md)
- [docs/operations/runbooks.md](../operations/runbooks.md)
- [docs/adr/0003-backend-records.md](../adr/0003-backend-records.md)

## Work

1. Inspect existing mise-managed tools read-only. Verify agreed package versions and Nest/Prisma ESM/compiler compatibility; resolve project dependencies to exact pins and lockfile without changing host tools.
2. Scaffold apps/web, apps/api, apps/worker and shared domain/contracts/ui/config packages. Use CSS Modules and Phosphor; no Tailwind or unrequested future features.
3. Create Dockerfiles/Compose for web/API/worker/Postgres/Keycloak/Mailpit with local ports, named volumes, health-gated startup, safe local secret generation and .env.example.
4. Implement health/live/readiness, worker heartbeat/pg-boss connection, controlled migrations/seed entry points and documented root scripts. Add actual typecheck/lint/build/test CI jobs when the code exists.
5. Update runtime/dependency/container inventory and README with commands that actually work.

## Acceptance and evidence

- Clean setup and repeat startup; DB/identity persistence after normal restart; API ready versus DB-down; worker start/stop.
- Build and typecheck all application packages with locked dependencies. No fake passing test scripts, global installation, secrets in generated files or volume deletion.

Use the relevant AC identifiers in [acceptance](../quality/acceptance.md). Record actual commands/outcomes, browser evidence where applicable, migrations/contracts changed, unresolved failures and external dependencies in docs/implementation/evidence/P01.md. Do not claim a test or supplier approval passed without evidence.

## Completion

A reproducible local foundation and truthful setup/CI evidence; no unfinished screens represented as product completion.

Update CHANGELOG.md, affected specs/contracts/notices and milestone evidence. Preserve unrelated work and report the final result, checks actually run, unresolved gaps and next milestone. Stop at this milestone's boundary. Routine decisions already covered by the handoff are executable defaults; missing commercial approvals are tracked gates, not permission to silently omit behavior.
