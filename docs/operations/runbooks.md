# Development deployment and operations runbooks

Local foundation commands are implemented in P01. Production, restoration and incident procedures below remain release requirements; they have not been exercised against paid infrastructure. See [P01 evidence](../implementation/evidence/P01.md) and [runtime inventory](runtime-inventory.md).

## Local setup

Prerequisites are existing mise-managed Docker CLI/runtime access, Node 24.22.0 LTS and pnpm 12.14.0. Inspect availability read-only. If missing/outdated, stop with the exact founder-run mise-root command; no global installation, mise edit or shell change.

Run `pnpm local:init` once, then `pnpm local:up`. The initializer generates ignored mode-0600 `.env.local` and refuses to replace existing configuration. Compose must use `--env-file .env.local`; root scripts include it. Wait for API health gating, then run `docker compose --env-file .env.local exec -T api pnpm db:seed` and `pnpm test:local`. Seed is idempotent: P01 probe plus seven synthetic personas and nine catalog references/metadata, with correct Free/Pro fixture limits. It creates no real identity-provider users, brokerage data or trade executions. Seed and API startup reject synthetic production use. Browser endpoints are localhost web 3000, API 3001, Keycloak 8080, Mailpit UI 8025. DB and SMTP stay internal. Do not kill unrelated services; change ports if needed.

P02 adds `pnpm check:contracts` for canonical OpenAPI/chart/type consistency and `pnpm check:migrations` inside the configured API/CI environment for applied SQL checksums. `pnpm test:migrations` creates a separate generated-name database through the local PostgreSQL container, migrates/seeds/tests it, then drops that database only. It does not delete any volume or reset the application/identity databases. Existing production records must never be used as test fixtures.

Use `pnpm local:logs` for routine logs, `pnpm local:down` to stop while preserving volumes. Do not print `.env.local` or run unredacted `docker compose config` in shared output; use `config --quiet` for validation. `pnpm test:resilience` is an intentional local outage/restart drill, followed by `pnpm test:local`. Application checks run inside Docker using the exact command in the [README](../../README.md).

If PostgreSQL initialization was interrupted after its cluster was created, preserve its volume. Start PostgreSQL with `docker compose --env-file .env.local up -d --build postgres`, then run `docker compose --env-file .env.local exec -T postgres bash /docker-entrypoint-initdb.d/01-create-roles.sh`. This idempotently creates missing roles/databases; it does not reset passwords or remove records. Then rerun `pnpm local:up`.

Services: web, api, worker, postgres, keycloak, mailpit. Named volumes for app/identity data, dependencies/build artifacts and local objects. Distinct DB users/databases. Health-gated startup; migrations run once through a controlled setup task. Configure a stable browser-reachable local OIDC issuer (auth.localhost:8080) and a matching Docker network alias so browser and API validate the same issuer without rewriting token claims; prove resolution in P04. Local fixture seed is deterministic/idempotent and clearly synthetic. Restart preserves records. Volume deletion is an explicit separately documented reset, not part of normal startup.

## Environment contract

| Category | Required configuration |
| --- | --- |
| Web | public origin/brand; fixed internal API origin; approved external host allowlist |
| API/worker | DATABASE_URL, session secret/encryption key, CSRF/origin config, release mode |
| OIDC | issuer, client ID/secret, callback origin, required staff assurance mapping |
| Objects | adapter local/r2, local path OR endpoint/bucket/access credentials, URL expiry |
| Email | SMTP host/port/credentials/from, local-versus-production mode |
| Billing | mode, API secret, webhook secret, monthly/annual price IDs, portal config |
| Data | fixture/provider adapter, credentials, dataset/agreement/capability configuration |
| Operations | telemetry sink/retention, alert contact, deployment revision, backup policy |

Server-only configuration must not use public frontend prefixes. Startup validates required settings by mode and fails closed for production fixtures, default dev secrets/realm, missing data capabilities or unsigned webhooks. Secrets are supplied via ignored local files or provider secret configuration and never printed.

