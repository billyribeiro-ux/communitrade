# Stocks Options and Futures MVP Specification

Version 1.7 · October 19, 2026 · Complete repository engineering handoff baseline

Build a responsive web community where traders publish annotated stock, options, and futures ideas, discuss them, maintain a journal, and review a complete history of their reported trade outcomes. Launch with Free and Pro memberships. Screen sharing, livestreaming, voice rooms, and live room chat belong to Phase 2 and are deferred in full.

The baseline is 24 weeks of planned delivery with a public launch window of 24–28 calendar weeks, using two full-time experienced engineers and part-time design, QA, infrastructure, and specialist support. The reference build budget is $296,400 including contingency. Reference operating costs are $13,750 per month before marketing and payment-related variable charges. All rates, staffing levels, commercial data allowances, and conversion assumptions are planning inputs, not supplier quotations or revenue forecasts.

Product scope is fixed by this version. Vendor contracts, legal treatment, payment underwriting, and final commercial data pricing remain external release gates. They do not authorize additional features. A blocked gate moves the release date or triggers an explicit scope revision; it does not justify quietly removing an asset class or labeling unverified results as verified.

# Product scope and ownership

The founder owns product priorities, budget changes, launch decisions, and scope revisions. A designated engineering lead owns implementation, data integrity, technical acceptance, and release readiness. Legal advisers and data suppliers confirm requirements within their respective areas; their approval does not substitute for product acceptance.

Phase 1 targets adult self-directed traders in the United States, using English and USD. The first closed beta is invitation-only. Public registration and paid Pro membership follow the release gates below. International sales, localization, native mobile apps, and professional market-data subscriptions are outside this baseline.

The product sells community and research software. It does not hold customer trading funds, execute orders, copy trades, or manage portfolios. Users do not enter brokerage credentials. This boundary reduces implementation scope but does not settle the legal classification of publications or recommendations.

The primary user journey is: discover an idea, inspect its chart and complete trade plan, ask or answer questions, follow the author or instrument, publish a personal idea, report its lifecycle, and review the result in a journal. Pro adds convenience and deeper analysis rather than purchasing credibility or feed placement.

## Fixed release decisions

| Decision | Phase 1 baseline |
| --- | --- |
| Product surface | Complete marketing/subscription website, public community, private member dashboard/pages, administration and supporting systems |
| Asset classes | Stocks and ETFs, standard equity and ETF options, selected CME equity index futures |
| Frontend | Next.js App Router, React, TypeScript, plain CSS with CSS Modules, custom React components, Phosphor Icons; exact baseline below |
| Local development | Docker Compose on the founder's Mac: Next.js, NestJS, PostgreSQL, and a background worker |
| Frontend hosting | Vercel; budget for Pro at commercial launch |
| Backend core | NestJS on Node.js LTS, TypeScript, PostgreSQL, Prisma, REST/OpenAPI; versions below |
| Chart library | TradingView Lightweight Charts with required notices and attribution |
| Data delivery | Licensed delayed quotes and bars; uniform delayed access for Free and Pro |
| Record evidence | Server-timestamped publications and member-reported executions, clearly labeled |
| Social model | Public ideas, profiles/avatars/bios, threaded comments, replies, reactions, follows, bookmarks, external sharing and internal reposts |
| Private space | Drafts, personal journal, private notes, watchlists |
| Monetization | One Pro plan; $29 monthly or $290 annually before applicable tax |
| Performance discovery | Transparent reported statistics; editorial discovery; no verified-performance leaderboard |
| Execution | Members trade separately with their own brokers |
| Next major phase | Livestreaming, screen sharing, voice, and persistent live room chat; no Phase 1 implementation |

The subscription prices are the initial commercial test configuration. A price change requires a recorded commercial decision and clear treatment of existing subscribers; it is not an engineering prerequisite.

# Priorities and scope control

P0 requirements must work before the invited beta. P1 requirements must work before public paid launch. Both are included in Phase 1 estimates. Deferred items are outside Phase 1 and cannot enter a sprint without a versioned scope change.

| Requirement | Priority | Delivery requirement |
| --- | --- | --- |
| Identity, privacy, authorization, administrator MFA | P0 | Required for any external users |
| Instrument catalog across all three asset classes | P0 | Explicit supported instruments and contracts |
| Drafts, structured publishing, chart drawings, frozen history | P0 | End-to-end authoring and readback |
| Comments, replies, reactions, follows, reporting | P0 | Useful discussion with abuse controls |
| Trade lifecycle and reported P&L calculations | P0 | Correct stock, options, and futures examples |
| Licensed delayed data with freshness labels | P0 | All three classes covered before beta |
| Profiles/avatars/bios, dashboard, feed, search, private journal, external share and internal repost | P0 | Core customer journey complete |
| Complete marketing, pricing, FAQ, support and policy routes | P0/P1 | Free entry before beta; paid subscription journey before paid launch |
| Backups, monitoring, privacy isolation, restore exercise | P0 | Operational readiness |
| Pro billing and entitlement lifecycle | P1 | Required before charging anyone |
| Advanced journal filters and outcome summaries | P1 | Deliver the paid workflow |
| Saved layouts, expanded watchlists and journal allowances | P1 | Deliver documented Pro limits |
| Notification center, opt-in email digest, preferences | P1 | Engagement without room chat |
| Expanded moderation tools, appeals, support workflow | P1 | Public community readiness |
| Accessibility, performance, cross-browser acceptance | P1 | Public release quality |
| Livestreaming and live room chat | Deferred Phase 2 | Separate future specification and funding |
| Scanners, institutional flow, broker verification, creator payouts | Deferred | Later backlog; no promised delivery date |

Changes must state the customer problem, affected requirements, engineering estimate, supplier/legal effect, cost delta, and schedule delta. The founder accepts the tradeoff before implementation. New scope requires removing equivalent work or increasing budget/time. Product bugs and changes needed to satisfy an existing acceptance criterion are not new features.

# Supported instruments

## Stocks and ETFs

Support provider-listed USD common stocks and ETFs on the supported U.S. exchanges, with vendor reference IDs rather than ticker text as the permanent identity. Publishing supports long and short ideas, whole-share quantities, one entry, and up to three partial exits. Stock borrow availability and actual borrow charges are not provided; short-trade results are labeled incomplete for borrowing costs unless the member supplies those costs.

Exclude OTC securities, non-U.S. listings, crypto assets, fractional-share accounting, and corporate actions that cannot be reconciled safely. Affected positions remain visible with a calculation warning; the system does not silently rewrite their history.

## Options

Support standard, unadjusted, 100-share U.S. equity and ETF options. Include long calls, long puts, bull call debit spreads, bear put debit spreads, bull put credit spreads, and bear call credit spreads. Verticals have two legs, equal contract quantities, the same underlying, the same expiration, and the same option type. Contract selection must come from valid reference data.

Each position has one grouped entry and up to three proportional partial exits. A partial exit closes the same number of spread units across both legs. Legging in or out, scale-ins, ratio positions, naked short options, covered-call stock linkage, cash-secured-put collateral accounting, calendars, diagonals, iron condors, index options, futures options, and adjusted contracts are deferred.

The initial options workspace uses the underlying chart, contract quote snapshots, a leg table, and an expiration payoff chart. Historical option-premium candlestick charts, volatility surfaces, and pre-expiration what-if modeling are deferred. Entry-time Greeks may be shown only when licensed data with a timestamp is available; missing Greeks do not block publication and are never invented.

