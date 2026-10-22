# ADR 0005 Reported outcomes and honest reputation

Date: October 19, 2026
Status: Baseline decision replacing original brainstorming ranking

## Context

No broker-connected verification exists in Phase 1. Raw win-rate promotion can misrepresent incomplete/self-reported outcomes.

## Decision

Publish timestamps, original terms, delays/cost coverage/exclusions and complete history. Default discovery is recency/interests/editorial completeness. No automated high-win-rate leaderboard or paid credibility boost.

## Consequences

Retrospective reports remain visible but excluded from forward-publication subset. Verification/ranking is a future separate scope decision.

## Alternatives and revisit trigger

Use [system architecture](../architecture/system-design.md), [integration contracts](../architecture/integrations.md), and [requirements](../product/requirements.md) for the detailed boundary. Revisit if supported versions, measured performance, legal/supplier terms, founder scope or release evidence invalidate the decision. Preserve the original decision and document the replacement rather than silently changing the stack.
