# Engineering instructions

## Toolchain policy supplied by the founder

- Every CLI and runtime on this Mac is managed by mise from ~/.config/mise/config.toml, locked by ~/.config/mise/mise.lock.
- Never install, update or remove tools with brew, npm/pnpm/bun global installs, cargo install, pipx, uv tool, gem, go install, rustup, or vendor install scripts (curl | sh).
- Never run mise use/unuse/upgrade/self-update/settings/lock or edit ~/.config/mise or shell startup files. If a tool is missing or outdated, stop and tell the founder the exact `mise-root use -g <tool>@<version>` to run.
- Project dependencies (pnpm install, uv sync, cargo build) are fine.

## Product and implementation rules

Read [docs/README.md](docs/README.md) and the assigned milestone before editing. User instructions override repository defaults. Implement the entire assigned vertical slice, including its frontend, API, persistence, authorization, failure states, and relevant acceptance evidence.

- Plain CSS and CSS Modules only for authored UI styling. Do not introduce Tailwind, shadcn/ui styling, Sass, or a CSS-in-JS framework.
- Phosphor is the interface icon standard. Read chart values/colors from shared CSS tokens; chart canvas options and SVG geometry may use the rendering library's APIs.
- Respect exact agreed package versions. Never silently substitute a major version or use floating latest tags in committed runtime dependencies.
- Keep public and private records explicitly separated. Every object access is authorized on the server. Never expose secrets, journal notes, or authentication tokens in public caches or browser bundles.
- Use decimal-safe trade calculations. Preserve original publications and visible corrections. Do not imply broker verification.
- No Phase 2 rooms, streaming, scanners, broker integration, or creator payouts.
- Keep provider adapters replaceable. Fixture mode is visibly synthetic and is prohibited for a production release.
- Follow [architecture decisions](docs/adr/README.md), [data model](docs/architecture/data-model.md), [API contract](docs/architecture/api-contract.md), and [acceptance plan](docs/quality/acceptance.md).

## Milestone workflow

1. Report the milestone and requirement IDs being implemented.
2. Inspect existing code and applicable instructions; preserve unrelated work.
3. Resolve implementation detail within the written defaults. Record material changes in an ADR; do not add scope to hide a blocker.
4. Implement, run appropriate checks, and inspect the affected UI in a browser where available.
5. Update relevant specifications, the milestone evidence record, and CHANGELOG.md.
6. Report what works, commands/checks actually run, unresolved failures, and the next milestone. Never mark a check passed based on a file's existence.
7. Do not publish, buy services, or deploy beyond the current authorized task. Routine local engineering and documentation work do not require repeated confirmation.

Do not treat an engineering-selected baseline as founder-approved branding, a signed contract, legal approval, or completed software. External dependencies have owners and release gates; see [dependency register](docs/handoff/dependencies-and-release-gates.md).