Assignment, exercise, and unusual settlements require a member-reported resolution and a review flag. Phase 1 does not simulate brokerage handling. A position cannot be automatically assigned a zero value merely because its expiration passed.

## Futures

Start with actual listed contracts for ES, MES, NQ, and MNQ. This is a deliberately bounded futures catalog that still supports futures at launch. Add other futures families only through scope change or a later release.

Capture exchange, root, contract month/year, currency, multiplier, minimum price increment, tick value, last trading date, and applicable session calendar from approved reference data. Show the contract month prominently on every trade card and publication. Support outright long or short positions, whole-contract quantities, one entry, and up to three partial exits.

Continuous contracts are excluded from executable trade selection and Phase 1 charts. No automatic rolling, spread futures, depth of market, order ladder, margin engine, or physical-delivery workflows. Near-expiry and expired contracts receive clear status labels. Contract metadata is versioned; a supplier correction triggers reviewed recalculation rather than an unnoticed historical change.

## Data availability and limits

Instrument discovery is a symbol lookup and catalog, not a scanner. An administrator can disable new publications in an instrument when reference data or licensing is unavailable while preserving existing records. No supported asset class may be removed from launch without a scope revision.

# User roles and application screens

Visitors can read public ideas and profiles. Verified-email members can participate and keep private records. Pro members receive the allowances below. Moderators manage reported public content; administrators manage users, instruments, billing support, operational controls, and moderator permissions.

Email verification means ownership of an email address. It must never be displayed as verified trading performance. Accounts are pseudonymous publicly. Administrative actions and role changes are audited. Administrators require MFA; members can enable it through the chosen identity provider.

The main application navigation is Dashboard, Feed, Explore, Publish, Journal, and Profile. Watchlists, bookmarks, layouts, search, notifications, settings, and billing are accessible from the application shell. Public marketing and staff tools have their own role-appropriate layouts. Phase 2 and scanner navigation are deferred.

Required surfaces include the full public marketing website (Home, Features, How It Works, Pricing, FAQ, About, Contact, Support and policy/status pages); account/verification/recovery/onboarding/subscription flows; public ideas/profiles/instruments; the complete private dashboard, composer, journal/analytics, watchlists, bookmarks, layouts, notifications, profile/settings/billing; and staff reports, appeals, corrections, users, instruments/data, billing, editorial, support, jobs and audit. The repository route catalog specifies every path, permission and journey.

Onboarding asks for experience level, asset interests, and display name. These preferences organize content; they do not create individualized investment recommendations. Account creation includes the applicable age/residency declarations and terms acceptance determined during legal review.

# Publishing and chart authoring

Every publication has a title, asset class, instrument, thesis, timeframe, supporting chart, strategy/direction, entry conditions, invalidation, intended exit rules, and position/conflict disclosure. Educational posts are a separate publication type and do not enter trade statistics.

The composer proceeds through instrument and strategy, trade details, chart and explanation, then review and publish. It shows missing fields and calculation limitations before publication. A member can save drafts privately and preview the exact public view. Saving and publishing are idempotent; a retry does not create duplicate ideas.

## Chart scope

Provide candlesticks, volume, time/price crosshair, zoom/pan, and supported 1-minute, 5-minute, 15-minute, 1-hour, and daily bars. Historical coverage is the preceding 90 calendar days for intraday bars and one year for daily bars where the selected instrument has that history. Newly listed futures contracts may have shorter histories, which must be labeled.

Use regular sessions for stocks/ETFs and exchange sessions for futures, with visible timezone/session labels. Store canonical timestamps in UTC and display America/New_York by default, with a user-selected display timezone. Handle holidays, overnight futures sessions, and daylight saving transitions through calendar data.

The drawing set is horizontal levels, trendlines, rectangles, arrows, text notes, and entry/target/invalidation overlays. Include select/move, delete, undo/redo, autosave, and restore. Permit up to 50 drawing objects per chart and one chart per publication. All drawings use time/price anchors rather than pixel positions. Provide optional 20-, 50-, and 200-period exponential moving averages. Other indicators, Fibonacci/Gann tools, scripting, and multi-chart synchronization are deferred.

Create a shareable chart image from the actual saved state and a reopenable structured chart record, subject to data rights. Feed thumbnails load as images; interactive charts load when opened. The options payoff chart is generated from position terms and is explicitly labeled as an expiration payoff before fees, assignment effects, and early closing.

Desktop supports the full drawing set. Mobile supports reading, publishing structured plans, horizontal levels, text notes, and moving existing anchors; advanced freehand-style manipulation is not part of the mobile acceptance criteria. Core functions must remain usable at 320 CSS pixels without horizontal page overflow.

