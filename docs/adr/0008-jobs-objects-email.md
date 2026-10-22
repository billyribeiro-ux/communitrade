# ADR 0008 Durable jobs storage and email

Date: October 19, 2026
Status: Engineering-selected baseline

## Context

The earlier plan left queue/storage/email undecided, which would force agents to improvise.

## Decision

pg-boss 12.38.0 on PostgreSQL; transactional outbox; separate Node worker. Filesystem object adapter locally, R2 production target. Mailpit locally, Resend SMTP production target.

## Consequences

No Redis required. At-least-once external effects require idempotency/reconciliation. Actual credentials/contracts and lockfile notices remain release gates.

## Alternatives and revisit trigger

Use [system architecture](../architecture/system-design.md), [integration contracts](../architecture/integrations.md), and [requirements](../product/requirements.md) for the detailed boundary. Revisit if supported versions, measured performance, legal/supplier terms, founder scope or release evidence invalidate the decision. Preserve the original decision and document the replacement rather than silently changing the stack.
