# Runtime and dependency inventory

Date: October 20, 2026. P01–P07 local implementation, not a production deployment inventory or final license SBOM. Direct dependencies are exact-pinned; `pnpm-lock.yaml` resolves transitives and artifact integrity. P06 installs the chart renderer; P07 implements semantic drawing/editor/draft persistence using existing dependencies and schema. Supplier protocol implementation does not mean commercial approval or actual supplier conformance.

| Component | Installed version / role |
| --- | --- |
| Host and container Node.js | 24.22.0 LTS |
| Host and container pnpm | 12.14.0 |
| Host Docker / Compose | 29.8.2 / 5.5.1 |
| Next.js / React / React DOM | 16.4.2 / 19.3.1 / 19.3.1 |
| TypeScript | 7.0.2, native CLI; no Nest CLI or TypeScript ESLint parser |
| Nest common/core/platform-express | 12.2.0 |
| Prisma CLI/client/adapter-pg | 7.10.1, generated ESM client and PostgreSQL driver adapter |
| pg / pg-boss | 8.23.1 / 12.38.0 |
| Lightweight Charts / fancy-canvas | 5.2.1 / 2.1.0; installed P06, Apache-2.0 / MIT |
| Phosphor React | 2.1.10; plain CSS/CSS Modules |
| reflect-metadata / RxJS | 0.2.2 / 7.8.2 |
| Oxlint / tsx | 1.89.0 / 4.23.15 |
| Ajv / ajv-formats | 8.20.0 / 3.0.1, full JSON Schema 2020-12 runtime validation |
| openid-client / jose / Sharp | 6.8.8 / 6.2.12 / 0.35.5, OIDC/session verification and private avatar processing |
| Swagger Parser | 13.1.0, build-time OpenAPI 3.1 validation; Node >=22.19.0 |
| Node / pg / React / React DOM declarations | 24.19.2 / 8.23.1 / 19.3.0 / 19.3.0 |

## Container bases

| Image | Pinned upstream digest |
| --- | --- |
| eclipse-temurin:21.0.8_9-jdk (Keycloak SPI build only) | `sha256:7d1d666ddafac14da0ded6b4b076becf76cf88b31f9d7953a76555cc82f86511` |
| node:24.22.0-bookworm-slim | `sha256:a5f4366e834695d5f363b920c104953a535d3a9864d1bdf74566a0ebe01daee5` |
| postgres:18.6 | `sha256:74935e72241653ca55e0414067e6d8763aceb8a810eb51b452253ec3dcfc4336` |
| quay.io/keycloak/keycloak:26.8.1 | `sha256:79c623a22abacf3fe6c00a5fb30f5b7843d717b234033b80995891c06116d244` |
| axllent/mailpit:v1.27.8 | `sha256:6abc8e633df15eaf785cfcf38bae48e66f64beecdc03121e249d0f9ec15f0707` |

The application development image adds Debian CA certificates and OpenSSL for Prisma tooling. This build resolved `ca-certificates=20250419~deb12u1`, `libssl3=3.0.22-1~deb12u1` and `openssl=3.0.22-1~deb12u1`. Apt repositories are not snapshotted: these OS packages can change on a rebuild. Immutable production image provenance/SBOM remains a P14 gate. No package was installed globally on the Mac.

The PostgreSQL development image copies the initialization script with mode 0644 so the official entrypoint sources it. This avoids Mac bind-mount execute-bit behavior. It creates separate application and identity roles/databases. They share one local PostgreSQL server/volume; this is not the final production credential separation.

## Service boundaries

| Service | Role / readiness |
| --- | --- |
| deps | One-shot frozen install, Prisma generation, shared-package builds |
| migrate | One-shot `prisma migrate deploy`, after PostgreSQL/deps |
| web | Localhost 3000; `/health`, fixed internal API proxy |
| api | Localhost 3001; live independent of DB, ready checks expected table |
| worker | pg-boss queue and 15-second heartbeat, 3 retries with backoff and 30-second expiry; health checks DB heartbeat freshness within 90 seconds |
| postgres | No host port; application and identity databases; persistent named volume |
| keycloak | Localhost 8080; management readiness; configured product realm, registration/verification/recovery and ACR-based MFA |
| mailpit | UI/API localhost 8025; SMTP internal 1025; ephemeral captured mail |

Compose masks the host `.env.local` inside app containers and scopes environment variables per service. Web gets no DB or identity administrator credentials. Secrets remain ignored local configuration; no public frontend environment prefixes are used. Runtime health responses are intentionally minimal and uncached.

Named volumes isolate dependencies and build output from host installations. `local_objects` is shared by the API filesystem StoragePort and real avatar-processing worker. Raw objects are quarantined outside public roots. P04 adds separate package dependency/build volumes for the media package. No Redis, streaming server, scanner or broker service is introduced.

## Package script behavior

Build/typecheck/test scripts generate the Prisma client and build shared packages before dependent apps. API/worker use direct `tsc` output; development uses tsx with explicit Nest injection. Web typecheck generates Next route types. Web builds explicitly select `NODE_ENV=production`, even from a development container. Oxlint provides syntax/correctness linting, with TypeScript CLI checking types separately. pnpm 12 uses `allowBuilds`; only Prisma engines/CLI, esbuild and sharp are allowed dependency lifecycle builds. Fresh-release exceptions are exact-version scoped and `minimumReleaseAgeStrict` prevents silent additions.