## Production reference topology

Vercel web and fixed /api/v1 routing; paid Render API/worker/Keycloak and managed PostgreSQL; R2 processed objects; Resend SMTP; Stripe; licensed data supplier. Verify PostgreSQL major availability and exact recovery tier before provisioning. If selected major is unavailable, retain local pin and document a narrow supported provider/version change rather than invent compatibility.

Keep API/DB/worker in a measured US region close to web server rendering. Configure connection pools for total replica concurrency and reserve DB capacity for jobs/identity. Separate runtime/migration/backup/identity credentials. Do not use free ephemeral database instances for production records.

## Deploy procedure

1. Confirm release gates, credentials/domains and supported pins; review diff, migration/backfill and notices.
2. Build immutable app/worker artifacts in CI; scan dependencies and secrets; record digest/revision.
3. Apply compatible additive migrations with one migration actor; capture recovery checkpoint.
4. Deploy API/worker/identity configuration, verify readiness and queue behavior, then deploy web.
5. Run synthetic smoke accounts covering public read, login, private isolation, publication, billing reconciliation test and supplier status.
6. Observe latency/errors/freshness/webhook backlog. Roll back app on a compatible schema or forward-fix migration; never blindly reverse a destructive migration.
7. Record deployed version, evidence, incident contact and change log.

Vercel deploys Next.js through its supported build flow, not local Compose. Secrets/real purchases and public launch require the actual deployment authorization; this handoff is preparation.

## Restore drill

Before beta and public launch: restore DB into a separate clean instance from a chosen checkpoint, restore/verify referenced processed objects, verify user/deletion-suppression/session state, compare publication/version/event counts and financial fixtures, apply pending erasures, verify login and private isolation, and measure RPO <=1h/RTO <=8h. Verify provider billing reconciliation without replaying external side effects.

Keep old instance intact until the recovered instance passes and cutover is deliberate. A successful backup job is not a successful restore. Document timestamp, backup provenance, lost-data window, elapsed recovery, checks and operator.

## Incidents

Data outage: label stale/unavailable, suspend new publication where references/rights are unavailable, preserve permitted saved text/evidence, bound retries and notify operations. Never manufacture quotes or fills.

Queue backlog: inspect job kind/failure, disable poisonous input, bound replay through stable delivery key, avoid duplicate refunds/emails, reconcile uncertain external effects. No arbitrary shell command from admin retry.

Billing incident: validate provider signature/mode, compare current subscription, pause affected automated changes if needed, preserve paid-through data and records, audit corrective reconciliation.

Privacy/security: contain access, revoke sessions/keys as needed, preserve minimal redacted evidence, inform named incident owner, assess user/supplier notification with advisers, fix and regression-test before restoring capability.

## Alerts and cost controls

Monitor API p95/errors, DB connections/storage, worker backlog/failed jobs/outbox age, supplier freshness by asset, image failures, webhook reconciliation age, email failures, authentication anomalies and public availability. Each alert has owner, severity and runbook. Review infrastructure/data usage weekly during beta; enable platform spend alerts and capacity thresholds. Existing budget figures are provisional, not vendor quotes.

