# Third party notices and licensing inventory

P01 dependencies are installed and locked. This initial inventory includes planned later components, so it is not a completed software bill of materials. See the [installed runtime inventory](docs/operations/runtime-inventory.md). Before beta, generate the full inventory from the actual lockfile and container digests, preserve required license/NOTICE texts, review transitives, and record commercial data rights. The [project LICENSE](LICENSE) does not override third-party permissions.

| Component | Intended use | Upstream license / terms to preserve |
| --- | --- | --- |
| Nodemailer 10.1.7 / @types/nodemailer 8.0.2 | SMTP EmailPort / declarations | MIT-0 / MIT; installed license texts retained in package artifacts and lockfile |
| Next.js, React, React DOM | Web application | MIT; verify exact installed artifacts |
| NestJS and Express | Backend | MIT; verify framework and transitive notices |
| `@prisma/adapter-pg` 7.10.1 and Prisma Client/CLI 7.10.1 | PostgreSQL access, generated client, and migrations | Apache-2.0; verify bundled engine and transitive notices |
| `pg` 8.23.1 | PostgreSQL driver | MIT; verify transitive notices |
| `reflect-metadata` 0.2.2 and RxJS 7.8.2 | Nest runtime support | Apache-2.0; verify transitive notices |
| openid-client 6.8.8 / jose 6.2.12 | OIDC protocol and JOSE verification | MIT; installed P04 project dependencies |
| Sharp 0.35.5 | Avatar processing and trusted snapshot conversion | Apache-2.0; bundled libvips and codec notices require final artifact inventory |
| TypeScript | Compiler | Apache-2.0; preserve applicable notices |
| Oxlint 1.89.0 and tsx 4.23.15 | Linting and TypeScript development runner | MIT; verify exact installed artifacts |
| Ajv 8.20.0 / ajv-formats 3.0.1 | Runtime JSON Schema request/chart validation | MIT; installed package license metadata checked in P02 |
| @apidevtools/swagger-parser 13.1.0 | Build-time OpenAPI validation | MIT; installed package license metadata checked in P02 |
| `@types/node` 24.19.2 and `@types/pg` 8.23.1 | Type declarations | MIT; verify exact installed artifacts |
| Prisma | Database toolkit | Apache-2.0; review driver/transitive licenses |
| PostgreSQL | Database | PostgreSQL License |
| Lightweight Charts 5.2.1 | Chart rendering | Apache-2.0 plus TradingView attribution/NOTICE requirements |
| Phosphor React 2.1.10 | UI SVG icons | MIT |
| Simple Icons | Selected social marks | CC0 icon assets; trademarks remain separately controlled |
| pg-boss 12.38.0 | PostgreSQL jobs | MIT |
| Playwright and playwright-core 1.64.0 | Trusted publication snapshot browser automation | Apache-2.0; upstream LICENSE, NOTICE, and ThirdPartyNotices are retained under `third-party/playwright-1.64.0/` and `third-party/playwright-core-1.64.0/` |
| Keycloak 26.8.1 | Local identity reference | Apache-2.0; container/transitive inventory required |
| Mailpit 1.27.8 | Local email capture | MIT upstream; pinned image digest in runtime inventory |
| System font stack | UI typography | No bundled font files; platform licenses remain applicable |
| Node/container base images | Runtime and operating system | Inventory exact image contents and digests |
| Market data, logos, user uploads | Content | Supplier, trademark, and user-content rights; not covered by code licenses |

TradingView: retain the upstream LICENSE and NOTICE, required attribution and link, and attribution in applicable chart/share surfaces. Do not describe this as a partnership or permission to copy TradingView's proprietary UI, data, or complete tool suite.