P02 adds no decimal dependency: supported calculations use strict decimal strings and BigInt intermediates. Six immutable SQL migration files include P01 plus the P02 forward migrations. See [P01 evidence](../implementation/evidence/P01.md), [P02 evidence](../implementation/evidence/P02.md), [ADR 0012](../adr/0012-foundation-toolchain.md), [ADR 0013](../adr/0013-domain-persistence-contracts.md) and [third-party notices](../../THIRD_PARTY_NOTICES.md).

P04 adds media outbox dispatch, pg-boss processing with bounded retry/terminal rejection, expiration cleanup, and per-request authorized WebP delivery. See [P04 evidence](../implementation/evidence/P04.md) for actual acceptance rather than inferring it from configuration.

P05 adds no external runtime dependency. Web now depends on the existing first-party contracts workspace, with the locked Docker install updated. The domain package contains the typed data port, synthetic adapter and injected-transport Databento boundary. API-only supplier settings, exact UUID/dataset/symbol/version mappings, approved calendars and audience/purpose agreement grants remain server-side. Ten immutable migrations and 52 Prisma models are present. The local seed contains 21 synthetic instruments and retains corrected/historical versions. See [P05 evidence](../implementation/evidence/P05.md) and [ADR 0016](../adr/0016-market-data-reference-capabilities.md).

P06 adds exact-pinned Lightweight Charts 5.2.1 and locked fancy-canvas 2.1.0, with retained upstream license/notice and TradingView attribution. Browser-only chart instances and observers are ephemeral; P06 adds no tables or endpoints. Existing getBars page bounds and session semantics now match its canonical contract. Schema inventory remains 52 models, ten immutable migrations and 125 API operations / 106 schemas. Actual rendered/browser and licensed supplier acceptance remain separate gates; see [P06 evidence](../implementation/evidence/P06.md) and [ADR 0017](../adr/0017-chart-rendering-lifecycle.md).

P07 adds owned draft/chart handlers on the existing canonical contract and tables, plus browser-only primitives/controller/forms and serial autosave. No dependency, model, migration or canonical operation/schema was added. See [P07 evidence](../implementation/evidence/P07.md) and [ADR 0018](../adr/0018-semantic-chart-drafts.md); actual browser/touch acceptance remains open.

## P08 trusted capture addition

Worker runtime dependencies add exact `playwright@1.64.0` and runtime `sharp@0.35.5` (previously the worker's image-test development dependency). The worker uses `mcr.microsoft.com/playwright:v1.64.0-noble@sha256:06a9939e57531807f8d5fd76ce44b53165ffb7d7501d87ab10e285c20b1e971f`, with the exact pinned Node 24.22.0 runtime copied from the existing Node image and pnpm 12.14.0 enabled. Browser/system components retain their upstream notices; see [notices](../../THIRD_PARTY_NOTICES.md). The root web package references the existing workspace domain/media packages for decimal estimates and server-only token verification. No global host CLI/runtime is installed or changed.

## P09 community additions

P09 adds no package/runtime dependency. Existing PostgreSQL full-text search and Sharp image composition support community distribution and licensed attributed exports. Migration 014 brings the current inventory to 55 models/fourteen migrations; generated contracts have 129 operations/111 named schemas and the ADR inventory is twenty. No host CLI/runtime was installed or updated. Actual verification is recorded in [P09 evidence](../implementation/evidence/P09.md).

## P10 private workspace additions

No external runtime package version changes. The worker adds the existing `@trading/domain` workspace dependency so CSV analysis shares decimal/ratio formatting. Three additive migrations bring the inventory to 55 models/seventeen migrations; generated contracts have 134 operations/115 named schemas and the ADR inventory is twenty-one. Personal CSV objects use private filesystem export storage in local Docker; authenticated download routes never expose storage keys or bearer URLs. See [P10 evidence](../implementation/evidence/P10.md).


## P11 delivery additions

Worker exact-pins Nodemailer **10.1.7** (MIT-0), with **@types/nodemailer 8.0.2** (MIT) for compilation. Registry package metadata and the installed license artifacts are recorded in [P11 evidence](../implementation/evidence/P11.md); the SMTP API follows [upstream documentation](https://nodemailer.com/smtp). No host tool changed. Inventory: 59 Prisma models/eighteen migrations, 141 operations/124 named schemas and 22 ADRs. Existing pg-boss/PostgreSQL/Mailpit provide durable fanout, SMTP and digest delivery; no additional runtime service is introduced.

## P12 runtime boundary

P12 adds no external runtime service or payment SDK dependency. Native Node fetch/crypto implement the replaceable server-only Stripe REST/signature adapter; PostgreSQL persists the synthetic local provider and durable billing state. Existing API/worker/pg-boss/identity/Mailpit/Next services remain. The Stripe API protocol is pinned to `2025-06-30.basil`, an explicitly tested supported version, without claiming it is the latest version. Current inventory: 72 models, twenty migrations, 144 operations/132 schemas and 23 ADRs. Actual checks and outstanding provider/browser gates are in [P12 evidence](../implementation/evidence/P12.md).

## Current release inventory

The October 22 [exact local image/host inventory](../implementation/artifacts/release-closure/inventory.json), notice archives and [follow-up record](../implementation/evidence/release-closure.md) supplement this historical runtime baseline. They identify actual image architectures/IDs, npm/OS/JAR components and retained available notices. They do not establish production hosting versions, target-architecture conformance, vulnerability certification or legal approval. Recollect against the exact candidate artifacts before distribution.
