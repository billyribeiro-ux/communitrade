# System architecture

Read the [ADR index](../adr/README.md), [data model](data-model.md), [API contract](api-contract.md), [integrations](integrations.md), and [operations](../operations/runbooks.md).

## Deployment and ownership

| Process/service | Responsibility |
| --- | --- |
| apps/web | Next.js marketing/public SSR, member/staff UI, CSS Modules and Phosphor |
| apps/api | NestJS business rules, sessions, authorization, OpenAPI, commands/queries |
| apps/worker | Same backend packages; pg-boss consumers, outbox delivery, processing/reconciliation |
| PostgreSQL | Authoritative application records, app sessions, outbox, pg-boss schema |
| Keycloak | OIDC identity, registration, passwords, verification, recovery, MFA |
| Local files / production R2 | Processed image/export storage behind a StoragePort |
| Mailpit / production Resend SMTP | EmailPort delivery |
| Stripe | Hosted subscription checkout/portal and signed billing events |
| MarketDataPort | Synthetic local adapter; licensed provider adapter after procurement |

Local Docker Compose includes web, API, worker, PostgreSQL, Keycloak and Mailpit. Core application remains four processes/services; the latter two support local identity/email. PostgreSQL hosts separate application and identity databases with separate users; pg-boss has its own schema. No Redis requirement.

Production reference: Vercel web; paid always-on Render API/worker/Keycloak services; managed PostgreSQL with verified backup tier; R2 objects; Resend email; Stripe. The founder approved Vercel, not these paid purchases. Other selections are engineering defaults documented in ADRs; provisioning, regional fit, contracts and exact tiers remain release inputs.

## Repository layout

Expected scaffold:
- apps/web, apps/api, apps/worker
- packages/domain (pure calculations/value objects), packages/contracts (generated API types), packages/ui (plain CSS components), packages/config
- prisma/schema.prisma and reviewed migrations
- contracts/openapi.json and contracts/chart-state.schema.json
- tests/fixtures (synthetic), tests/e2e
- infra/compose and deployment descriptions
- scripts, docs, .github

Use pnpm workspaces. No Nx/Turborepo build dependency is necessary initially. Dependencies point through package exports, not relative imports across application internals. Keep Nest/Prisma/provider classes out of the pure calculation package.

## Browser to server boundary

Browser requests /api/v1 through the application's origin; local web proxy/rewrite forwards to API's internal hostname. Production web rewrites to a fixed configured Nest origin. Server Components fetch from the trusted API origin with only the intended user's session cookie and request context. Never forward cookies to user-supplied destinations or cache private responses publicly.

Nest is the session and business-rule authority. It is not duplicated inside Next route handlers. The web layer must not write directly to the production database. Static marketing can render independently of API/data outages. Public research reads use only published, visible, licensed records.

## Identity/session sequence

1. Browser starts /api/v1/auth/login with a validated relative return path. API creates state/nonce/PKCE transaction, records short expiry, and redirects to Keycloak.
2. Provider callback reaches /api/v1/auth/callback through the same public origin. API validates state, nonce, issuer, signature/audience/time and code exchange.
3. Map (issuer, subject) to app user; retain email verification state. Application roles/entitlements come from application records, not arbitrary browser claims.
4. Rotate opaque session ID, store its hash in PostgreSQL, set appropriate HttpOnly cookie, then redirect to onboarding or safe return.
5. Each request checks session expiry/revocation/account state; permissions and resource ownership are checked in the service layer as well as route policy.
6. Logout revokes application session; logout-everywhere revokes all app sessions and requests provider logout where supported. Provider password/MFA changes and backchannel logout must revoke affected app sessions.
7. API enforces verified email for participation and step-up evidence for administrators. No direct password grant.

## Modules

Accounts, Profiles, Instruments, Publications, Positions, Discussions, Social, Journal, Billing, Notifications, Media, Support, Moderation, Audit and Operations. Module interfaces expose business operations, not ORM models. Position calculations use versioned pure functions. Public performance is a rebuildable projection, never an editable score.

## Transactions and events

Publication create, lifecycle append, quota reservation, plan entitlement change, moderation propagation and their outbox rows commit transactionally. Lock the relevant aggregate or use optimistic revision checks to prevent lost updates. Use unique constraints for toggles, provider event IDs and idempotency keys.

API transaction never waits for SMTP, object processing, payment calls or provider data ingestion. Persist a request state and queue work after commit through the outbox dispatcher. At-least-once delivery is expected; consumers use stable delivery keys and do not claim exactly-once external effects.

pg-boss jobs are created by an outbox dispatcher with an idempotent outbox ID mapping. If a crash occurs between enqueue and marking dispatched, duplicate dispatch must be harmless. Consumers record completed side effects; use provider-supported idempotency when available. Email duplicates after an ambiguous provider timeout are logged and minimized rather than represented as impossible.

## Caching and failure handling

Public SSR/cache keys include publication version and visibility/license capability; moderation invalidates original/repost/share derivatives. Read-through cached bars have provider/instrument/interval/session/adjustment keys and preserve as-of. Private responses use no-store and never enter shared caches.

Bound provider requests with timeouts and retries for safe reads; do not retry money/command operations blindly. Published text survives a data outage; quote status does not imply fill execution. Readiness checks DB/schema; detailed diagnostics stay private. A slow supplier cannot consume all API concurrency.

## Engineering package compatibility

Agreed versions are preserved in MVP. P01 verified Nest 12, ESM Prisma 7 and TypeScript 7 with direct CLI builds on the Mac and Linux containers; see [ADR 0012](../adr/0012-foundation-toolchain.md) and [evidence](../implementation/evidence/P01.md). Explicit dependency injection supports both tsx development and emitted builds. Next uses its TypeScript CLI checker, and Oxlint avoids the incompatible TypeScript ESLint parser. Do not silently downgrade the frontend compiler or upgrade Prisma to a release candidate. Record a narrow ADR amendment and evidence before changing pins.

Lifecycle: logical modules now; measured extraction of heavy scanners or analytics later. Streaming is not implemented in Phase 1.
