# ADR 0016: Reference catalog and market-data rights boundary

Date: October 20, 2026. Status: local engineering implementation with automated evidence in [P05](../implementation/evidence/P05.md); rendered browser acceptance and commercial supplier conformance remain open.

## Context

P05 supplies the stocks, standard equity/ETF options and ES/MES/NQ/MNQ reference-data foundation for later charts and publishing. Ticker text cannot identify a permanent instrument. Local development has no supplied commercial dataset credentials or signed redistribution agreement. Synthetic data must therefore be useful for engineering without being confused with exchange data or production approval.

## Decision

Keep catalog identity and immutable metadata versions in PostgreSQL. Use actual dated futures contracts and actual option contract IDs within the synthetic catalog; reject continuous futures and unsupported option structures. Correct reference data by appending a metadata version, retaining historical versions and existing records. Administrative enable/disable changes affect new publishing eligibility and are reasoned, audited, idempotent and restricted to administrators with recent MFA.

Use a replaceable typed MarketDataPort for lookup, contract selection, bars, quote snapshots, calendars and capabilities. Every data result identifies its provider, as-of time, delay, freshness, metadata version and permitted uses. Synthetic results prominently say Demo data. Missing or stale reference data must prevent new publication rather than silently supplying invented terms. Missing Greeks remain absent.

Public display, member display, retained bars, retained snapshots, external images and personal-record exports are separate server-side permissions. Supplier responses cannot grant rights by themselves. Production configuration rejects synthetic mode and unapproved capabilities. Local fixture tests do not close the commercial release gate.

For the same supplier, dataset, audience and purpose, intersect the flags of all effective, nonrevoked agreement rows conservatively. Compose distinct purposes field by field, then intersect provider/server permissions; a display-only grant does not erase a separate retention grant, and an extra permissive row does not override an active restriction. Operational changes must expire/revoke obsolete agreement scopes explicitly. A future union-of-agreements policy would require a separate reviewed decision.

Databento remains the first procurement target. Its production adapter uses documented historical HTTP protocols with injected transport for contract testing, bounded timeouts and transient retries. No real supplier request, purchase, scraping or licensed dataset is authorized by this decision. Actual production onboarding, dataset coverage, exchange calendars and agreements remain release prerequisites.

Synthetic bars support all five planned intervals. Supplier all-session hourly/daily OHLC cannot be converted to regular-session OHLC merely by filtering timestamps. The production boundary therefore aggregates approved 1-minute data inside authoritative sessions for 1h/1d, anchoring at session open and respecting early closes, partial final hours and overnight futures trading dates. Pagination withholds incomplete transport-boundary groups and re-requests their source rather than inventing or skipping data. Split-adjusted bars, stock extended hours and regular-only futures aggregation remain outside the baseline and fail explicitly. Real supplier conformance remains a release gate. No raw or extended-hours aggregate may be mislabeled as regular or adjusted.

## Consequences and verification

Reference lookup and strategy selection can be implemented locally across all three asset classes before procurement. Charts/drawings, public trade publication, scanners, broker integrations and streaming remain later milestones or phases. Protocol tests, database/HTTP tests and rendered browser acceptance are distinct evidence. The browser tool currently denies localhost; no alternate browser workaround is authorized.

Primary references checked October 20, 2026: [Databento Historical API](https://databento.com/docs/api-reference-historical), [option parent symbology](https://databento.com/docs/examples/options/equity-options-introduction/using-parent-symbology-to-fetch-an-option-chain), [Databento licensing portal](https://databento.com/docs/portal), [NYSE hours/calendar](https://www.nyse.com/trade/hours-calendars), [CME E-mini FAQ](https://www.cmegroup.com/trading/equity-index/eminifaq.html), [CME Micro E-mini FAQ](https://www.cmegroup.com/articles/faqs/micro-e-mini-equity-index-futures-frequently-asked-questions.html). Supplier documentation establishes protocol facts, not permission to redistribute data.
