# ADR 0017: Chart rendering, history and browser lifecycle

Date: October 20, 2026. Status: engineering implementation for P06; executed checks and remaining acceptance are recorded in [P06 evidence](../implementation/evidence/P06.md).

## Context

P05 supplies instrument identity, immutable reference versions, source envelopes and use-rights enforcement. P06 must render that data without inventing market activity or confusing option premiums with underlying prices. The existing client/SSR split must preserve session-derived rights and avoid placing supplier credentials in browser code. P07 and P08 own drawings and saved publication state.

## Decision

Install exactly Lightweight Charts 5.2.1 and its locked dependency. A dedicated Next client ChartHost uses the v5 `createChart`/`addSeries` API for candles, volume and optional EMA 20/50/200. Dynamic client loading keeps canvas access out of server rendering. Application controls use CSS Modules and Phosphor; canvas theme values come from shared CSS tokens. Preserve the library attribution logo, visible TradingView link, and upstream license/notice.

An option reference resolves its actual catalogued stock underlying; a futures chart retains the selected listed contract UUID and month. A historical metadata detail remains historical, while the separate current-context chart explicitly identifies the current metadata version. Disabled new-publishing eligibility does not itself erase licensed history.

ChartDataAdapter validates identity, interval, session, adjustment, source/freshness, metadata version, audience permissions and decimal OHLCV before rendering. Keep original decimal strings for text alternatives. Convert values to numbers only at the canvas/indicator boundary. Reject malformed or overlapping/out-of-order bars rather than sorting away a supplier defect. EMA starts with the first complete period's SMA; warmup prices and closed-session candles are not manufactured.

Request 90 calendar days for intraday and one calendar year for daily history, ending no later than the selected contract's expiration. Load bounded pages of up to 10,000 records, with a maximum of 100 transport pages and 200,000 observations. The transport bound accommodates a year of futures daily aggregation from minute source pages; it is distinct from the output bar limit. Cancel on interval/instrument change or unmount, bound individual requests, and do not present a partial load as a complete chart. A changing source/permission envelope requires a new snapshot. Empty advancing transport pages preserve real gaps; outages fail explicitly. Data remains a refreshable history snapshot, with no real-time subscription claim or premium-only history entitlement introduced.

Stocks use regular sessions and futures use exchange sessions. Reject mismatched session requests and historical option-premium candles explicitly. Daily timestamps identify session opens, including the prior evening for overnight futures sessions; formatting changes the display timezone without changing canonical UTC chronology. Calendars determine holidays, DST and early closes. Missing/listing-limited history is labeled, and contracts do not roll automatically.

Each mounted host owns its chart, subscriptions and observers. Disposal removes crosshair subscriptions, resize/theme observers, media listeners and the chart instance; initialization failure also cleans up. Theme changes update canvas colors. Keyboard and button pan/zoom/fit controls accompany pointer/touch controls. Exact source-price tables and visible source/session/adjustment labels remain outside the canvas.

## Consequences and verification

No chart-state writes, autosave, publication locking, drawing tools or image export are added here. P07/P08 can reuse the renderer without coupling browser objects to persisted JSON. No migration or additional API endpoint is required for P06. API bar semantics/page bounds are corrected within the existing contract.

Lifecycle tests with injected renderers, data-validation tests, real HTTP/SSR checks and optimized builds provide different evidence from rendered browser inspection. Localhost browser access is currently denied by the supported browser tool's saved policy; no alternate/headless browser workaround is used. Keyboard/touch/visual/browser-matrix acceptance and actual supplier conformance remain explicit gates until executed.

Primary references checked October 20, 2026: [v5 chart API](https://tradingview.github.io/lightweight-charts/docs/api/interfaces/IChartApi), [time scale options](https://tradingview.github.io/lightweight-charts/docs/api/interfaces/TimeScaleOptions), [upstream v5.2.1 NOTICE](https://github.com/tradingview/lightweight-charts/blob/v5.2.1/NOTICE), [upstream v5.2.1 license](https://github.com/tradingview/lightweight-charts/blob/v5.2.1/LICENSE). These establish implementation/license references, not a market-data redistribution approval.
