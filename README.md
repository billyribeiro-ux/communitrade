# Trading community platform

Phase 1 engineering handoff for a commercial stocks, options, and futures community. Covers the public marketing website, accounts, subscriptions, public publishing/discussion, private member workspace, administration, integrations, and operations.

**Status:** P01–P14 now have local implementation records. Phase 1 includes the marketing/subscription site, stocks/options/futures research, chart drawings and frozen publications, discussion/sharing, private journal/analytics/exports, billing, notifications, administration, support and privacy. P14 adds signed production ingress, private R2 storage, sender suppression, deployment artifacts and measured local recovery/load checks. See [P14 evidence](docs/implementation/evidence/P14.md) and the [acceptance matrix](docs/quality/p14-acceptance-matrix.md). The release decision is **NO_GO** while manual browser acceptance and external legal/provider/operations gates remain open. No commercial approval or production deployment is claimed.

## Run locally

Use the existing mise-managed Node **24.22.0**, pnpm **12.14.0** and Docker tools. Do not globally install or update tools. Start Docker Desktop first.

```sh
pnpm local:init
pnpm local:up
docker compose --env-file .env.local exec -T api pnpm db:seed
pnpm identity:configure
pnpm identity:seed
pnpm test:local
```

`local:init` is first-setup only: it creates an ignored mode-0600 `.env.local` and refuses to overwrite it. It has already run on this machine. Open [the marketing website](http://localhost:3000), [sign up](http://localhost:3000/signup), or [sign in](http://localhost:3000/login). Registration verifies email through [Mailpit](http://localhost:8025); provider account security uses the same [local issuer](http://auth.localhost:8080/realms/options-trade-ideas/account) from browser and containers. The private [member workspace](http://localhost:3000/app) requires sign-in and onboarding. Account/profile/avatar/preferences/session views use real APIs. Implemented trading workflows use the synthetic local provider; synthetic design previews require explicit `LOCAL_DESIGN_PREVIEW=1` and never bypass member or staff identity gates. [Component review](http://localhost:3000/design-preview) remains local-only.

`identity:configure` preserves existing realm users while setting the local confidential OIDC client, PKCE, email, MFA and signed backchannel logout. `identity:seed` generates five separate provider personas in ignored mode-0600 `.local/identity-personas.json`; those credentials are never source-controlled. The application/domain seed and provider seed serve different purposes. Use real sign-up for your own local account.

`local:up` installs locked project dependencies inside Docker, generates Prisma, builds shared packages, applies migrations, then starts health-gated services. The seed creates seven synthetic fixture personas and 21 synthetic references: one underlying, twelve option contracts and eight dated futures contracts. Historical metadata is retained; fixtures are prohibited in public/production releases. Browse [instrument lookup](http://localhost:3000/instruments) or signed-in Explore. The database and SMTP have no host port. Container dependencies and build output use named volumes. Normal `pnpm local:down` preserves data; never add `-v` as routine cleanup.

Run the same application checks inside the existing API container:

```sh
docker compose --env-file .env.local exec -T api sh -lc 'pnpm lint && pnpm typecheck && pnpm check:contracts && TEST_DATABASE_URL="$DATABASE_URL" pnpm test && pnpm build && pnpm check:migrations'
pnpm check:docs
```

Real database tests run when `TEST_DATABASE_URL` is supplied; otherwise they explicitly skip. `pnpm test:migrations` creates an isolated acceptance database, applies all migrations, seeds twice, runs the full suite/checksums, then removes only that temporary database. Existing app/identity databases and Docker volumes are preserved. `pnpm contracts:generate` regenerates the typed client after canonical contract changes; `check:contracts` detects drift. `docker compose --env-file .env.local exec -T api pnpm test:p03:boundaries` checks the optimized build’s release/fixture boundary after `pnpm build`. `pnpm test:p03:http` checks the running site’s full route/link inventory, SSR/noindex boundaries and server plan-intent form; it does not replace browser acceptance. `pnpm test:resilience` deliberately stops the local DB/worker and performs a full Compose down/up to check recovery and persistence; follow it with `pnpm test:local`. `pnpm test:p04:live` exercises the configured Keycloak code flow, independent owners, real upload worker, MFA and Mailpit recovery using local synthetic identities. Run it after identity setup and allow the normal login rate window between repeated runs. It does not replace visual browser review. See [runbooks](docs/operations/runbooks.md) and [runtime inventory](docs/operations/runtime-inventory.md).

## Start here

P05 acceptance runs serially after builds/seeding: `pnpm test:p05:http` validates real API/SSR responses against OpenAPI, and `pnpm test:p05:live` checks member/admin authorization, quote-derived structures and temporary rights restrictions using local synthetic session fixtures. Both are HTTP/protocol checks, not rendered browser acceptance. See [P05 evidence](docs/implementation/evidence/P05.md).

P06 checks run after generation/build: `pnpm test:p06:http` covers chart API/SSR/session behavior, and `pnpm test:p06:live` verifies independent public/member retained-bar permissions with disposable local session fixtures. These do not establish rendered canvas/browser acceptance. Open an instrument to use candles, volume, optional EMAs and exact text prices. See [P06 evidence](docs/implementation/evidence/P06.md).
P07 checks run after build/seed: `pnpm test:p07:live` exercises real owned draft/chart saves, all drawing families, second-session conflicts, private SSR and denied writes. Open `/app/drafts` or start at `/app/publish`. [P07 evidence](docs/implementation/evidence/P07.md) records the complete checks and the browser-policy blocker.

P09 community checks: `pnpm test:p09:live` after healthy API/web/worker. See [P09 evidence](docs/implementation/evidence/P09.md) for actual checks, and [ADR 0020](docs/adr/0020-community-distribution-and-source-visibility.md) for source visibility/sharing decisions.

P08 checks run after build/migrate/seed and healthy API/web/worker: `pnpm test:p08:live`. Complete a saved draft at `/app/drafts/{id}/compose`; report its lifecycle from the published idea, and review structured corrections at `/admin/corrections`. The worker image adds its pinned browser and a shared server-only render secret; see [runbook](docs/operations/runbooks.md) before recreating existing services.



1. Read [AGENTS.md](AGENTS.md) and the [handoff index](docs/README.md).
2. Read the [MVP baseline](docs/mvp-specification.md), [requirements](docs/product/requirements.md), and [route catalog](docs/product/routes-and-journeys.md).
3. Follow the [execution plan](docs/implementation/execution-plan.md) and [P14 release report](docs/implementation/p14-release-status.json). P01–P14 have local evidence; the next work is resolving recorded release gates and completing the manual/provider acceptance matrix. The [release closure checklist](docs/handoff/release-closure.md) names exact founder inputs and locally prepared tools/evidence. Phase 2 livestreaming remains deferred.
4. Validate this documentation package with `node scripts/verify-handoff.mjs`.

## Agreed stack

| Area | Decision |
| --- | --- |
| Frontend | Next.js App Router, React, TypeScript |
| Styling | Plain CSS, CSS Modules, CSS custom properties; custom React components |
| Icons | Phosphor; approved brand SVGs for social destinations |
| Charts | TradingView Lightweight Charts 5.2.1; application-owned drawing tools |
| Backend | NestJS, Node.js LTS, REST/OpenAPI |
| Records | PostgreSQL, Prisma; decimal-safe calculations |
| Local execution | Docker Compose on the founder's Mac |
| Frontend production | Vercel commercial plan |
| Background jobs | PostgreSQL-backed pg-boss; separate worker |
| Identity baseline | OIDC Authorization Code + PKCE; local Keycloak |
| Production services | Reference targets and procurement gates in [integrations](docs/architecture/integrations.md) |

Exact versions are in the package manifests, `pnpm-lock.yaml`, the MVP baseline and [ADR index](docs/adr/README.md). [ADR 0012](docs/adr/0012-foundation-toolchain.md) records the verified TypeScript 7 compiler path and lint baseline.

## Product boundaries

Free and Pro subscriptions; stocks/ETFs, six defined equity-option structures, ES/MES/NQ/MNQ contracts. Trade executions and outcomes are member-reported. Public promotion does not use an unverified win-rate leaderboard.

Livestreaming, screen sharing, live-room chat, scanners, institutional-flow analysis, broker verification, execution, and creator payouts are deferred. See [scope and change control](docs/product/requirements.md).

## Repository use

This is a proprietary commercial project; see [LICENSE](LICENSE). Third-party components retain their own licenses; see [notices](THIRD_PARTY_NOTICES.md). Do not publish the repository or deploy services merely because these files exist.

Engineering standards: [contributing](CONTRIBUTING.md), [security](SECURITY.md), [support](SUPPORT.md), [conduct](CODE_OF_CONDUCT.md), [changelog](CHANGELOG.md).

The complete candidate is published to [communitrade](https://github.com/billyribeiro-ux/communitrade), public under the founder’s October 22 instruction. Branch protections and security settings are enforced; [GitHub evidence](docs/implementation/evidence/github-setup.md) records CI results and the outstanding independent reviewer. Business/domain identity, vendor agreements, provider access and remaining approvals follow the [release checklist](docs/handoff/release-closure.md).

P10 local acceptance: `pnpm test:p10:live` after healthy API/web/worker. Exports are in the Journal page. Watchlist labels are resolved in a batched, rights-aware API response; no per-instrument browser request fan-out is required.
