# ADR 0007 OIDC identity and opaque app sessions

Date: October 19, 2026
Status: Engineering-selected baseline

## Context

Local Docker development needs a concrete identity path without custom password/security implementation.

## Decision

Keycloak 26.8.1 locally, OIDC Authorization Code + PKCE, server code exchange, hashed opaque app sessions in PostgreSQL. Provider owns passwords/recovery/MFA; application owns roles/ownership/entitlements.

## Consequences

Adds local identity service/database. Production secure identity operation/credentials are required. Provider can change through the fixed protocol with tested mapping, not rewritten app passwords.

## Alternatives and revisit trigger

Use [system architecture](../architecture/system-design.md), [integration contracts](../architecture/integrations.md), and [requirements](../product/requirements.md) for the detailed boundary. Revisit if supported versions, measured performance, legal/supplier terms, founder scope or release evidence invalidate the decision. Preserve the original decision and document the replacement rather than silently changing the stack.
