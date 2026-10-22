# ADR 0014: Local preview boundary, contact intake and plan navigation

Date: October 19, 2026. Status: engineering implementation for P03; not founder approval of artwork or legal copy.

## Context

P03 supplies the complete marketing site and application shell before P04 identity, P05 licensed market data, P06/P07 charts and drawings, and later member workflows. A shell must not create authentication or entitlement authority from a query parameter or expose fixture records in production.

## Decision

- Synthetic record handlers and metadata generators individually require explicit `RELEASE_MODE=local` (or development without a production release mode). Layout checks are supplemental; React server payloads must not bypass the record handler boundary. Private, account, staff and every local preview response are noindex. Public release requires approved versioned policy evidence and an HTTPS canonical origin; current draft records deliberately block it.
- Shared CSS Modules and native modal `<dialog>` implement the design baseline. Native modal focus behavior avoids a custom focus trap and requires real browser acceptance; no additional accessibility or styling dependency was introduced. CSS token values drive illustrative SVG charts. Actual Lightweight Charts and owned drawing integration remain P06/P07.
- Plan intent is a bounded navigation preference: Free/Pro, month/year and a validated relative return path. An HttpOnly, SameSite=Lax cookie expires after 30 minutes. It contains no session, payment or entitlement claim. Next server actions apply same-origin checks. P04 consumes intent after identity; P12 grants benefits only from server-reconciled billing. All account and checkout-result screens state these boundaries.
- Public contact implements the existing `POST /api/v1/support` contract now, including required affirmative consent. Private support-ticket fields are additive migration 007. Intake stores email, subject, message, consent version and server timestamp; no public ticket retrieval is introduced. P13 implements authenticated ownership and purpose-limited staff access.
- Contact requires an exact configured `Origin`, validates the generated contract, HMAC-hashes the connection address, serializes intake with a PostgreSQL advisory lock, and limits three new requests per principal per UTC hour in accordance with the security contract. Idempotent retries replay the same receipt for 24 hours; changed payloads conflict. It does not trust client-supplied forwarding headers. Behind the local Next proxy the connection address is shared, so the cap is intentionally conservative. A trusted production ingress/rate-limit design is a P14 release check, not an excuse to trust arbitrary forwarded addresses.

## Consequences and remaining evidence

The local shell works without pretending to create real accounts, trade publications, paid subscriptions or staff authority. Unknown/private record references return generic unavailability. Contact success is a durable intake receipt, not a promise of staffed response coverage. P13 retention jobs must purge expired idempotency/rate records and apply approved ticket retention. Operator contacts, approved legal text and licensed data remain external release gates.

Browser inspection is independently required. Automated HTTP, schema, database and build checks cannot substitute for keyboard, zoom, screen-reader, viewport or rendered contrast review. See [P03 evidence](../implementation/evidence/P03.md).

Amended October 20, 2026 during P04: contact enforcement and this record were corrected from five to the authoritative security contract’s three new requests per UTC hour. Idempotent receipt replay is exempt. See [ADR 0015](0015-identity-profile-media.md).
