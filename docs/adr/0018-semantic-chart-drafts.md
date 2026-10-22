# ADR 0018: Semantic chart drafts and linked plan prices

Date: October 20, 2026. Status: engineering implementation for P07; acceptance evidence is maintained in [P07 evidence](../implementation/evidence/P07.md).
Requirements: REQ-008, REQ-009, REQ-028.

## Context

P06 renders licensed, session-aware market history and preserves source decimals. P07 adds private chart state and drawing edits without coupling persisted data to canvas pixels. A chart must remain meaningful across interval changes, calendar gaps, viewport changes and edits to the trade plan. Private retained-history use can be permitted independently from permission to publish new material. Options charts represent their selected stock underlying; futures charts represent an actual dated contract.

## Decision

Persist chart drawings as versioned semantic records conforming to `contracts/chart-state.schema.json`. Anchors retain UTC time and decimal-string price, plus session context where available. Pixel coordinates are transient rendering values only. When a time cannot be projected in the current viewport, keep the original anchor and render it only when a valid chart coordinate exists; never fabricate bars or rewrite an anchor to a nearby candle. One-anchor horizontal/text/plan-level objects and two-anchor trendline/rectangle/arrow objects follow the contract. The drawing set is capped at 50 unique UUIDs.

Drawing operations use immutable snapshots and transactional gestures. A completed create/move/edit is one undo unit; cancellation restores the gesture's starting state without adding history; a new branch clears redo. Form edits preserve entered decimal strings and UTC timestamps. Canvas geometry may use floating point, but geometry conversion must not overwrite semantic originals until a user commits a movement. Text is plain data limited to 500 characters; style values are bounded and allowlisted.

Entry, target and invalidation overlays link to their corresponding plan fields and use the chart's underlying-price coordinate. They do not create a second independently editable price source. The trade plan remains authoritative when numbers are changed; draft editor commits update the linked chart level and plan value as one logical edit. Published snapshots, when introduced by the publication workflow, remain immutable and preserve their source revision.

Private draft setup selects instruments with enabled status plus member-display and retained-bar capabilities. It does not require current freshness or new-publishing capability: a private chart can use entitled retained history when new publishing is held. Catalog results marked synthetic/demo remain available for local fixture development and are labeled “Synthetic fixture · not production data”; production API guards continue to reject synthetic use. New-publishing status is shown separately and is never inferred from private chart eligibility. Options drafts select the stock underlying; futures drafts select a dated listed contract.

Draft writes use the private owner-scoped API, idempotent draft creation and revision-protected partial updates. A failed setup update retains its draft identity and revision for retry instead of creating another record. Autosave and revision-conflict handling retain the last acknowledged chart/draft revision. Public rendering and publication capture remain later workflow concerns and do not expose private drafts.

## Alternatives and tradeoffs

Pixel-only annotations were rejected because they shift with zoom, interval and display size. Snapping absent timestamps to visible candles was rejected because it destroys user intent and invents precision. Duplicating linked prices in the chart and plan was rejected because the values could diverge. Requiring new-publishing capability before creating a private chart was rejected because that capability is independent from member display and retained bars. Synthetic fixtures are labeled and remain local-development-only rather than being silently removed from local catalog workflows.

## Consequences

Serialization, validation and history can be tested without a browser renderer. The renderer is responsible for coordinate projection and visual hit testing, while the controller owns semantic transactions. Data capability checks remain server-authoritative. Every chart/linked-plan write checks effective database grants and the configured provider separately for member display and retained bars; denial/failure rolls back both revisions while saved owner reads remain available. UI labels distinguish retained-history access from new-publishing eligibility. P08 must freeze the last acknowledged semantic chart state alongside its draft revision before publication.

## Validation and revisit trigger

Implementation and actual executed checks are listed in [P07 evidence](../implementation/evidence/P07.md). Revisit if the chart schema, plan-price authority, market-data capability model or publication revision contract changes. Supplier approval and browser acceptance are tracked separately from this implementation decision.
