# Integration contracts and provider defaults

These are implementation defaults chosen to make engineering executable. Founder-approved core choices remain unchanged. No supplier agreement, account, payment acceptance or expenditure is implied.

## Service selections

| Capability | Local implementation | Production/reference target | External gate |
| --- | --- | --- | --- |
| Web | Next.js Docker dev server | Vercel Pro | Account, domain, commercial plan, deployment task |
| API and worker | Nest/Node containers | Paid always-on Render services | Region/tier/cost and credentials |
| Database | PostgreSQL 18.6 volume | Managed Render Postgres supporting selected major | Verify major availability, PITR window, backup/recovery tier |
| Identity | Keycloak 26.8.1 container, email via Mailpit | Keycloak on managed paid service; OIDC portable | Secure deployment, MFA/recovery operations, mail/domain |
| Durable jobs | pg-boss 12.38.0, same PostgreSQL cluster | Same library, separate worker | Capacity, failure alerting |
| Objects | Filesystem adapter in mounted local volume | Cloudflare R2 S3-compatible API | Bucket/access policy, region/legal constraints, credentials |
| Email | SMTP Mailpit | Resend SMTP | Verified sender, deliverability, consent and terms |
| Subscription | Fake signed test events or Stripe test mode | Stripe Checkout/Billing/Portal | Processor acceptance, real prices/tax configuration |
| Data | Deterministic synthetic adapter | Databento first procurement/integration target | All three datasets and redistribution/retention rights approved |
| Monitoring | Structured logs, health checks, local metrics | OpenTelemetry-compatible sink and platform alerts | Sink account/retention/contact configuration |

Production data procurement can select a different supplier if Databento terms do not satisfy the scope. This is not permission to drop an asset class or scrape quotes. Adapters and tests below are fixed regardless of commercial selection.

## Ports

MarketDataPort:
- searchInstruments(query, asset, cursor)
- getInstrument(id, metadataVersion)
- listOptionContracts(underlyingId, expiration, optionType, cursor)
- listFuturesContracts(root, cursor)
- getBars(instrumentId, interval, from, to, session, adjustment)
- getQuoteSnapshot(instrumentId)
- getCalendar(venue, range)
- getCapabilities(instrumentId, audience, purpose)

Every result carries provider reference, asOf, delaySeconds, freshness, metadataVersion, and capabilities: displayPublic, displayMember, retainBars, retainSnapshot, exportImage, exportPersonalRecord. Capabilities are server configuration backed by agreements, not supplier response claims alone. Missing reference data prevents new publication; existing history remains clearly flagged.

StoragePort supports putQuarantined, readQuarantined, putProcessed, readAuthorized, deleteObject, and createExpiringDownload. Local and production adapters must implement the same ownership/purpose constraints. No public direct bucket listing. Direct upload URLs are short-lived and constrained; completion verifies actual bytes/ownership before processing. A signed URL is not permission to bypass resource authorization.

EmailPort sends transactional templates and optional digests with stable delivery IDs, subject, safe variables and preference category. Local messages remain in Mailpit. Resend SMTP is the default production transport; honor suppression/unsubscribe, bounces and provider limits. Never place chart-private notes or trade credentials in templates.

BillingPort creates checkout/portal sessions, retrieves current provider subscription, verifies webhooks, and performs authorized refund operations. Plan IDs and price IDs map server-side. Preserve provider account/mode/event IDs, dedupe, and reconcile current truth on uncertain/out-of-order events.

## Fixture boundaries

A local fake for payment/data is deterministic and carries demo/source metadata. It cannot be enabled when NODE_ENV=production or RELEASE_MODE=public. Production checks fail closed without approved integration capabilities. No synthetic quote is labeled delayed exchange data.

Keycloak realm seed uses synthetic users, no real passwords committed. Generate development-only secrets at setup, store outside version control, and prohibit dev realm settings in production. Use OIDC discovery, PKCE, server-side code exchange and key validation rather than a deprecated provider-specific Node adapter.

## Failure/retry policy

Safe provider reads: 5-second interactive timeout, at most one bounded immediate retry for transient failure; longer retries go to worker with jitter. Data fetch stale fallback is explicitly labeled and capability checked. Worker jobs: bounded exponential backoff, default five attempts over at most 24 hours, then failed state and staff alert. Job-specific policies can be stricter.

Stripe calls use stable idempotency keys and reconciliation; no blind repeated checkout/refund. Webhook signatures use raw request body; invalid signatures have no domain effects. Email failure must not roll back published ideas. Upload/processing failure keeps the draft and explains retry.

## Verification sources

