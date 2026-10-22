# Contributing

This is a private commercial engineering project, not an open-source invitation. Work requires authorization from the project owner and the applicable contributor/IP agreement.

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

Engineering lead reviews API/data/calculation changes. Founder reviews scope and visual evidence. An independent reviewer checks release security/calculation evidence. Configure actual GitHub handles and protected branches when the remote exists; repository templates alone do not enforce reviews.

Use the [PR template](.github/pull_request_template.md). Keep implementation changes separate from commercial/legal approval. Security reports follow [SECURITY.md](SECURITY.md).
