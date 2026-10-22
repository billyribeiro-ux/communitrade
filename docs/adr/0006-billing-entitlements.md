# ADR 0006 Single Pro subscription and server entitlements

Date: October 19, 2026
Status: Product price baseline; engineering provider target

## Context

Free and Pro share core public transparency; paid value is workflow capacity/analysis.

## Decision

Stripe hosted Checkout/Portal is reference implementation. Server webhook/current-state reconciliation grants entitlements. Preserve data on downgrade. Define cancellation/grace/refund behavior in requirements.

## Consequences

Processor approval, account/tax configuration and actual acceptance are gates. Fake/test events cannot grant production entitlements.

## Alternatives and revisit trigger

Use [system architecture](../architecture/system-design.md), [integration contracts](../architecture/integrations.md), and [requirements](../product/requirements.md) for the detailed boundary. Revisit if supported versions, measured performance, legal/supplier terms, founder scope or release evidence invalidate the decision. Preserve the original decision and document the replacement rather than silently changing the stack.
