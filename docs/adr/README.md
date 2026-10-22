# Architecture decision records

Accepted by founder means the conversation explicitly approved the decision. Engineering-selected baseline means a concrete reversible implementation default supplied for this handoff; it is not a signed vendor purchase, approved legal conclusion, or retroactive visual approval.

| ADR | Decision | Status |
| --- | --- | --- |
| [0001](0001-phase-1-scope.md) | Complete Phase 1 product scope | Accepted product direction |
| [0002](0002-frontend-css-icons.md) | Frontend and CSS-only design | Accepted by founder |
| [0003](0003-backend-records.md) | NestJS PostgreSQL and Prisma | Accepted by founder |
| [0004](0004-charts-drawings.md) | Lightweight Charts and owned drawing editor | Accepted product requirement; engineering implementation selected |
| [0005](0005-evidence-reputation.md) | Reported outcomes and honest reputation | Baseline decision replacing original brainstorming ranking |
| [0006](0006-billing-entitlements.md) | Single Pro subscription and server entitlements | Product price baseline; engineering provider target |
| [0007](0007-oidc-sessions.md) | OIDC identity and opaque app sessions | Engineering-selected baseline |
| [0008](0008-jobs-objects-email.md) | Durable jobs storage and email | Engineering-selected baseline |
| [0009](0009-hosting-local-production.md) | Docker local and Vercel frontend hosting | Founder-approved core; engineering production reference |
| [0010](0010-licensing-governance.md) | Commercial ownership and dependency licensing | Conservative engineering baseline |
| [0011](0011-design-baseline.md) | Explicit visual and workflow defaults | Engineering-selected implementation baseline |
| [0012](0012-foundation-toolchain.md) | Foundation compiler and package compatibility | Engineering-selected baseline; local P01 builds/runtime verified |
| [0013](0013-domain-persistence-contracts.md) | Domain arithmetic, persistence and generated API contracts | Engineering implementation; local P02 verification |
| [0014](0014-preview-shell-contact-intent.md) | Local preview boundaries, contact intake and plan intent | Engineering implementation; P03 automated evidence |

| [0015](0015-identity-profile-media.md) | Local OIDC, private sessions, public profiles and worker media | Engineering implementation; P04 evidence |
| [0016](0016-market-data-reference-capabilities.md) | Reference catalog, provider boundary and separate data-use rights | Engineering implementation; P05 evidence recorded separately |
| [0017](0017-chart-rendering-lifecycle.md) | Client chart lifecycle, session-aware history and text alternatives | Engineering implementation; P06 evidence recorded separately |
| [0018](0018-semantic-chart-drafts.md) | Semantic chart state, private drafts and linked plan prices | Engineering implementation; P07 evidence recorded separately |

| [0019](0019-publication-snapshots-reported-lifecycle.md) | Frozen publication jobs, reported lifecycle and visible corrections | Engineering implementation; P08 evidence recorded separately |
| [0020](0020-community-distribution-and-source-visibility.md) | Community distribution, attributed sharing and current source visibility | Engineering implementation; P09 evidence recorded separately |

Amend an ADR when evidence changes the decision; do not silently rewrite accepted constraints. Preserve superseded decisions with a link to their replacement and summarize actual implementation changes in CHANGELOG.md. Initial decisions are dated October 19, 2026; subsequent records carry their execution dates.

Use [template](template.md) for subsequent decisions. Scope/cost changes follow the product change process; routine implementation choices already covered by requirements do not require repeated founder confirmation.

- [0021 Private workspace quotas and export jobs](0021-private-workspace-and-export-jobs.md) — owner isolation, preserved downgrade access, exact allowances and authenticated CSV lifecycle.

- [0022 Notifications delivery and consent](0022-notifications-delivery-and-consent.md) — durable fanout, bounded SMTP uncertainty, local-date digest and private first-party measurement.

- [0023 Billing provider truth and recovery](0023-billing-provider-truth-and-recovery.md)

- [0024 Staff, support and privacy control](0024-staff-support-privacy-control.md)

- [0025 Production boundaries and release evidence](0025-production-boundaries-and-release-evidence.md)
