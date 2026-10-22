# ADR 0002 Frontend and CSS-only design

Date: October 19, 2026
Status: Accepted by founder

## Context

Next.js/React/TypeScript and Phosphor were selected; the founder explicitly rejected Tailwind.

## Decision

Use the pinned Next/React/TypeScript baseline, App Router, CSS Modules and CSS variables, custom React components and Phosphor. Remove Tailwind/shadcn styling assumptions. Use system fonts and the documented visual baseline.

## Consequences

Complex unstyled behavioral primitives may be pinned during P03 without adding a styling framework. Actual visual output is reviewed; the earlier sketch is not approved.

## Alternatives and revisit trigger

Use [system architecture](../architecture/system-design.md), [integration contracts](../architecture/integrations.md), and [requirements](../product/requirements.md) for the detailed boundary. Revisit if supported versions, measured performance, legal/supplier terms, founder scope or release evidence invalidate the decision. Preserve the original decision and document the replacement rather than silently changing the stack.