Source capabilities: [Render workers](https://render.com/docs/background-workers), [Render recovery](https://render.com/docs/postgresql-backups), [Vercel Next.js](https://vercel.com/docs/frameworks/full-stack/nextjs). Actual account settings and restore measurements remain release evidence.

## P04 local identity and avatar checks

After `pnpm local:up`, run `pnpm identity:configure` and optionally `pnpm identity:seed`. Configuration is local-only and idempotent; it preserves existing users. Persona passwords/TOTP values are generated into ignored mode-0600 `.local/identity-personas.json`. Do not print or commit that file. Normal sign-up uses provider-owned forms and Mailpit verification; no application password table or password grant is used.

Default browser/container issuer is `http://auth.localhost:8080/realms/options-trade-ideas`. Keep its authority consistent: when changing KEYCLOAK_PORT, update OIDC_ISSUER to the same authority. Compose uses the configured port for both the container listener and published route; never merely rewrite discovery text. Production must use HTTPS and a hardened provider configuration.

`pnpm test:p04:live` performs real local OIDC, onboarding, owner/private SSR boundaries, CSRF/revision checks, avatar raw upload/outbox/Sharp worker, provider logout, MFA and verification/recovery email checks. It uses only generated synthetic personas and Mailpit; it never prints callback URLs, cookies, passwords or action tokens. Its temporary registration account is removed afterward. Repeated runs obey the normal ten-login-per-ten-minute and ten-upload-per-hour limits. A 429 is a rate-limit result, not a reason to disable production controls.

Media processing is durable: inspect safe failure codes and outbox status, retry transient failure with bounded worker policies, and re-upload terminally rejected/expired inputs with a new intent. Never expose quarantine directories or turn local storage into a static server. The worker sweeps expired quarantine/processing and old rejected/unattached avatars; attached active avatars retain authorization on every request. See [P04 evidence](../implementation/evidence/P04.md).

For the credential-change failure drill, `pnpm test:p04:credentials` deliberately stops and restarts only the local API, tests provider rollback when backchannel delivery is unavailable, then tests current/other-session revocation on successful authenticator removal and restores the synthetic OTP fixture. Run it separately from other live tests and obey the login window. This is an intentional local outage, not a production operation.

Run live journeys and the final `pnpm test:local` only after code generation, builds and database tests finish: generated-file changes restart the development API. For credential-action rollback, inspect persisted credentials and session access; Keycloak can return a native success redirect despite rolling back the transaction. That messaging ambiguity remains a production UI review gate.

## P05 catalog and data rights

Local Compose defaults to `MARKET_DATA_PROVIDER=synthetic` in the API only. Apply migrations, run the repeatable application seed and restart the API after changing seeded catalog references, because its provider fixture adapter is constructed at startup. The public reference starts at `/instruments`; authenticated Explore uses member permissions. `/admin/instruments` and `/admin/data` require an administrator with recent MFA. Instrument enable/disable requires a reason, CSRF and an idempotency key; it changes new-publishing availability without changing historical metadata.

After builds and database tests finish, run `pnpm test:p05:http`, then `pnpm test:p05:live`, then `pnpm test:local`. The HTTP check covers anonymous reference/SSR and pagination. The local live driver mints disposable opaque sessions through the existing AuthService for SQL-verified synthetic personas only; it does not claim a new OIDC/MFA exchange. It exercises the running API/web authorization boundary, audited commands and temporary capability restriction. Its cleanup restores the original fixture enablement, removes its temporary capability row and deletes its disposable sessions. Synthetic audit receipts remain append-only. Do not run these acceptance scripts in production or concurrently with seed/code generation.

Production/public configuration uses `MARKET_DATA_PROVIDER=databento`, a server-only `DATABENTO_API_KEY`, separate stock/option/future dataset identifiers, `DATABENTO_SCHEMAS`, `DATABENTO_APPROVED_CAPABILITIES`, the approved `DATABENTO_DELAY_SECONDS` and `DATABENTO_CALENDAR_CONFIG`. These values alone do not constitute signed data rights. Supply effective database agreement grants and immutable provider instrument mappings tied to exact metadata versions. Never copy keys into web configuration, logs or evidence. Options use underlying stock bars and actual option bid/ask snapshots; historical option-premium candles remain unsupported.

Supplier replacement or revocation must be tested across public/member display, stored bars, snapshots, images and personal exports separately. Disable new publishing if required references or permissions are missing; retain original publication metadata. Treat missing supplier samples, coverage, authoritative calendars and commercial approvals as open release gates, not permission to enable a production fixture fallback. [P05 evidence](../implementation/evidence/P05.md) records the executed checks and [ADR 0016](../adr/0016-market-data-reference-capabilities.md) records the boundary.

## P06 chart rendering checks

After generation/build and database tests finish, run `pnpm test:p06:http`, `pnpm test:p06:live`, then `pnpm test:local`. The HTTP script checks all five intervals, actual dated futures bars, session/DST/holiday handling, schema conformance and instrument SSR. The live script creates one opaque session through AuthService for an existing verified synthetic member, temporarily restricts public then member retained-bar permission, verifies independent API/SSR behavior, expires that session, and removes/verifies its own fixtures. It does not perform another OIDC login or change actual supplier grants. Run only in local synthetic mode and separately from other live tests; normal rate limits still apply.

Open an instrument from `/instruments` or signed-in Explore. Options chart their catalogued stock underlying, and futures month links open that actual contract. Select 1m/5m/15m/1h/daily, optional EMAs and display timezone. The chart is a refreshable history snapshot. Prices in the text table remain exact source decimals; drawing/persistence/export behavior follows P07/P08. Supplier-unavailable, permission-denied, expired-session and invalid-data states do not generate synthetic replacement candles. Browser validation must still exercise actual canvas, keyboard, pointer/touch, theme/resize/remount and the required widths/browser matrix; HTTP/Node checks cannot close that gate. See [P06 evidence](../implementation/evidence/P06.md).

Private chart drafts start from `/app/publish` and remain listed at `/app/drafts`; open a draft to continue editing it. Setup uses an enabled member-display/retained-bars instrument. This permits private work with retained history while new publishing is held; the catalog labels publication eligibility separately. Local synthetic/demo rows are explicitly labeled as synthetic and must never be used in production. Options select their stock underlying, and futures select an actual dated contract. If setup saving fails after draft creation, retry the setup save on the same page; it retains the created draft identity and does not create a duplicate. Chart levels for entry, targets and invalidation stay linked to their plan values. See [P07 evidence](../implementation/evidence/P07.md) for the executed checks and remaining acceptance.

After build/seed, `pnpm test:p07:live` runs local AuthService-backed chart/draft API and private SSR checks with disposable sessions/new drafts. It verifies all three asset families, owner/admin isolation, ETags, second-session reload/stale conflict, CSRF, linked levels and premium separation. It reads seeded chart drafts without changing them and removes/verifies its own fixtures. This is HTTP/server evidence, not a new OIDC exchange or rendered browser acceptance. Run serially after generation/database drills; retain normal rate limits. In the editor, recover a transient save failure with Retry after correcting any reported validation issue; stale conflicts require explicit reload/discard. Never replace a newer saved chart automatically or copy chart notes into private journal fields.

## P08 local publication and correction operation

After updating, run `pnpm local:init` only to generate a new local environment (preserve existing identity setup). Existing environments need one new server-only 32-byte-or-longer `PUBLICATION_RENDER_HMAC_SECRET`, shared by API/web/worker, never `NEXT_PUBLIC_` or a logged value. The checked-in example contains only a generation placeholder. Rebuild the worker with its pinned Playwright 1.64.0 browser image; it retains Node 24.22.0/pnpm 12.14.0 and uses 1 GiB shared memory. Run frozen dependency installation and additive migrations before recreating services. Do not reset volumes or modify applied SQL. `PUBLICATION_RENDER_BASE_URL=http://web:3000` and `PUBLICATION_API_BASE_URL=http://api:3001` are the configured local internal origins; production private ingress/storage adaptations and supplier approval remain release gates.

Start at `/app/publish`, save the chart, then choose Complete plan and publish. `/app/drafts/{id}/compose` holds plan/attachments/review; a job receipt is not a published idea. Only successful trusted capture creates public evidence. Observe safe job status/failure codes, outbox backlog and worker health; never log signed render URLs, session tokens or frozen private payloads. Recover transient processing through bounded outbox retries. A terminal initial failure unlocks the saved draft for a fresh reviewed attempt; a failed structured correction keeps the existing public version and returns to review. Do not delete a failed candidate or force visibility as recovery.

`pnpm test:p08:live` runs only in local synthetic mode against real API/web/worker services. It generates isolated synthetic authors and disposable publications, follows ordinary quotas, checks chart bytes/checksums/SSR/reporting/corrections, and removes only tracked fixture entities. It does not establish an OIDC sign-in, interactive browser, touch or visual review pass. Run generation/build/database checks separately first; they restart the development API. `pnpm test:migrations` creates/removes its own isolated database, seeds twice and runs the full suite. Both leave existing application/identity databases and volumes intact. Test files run serially because capability-denial fixtures share catalog scopes; each race scenario still runs concurrent commands. The guarded local cleanup removes only validated disposable identities/history under an exclusive transaction and restores/checks named guards before committing; it is not a product privacy-erasure route.

Report entry/exit/exception/review from the owner-only position page. Unknown cost means unknown; enter 0 only when known zero. Preserve claimed UTC separately from server receipt. Assignment/expiry requires an explicit remaining-unit net result and review, never an assumed fill. Structured corrections go through `/admin/corrections` with recent MFA and a separate reviewer; original risk/evidence stays linked. Community/social distribution is covered in P09; broader moderation/privacy operation is covered in P13 below.

## P09 community and sharing

After build/migration/seed and healthy web/API/worker, run `pnpm test:p09:live`. It creates disposable synthetic verified/onboarded members, publishes an actual option idea through the worker, then checks public/personal feeds, discussion, idempotent social actions, repost attribution, report receipt, licensed share bytes, SSR and source-hide derivative denial. It never posts to an external network. Existing users, seeded personas and rate-limit buckets are not reset. Never run generation/shared builds or capability-fixture tests while live acceptance is in progress; watched services may restart.

After an optimized Next build in the shared development checkout, restart the local web development service and wait for health before live capture checks. A P09 attempt timed out waiting for the trusted render marker; after restarting the development server the same publication flow completed. Do not force publication visibility to recover a capture, loosen the allowlist, or claim a manual browser check from worker output.

Use `/ideas`, `/app/feed`, `/app/bookmarks`, profiles and published idea discussion/Share controls for the implemented community surfaces. PostgreSQL full-text search uses current public text/author only. Source visibility/rights, not a repost's stored commentary, authorize its content. Independent image-export denial retains permitted canonical text/link sharing. Default snapshot bytes remain immutable; download=true appends attribution. Images already downloaded or cached by external social networks cannot be recalled.

Comments create/edit share ten account submissions per minute; new reports allow five per UTC hour. Idempotent command replay does not consume another slot. Respect Retry-After instead of clearing a bucket. Optional supplied invalid sessions fail closed, so sign in again or explicitly sign out before continuing personal public reads.

Production robots advertises `/sitemap.xml`; its sixteen `/sitemaps/{0..15}.xml` shards use the current-authorized `/api/v1/discovery/sitemap` projection. These routes use no-store and stop on authorization/traversal failure. Preview files remain empty/noindex. Supplier/branding/legal/production deployment gates remain separate. Browser clipboard/native-share/visual acceptance must use the supported browser surface; saved-origin policy denial is not permission to bypass it.

Local fixture cleanup reuses the guarded transaction helper with exact generated P08/P09 identity and synthetic-instrument validation, exclusive locks, restored immutable guards and checked constraints before commit. It removes only generated acceptance history; failure rolls back. This is not a production erasure endpoint or a general history-editing escape hatch.

## P10 private research and CSV jobs

Apply additive migrations 015–017 with `pnpm db:migrate`, regenerate Prisma, and run normal frozen project dependency installation (worker now consumes the existing domain workspace package). Existing source/volumes are preserved. `pnpm db:seed` adds dedicated visibly synthetic quota/downgrade cases; reruns preserve edited journal/list/layout content. Fixture mode remains prohibited for production.

Use `/app/journal`, `/app/journal/new`, `/app/journal/{id}`, `/app/journal/analytics`, `/app/watchlists` and `/app/layouts`. Journal contains raw CSV request/status/download; Pro analysis exports use the last successfully applied filters. Templates are saved/applied inside the chart editor and never mutate published charts. Unknown costs stay null. Private financial corrections keep the original event plus a superseding report.

`export.generate` uses the transactional outbox and pg-boss. Inspect owner-safe pending/running/succeeded/failed/expired status; retry requests with the same idempotency key after uncertainty. At most three jobs can be active per account. Recovery requeues stale claims with bounded attempts; an older claim cannot finalize a newer attempt. Raw CSV includes personal stored journal/position/leg/event/snapshot data and cannot accept paid filters. Oversized output fails explicitly at 50 MiB; it is never silently truncated. Pro export requests, processing and downloads check effective entitlement. Expired objects are removed by the worker; failed deletion retains its reference for retry. Downloads require the current owner session and expire within 24 hours.

Run `pnpm test:p10:live` after healthy API/web/worker, and restart the web development service after an optimized build before live checks. The local driver uses disposable synthetic identities and strict cleanup, with normal rate buckets preserved. It performs HTTP/SSR checks, not rendered browser inspection. P11 notification/preferences/delivery is recorded separately; privacy archive/deletion operation is covered in P13 below.


## P11 notification and delivery operations

Run `pnpm test:p11:live` only after API/web/worker/PostgreSQL/Keycloak/Mailpit are healthy. Its disposable fixtures use synthetic identities and generated `.invalid` recipients; cleanup removes only its own rows/objects and exact Mailpit IDs. Rebuild shared packages before acceptance; restart the development web service after optimized Next builds or the P03 production-boundary harness and wait for readiness. Do not run builds, Next type generation or parallel Next start harnesses during a trusted chart capture. The driver exercises HTTP/SSR and trusted product capture; it is not rendered browser UI acceptance.

`/admin/jobs` requires admin and recent MFA. Inspect safe failure codes, attempts, pending/queued/processing/failed/uncertain totals and oldest backlog age. Retry requires a reason, CSRF and a unique command key. It preserves attempts and the original time budget. Generic staff retry cannot reset frozen publication/media evidence, invalid/permanently rejected deliveries or uncertain SMTP sends. Use the established member recovery workflows for publication/media. Retry authentication/configuration errors only after the cause is corrected through a reviewed future recovery procedure; there is no unsafe reset switch.

An `uncertain` email means SMTP might already have accepted it. Check provider/Mailpit evidence against its stable Message-ID; do not resend blindly. Stale processing claims are quarantined after ten minutes. Queued work without a live queue job can be re-enqueued with the same attempt identity; five attempts/24 hours bound automatic delivery. Recipient RCPT 550 creates email suppression; SMTP AUTH/configuration failures never suppress a recipient. Digest unsubscribe only suppresses optional digests; mandatory account/security/billing in-app notices remain, and email still respects transport bounce suppression.

Digests are opt-in, fixed at 08:00 current user-local time, delayed by quiet hours. Each owner/local date has one ledger key. Check current zone, quiet hours, opt-in, suppression, active verified account, follows/mutes, Pro entitlement/searches and public source capabilities when investigating missing content. A digest without currently eligible public content is suppressed rather than filled with private content. Saved searches are owner-private and capped at five for Pro.

First-party analytics default off. Current consent version is `2026-10-20.v1`; withdrawal removes owner events in the same preference transaction. Activation requires three followed authors/instruments and then a trusted publication/comment/journal within seven days of joining; onboarding alone does not emit it. Only approved scalar enums and hashed business keys are stored. An hourly bounded retention sweep deletes records older than 90 days. Staff see aggregate event counts, never private event properties. P12 emits conversion/churn from reconciled billing transactions, never return URLs.

Production release still requires approved sender/domain, authenticated TLS SMTP credentials, real provider bounce/complaint webhook acceptance and deliverability verification. Local Mailpit capture does not prove production delivery. [P11 evidence](../implementation/evidence/P11.md) records actual outcomes and browser gates.

## P12 billing reconciliation and uncertain outcomes

For local acceptance, run `pnpm test:p12:live` with Docker services healthy. It uses generated synthetic identities and persisted fake provider truth; no real payment is made. API/worker must share BILLING_PROVIDER, BILLING_MODE and BILLING_PROVIDER_ACCOUNT_ID. Only the API receives Stripe credentials. Default local values are fake/test/local-fake-account. Production fake/test modes fail closed.

Use `/admin/billing` with current administrator role and recent MFA to inspect subscription state and reconcile current provider truth. Confirm the selected subscription and payment before a refund. A refund does not cancel; choose cancellation explicitly when authorized. Keep the support reason and returned audit receipt. Never update subscription_entitlement directly or reset an uncertain operation to pending with SQL. For a timeout after a provider mutation, retain the same command key and reconcile actual provider records before another attempt. Escalate exhausted or old provider idempotency windows for evidence review; a new key is not recovery.

Investigate failed/uncertain billing operations and billing_event retry state without copying provider credentials, signed webhook bodies, customer addresses or private journal data into logs. Verify provider/account/mode namespace, current processor records, failed renewal episode and the projection validity window. Expiry is enforced at every API/worker read even if the reconciliation scheduler is unavailable. Restores must replay provider truth before paid access is released. Production sender/tax/price/portal/underwriting and actual purchase/cancel/refund rehearsal remain release gates.

## P13 staff, support and privacy operation

Run `pnpm test:p13:live` only after API/web/worker readiness and all builds/type generation have finished. It creates disposable identities, tests real HTTP/worker flows, validates DTOs and verifies exact fixture cleanup. `pnpm test:migrations` additionally tests the last-administrator guard and competing demotions before seeding its separate disposable database; it never changes existing application administrators. Avoid concurrent Prisma generation and live capture.

Use `/admin` for role-scoped queue counts. Administrators assign reports and independent appeals; moderators see assigned cases and their corresponding audit trail. A reviewer cannot decide their own report, content or prior moderation appeal. Record a reason and use the returned audit receipt. Restore only undoes a staff moderation state; it cannot republish an owner-hidden or privacy-removed record. `/admin/users` supports suspension, restoration, role changes and explicit session revocation. Existing corrections, instruments/data, billing and jobs retain their job-specific authorization and MFA controls. Audit CSV is authenticated, bounded and excludes private payload metadata.

Set `SUPPORT_CONTACT_EMAIL` to a real staffed mailbox and `SUPPORT_CONTACT_MONITORED=true` only after coverage and escalation are recorded under G07. Production startup rejects missing/placeholder configuration. Local contact sends generic private reference receipts into Mailpit. Anonymous receipt IDs do not authorize ticket reading: the requester signs in with their verified matching email and explicitly claims the ticket using `/support/requests/{id}/claim`. Owners read/reply at `/support/requests/{id}`; administrators manage `/admin/support`. An uncertain email acknowledgment must be investigated against its stable Message-ID; do not reset it blindly to pending.

A user can request help with one owned journal entry or draft in a support ticket. A recent-MFA administrator approves a named, purpose-limited grant for 1–60 minutes. The owner can revoke it; resolving the ticket revokes approved grants. A fresh server authorization and audit protect every private read. Never copy the inspected private record into logs, audit metadata or a public issue. There is no general staff journal browser.

Personal archive requests use `/app/settings/privacy`, the durable export queue and authenticated JSON download. Expiry is at most 24 hours; collection overflow produces an explicit failure rather than a partial archive. Deletion needs explicit `DELETE_MY_ACCOUNT` confirmation and a verified application identity issued within five minutes. Requested deletions stay reviewable until their 30-day deadline; staff may process earlier. A retention hold requires a recorded reason and finite expiry within one year. A hold cannot interrupt an already-processing irreversible stage. The worker releases a hold at its recorded expiry. Review its purpose before that time and record a new finite hold only when justified. Cancel billing separately through P12 before provider linkage is retired.

The worker runs bounded recoverable erasure stages. Inspect `/admin/privacy` and safe stage/failure status; fix the underlying object/database issue and use the reasoned process action for a failed request. Do not delete ledger checkpoints or bypass triggers by hand. Access is revoked before object and private-record erasure. Public personal prose/charts are redacted through narrow database guards, and source visibility removes platform derivatives. Normal publication and position history remain protected outside that exact erasure scope. Retained minimal financial/audit/case data follows the purpose/retention review in the security contract.

### Suppression backup and restore

Production must configure a stable `PRIVACY_SUPPRESSION_KEY` of at least 32 characters, backed up separately from the application snapshot. Local mode falls back to `SESSION_SECRET`. Do not rotate the key without a reviewed key-version migration. Never print it or store it in the ledger file.

Before taking a backup, export the latest suppression ledger to an operator-selected private path with `node apps/worker/scripts/privacy-suppression.mjs export /absolute/private/ledger.json` in the configured worker environment. The command creates a new mode-0600 file and refuses to overwrite an existing path. Store it securely outside the older application backup; the ledger contains keyed digests, not raw subject/email values.

After restoring into an isolated instance, keep external traffic stopped. Mount the newer ledger and supply the same HMAC key. Run `PRIVACY_RESTORE_MAINTENANCE=true node apps/worker/scripts/privacy-suppression.mjs apply /absolute/private/ledger.json`. The command imports digests, invalidates matching restored identities/sessions and queues erasure in bounded batches. Current tooling accepts key version v1 and fails closed above its tested population/ledger bounds rather than claiming a partial restore complete. Reapply safely if interrupted. Wait for erasure completion, verify private objects/search/share/source denial and suppressed login, reconcile billing truth, then perform the separate P14 restore/release gate. G09 still requires measured production backup/object/RPO/RTO evidence; the local suppression drill is not that claim.

## P14 production boundaries and release gate

Read the [production reference](p14-production.md), [local drill procedure](p14-local-drills.md), [acceptance matrix](../quality/p14-acceptance-matrix.md) and [P14 evidence](../implementation/evidence/P14.md). `pnpm check:p14:release` reports recorded gates; `node scripts/p14-release-report.mjs --require-ready` fails while any gate is open. Reporting never deploys or enables charges.

For safe status counters, run `node apps/worker/scripts/p14-operational-check.mjs` inside the configured worker environment. It exits nonzero for missing/stale heartbeat, aged snapshots, uncertain email/billing or failed erasure; it emits counts only. Route this command to the approved monitor and test actual alert delivery before release. Do not clear uncertain work to make it green.

P14 signed ingress consumes replay nonces atomically in the application database. Only the configured Vercel-overwritten address is used for web rate-limit principals. Direct provider endpoints retain their own signature verification; no global forwarded-header trust is enabled. Resend permanent bounce/complaint handling suppresses known accounts and keyed recipient addresses, including anonymous receipts. Its replay metadata expires after 30 days; suppression persists under the approved policy. Preserve and reconcile the newest sender suppression state before allowing restored email delivery.

API idle-pool errors emit only a fixed safe event and discard broken connections. Readiness fails closed during database loss; liveness remains available. The local worker now runs Node directly as PID 1 with a 30-second stop grace so its job drain receives SIGTERM. Restart the worker explicitly after editing its source (`docker compose --env-file .env.local restart worker`); its Compose command no longer uses a watch wrapper. Production images also run Node directly.