Checked October 19, 2026: [Keycloak OIDC](https://www.keycloak.org/securing-apps/oidc-layers), [Keycloak downloads](https://www.keycloak.org/downloads), [pg-boss](https://github.com/timgit/pg-boss), [Render workers](https://render.com/docs/background-workers), [Render database recovery](https://render.com/docs/postgresql-backups), [R2 S3 API](https://developers.cloudflare.com/r2/api/s3/api/), [Mailpit Docker](https://mailpit.axllent.org/docs/install/docker/), [Resend SMTP](https://resend.com/docs/send-with-smtp), [Databento docs](https://databento.com/docs).

The docs establish integration capabilities, not commercial permission or a price quote. Preserve dataset-specific agreements and exact installed dependency/container license inventory before release.

## P05 executable provider boundary

P05 implements the typed catalog/market-data boundary and synthetic development adapter. [ADR 0016](../adr/0016-market-data-reference-capabilities.md) records the implementation decisions; [P05 evidence](../implementation/evidence/P05.md) records only checks actually executed. Catalog lookup and contract selection are not a scanner. Later publishing must invoke the server's eligibility checks again, including every option leg; an earlier selector result is not an authorization grant.

The API alone receives `MARKET_DATA_PROVIDER` and production supplier configuration. `synthetic` is the local default; `databento` is the production reference mode. Production/public mode must reject fixture configuration and fixture records before accepting requests. Supplier API keys remain server-only. Approved capability configuration is intersected with effective, nonrevoked database agreement grants for the dataset, audience and purpose. No provider response or caller-supplied audience flag can grant rights.

Databento Historical HTTP is RPC-style and supports JSON-line data. Production normalization must preserve decimal precision, interpret timestamps/prices according to the documented encoding and use real BBO fields for bid/ask; a trade price cannot be converted into an invented spread. Unsupported schemas, malformed records, absent reference mapping or missing calendars fail explicitly. The production boundary is tested with injected transport, not a paid supplier call. Dataset approval and supplier conformance using authorized real samples remain G03 gates.


## P11 executable email and delivery boundary

Nodemailer 10.1.7 implements EmailPort; local Docker SMTP is restricted to Mailpit and synthetic recipients. Production/public mode requires authenticated TLS and explicit verified sender configuration (`SMTP_HOST`, `SMTP_PORT`, `SMTP_TLS=true`, `SMTP_USER`, `SMTP_PASSWORD`, `EMAIL_FROM`, `EMAIL_FROM_VERIFIED=true`). No production credentials are installed by P11. Stable Message-ID is evidence for reconciliation, not a guarantee against SMTP duplicates. Lost acceptance acknowledgment is quarantined. RCPT 550 creates transport suppression; AUTH/configuration failures do not suppress the recipient. Provider bounce/complaint webhook acceptance remains a release gate.

Worker `APP_ORIGIN`/`SESSION_SECRET` configure canonical links and purpose-bound unsubscribe signatures. Its internal source-authorization request uses a short-lived ID-bound HMAC and the API's exact publication visibility/capability boundary; no member session is used. Retention runs hourly for first-party ProductEvent records older than 90 days. See [ADR 0022](../adr/0022-notifications-delivery-and-consent.md), [P11 evidence](../implementation/evidence/P11.md), and primary [Nodemailer SMTP documentation](https://nodemailer.com/smtp).

## P12 executable billing boundary

BillingPort uses a PostgreSQL-backed synthetic local processor or the server-only Stripe REST adapter. Local fake confirmations use authenticated owner sessions and CSRF. Fake event signing derives a purpose-specific key from the existing local SESSION_SECRET; no new shared secret is committed. Production/public startup rejects fake billing and test keys. All persisted billing account keys are namespaced by adapter (`fake:` or `stripe:`), then actual account ID and mode; every API and worker entitlement read uses that boundary and a bounded validity window.

API configuration: BILLING_PROVIDER, BILLING_MODE, BILLING_PROVIDER_ACCOUNT_ID, APP_ORIGIN. Stripe adds STRIPE_SECRET_KEY, STRIPE_WEBHOOK_SECRET, STRIPE_PRICE_PRO_MONTH and STRIPE_PRICE_PRO_YEAR. Live configuration additionally requires BILLING_LIVE_APPROVED=true, STRIPE_TAX_CONFIGURED=true and STRIPE_BILLING_PORTAL_CONFIGURATION_ID. These settings assert that external evidence has been recorded; setting a flag is not processor approval. Actual price currency/amount/interval and provider account are checked by the adapter before checkout. API keys, webhook secrets and raw card data never enter the web bundle; the worker only receives the account/mode scope and a purpose-bound service signing secret.

The worker calls a bounded HMAC-authenticated reconciliation sweep each minute. Scheduled reads repair missed events and pending operations; writes retain stable provider identities and uncertain outcomes require evidence. Current state is serialized per owner when applied. A return URL never changes a subscription. See [ADR 0023](../adr/0023-billing-provider-truth-and-recovery.md) and [P12 evidence](../implementation/evidence/P12.md).

Primary references checked during P12: [Stripe webhook signatures](https://docs.stripe.com/webhooks/signature), [Stripe subscription webhooks](https://docs.stripe.com/billing/subscriptions/webhooks), [Stripe API versioning](https://docs.stripe.com/api/versioning), [Nest raw body](https://docs.nestjs.com/faq/raw-body). The adapter pins its documented API version; these references do not establish a live account, processor approval or real credential conformance.

## P13 operational configuration

`SUPPORT_CONTACT_EMAIL` and `SUPPORT_CONTACT_MONITORED` describe the staffed contact channel. Production rejects missing/placeholder configuration; coverage/escalation remains G07 evidence. Generic receipt email uses the existing SMTP port and a separate durable `support_email` ledger with stable Message-ID, bounded retries and uncertain-ack quarantine. Staff jobs classify it as email without exposing recipients or submitted bodies.

`PRIVACY_SUPPRESSION_KEY` is a stable separately backed-up HMAC key required for production authentication/erasure/restore. Local mode falls back to the existing session secret. No new runtime or dependency was added. Full JSON personal archives reuse the private export storage/queue; all erasure object operations use replaceable storage ports. The restore CLI requires maintenance mode and key version v1 and fails closed outside its supported bounds. See [P13 runbook](../operations/runbooks.md#p13-staff-support-and-privacy-operation).
