# ADR 0004 Lightweight Charts and owned drawing editor

Date: October 19, 2026
Status: Accepted product requirement; engineering implementation selected

## Context

Members must publish annotated charts and notes, not screenshots without reopenable evidence.

## Decision

Use Lightweight Charts 5.2.1 and supported primitives/price-line APIs; build owned controller/store/persistence/export. Freeze original published state. Options chart the underlying and separate premiums/strategy payoff.

## Consequences

One chart/50 objects, agreed tools and mobile subset. No claim of full TradingView parity. Supplier rights gate snapshots/retention/sharing.

## Alternatives and revisit trigger

Use [system architecture](../architecture/system-design.md), [integration contracts](../architecture/integrations.md), and [requirements](../product/requirements.md) for the detailed boundary. Revisit if supported versions, measured performance, legal/supplier terms, founder scope or release evidence invalidate the decision. Preserve the original decision and document the replacement rather than silently changing the stack.
