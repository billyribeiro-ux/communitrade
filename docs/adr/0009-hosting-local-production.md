# ADR 0009 Docker local and Vercel frontend hosting

Date: October 19, 2026
Status: Founder-approved core; engineering production reference

## Context

The founder selected Docker on the Mac until deployment and Vercel for Next.js.

## Decision

Docker Compose for application plus local identity/mail. Vercel commercial frontend. Render paid always-on API/worker/Keycloak and managed PostgreSQL is the reference deployment, subject to supported versions/tier/region verification.

## Consequences

No paid purchase/deployment has occurred. Vercel Nest Functions remain an alternative requiring explicit worker-model review, not an assumed always-on worker.

## Alternatives and revisit trigger

Use [system architecture](../architecture/system-design.md), [integration contracts](../architecture/integrations.md), and [requirements](../product/requirements.md) for the detailed boundary. Revisit if supported versions, measured performance, legal/supplier terms, founder scope or release evidence invalidate the decision. Preserve the original decision and document the replacement rather than silently changing the stack.
