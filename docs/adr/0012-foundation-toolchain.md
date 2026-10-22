# ADR 0012 Foundation compiler and package compatibility

Date: October 19, 2026  
Status: Engineering-selected implementation baseline; P01 local build/runtime verification passed

## Context

The MVP locks TypeScript 7.0.2, Node.js 24.22.0, NestJS 12.2.0, Prisma 7.10.1, Next.js 16.4.2, pnpm 12.14.0, and PostgreSQL 18.6. These packages use different compiler integration paths. Nest CLI and the default Next.js TypeScript integration have historically loaded the TypeScript JavaScript Compiler API, which TypeScript 7.0 does not ship. A version-compatible dependency graph alone does not prove that the applications compile together.

## Decision

- Keep the agreed TypeScript 7.0.2 pin. Build the Nest API and worker with the standalone `tsc -p <project>` command and run emitted Node ESM output. Do not use Nest CLI commands for compilation or startup. Use explicit Nest injection tokens (`@Inject(...)` or stable symbols) wherever constructor injection would otherwise depend on emitted design-type metadata. This avoids relying on the missing TypeScript programmatic API and makes DI dependencies explicit. Nest's ESM runtime and this direct compiler path remain subject to the P01 build gate.
- Keep Next.js 16.4.2 and TypeScript 7.0.2. Select Next's TypeScript CLI path with `experimental.useTypeScriptCli: true` so Next delegates checking to the local `tsc` executable instead of loading the JavaScript Compiler API. This is an explicit compatibility setting even though the 16.4 line enables the path by default.
- Use Oxlint 1.89.0 for JavaScript/TypeScript linting. The current `@typescript-eslint/parser` 8.72.0 metadata excludes TypeScript 6.1 and later (`typescript <6.1.0`), so that parser is not a compatible choice for TypeScript 7. Oxlint's native TypeScript rules avoid that parser dependency. Type-aware linting is a separate capability; enable it only when the pinned Oxlint and its TypeScript-Go companion are verified together.
- Keep Prisma CLI and client at 7.10.1. Use `@prisma/adapter-pg` 7.10.1 with `pg` 8.23.1 and `@types/pg` 8.23.1. Generate the ESM `prisma-client` client into an explicit source output directory and construct PrismaClient with PrismaPg. Keep database connection strings in runtime configuration and pass them to the adapter; generated/browser contracts contain no credentials.
- Keep the shared strict TypeScript settings in `packages/config/tsconfig.base.json`. Node applications override module output and resolution to `NodeNext`; Next's app config uses its framework-compatible module settings.

## Consequences

This keeps one exact TypeScript 7 baseline without depending on the Nest CLI's programmatic compiler integration or a TypeScript ESLint parser whose published peer range excludes TS7. [P01 evidence](../implementation/evidence/P01.md) records successful API/worker and Next production builds, typechecking, runtime startup and real PostgreSQL adapter tests on the local Mac/Linux container setup. Remote CI and production deployment remain unverified.

## Evidence and sources

Read-only npm metadata checked on October 19, 2026 confirms the exact package releases and declared compatibility ranges: [Nest core 12.2.0](https://registry.npmjs.org/@nestjs/core/12.2.0), [Nest common 12.2.0](https://registry.npmjs.org/@nestjs/common/12.2.0), [Nest Express adapter 12.2.0](https://registry.npmjs.org/@nestjs/platform-express/12.2.0), [Prisma 7.10.1](https://registry.npmjs.org/prisma/7.10.1), [Prisma Client 7.10.1](https://registry.npmjs.org/@prisma/client/7.10.1), [PostgreSQL adapter 7.10.1](https://registry.npmjs.org/@prisma/adapter-pg/7.10.1), [pg 8.23.1](https://registry.npmjs.org/pg/8.23.1), and [@types/pg 8.23.1](https://registry.npmjs.org/@types/pg/8.23.1).

Prisma 7's ESM and driver-adapter requirements are documented in the [v7 upgrade guide](https://www.prisma.io/docs/guides/upgrade-prisma-orm/v7) and [generator reference](https://www.prisma.io/docs/orm/v7/prisma-schema/overview/generators). The [Nest 12 migration guide](https://docs.nestjs.com/migration-guide) describes the framework's ESM packages and Node requirements. Nest CLI's TypeScript 7 limitation is tracked in its [TypeScript 7 support issue](https://github.com/nestjs/nest-cli/issues/3479); this ADR avoids that CLI compiler path rather than claiming Nest itself cannot run on TypeScript 7.

Next's TypeScript CLI mode and TypeScript 7 transition are described in the [Next.js 16.3 preview discussion](https://github.com/vercel/next.js/discussions/95130) and [TypeScript 7 discussion](https://github.com/vercel/next.js/discussions/95633). The TypeScript ESLint parser version constraint is published in [@typescript-eslint/parser 8.72.0 metadata](https://registry.npmjs.org/@typescript-eslint/parser/8.72.0). Oxlint's TypeScript and type-aware support are described in its [official docs](https://oxc.rs/docs/guide/usage/linter/type-aware.html).

## Revisit trigger

Revisit only if the P01 direct compiler/build gate fails, a dependency changes its supported API or peer range, TypeScript 7 restores the programmatic API in a compatible release, or framework maintainers remove/alter the documented CLI mode. Record any replacement versions and evidence before changing the pins.
