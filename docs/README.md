# Phase 1 engineering handoff index

Version 2.1, October 22, 2026. This package is the repository implementation handoff for the **entire** business platform. It covers public marketing/subscription, public research/community, private member workflows, administration, integrations and operation. Software implementation and external approvals are tracked separately in milestone evidence and release gates.

## Reading order and authority

User instructions -> [root AGENTS](../AGENTS.md) -> [MVP baseline](mvp-specification.md) plus [detailed requirements](product/requirements.md) -> route/design/contracts/ADRs -> assigned prompt and acceptance evidence. Companion specifications fill detail previously absent from the single MVP file. Approved scope/technology constraints cannot be overridden by a convenient implementation example.

| Area | Document |
| --- | --- |
| Readiness and start point | [Engineering readiness](handoff/phase-1-readiness.md) |
| Documentation integrity evidence | [Validation record](handoff/validation-record.md) |
| Requirements and limits | [Product requirements](product/requirements.md), [MVP baseline](mvp-specification.md) |
| Every public/member/staff route | [Routes and journeys](product/routes-and-journeys.md) |
| Marketing, FAQ and policy implementation | [Content specification](product/marketing-and-policy-content.md) |
| CSS-only visual baseline | [Design system](design/design-system.md) |
| Architecture and boundaries | [System design](architecture/system-design.md) |
| Persistence and financial invariants | [Data model](architecture/data-model.md) |
| Identity/profile/media execution | [P04 evidence](implementation/evidence/P04.md), [ADR 0015](adr/0015-identity-profile-media.md) |
| Instrument/provider/capability execution | [P05 evidence](implementation/evidence/P05.md), [ADR 0016](adr/0016-market-data-reference-capabilities.md) |
| Implemented schema and fixture evidence | [Persistence schema](architecture/persistence-schema.md), [calculation fixtures](architecture/calculation-fixtures.md), [P02 evidence](implementation/evidence/P02.md) |
| API semantics and endpoint catalog | [API contract](architecture/api-contract.md) |
| Machine contracts | [OpenAPI](../contracts/openapi.json), [chart state](../contracts/chart-state.schema.json) |
| Chart rendering execution | [P06 evidence](implementation/evidence/P06.md), [ADR 0017](adr/0017-chart-rendering-lifecycle.md) |
| Semantic drawings and private chart drafts | [P07 evidence](implementation/evidence/P07.md), [ADR 0018](adr/0018-semantic-chart-drafts.md), [Chart engine](architecture/chart-engine.md) |
| Publication composer, trusted evidence and reporting | [P08 evidence](implementation/evidence/P08.md), [ADR 0019](adr/0019-publication-snapshots-reported-lifecycle.md) |
| Private journal, analytics, watchlists, layouts and exports | [P10 evidence](implementation/evidence/P10.md), [ADR 0021](adr/0021-private-workspace-and-export-jobs.md) |
| Community distribution and sharing | [P09 evidence](implementation/evidence/P09.md), [ADR 0020](adr/0020-community-distribution-and-source-visibility.md) |
| Chart/export implementation contract | [Chart engine](architecture/chart-engine.md) and MVP chart contract |
| Notifications, durable email and consented measurement | [P11 evidence](implementation/evidence/P11.md), [ADR 0022](adr/0022-notifications-delivery-and-consent.md) |
| Billing lifecycle, provider truth and entitlements | [P12 evidence](implementation/evidence/P12.md), [ADR 0023](adr/0023-billing-provider-truth-and-recovery.md) |
| Integration and release decision | [P14 evidence](implementation/evidence/P14.md), [acceptance matrix](quality/p14-acceptance-matrix.md), [release gates](implementation/p14-release-status.json), [ADR 0025](adr/0025-production-boundaries-and-release-evidence.md) |
| Staff, support and privacy execution | [P13 evidence](implementation/evidence/P13.md), [ADR 0024](adr/0024-staff-support-privacy-control.md) |
| Identity/jobs/storage/email/data/billing | [Integrations](architecture/integrations.md) |
| Accepted and engineering-selected decisions | [ADR index](adr/README.md) |
| Implementation order | [Execution plan](implementation/execution-plan.md), [traceability manifest](implementation/requirements.json) |
| Ready-to-assign Codex prompts | [P01 Foundation](prompts/P01-foundation.md), then P02–P14 through execution plan |
| Acceptance and evidence | [Acceptance plan](quality/acceptance.md) |
| Security/privacy/retention | [Security contract](quality/security-and-privacy.md) |
| Development/deployment/recovery/incidents | [Runbooks](operations/runbooks.md) |
| Long-term support and later roadmap | [Maintenance](operations/maintenance-and-roadmap.md) |
| Release closure and founder inputs | [Exact checklist](handoff/release-closure.md), [follow-up evidence](implementation/evidence/release-closure.md) |
| External approvals/credentials | [Dependency and release gates](handoff/dependencies-and-release-gates.md) |
| GitHub settings and delivery | [Repository governance](governance/repository-settings.md) |
| Change history and licensing | [Changelog](../CHANGELOG.md), [license](../LICENSE), [notices](../THIRD_PARTY_NOTICES.md) |

## What agents receive

32 requirement records with acceptance mappings; complete route/journey inventory; a concrete CSS/token/component baseline; database invariants and calculation fixtures; typed OpenAPI/chart contracts; 25 ADRs; 14 ordered implementation prompts; security/operations/release procedures; GitHub issue/PR/CI templates and repository policies. P01–P14 have local implementation evidence. Rendered browser acceptance remains tracked separately from automated checks. P05 adds the reference catalog, scoped data capabilities and provider boundary; commercial supplier conformance remains gated. P06 adds chart rendering and normalized history; P07 adds private chart drafts and semantic drawings; P08 adds the composer, trusted publication capture, reported lifecycle, corrections and performance; P09 adds community feeds/discussion/social actions/sharing and source-aware discovery; P10 adds the private journal/positions, Free/Pro analytics, authenticated CSV jobs, watchlists and chart layouts; P11 adds notifications, digest delivery, saved public searches, staff-safe jobs and consented measurement; P12 adds billing checkout/portal, provider-truth lifecycle and scoped entitlements; P13 adds assigned moderation, operational support and recoverable privacy workflows; P14 adds production boundaries, immutable private R2 objects, sender suppression, production image/role artifacts, local recovery/load evidence and an explicit NO_GO release decision pending external/manual gates.

## What agents must not infer

An engineering baseline is not a founder-approved visual mockup, signed supplier agreement, legal clearance, payment underwriting, purchased hosting account, or passing application test. [Gates](handoff/dependencies-and-release-gates.md) identify the actual owner/evidence. Local fixture-backed development can begin at P01 while those inputs are pursued.

Validate package integrity with `node scripts/verify-handoff.mjs`. It checks documentation/contract/traceability consistency; actual application checks are introduced and run during implementation.
