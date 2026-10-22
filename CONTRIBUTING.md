# Contributing

This is a proprietary commercial engineering project; public source visibility does not grant an open-source license. Work requires authorization from the project owner and the applicable contributor/IP agreement.

Read [AGENTS.md](AGENTS.md), the [execution plan](docs/implementation/execution-plan.md), and the assigned prompt. Open a scoped branch and PR for one milestone or reviewable subtask. Reference requirement and acceptance IDs. Keep unrelated refactors out of feature changes.

## Definition of done

- Public, Free, Pro, moderator, and administrator behavior matches the relevant permission boundary.
- Appropriate success, loading, empty, denied, expired, error, and retry states work.
- Schema migrations and rollback/recovery consequences are reviewed.
- Relevant checks pass; attach actual commands, results, UI evidence, and known limits.
- Secrets and licensed data are absent from fixtures, screenshots, and logs.
- Documentation, API/schema changes, notices, and changelog reflect the delivered state.
- Required external release gates remain explicit; tests using fakes do not satisfy supplier approval.

After scaffolding, CI must run type checking, linting, meaningful domain/integration tests, production builds, and relevant browser scenarios. [Acceptance](docs/quality/acceptance.md) specifies what those checks prove. Do not add empty jobs or success-only placeholders and describe them as tests.

## Review and merges

Follow the founder-approved [solo-maintainer policy](docs/adr/0026-solo-maintainer-governance.md): use a protected PR, run a separate read-only automated review, resolve actionable findings, and pass the current CI/CodeQL gates before an ordinary squash merge. The founder remains accountable; automated review is not independent human assurance. Restore independent human approval when another trusted maintainer joins. Independent production security/recovery review requirements remain explicit release gates.

Use the [PR template](.github/pull_request_template.md). Keep implementation changes separate from commercial/legal approval. Security reports follow [SECURITY.md](SECURITY.md).
