# Phase 1 engineering readiness

The earlier assertion that one MVP file was a complete engineering handoff was inaccurate. The current handoff supplies the missing connected repository specifications, decisions, contracts, prompts and governance.

## Handoff completion criteria

- All product surfaces are specified, including marketing/checkout/member/public/staff, rather than only a member dashboard.
- Profiles/avatars/bios, external sharing/internal reposts, chart rendering/drawing/save/export, trade calculations, subscriptions, privacy and support have concrete behavior.
- Every requirement maps to acceptance and a primary milestone.
- APIs and chart-state payloads have machine-readable schemas; database invariants and cross-cutting failure/permission rules are explicit.
- Architecture decisions identify founder approvals versus engineering defaults.
- Agents have bounded prompts with inputs, prerequisites, deliverables, checks and stopping points.
- Repository contribution/security/conduct/support/changelog/licensing and GitHub templates exist.
- External dependencies are recorded without fake approval/credentials or blocking local fixtures.
- Documentation integrity checks pass with no unresolved internal link/reference/traceability failure.

## Current implementation state

P01–P14 have local implementation evidence. [P01](../implementation/evidence/P01.md) and [P02](../implementation/evidence/P02.md) cover foundation/domain; [P03](../implementation/evidence/P03.md) covers site/shell; [P04](../implementation/evidence/P04.md) covers real local identity/profile/media; [P05](../implementation/evidence/P05.md) covers catalog, options/futures selection, scoped data rights and tested provider protocols; [P06](../implementation/evidence/P06.md) covers chart rendering, normalized sessions, indicators, lifecycle and text alternatives. Rendered browser acceptance remains pending. [P07](../implementation/evidence/P07.md) adds owned chart drafts, drawing tools and autosave. [P08](../implementation/evidence/P08.md) adds the composer, trusted frozen snapshots, reported lifecycle, visible corrections and performance. [P09](../implementation/evidence/P09.md) adds feeds, full-text search, discussion, social actions, sharing and source-aware discovery. [P10](../implementation/evidence/P10.md) adds the private research workspace, quotas, chart layouts and authenticated raw/analytical exports. [P11](../implementation/evidence/P11.md) adds owner notifications, local-time digests, delivery operations and consented measurement. [P12](../implementation/evidence/P12.md) adds provider-scoped checkout/portal, billing lifecycle and entitlements. [P13](../implementation/evidence/P13.md) adds administration, assigned moderation, private support and privacy erasure. [P14](../implementation/evidence/P14.md) adds production boundaries, local recovery/load evidence and a NO_GO release report. Next work is external gate remediation and outstanding manual/provider acceptance in the [execution order](../implementation/execution-plan.md).

## Not a release certificate

P03–P14 have automated evidence with rendered visual and real provider acceptance pending. P14 is a local engineering candidate, not a public release certificate. Local tests do not establish a remote CI pass, approved branding, supplier contract, legal clearance, purchased account or public deployment. Actual beta/public readiness requires [acceptance evidence](../quality/acceptance.md) and the [release gates](dependencies-and-release-gates.md).

## Earlier gaps closed

| Earlier gap | Handoff location |
| --- | --- |
| Marketing/subscriber platform reduced to a generic landing page | Routes and marketing content |
| Avatar/bio/card details absent | REQ-004 and design system |
| Social/internal sharing unspecified | REQ-017 and API |
| Drawing list without complete integration contract | MVP chart contract, chart schema and chart engineering |
| Database/API left to interpretation | Data model, OpenAPI and API semantics |
| Queue/identity/storage/email undecided | Integration defaults and ADRs |
| No engineering prompt sequence or acceptance mapping | P01–P14 and requirement manifest |
| GitHub/governance/licensing absent | Root policies, .github templates/workflow and ADRs |
| “Latest” confused with proven compatibility | Exact baseline plus P01 build/integration gate |

The visual baseline and supporting providers are explicit engineering choices now, not claimed retroactive founder decisions. Actual visual output and production terms still receive the normal release review.
