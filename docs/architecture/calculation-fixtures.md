# Calculation fixtures and domain boundary

Implemented in P02. The authoritative synthetic manifest is [domain-calculations.json](../../contracts/fixtures/domain-calculations.json). Its 20 cases are executed by the domain test runner, not merely checked for file existence. The API persona fixture copies those cases and a test proves exact synchronization. They are deterministic examples, not quotes, fills, trading advice or broker-verified evidence.

`packages/domain` provides strict decimal-string value conversion/formatting, plan/tick validation, grouped position calculations, expiration payoff, frozen-risk provenance, lifecycle validation/transitions, entry-report eligibility, outcome aggregation and visible correction versions. `apps/api/src/domain/reference-plan.ts` hydrates the canonical API plan using trusted contract references and retains metadata version IDs. It never accepts a client-selected strike/multiplier as reference data.

## Worked coverage

| Family | Expected evidence |
| --- | --- |
| Stock long / short | 10 shares 100 to 105 / 95, total supplied costs 2: gross 50, net 48; short borrow coverage explicit |
| Long call | 2 contracts 1.50 to 2.00, multiplier 100: gross 100, initial risk 300; unlimited theoretical upside labeled |
| Long put | Strike 100, premium 2: risk 200, maximum expiry profit 9,800 before costs |
| Bull call debit | 100/105 strikes, debit 1.50: maximum loss 150, profit 350 before costs |
| Bear put debit | 105/100 strikes, debit 1.25: maximum loss 125, profit 375 before costs |
| Bull put / bear call credit | Width 5, credit 1.20: maximum profit 120, loss 380 before costs |
| Futures | ES/MES/NQ/MNQ multipliers 50/5/20/2 and tick 0.25; long/short signs and invalid tick rejection |
| Partial exits / rounding | Exact quantity and cash-flow conservation across partitions; one position outcome; half-away display rounding, tiny signed remainders retained |
| Costs / exclusions | Null fees produce null net and incomplete coverage; breakeven distinct; retrospective, unresolved, canceled/never-entered excluded appropriately |
| Expiry / corrections | Expiry changes an open state to unresolved without inventing a fill; reviewed resolution remains explicit; corrected metadata/history retains source and frozen initial risk |
| Duplicate commands | Same hash/key replays; changed hash conflicts; real concurrency and rollback are separately tested in PostgreSQL |

Plan validation supports exactly the six defined option structures and actual futures roots. It rejects wrong-side or unequal legs, wrong option type/underlying/expiry, adjusted or non-100 options, unsupported roots, invalid ticks/quantities/UTC timestamps and nonsensical spread prices. Publishing checks contract expiry; historical accounting deliberately accepts an expired frozen snapshot.

Lifecycle events require member-claimed time and a distinct server received time. Fill events need quantity/price and explicit null/value costs; terminal explanations/reviews need a reason. Partial exits must leave a residual quantity, at most three partials are allowed, final exits close the balance, and scale-ins are rejected. Up to 60 seconds of claimed/server clock skew is tolerated; forward-report eligibility still records chronology and the five-minute reporting window. No timestamp implies broker verification.

Public performance aggregation has explicit counts, cost coverage and exclusions; it cannot combine multiple asset/strategy groups into a dollar leaderboard. Every displayed statistic remains member-reported. P08 implements UI presentation and public publishing; licensed catalog/quote behavior is P05.

Run `pnpm test` for pure tests; real database cases explicitly skip without `TEST_DATABASE_URL`. Use the Docker check command in the [README](../../README.md), or `pnpm test:migrations` for an isolated freshly migrated database with seed and the full suite. See [P02 evidence](../implementation/evidence/P02.md).

P08 regression cases additionally verify planned entry 100/stop 95, actual fill 90 and exit 105 produces 15 realized / 5 frozen risk / 3R, and a four-unit plan with actual entry 101, two partial units exiting 105 plus six reported remaining-unit net produces ten combined cash / twenty frozen risk / 0.5R. Composer estimates verify 150 cash risk and 350 maximum profit for a five-wide call debit spread; server hydration remains authoritative.