Lightweight Charts is Apache-2.0 licensed with documented attribution requirements. Its charting components do not include market data, and drawing/indicator behavior requires application implementation. [Official repository](https://github.com/tradingview/lightweight-charts), [TradingView library comparison](https://www.tradingview.com/charting-library-docs/latest/getting_started/product-comparison/).

## Chart implementation contract

Pin `lightweight-charts` to 5.2.1, the latest library release verified on October 19, 2026. TradingView's September plugin-package release did not change that library version. Use the version 5.2 documentation and current TypeScript interfaces. This section defines the engineering approach and acceptance criteria; the chart editor still requires implementation and browser validation. [Official releases](https://github.com/tradingview/lightweight-charts/releases)

### Rendering and drawing ownership

Mount the chart inside a dedicated Next.js client component after the browser container exists. Use `createChart` and the v5 `chart.addSeries(CandlestickSeries, options)` API, with volume and the agreed EMA series. Keep chart instances outside React's serialized application state. Resize with the container, update colors from the CSS design tokens, and remove chart instances, subscriptions, and pointer handlers on unmount. React development remounts must not leave duplicate charts or listeners. [Chart API](https://tradingview.github.io/lightweight-charts/docs/api/interfaces/IChartApi)

Build an application-owned drawing engine on the supported series-primitive API. Use `ISeriesPrimitive`, `attachPrimitive`, canvas renderers, and their attach/detach/update lifecycle for anchored drawings. Simple horizontal labels may use `createPriceLine`; editing and persistence still belong to the application. The toolbar uses Phosphor icons and CSS Modules. Official plugins can be evaluated individually, but none substitutes for a complete saved drawing editor and no third-party drawing suite is selected by default. [Series primitives](https://tradingview.github.io/lightweight-charts/docs/plugins/series-primitives), [series API](https://tradingview.github.io/lightweight-charts/docs/api/interfaces/ISeriesApi)

| Tool | Creation and editing behavior |
| --- | --- |
| Horizontal level | Place at one price; drag vertically; optional short label |
| Trendline | Place two time/price anchors; move either endpoint or the whole line |
| Rectangle | Place opposite corners; resize through handles or move the whole region |
| Arrow | Place start and end anchors; move endpoints or the whole arrow |
| Text note | Place one anchor; enter plain text; edit text and move the note |
| Entry, target, invalidation overlay | Render the structured trade plan as labeled levels; draft edits reconcile with the matching form fields |

Use a shared interaction controller for select, create, drag, resize, text editing, and cancel states. Hit-test handles before object bodies. A completed drag is one undo operation. Escape cancels an unfinished edit, Delete removes a selected object when focus is outside a text field, and undo/redo has both toolbar buttons and platform-appropriate shortcuts. Chart panning must not compete with drawing gestures. Color, line width/style, and rectangle fill opacity use validated style settings. Publishing stops edits to the original drawing state.

### Coordinates and saved state

Persist a versioned chart-state document containing instrument/reference ID, asset class, actual futures contract where applicable, interval, session/timezone display settings, adjustment basis, visible range, indicator settings, data provenance/as-of time, and the drawing collection. Each drawing stores a stable ID, type, time/price anchors, validated style, optional plain-text label, and any structured-plan field reference. Store semantic times and decimal-safe price representations, not screen pixels or library class instances.

Convert coordinates through the series and time-scale APIs for rendering and pointer input. Logical indexes may be used temporarily while interacting but are not the permanent identity of an anchor. Define interval/session mapping for gaps and timeframe changes; preserve the original time and price when its bar is not in the current dataset. Do not silently attach it to a different candle or invent OHLC data. Recompute geometry after pan, zoom, resize, history loading, and data refresh. [Time-scale API](https://tradingview.github.io/lightweight-charts/docs/api/interfaces/ITimeScaleApi)

Validate ownership, schema version, drawing types/count, field lengths, coordinates, numeric bounds, and payload size on the server. Keep the existing 50-object limit. Display saved notes as plain text. Chart notes in a published idea are public; journal-only notes remain private and must never enter the public chart export.

### Saving publishing and images

Autosave the editable draft through an authenticated chart-state endpoint after a short debounce, with a visible saving/saved/failed state, retry, and optimistic revision checks. A stale browser tab must not overwrite a newer revision silently. A refresh restores the latest acknowledged state; unsaved changes remain visibly unsaved. Switching symbols creates or loads the correct instrument's state rather than carrying price-specific drawings onto another symbol.

Publishing stores the validated chart state and structured trade terms in the publication's locked version. Preserve the original viewport and a licensed image/data snapshot sufficient for the promised original view. Keep original and current market context clearly distinct when new bars are available. If licensing does not permit the required retention or image sharing, resolve that supplier gate before enabling the affected publication/export behavior. Subsequent corrections create visible versions.

Generate thumbnails and share images from the committed chart version. In v5.2 use `chart.takeScreenshot(true, false)` to include the primitive/top layer and omit the crosshair. Compose any required publication labels and attribution explicitly; arbitrary HTML toolbar/tooltip elements are not assumed to appear in the canvas image. Exclude selection handles, transient previews, and private notes. Test that every supported drawing and its text survives capture. The image and reopenable chart state must refer to the same publication version. [Screenshot API](https://tradingview.github.io/lightweight-charts/docs/api/interfaces/IChartApi#takescreenshot)

### Options and futures presentation

Options publications show the underlying price chart, valid selected contracts, delayed quote snapshots, leg details, and the existing expiration payoff chart. Distinguish underlying-price levels from option premium, net spread debit/credit, and strategy P&L; never draw an option premium as though it were an underlying price level. Use the tested position calculation module for payoff values. Historical option-premium candles and pre-expiration modeling remain deferred.

Futures publications use the selected listed contract's own bars and metadata. Preserve tick size, multiplier, contract month, source timestamp, session labels, and expiry status. Switching to a different contract is a different instrument, not an automatic roll.

### Chart delivery and acceptance

Deliver the chart work in four bounded milestones: rendering/data adapter; drawing creation/editing; persistence and publication locking; image capture and cross-device acceptance. Every milestone includes relevant checks before the next one.

Acceptance covers all six tool families; anchor and style serialization; select/move/delete; undo/redo; refresh and second-device restoration; concurrent-save conflicts; pan/zoom/resize and timeframe changes; missing-history handling; all 50 drawings; snapshot/export fidelity; failed uploads/data requests; keyboard access; React cleanup; and server rejection of unauthorized state changes. Test the agreed mobile subset on touch devices. Provide accessible toolbar names and textual trade levels alongside the canvas.

The required drawing tools, notes, and saved trade-idea publishing are Phase 1 work. Fibonacci/Gann tools, arbitrary scripts, synchronized multi-chart layouts, and full parity with TradingView's commercial charting platform remain outside this baseline.

## Publication rules

Public trade publications lock their trade terms, chart snapshot, drawings, original thesis, and conflict disclosures immediately. There is no silent editing window. Corrections create visible revisions with server timestamps and old/new values. Display-text corrections can be appended without changing the original evidence. Educational posts and private drafts may be edited, with visible edit labels on public educational posts.

A member may cancel a pending idea with a reason, but the publication and cancellation remain visible. Members can request removal of personal information or report content; moderation and lawful deletion take precedence over public persistence. Store only the audit information that the adopted retention policy permits. No promise of permanent personal-data retention is made.

Use a baseline limit of ten new public publications per account per day for both plans, with additional anti-abuse limits. Titles allow 120 characters; descriptions allow 10,000; comments allow 2,000. Allow three PNG/JPEG/WebP attachments of at most 2 MB each per publication. Re-encode images, remove metadata, validate content type, and reject executable content and SVG. Attachments must not replace the structured trade fields.

Acceptance requires a member to reopen a publication on another device with the same chart anchors and terms, inspect every subsequent revision, and recover a saved draft after a refresh. Failed uploads and supplier errors must not erase the draft.

# Trade lifecycle and calculation rules

Publication and trading execution are different events. All fill prices are member-reported in Phase 1. Labels, profile statistics, exports, and share cards must preserve that distinction. A timestamp proves when the platform received a statement, not when a brokerage executed a trade.

## States and transitions

| State | Permitted next events |
| --- | --- |
| Draft | Edit, publish, discard |
| Published pending entry | Report entry, cancel, mark never entered, append update |
| Entered | Report partial exit, report full exit, append update, flag exception |
| Partially closed | Report another partial exit or final exit, append update |
| Closed | Add review, submit visible correction for review |
| Canceled or never entered | Add explanation; no win/loss result |
| Overdue or unresolved | Resolve with evidence/statement or retain unresolved status |

An entry submission records received_at, member-claimed execution time, price, quantity, costs, and whether the submission occurred within the declared entry window. Eligibility for forward-publication statistics requires the original publication to precede the claimed entry, the claimed entry to fall inside the original entry window, and the report to reach the server within five minutes of that claimed entry. Later reports are labeled retrospective. These checks establish reporting chronology, not execution verification. Retrospective records remain in the journal but are excluded from forward-publication statistics. Record exit reporting delays too and expose them in the history. An author cannot reset the statistics by deleting a public idea.

When an option expires or a futures contract stops trading, an open position becomes unresolved until a documented outcome is available. Do not assume execution at a target, stop, settlement, midpoint, or zero. Missing quotes and ambiguous results remain missing/ambiguous.

Partial exits cannot exceed the remaining quantity or occur before the entry in the member's claimed sequence. Entry scale-ins and post-entry stop/target adjustments are outside structured accounting; an author may discuss a changed plan in an update, with a clear changed-plan flag. A roll is recorded as a close and a separately published linked idea; there is no automatic roll-chain analytics in Phase 1.

## Calculations

Use decimal-safe money arithmetic and instrument metadata. Store quantities and prices with appropriate precision and calculate before rounding the displayed result.

- Stocks: signed exit-minus-entry price times shares, less entered trading costs. For short positions, reverse the sign; label borrowing-cost coverage.
- Futures: signed exit-minus-entry price times contract multiplier times contracts, less entered costs. Validate price increments against reference metadata. Margin is not the risk denominator.
- Options: sum each leg's signed cash flows times the contract multiplier, less entered costs. A reported net spread price is sufficient for grouped entries/exits; a breakdown is optional and must reconcile when supplied.
- Debit vertical maximum theoretical loss: debit times multiplier and units. Maximum theoretical profit: strike width less debit, times multiplier and units.
- Credit vertical maximum theoretical profit: credit times multiplier and units. Maximum theoretical loss: strike width less credit, times multiplier and units.

Validate positive quantities, valid contract combinations, sensible spread debit/credit bounds, expiration, timestamps, and exit balances. Exceptions need an explicit reason and review label rather than silent normalization.

Store initial planned cash risk separately. For stocks/futures it is the initial entry-to-stop distance times quantity/multiplier; it is not a guaranteed loss cap. For supported long options/verticals use initial theoretical maximum loss. R equals reported net realized P&L divided by this frozen positive initial risk. Changed risk assumptions do not rewrite the denominator.

Unit fixtures must cover stock long/short, long call/put, all four supported verticals, futures long/short with different multipliers, partial exits, costs, breakeven outcomes, expired/unresolved positions, duplicate submissions, and rounding. A fictional 100/105 call spread entered for $1.50 with multiplier 100 must show $150 theoretical maximum loss and $350 theoretical maximum profit before costs.

## Phase 1 performance presentation

Show eligible closed-position count, wins, losses, breakevens, win rate, average win/loss, total reported realized P&L, worst reported loss, mean R where valid, and unresolved-position count. Define a win as net reported realized P&L greater than zero after entered costs; report how many positions have complete cost data. Win rate is wins divided by wins plus losses; breakevens are displayed separately.

Partial exits belong to one position and never create extra wins. Retrospective, educational, canceled, never-entered, and unresolved items do not enter the closed-trade denominator. Display excluded counts and reasons beside results. Include records with missing costs only in a clearly identified incomplete-cost view, not the headline net-results subset.

There is no brokerage verification, account return, Sharpe ratio, account equity curve, portfolio drawdown, automatic execution simulation, or combined cross-asset dollar leaderboard. Reported outcomes are filterable by asset and supported strategy. Public records remain visible regardless of subscription.

Default discovery combines recency, followed interests, and manual editorial selections. Members can inspect reported statistics, but no automated promotion rewards the highest win rate. A later verified-performance system requires its own specification. Editorial criteria favor complete plans, useful discussion, documented follow-up, and transparent losses; subscription status cannot improve editorial eligibility.

# Community features and moderation

The feed offers Following and Discover, asset tabs, instrument/strategy filters, and Newest sorting. Editorial selections form a separate labeled collection. Full-text search covers public titles/descriptions and author names; structured filters cover asset, symbol, supported strategy, and publication status. Search of private journal data is owner-scoped and never shares an index with public results without explicit access filtering.

Provide one reaction type, bookmarks, author follows, and instrument follows. Comments support direct replies with two visible levels; deeper responses flatten into the thread while preserving the reply target. Include edit labels, reports, and muted notifications. Replies may optionally be tagged Question, Counterargument, Alternative structure, or Risk concern. Dedicated live chat, direct messages, group channels, image uploads in comments, and unsolicited user-to-user messaging are deferred.

Members may mute another author's content. Muting does not give an author permission to suppress criticism on the author's public publications. Authors may report abuse; moderators decide removal. Reports cover spam/scams, harassment, impersonation, misleading performance, undisclosed promotion, and personal information. The administrator interface includes queues, reasons, reversible content hiding, account suspension, role controls, audit logs, and appeals.

Use rate limits for registration, posting, reactions, follows, and reports. Detect simple duplicate content and coordinated reaction bursts; human review decides sanctions. Do not build a sophisticated fraud-scoring product in the MVP. Moderators cannot read private journals through ordinary moderation tools. Exceptional support access requires a specific purpose, limited access, and an audit event.

Launch acceptance includes reports reaching the queue, content hiding/restoration, member notices, an appeal path, and enforced bans that cannot be bypassed by a normal session refresh. Moderation coverage is during published support hours; an urgent report contact handles exposed personal information and account security outside that schedule.

# Journal notifications and subscriptions

Private journal entries can link to a public idea or stand alone. Include thesis, structured supported position, personal notes, outcome, tags, and a review. Public publication terms cannot be changed through editing a linked private note. Conversion of a private draft into a public post creates a new publication timestamp and never inherits a historical public record.

All members can export their own stored records and request account/data deletion through the applicable policy. Pro adds filtered analytical exports, not a paywall on access to one's own raw personal data. Public statistics are identical across plans.

| Feature | Free | Pro |
| --- | --- | --- |
| Read and publish public ideas | Included with common anti-abuse limits | Same |
| Comments, replies, follows, reactions, bookmarks | Included | Same |
| Delayed data and core chart drawings | Included | Same data delay |
| Public history and basic reported statistics | Included | Same public transparency |
| Watchlists | 1 list with 25 instruments | Up to 10 lists with 100 instruments each |
| Saved private chart layouts | 1 | Up to 10 |
| New private journal entries | 30 per calendar month | Up to 1,000 per month under fair use |
| Journal access after reaching a limit | Read/edit existing entries and export | Same |
| Journal analytics | Basic counts and individual outcomes | Filters by strategy/tag/period; win/loss distribution; mean R; review completion |
| CSV export of personal raw records | Included | Included |
| Filtered analytical CSV reports | Not included | Included |
| In-app activity notifications | Included | Included |
| Opt-in daily email digest | Followed publication activity | Activity plus saved public search summaries, capped at five searches |

Neither plan includes price-trigger alerts, real-time exchange data, scanners, creator channels, live rooms, or broker integrations. A saved public search finds community posts, not financial-market screening results.

Notification events are new followed-author publications, replies/mentions, important updates to bookmarked ideas, moderation notices, and billing/account events. Provide preference controls, aggregation, unsubscribe for optional email, and quiet-hour handling for digests. Account/security/billing notices remain transactional. No SMS, mobile push, or urgent trading-signal delivery commitments.

Pro billing must cover monthly/annual checkout, applicable tax, invoices/receipts, upgrade, cancellation at period end, failed payments, renewal, refund administration, and downgrade. Use a hosted billing portal where supported. Webhooks are authenticated, replay-safe, and idempotent; the server determines entitlements. A cancellation preserves paid access through the paid period. A downgrade preserves records and allows editing/export while restricting additions beyond Free allowances. No creator payouts, revenue sharing, or payment marketplace is implemented.

Stripe publishes U.S. domestic card pricing of 2.9% plus $0.30, with additional products and transaction circumstances potentially adding fees. The operating model uses a 4% revenue allowance for payment/billing costs, with refunds and disputes tracked separately. Processor acceptance of the actual business must be confirmed; the restricted-business list includes relevant financial and content-platform categories. [Stripe pricing](https://stripe.com/pricing), [Restricted businesses](https://stripe.com/legal/restricted-businesses).

# Data suppliers legal review and business controls

The launch baseline uses licensed delayed data rather than a retail feed or scraped quotes. Each display shows asset, source attribution where required, provider timestamp, delay, market session, and stale/missing status. Target a 15-minute delay where contracts permit; a longer mandatory delay must be displayed and reviewed before committing to the supplier. Public and Pro data remain identically delayed in Phase 1.

Options need valid contract reference data and delayed bid/ask snapshots. Futures need approved contract reference data and delayed contract bars. Stock bars must label their adjustment basis. Handle corporate-action exceptions explicitly so a split does not create artificial profits or move an old drawing without explanation.

Data licensing must address public display, logged-in display, thumbnails/screenshots, delayed snapshots, retention, derived payoff/analytics, personal exports, and operational calculations. Commercial pricing includes provider minimums and applicable exchange fees; these are not implied by a retail API price. Usage reporting and entitlements must follow the signed terms. Preserve publications while removing or replacing stored market-data components when contract obligations require it.

OPRA states that vendors need agreements for delayed as well as current data; delayed data avoids certain usage/device charges, not all vendor requirements. CME documents separate display, non-display, historical, and distribution policies. [OPRA vendor requirements](https://www.opraplan.com/), [CME policy center](https://www.cmegroup.com/market-data/license-data/market-data-policy-education-center.html).

Before public monetization, securities/futures counsel reviews publication behavior, editorial selections, reported statistics, conflicts, disclaimers, member conduct, privacy, terms, advertising, and state/federal implications. Publisher exclusions and CTA treatment depend on actual activity. If a lawful operating model requires changes, record a scope revision or postpone the affected release; disclaimers are not a substitute. [SEC adviser guidance](https://www.sec.gov/files/divisions/investment/iaregulation/memoia.htm), [CFTC intermediary definitions](https://www.cftc.gov/IndustryOversight/Intermediaries/index.htm).

No personalized portfolio recommendations, performance fees, order-based compensation, promises of investment returns, account custody, or automated trade following. Require members to disclose whether they hold the discussed position and whether publication is compensated. Sponsored ideas and issuer promotions are not accepted at launch. Establish a review process for claims that appear manipulative or fraudulent.

External decisions have named accountable roles and deadlines: the founder selects suppliers and confirms commercial terms by the end of week 3; counsel identifies required product controls by week 3 and reviews the implemented workflows before paid launch; the engineering lead validates the documented engineering defaults, provider compatibility and supplier integrations and signs off the instrument and calculation model by week 3; the founder obtains processor acceptance before the week 17 billing milestone. Exchange/license policy changes after selection trigger an impact review. These decisions cannot be represented as already signed contracts or legal clearance.

# Technical implementation boundaries

The founder-approved frontend/backend stack, CSS-only styling, Phosphor icons, Vercel frontend hosting and Docker development remain fixed. The repository handoff supplies concrete engineering defaults for identity, jobs, storage, email and reference production deployment, with ADRs distinguishing those defaults from founder approvals. Provider contracts, actual paid tiers/regions, credentials, legal/operator identity and release evidence remain external gates.

## Locked frontend stack — October 19, 2026

This is the stable-release baseline checked on October 19, 2026, using publisher documentation and read-only npm registry metadata. “Latest” describes this verification date; it does not mean dependencies float automatically. Selection is documented here; the application has not been scaffolded or build-tested.

| Layer | Locked selection | Purpose |
| --- | --- | --- |
| Web framework | [Next.js 16.4.2](https://registry.npmjs.org/next/16.4.2), App Router | Public idea/profile pages, metadata, routing, server rendering |
| UI runtime | [React 19.3.1](https://registry.npmjs.org/react/19.3.1) and [React DOM 19.3.1](https://registry.npmjs.org/react-dom/19.3.1) | Interactive community and trading interfaces |
| Language | [TypeScript 7.0.2](https://registry.npmjs.org/typescript/7.0.2), strict mode | Typed UI models and API contracts |
| Styling | Plain CSS with Next.js CSS Modules and shared CSS custom properties | Scoped component styles, responsive layouts, shared design tokens, dark/light themes |
| Components | Custom React components styled with CSS Modules | Reusable product components; accessible unstyled behavior primitives may be selected during scaffolding |
| Interface icons and SVG | [@phosphor-icons/react 2.1.10](https://registry.npmjs.org/@phosphor-icons/react/2.1.10) | One consistent icon family across navigation, feeds, profiles, sharing, charts, and moderation |
| Brand SVGs | [Simple Icons 16.35.0](https://registry.npmjs.org/simple-icons/16.35.0), only when needed | Social-platform marks subject to each brand's usage rules |
| Financial charts | [TradingView Lightweight Charts 5.2.1](https://registry.npmjs.org/lightweight-charts/5.2.1) | Stock, underlying, and futures price charts |
| Development/build runtime | [Node.js 24.22.0 LTS](https://nodejs.org/en/blog/release/v24.22.0) | Supported LTS toolchain for frontend development and builds |
| Package manager | [pnpm 12.14.0](https://pnpm.io/blog/releases/12.14.0) | Reproducible project dependency installation |

Use Next.js Server Components for suitable public content and client components for chart interaction, drawings, forms, and other browser behavior. Keep private journal data out of public page caches. The selected React and Node versions meet Next.js's published package requirements; full integration, type checking, and production-build validation are required when scaffolding. Node here is a frontend toolchain decision and does not choose the backend language.

### Phosphor icon standard

Use the maintained `@phosphor-icons/react` package, not the legacy `phosphor-react` package. The product standard is regular weight for normal controls and fill weight for selected states, using consistent 16, 20, and 24 pixel sizes. Reserve bold for a specific, documented emphasis pattern. Avoid mixing weights arbitrarily. Use SVG/currentColor, accessible labels for icon-only buttons, and hide decorative icons from assistive technology.

Use Phosphor's documented server-rendering entry point in Server Components and import only the icons needed. Apply its documented Next.js import optimization if development compilation warrants it. Phosphor is MIT licensed. Phosphor is the interface icon standard for all custom components. Social-platform logos use approved brand SVGs rather than improvised interface symbols. [Phosphor React documentation](https://github.com/phosphor-icons/react)

### Chart and design boundaries

Lightweight Charts supplies chart rendering and extension APIs. The drawing toolbar, persistent annotations, edit handles, undo/redo, notes, frozen publication snapshots, and readback behavior are application work already included in Phase 1. Market data must come from a separately licensed supplier. The chart library does not supply an options chain, options strategy calculator, scanner, or a complete TradingView drawing suite. Preserve its required attribution and notices. [Plugin and drawing extension documentation](https://tradingview.github.io/lightweight-charts/docs/plugins/intro)

The repository design-system specification now defines a concrete neutral dark/light palette, system typography, spacing, component states, responsive layouts, avatar/profile treatment and sharing/repost workflows. It is an engineering-selected implementation baseline replacing the rejected sketch; actual rendered branding/flows still receive visual review. Author styles in ordinary .css files: .module.css for component-local rules and global CSS for reset, typography and shared variables. Use native Grid/Flexbox, media/container queries and CSS variables. [Next.js CSS documentation](https://nextjs.org/docs/app/getting-started/css)

The styling decision supersedes the previous Tailwind and shadcn/ui selections. Do not introduce Tailwind packages, its PostCSS plugin, utility-class styling, shadcn-generated styling, Sass, or CSS-in-JS libraries. Build reusable React components with the shared CSS tokens. Any unstyled behavior primitives must preserve keyboard, focus, and screen-reader requirements and use the same CSS styling system. The backend selection is approved: NestJS, Node.js LTS, TypeScript, PostgreSQL, Prisma, and REST/OpenAPI.

### Version and toolchain policy

Use exact direct dependency versions and commit the generated `pnpm-lock.yaml` when implementation begins. Record the exact pnpm version in the project's package-manager metadata and enforce Node 24.22.0 in development/CI configuration without editing global mise configuration. This Mac already reports Node 24.22.0 and pnpm 12.14.0 under mise; no runtime installation or update is needed.

Review security patches promptly and update through a checked change with type checking, production build, and relevant workflow verification. Reassess supported LTS releases and library maintenance over time; the architecture is locked for the initial build, not frozen on obsolete versions for 10–20 years. Next.js 16.4 was released October 6, and the October 14 security advisory establishes a patched baseline; the selected 16.4.2 follows that patch. [Next.js 16.4 release](https://nextjs.org/blog/next-16-4), [October security update](https://nextjs.org/blog/nextjs-security-update-october-14-2026)

## Locked backend core

Choose NestJS with TypeScript on Node.js LTS, PostgreSQL for authoritative records, and Prisma for database access and migrations. This is the selected backend for Phase 1. It shares the frontend's primary language and provides explicit modules and policies for the growing community product. The initial backend is a modular monolith: one backend codebase with distinct business modules, an API process, and a separately running worker process. This selection adds no Phase 2 work and does not change the planning budget or timeline.

### Backend baseline on October 19 2026

| Layer | Selection | Role |
| --- | --- | --- |
| Runtime | Node.js 24.22.0 LTS | Same mise-managed runtime as frontend development |
| Language | TypeScript, strict mode | Shared domain vocabulary and generated API types; package compiler compatibility is verified during scaffolding |
| Application framework | NestJS 12.2.0 | Accounts, publications, comments, journal, billing entitlements, moderation, and provider adapters |
| HTTP adapter | @nestjs/platform-express 12.2.0 | Nest's default Express integration; no adapter change without a measured requirement |
| API | REST with OpenAPI | Explicit, documented contract and generated frontend client types |
| Database | PostgreSQL 18.6 | Managed production database with transactions, constraints, backups, and point-in-time recovery |
| Database access | prisma and @prisma/client 7.10.1 | Matching stable versions for typed queries and reviewed migrations |
| Background processing | pg-boss 12.38.0 on PostgreSQL; separate Node worker from the same backend codebase | Emails, exports, image processing, provider refresh, and derived statistics |

The Nest package baseline was verified through the publisher's npm registry: [core 12.2.0](https://registry.npmjs.org/@nestjs/core/12.2.0), [common 12.2.0](https://registry.npmjs.org/@nestjs/common/12.2.0), and [Express adapter 12.2.0](https://registry.npmjs.org/@nestjs/platform-express/12.2.0). Nest supports TypeScript and provides modules, dependency injection, and HTTP integrations. Node 24.22.0 meets the current framework and CLI runtime requirements. [Nest introduction](https://docs.nestjs.com/), [Nest 12 migration guide](https://docs.nestjs.com/migration-guide)

PostgreSQL 18.6 is the current supported stable 18.x release on this verification date; PostgreSQL 19 is still a release candidate. PostgreSQL majors receive five years of support, so a 10–20 year business requires planned database upgrades. Keep the current supported minor release patched. [PostgreSQL versioning policy](https://www.postgresql.org/support/versioning/)

Prisma's npm `latest` tag currently resolves to 8.0.0-rc.23. Pin the stable 7.10.1 CLI and client instead and follow version 7 documentation. Prisma 7 uses ESM and requires a database driver adapter; include the PostgreSQL adapter and driver in the scaffold's dependency review. Do not copy Prisma 8 examples into a version 7 project. Node 24.22.0 meets the version 7 package requirement. [Prisma 7 upgrade guide](https://www.prisma.io/docs/guides/upgrade-prisma-orm/v7), [Prisma 7.10.1 release](https://github.com/prisma/orm/releases/tag/7.10.1)

### Application boundaries and operational requirements

Next.js owns the web interface, public rendering, and browser session integration. NestJS owns business rules and authoritative writes. Route browser API traffic through the same public origin where practical. Validate all API inputs at runtime and generate frontend types from the API contract; TypeScript alone does not validate incoming network data.

Organize the backend into Accounts, Profiles, Publications, Instruments, Positions, Discussions, Journal, Billing, Notifications, Moderation, and Audit modules. Store immutable published chart-state versions and trade lifecycle events. Keep authoritative P&L arithmetic decimal-safe, enforce lifecycle transitions in transactions, and make duplicate payment/provider messages safe to process again.

Use a maintained identity solution with secure session handling and administrator MFA. Every journal, draft, attachment, export, and paid feature must enforce ownership and entitlement on the server. Apply CSRF protection where cookie-based authentication requires it, rate limits, upload validation, parameterized database access, secret management, and audited administrative actions. Framework selection supports these controls; their implementation and acceptance checks determine security. [Nest authorization](https://docs.nestjs.com/security/authorization), [runtime validation](https://docs.nestjs.com/techniques/validation)

Use pg-boss 12.38.0 on PostgreSQL with a separate Node worker, bounded retries/timeouts, idempotent handlers and failure visibility. Persist outbox records with relevant business changes. Local identity uses Keycloak 26.8.1 through standard OIDC code+PKCE; local email uses Mailpit and local processed objects use an owner-aware filesystem adapter. Production reference adapters are R2 objects, Resend SMTP and Stripe billing. PostgreSQL full-text search is the initial search implementation. Exact dependency/digest inventory and integration build evidence are required during scaffolding.

Vercel is the selected Next.js frontend host, covering the web application, server rendering, and CDN delivery. Plan for Pro at commercial launch; Hobby is restricted to personal, non-commercial use. Use Git-connected preview deployments, separate production and preview configuration, and usage/spend monitoring. This decision does not create a Vercel project or purchase a plan. [Next.js on Vercel](https://vercel.com/docs/frameworks/full-stack/nextjs), [Vercel plan terms](https://vercel.com/docs/plans/hobby)

Vercel supports NestJS Functions with Fluid compute and remains a documented alternative. The engineering reference deployment uses paid always-on Render services for NestJS, worker and Keycloak plus managed PostgreSQL, preserving the separately running worker model. Verify supported PostgreSQL major, backup tier, region and actual commercial terms before provisioning. The founder's hosting approval covers Vercel frontend; no additional purchase is implied. [NestJS on Vercel](https://vercel.com/docs/frameworks/backend/nestjs), [Render workers](https://render.com/docs/background-workers), [Render recovery](https://render.com/docs/postgresql-backups)

Implement the documented provider adapters, database recovery, health checks, structured/redacted telemetry and alerts. Actual service accounts/tiers, dataset rights, legal policies, processor acceptance, support staffing and production secrets are tracked release gates. The infrastructure allowance and staffing/timeline remain planning assumptions requiring review against the full handoff; they are not provider quotations or a guarantee that added detail costs nothing. Complete package/compiler/provider integration must pass implementation checks. No host tool installation, paid account or deployment is performed by this specification.

Introduce supplier adapters and typed asset-specific position models so future scanners and broker imports can reuse instrument identities and trade events. Heavy scanning and analytics must run in workers or later specialized services, with measured capacity determining any new language or infrastructure. Do not prebuild streaming rooms, generalized signal engines, or unused future database tables.

Core entities are User, Role, Profile, Instrument, InstrumentMetadataVersion, Publication, PublicationRevision, ChartState, Attachment, Position, PositionLeg, PositionEvent, OutcomeSnapshot, Comment, Reaction, Follow, Bookmark, Watchlist, JournalEntry, Notification, SubscriptionEntitlement, Report, ModerationAction, and AuditEvent. Public and private ownership must be explicit on every relevant object.

Server-side transactions enforce lifecycle rules. Derived metrics retain the calculation version and can be rebuilt from source events. Record changes use append-only business events with audited corrections; this is not a claim of externally certified tamper-proof storage. Monetary arithmetic uses decimal-safe representations. Market-data API keys and payment secrets never enter browser bundles.

The implementation must respect the machine-wide mise toolchain policy. Project dependencies can be installed with the project's package manager; global tools, mise configuration, and shell initialization are not modified. This specification does not authorize installation or deployment.

## Local Docker development

Use Docker Compose on the founder's Mac for local development before deployment and retain it for ongoing development afterward. Run separate services for the Next.js frontend, NestJS API, PostgreSQL database, and background worker. The worker shares the backend codebase and starts separately. Its queue configuration follows the selected durable-job implementation; no additional queue service is implied by this decision.

Support source hot reload, service health checks, and a named PostgreSQL volume so ordinary container recreation preserves development records. Keep service-to-service addresses in environment configuration and expose only the ports needed for local browser access, bound to localhost by default. Use synthetic or clearly labeled fixture market data until licensed supplier access is configured. Real data feeds, email, payments, and identity integrations can still require external services and their own accounts.

Record compatible container images for the selected Node.js and PostgreSQL versions and commit the Compose files and Dockerfiles when scaffolding. Keep dependencies and build output inside suitable container volumes so host and container installations do not overwrite one another. Store local secrets outside version control, provide an example configuration, and document database reset and backup commands; deleting a database volume must be an explicit development action.

Docker is the local execution environment; Vercel remains the selected production frontend host. Vercel's Next.js deployment uses its supported build/runtime flow rather than deploying this local Compose stack. Backend, worker, and managed database production hosting remain separate decisions. Continue respecting mise for host tools; this decision does not install or update Docker or any host runtime.

# Reliability privacy and quality acceptance

Capacity targets are 5,000 registered accounts, 1,000 monthly active members, 100 concurrent application sessions, 50,000 publications, and 250,000 comments. These are engineering test targets, not a customer forecast. Load tests include browsing and a smaller mixture of writes and chart opens; 100 sessions are not represented as 100 concurrent market-data streams.

| Area | Public release target |
| --- | --- |
| Application availability | 99.5% monthly operating objective; supplier outages reported separately |
| Public page performance | 75th percentile largest contentful paint under 2.5 seconds on the agreed representative mobile test profile |
| Ordinary API requests | 95th percentile under 750 ms under the defined load, excluding external data retrieval |
| Cached search | 95th percentile under 1 second under the defined load |
| Publication writes | No lost/duplicate writes in retry and failure tests |
| Recovery | Recovery point objective of 1 hour for database changes and recovery time objective of 8 hours |
| Browser coverage | Current stable Chrome, Safari, Firefox, Edge; iOS Safari and Android Chrome for agreed mobile flows |
| Accessibility | WCAG 2.2 AA target for core flows, with accessible form labels and text alternatives to chart-only information |
| Security | No unresolved critical/high findings in release review |

Define test network, device, dataset, and load conditions before measuring. External data and identity dependencies have independent failure states; a data outage must not prevent reading saved public explanations or exporting personal records.

Require authorization tests proving that guessed IDs, search, image URLs, exports, and caches cannot expose another member's private data. Include CSRF/session protections as appropriate, output escaping, secure cookies, rate limiting, upload validation, secret handling, dependency review, and audited administrator access. Adopt retention schedules for business records, deleted content, logs, and backups during legal review rather than retaining everything indefinitely.

Back up the database with point-in-time recovery; protect object storage with an appropriate recovery policy. Perform a restore into a clean environment before beta and again before public launch. Monitor failed jobs, calculation errors, data freshness, billing webhook failures, delivery errors, unusual access, and application availability. Maintain a public status page and a short incident/support runbook.

Required end-to-end acceptance scenarios include registering, verifying email, publishing each supported trade family, restoring chart drawings, replying/reporting, partial/final close, unresolved expiration, correction history, private journal isolation, cancellation/downgrade, duplicate payment webhooks, data-provider outage, backup restore, and basic keyboard/screen-reader use. Tests must include unfavorable outcomes and misleading-input attempts, not just successful trades.

# Delivery team timeline and dependencies

The reference team is two experienced full-time engineers for 24 active workweeks, one part-time designer, part-time QA ramping before beta, an independent infrastructure/release specialist, and securities/futures counsel. The founder supplies weekly decisions and operates the founding community. Delayed decisions, team changes, or unresolved supplier terms extend the schedule.

| Weeks | Deliverable | Exit condition |
| --- | --- | --- |
| 1–3 | Instrument/data feasibility, legal/payment review initiation, UX flows, calculation fixtures, architecture | All three asset classes have viable commercial data paths; supplier terms and required controls are understood |
| 4–7 | Identity, roles, instrument catalog, private/public data model, drafts, basic feed | Authenticated users can safely create/read private drafts and public test ideas |
| 8–12 | Chart drawings, structured stock/options/futures composer, locked history, comments/replies | A complete publication for each supported trade family reopens correctly |
| 13–16 | Delayed data integration, lifecycle/accounting, basic journal, reports/moderation, backup restore | P0 acceptance passes; 20 founding contributors can enter invited beta |
| 17–19 | Pro billing, entitlements, advanced journal filters, watchlists/layout allowances, notifications | Paid-plan lifecycle passes in test mode; Pro value is usable |
| 20–22 | Expanded beta with 50–100 invited members, accessibility, load/security review, operational rehearsal | Defects and support demand measured; no unresolved critical/high issues |
| 23–24 | Fixes, production billing check, content seeding, supplier reporting, release review | All public-launch gates pass |
| 25–28 | Calendar and integration contingency | Absorb holiday availability, vendor review, and material integration defects |

Invite beta begins around week 16 with the same three asset classes. Public paid launch is targeted for weeks 24–28, not promised for a fixed date. Workweeks are project-relative; contingency includes the effect of holiday availability when the calendar crosses year-end. Supplier negotiations begin in week 1 and must overlap engineering rather than wait for a finished application.

For illustration only, a November 2, 2026 kickoff corresponds to an April 18–May 16, 2027 public-launch window. The date moves with actual kickoff, staffing, contract readiness, and gate outcomes. No team has been hired and no launch date is committed by this specification.

The critical path is data/legal feasibility, instrument model, lifecycle/calculation correctness, chart publication persistence, end-to-end privacy, then beta and paid release. Design and supplier negotiations overlap feature implementation. If commercial terms are not viable by the end of week 3, avoid committing the full build budget until the founder selects a revised commercial plan.

With one full-time experienced engineer and limited specialist help, allow approximately 10–15 months for comparable scope. A part-time founder schedule can be longer. AI coding assistance does not remove supplier negotiations, calculation review, privacy testing, moderation setup, or beta observation time.

# Development budget

The following is an explicit reference staffing model in USD. Hourly rates are assumed procurement inputs rather than surveyed market averages. Confirm scope and quotes before committing cash. Design, QA, and infrastructure work overlap the 24 active engineering weeks.

| Item | Assumption | Reference cost |
| --- | --- | ---: |
| Two full-time engineers | 1,920 combined hours at $90/hour | $172,800 |
| Product/UX design | 160 hours at $85/hour | $13,600 |
| Dedicated QA | 240 hours at $65/hour | $15,600 |
| Independent infrastructure/release work | 100 hours at $140/hour | $14,000 |
| Securities/futures counsel and policies | Allowance | $15,000 |
| Data onboarding and prelaunch service allowance | Allowance | $8,000 |
| Independent security assessment | Allowance | $8,000 |
| Subtotal | Labor and allowances | $247,000 |
| Contingency | 20% of subtotal | $49,400 |
| Reference build total | Subtotal plus contingency | $296,400 |

A reasonable procurement envelope for this defined scope is approximately $220,000–$400,000, with the reference model near $300,000. Supplier minimums, unusually expensive licenses, or extensive legal restructuring can exceed that envelope and require a new decision. Founder compensation, fundraising, incorporation/tax advice outside the allowance, paid growth campaigns, and postlaunch operating runway are excluded from the build total.

A founder-engineered route may reduce outside build cash to roughly $50,000–$120,000 by replacing paid engineering labor with substantial founder time and tightly controlling contractors. That is not the cost of buying the same staffed schedule, and it excludes the founder's opportunity cost and living expenses. Obtain the data/legal quotes before relying on this lower-cash route.

The $8,000 prelaunch data allowance assumes a staged development/beta agreement, not six months of unrestricted production distribution. If vendors require full production minimums earlier, use contingency only with a documented forecast; replenish the budget if contingency would be consumed by known recurring charges.

# Operating costs and runway

These are monthly allowances near the initial capacity target. Data rights are the largest unquoted variable; replace these values with actual vendor terms before launch. Retained engineering covers maintenance rather than new scanner or livestreaming development.

| Item | Reference per month | Planning range per month |
| --- | ---: | ---: |
| Application, database, queue, storage/CDN, backups | $600 | $350–$1,200 |
| Identity and transactional email | $100 | $50–$300 |
| Monitoring and operational tooling | $150 | $100–$500 |
| Licensed stock/options/futures data and exchange costs | $3,500 | $2,000–$10,000+ |
| Community moderation | $1,800 | $1,000–$3,000 |
| Customer support | $1,000 | $500–$2,000 |
| Accounting, insurance, routine legal reserve | $600 | $500–$1,500 |
| Engineering maintenance | $6,000 | $4,000–$10,000 |
| Total before marketing and payment costs | $13,750 | $8,500–$28,500+ |

The data row is a provisional combined allowance, not evidence that these rights can be purchased at that price. User-based exchange charges, added storage/history, and professional users can change the cost shape. Restricted professional-data access is part of the launch commercial model, subject to the actual supplier definitions and eligibility process.

Reserve a further $3,000 per month for measured acquisition experiments after public release, separate from operations. Payment/billing allowance is 4% of subscription revenue; sales taxes collected, refunds, disputes, and unusual processor fees are accounted separately. Business taxes and founder compensation are not included.

Six months of reference operations costs $82,500. Adding six months of the $3,000 acquisition allowance brings postlaunch runway to $100,500. Reference build plus that runway totals $396,900. This is a financing planning amount, not an instruction to spend it.

At $29 monthly, a 4% payment allowance and an additional illustrative $3 variable service cost leave $24.84 per paying member. Covering $13,750 of reference fixed costs would require about 554 paying members before acquisition spend. Annual discounts, lower realized prices, churn replacement, and scaling data costs increase the requirement. This calculation is a sensitivity example and does not assume that 554 subscribers fit the initial audience or license tier.

# Launch gates and success measures

Invited beta requires passing P0 acceptance, signed beta-appropriate data rights for all three classes, approved participant terms, no known critical/high privacy or security issues, a successful restore, and a staffed reporting/support path. Use the following public-launch checklist after the beta.

- [ ] All P0 and P1 requirements pass their acceptance scenarios.
- [ ] Stock, supported options, and all four futures roots have working reference data and delayed displays.
- [ ] Every performance surface identifies member-reported execution and excluded/unresolved records.
- [ ] Data display, storage, export, and distribution terms are signed and implementable.
- [ ] Counsel has reviewed the actual public/paid workflows and required controls are implemented.
- [ ] The payment provider accepts the actual business; real purchase/cancel/refund rehearsal succeeds.
- [ ] Private-data isolation, correction history, arithmetic fixtures, and webhook replay tests pass.
- [ ] No unresolved critical/high security findings or critical calculation defects remain.
- [ ] Accessibility and performance checks meet agreed targets or have explicit founder-accepted, noncritical exceptions.
- [ ] Backup restore, incident runbook, supplier outage behavior, and moderation coverage are operational.
- [ ] At least 20 founding contributors and 50 useful original publications cover stocks, options, and futures collectively, with at least ten publications in each class.
- [ ] Four weeks of beta observation have produced actual usage, defect, and support evidence.

Collect activation, weekly returning contributors, publication-to-outcome review completion, substantive replies, unresolved positions, report handling time, Pro conversion, voluntary churn, support burden, and revenue net of refunds. Define activation as a member who follows at least three interests/authors and then publishes, comments, or creates a journal entry within seven days. Separate readers and authors in retention analysis.

Initial business learning targets are 35% activation among invited members, 30% four-week return among activated members, at least 60% of entered positions receiving a resolution/review within seven days of the declared horizon, and a 3–5% paid-conversion experiment after users have access to working Pro features. These are hypotheses for review, not engineering acceptance criteria or promises. A small beta cannot validate long-term retention or rare trading risks.

If beta users do not return, do not assume livestreaming will fix retention. Review the publishing, discussion, journal, pricing, and acquisition evidence first. The founder decides whether to iterate Phase 1, adjust the commercial model, or fund Phase 2.

# Deferred scope and Phase 2 reservation

Phase 2 is reserved for livestreaming with screen sharing, host audio, public/member/invite rooms, moderation, and persistent live room chat linked to trade ideas. Its detailed UX, provider selection, audience caps, recordings, pricing, costs, launch date, and build estimate are intentionally not defined here. There is no Phase 1 streaming infrastructure, room database, WebRTC integration, or live chat development.

Later backlog items are stock/options/futures scanners, institutional holdings and flow analysis, real-time data entitlements, broker-connected verification, trade execution, copy trading, creator subscriptions/payouts, expanded instruments and complex options strategies, native apps, AI-generated research, and team/enterprise offerings. Preserve stable user, publication, instrument, and event IDs so these can integrate later without prebuilding them.

Begin repository implementation with P01 Foundation, then the ordered P02–P14 assignments. Pursue supplier/legal/payment feasibility in parallel from the beginning. The complete requirements, page catalog, engineering defaults, contracts, acceptance criteria and agent prompts are now in the repository handoff. New brainstorming belongs to the deferred backlog unless it corrects an existing requirement or passes scope change.

# Repository engineering handoff

The local repository documentation package is the engineering source of truth alongside this baseline. Start with `docs/README.md`, then `docs/implementation/execution-plan.md` and `docs/prompts/P01-foundation.md`. There are 32 requirement records with acceptance mappings and 14 bounded agent prompts.

Companion specifications cover product behavior/routes/marketing content; CSS-only design; architecture/data/API/chart/integrations; ADRs; security/privacy/acceptance; operations/maintenance; external gates; and GitHub governance. Machine-readable contracts are `contracts/openapi.json` and `contracts/chart-state.schema.json`.

Root repository files include AGENTS, README, CONTRIBUTING, SECURITY, CODE_OF_CONDUCT, SUPPORT, CHANGELOG, a proprietary LICENSE notice, and THIRD_PARTY_NOTICES. GitHub issue/PR templates, CODEOWNERS setup guidance and documentation integrity CI are included. The repository has not been initialized/pushed, and templates are not configured branch protections.

The handoff prepares engineers to build; application implementation and all software acceptance checks remain unrun. Provider/visual defaults are distinguished from founder approvals. Signed data/legal/payment approvals, real business/domain identity, production accounts and release evidence cannot be manufactured by a specification.
