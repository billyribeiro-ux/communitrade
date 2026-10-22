# ADR 0003 NestJS PostgreSQL and Prisma

Date: October 19, 2026
Status: Accepted by founder

## Context

The founder approved NestJS/Node/TypeScript/PostgreSQL/Prisma after requesting reliability, security and maintainability.

## Decision

Nest 12.2.0 on Node 24.22.0 LTS; PostgreSQL 18.6; Prisma CLI/client 7.10.1; REST/OpenAPI; modular monolith plus worker. Use pure decimal calculations and versioned events.

## Consequences

Verify complete ESM/compiler/adapter build in P01. No assumption that package metadata proves integration. Reassess supported patches over time.

## Alternatives and revisit trigger

Use [system architecture](../architecture/system-design.md), [integration contracts](../architecture/integrations.md), and [requirements](../product/requirements.md) for the detailed boundary. Revisit if supported versions, measured performance, legal/supplier terms, founder scope or release evidence invalidate the decision. Preserve the original decision and document the replacement rather than silently changing the stack.