P06 installs `lightweight-charts` exactly 5.2.1 and its locked MIT `fancy-canvas` 2.1.0 dependency. The original [LICENSE](third-party/lightweight-charts/LICENSE) and [NOTICE](third-party/lightweight-charts/NOTICE) are retained from upstream tag v5.2.1. The fancy-canvas npm artifact omits its license text; the original [MIT license](third-party/fancy-canvas/LICENSE) is retained from [upstream tag 2.1.0](https://github.com/tradingview/fancy-canvas/blob/2.1.0/LICENSE). ChartHost keeps the built-in attribution logo and visible TradingView link; the installed distribution's copyright/license header remains intact. These code licenses do not license market data. Final transitive/container inventory remains a release gate.

Exact-version license fields were checked from read-only npm registry metadata for the newly listed packages on October 19, 2026. This is an initial inventory, not the final lockfile/container SBOM. Sources: [Prisma adapter metadata](https://registry.npmjs.org/@prisma/adapter-pg/7.10.1), [pg metadata](https://registry.npmjs.org/pg/8.23.1), [reflect-metadata](https://registry.npmjs.org/reflect-metadata/0.2.2), [RxJS](https://registry.npmjs.org/rxjs/7.8.2), [Oxlint](https://registry.npmjs.org/oxlint/1.89.0), [tsx](https://registry.npmjs.org/tsx/4.23.15), [@types/node](https://registry.npmjs.org/@types/node/24.19.2), [@types/pg](https://registry.npmjs.org/@types/pg/8.23.1), [Lightweight Charts](https://github.com/tradingview/lightweight-charts), [Phosphor](https://github.com/phosphor-icons/react), [Simple Icons](https://github.com/simple-icons/simple-icons), [pg-boss](https://github.com/timgit/pg-boss), [Keycloak](https://github.com/keycloak/keycloak), [Mailpit](https://github.com/axllent/mailpit), [GitHub licensing guidance](https://docs.github.com/en/repositories/managing-your-repositorys-settings-and-features/customizing-your-repository/licensing-a-repository).

Confirm the actual business rights holder and contributor assignments before distribution. User-upload terms must provide the necessary display/share license while respecting deletion and supplier restrictions.

P04 exact pins and licenses are recorded in the lockfile and installed package metadata. Preserve Sharp/libvips codec notices in the final release artifact; this inventory is not a completed transitive SBOM. See [ADR 0015](docs/adr/0015-identity-profile-media.md).

The P04 Keycloak extension compiles in a pinned Eclipse Temurin 21 JDK build stage. Its toolchain is not installed on the host or copied into the final runtime. Preserve the upstream JDK/container notices and include both build provenance and the final Keycloak image in release inventory.

P05 uses the documented Databento Historical HTTP protocol through application-owned adapters; no Databento SDK dependency or real market dataset was installed. Linking the first-party contracts workspace into the web app adds no new third-party runtime package. Market-data redistribution, storage, images and export rights remain separate commercial approvals; the adapter implementation and synthetic tests do not provide those rights. See [ADR 0016](docs/adr/0016-market-data-reference-capabilities.md).

P08's worker uses the exact `mcr.microsoft.com/playwright:v1.64.0-noble` image pinned by digest in `infra/worker/Dockerfile`, alongside the matching Playwright 1.64.0 npm packages. The npm packages are Apache-2.0; the retained upstream notices include notice files for third-party software bundled with Playwright. The browser image separately contains Chromium, Firefox, WebKit, Ubuntu Noble and browser/system libraries; their licenses and notices are governed by those bundled upstream distributions, not by Playwright's npm license. Preserve the image's browser and `/usr/share/doc` notices when redistributing the worker image, and include its exact digest and package inventory in the release SBOM. The image's OS/browser notices have not been copied into this source inventory; inspect the pinned final image during release inventory.

## October 22 release inventory follow-up

The [actual artifact inventory](docs/implementation/artifacts/release-closure/inventory.json) and [execution record](docs/implementation/evidence/release-closure.md) supersede the earlier missing-metadata count. They distinguish 196 external production entries from five proprietary workspaces and retain available npm, OS, browser and JAR notices from the exact three local image IDs/architectures. Exact-version registry/Maven records are license metadata inputs; filename-derived coordinates are explicitly marked for review. The four indexed notice archives are beside that inventory, with SHA-256 digests. No application/browser ran and no archive was uploaded.

All third-party rights and obligations continue to apply. This technical collection does not approve business IP assignments, commercial market-data rights, licenses for a different architecture/deployed frontend, or redistribution compliance. Human review of the actual distribution and applicable copyleft/browser/codec/database-driver requirements remains G11. Do not replace upstream notices with the proprietary project notice.
