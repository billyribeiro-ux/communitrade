# Ordered engineering execution plan

Each prompt is a bounded assignment containing inputs, deliverables, acceptance and stopping conditions. P01–P14 have local implementation/evidence records, including outstanding browser and external release gates. P12 implements billing and scoped entitlements; P13 implements staff/moderation/support/privacy workflows. P14 records a local candidate and NO_GO release decision; external/manual acceptance remains open. Completion requires actual evidence, not a file's existence.

| Milestone | Assignment | Dependencies | Primary result |
| --- | --- | --- | --- |
| P01 | [Reproducible workspace Docker and CI](../prompts/P01-foundation.md) | None | A reproducible local foundation and truthful setup/CI evidence; no unfinished screens represented as product completion. |
| P02 | [Domain model database contracts and calculation fixtures](../prompts/P02-domain-data-contracts.md) | P01 | Reviewable data schema, pure calculation package, typed contracts and real PostgreSQL invariant evidence. |
| P03 | [CSS design system complete marketing site and application shell](../prompts/P03-design-marketing-shell.md) | P01 | Complete public marketing and consistent application shell, with component and visual evidence and clearly identified later integration seams. |
| P04 | [Identity authorization profiles avatars and media pipeline](../prompts/P04-identity-profiles-media.md) | P02, P03 | Working local identity, private authorization and complete public profile/media journeys with security evidence. |
| P05 | [Stocks options futures reference data and provider adapters](../prompts/P05-instruments-data-adapters.md) | P02, P04 | Working reference catalog and fixture-backed adapter contracts, with external data rights status explicitly tracked. |
| P06 | [Lightweight Charts rendering data sessions and lifecycle](../prompts/P06-chart-rendering.md) | P03, P05 | Reliable rendered chart engine with source/session correctness and browser evidence, ready for drawing tools. |
| P07 | [Drawing tools interactions semantic anchors and autosave](../prompts/P07-drawing-editor.md) | P04, P06 | Complete drawing editor and saved-state behavior on real owned draft records. |
| P08 | [Composer publication snapshots lifecycle corrections and performance](../prompts/P08-publishing-lifecycle-evidence.md) | P02, P07 | End-to-end author -> public reader -> reported lifecycle -> transparent result, with frozen charts and correction evidence. |
| P09 | [Feeds search discussion social actions sharing and reposts](../prompts/P09-community-sharing.md) | P04, P08 | Complete public trading community and social distribution journeys with access and attribution evidence. |
| P10 | [Private journal analytics exports watchlists and saved layouts](../prompts/P10-journal-watchlists-layouts.md) | P08, P09 | Complete private research workspace with tested quotas and export/privacy boundaries. |
| P11 | [Notifications preferences durable delivery and product measurement](../prompts/P11-notifications-jobs-metrics.md) | P09, P10 | Reliable notification and background delivery workflows with observable failure/retry behavior. |
| P12 | [Free Pro checkout billing lifecycle and entitlements](../prompts/P12-billing-entitlements.md) | P04, P10, P11 | Complete subscription lifecycle in test mode and documented live acceptance gates. |
| P13 | [Staff tools moderation appeals support privacy and operational control](../prompts/P13-administration-support-privacy.md) | P08, P09, P11, P12 | Operationally usable administration and support/privacy workflows, not a decorative admin dashboard. |
| P14 | [Licensed integrations quality recovery and launch readiness](../prompts/P14-integration-release.md) | P03, P05, P06, P07, P08, P09, P10, P11, P12, P13 | An evidence-backed release candidate and explicit gate decision; no automatic deployment or purchase beyond the authorized task. |

## Order and collaboration

The safe default is one milestone at a time in listed order. Separate engineers can work on independent slices only after shared contracts and branch ownership are agreed; this document does not authorize simultaneous edits to the same interfaces. P03 can overlap P02 after P01; external supplier/legal/payment work starts immediately and continues alongside local engineering. Do not wait until P14 to investigate commercial feasibility.

P06–P08 are intentionally separate chart milestones: rendering, drawing/persistence, then publication/evidence/lifecycle. They must not be collapsed into “install a chart package.”

## Acceptance traceability

[requirements.json](requirements.json) maps every REQ to a primary milestone and AC. The [acceptance plan](../quality/acceptance.md) defines expected outcomes. API operations carry requirement IDs; chart schema and fixtures support deeper invariants.

For every milestone write evidence only when run. Required record: revision, implementation summary, actual checks, observed browser behavior, failures, requirement/AC coverage, migration/recovery effect, external gates, reviewer and next step. Unrun checks remain explicitly unrun.

## GitHub delivery

Use one PR per milestone or bounded subtask, with linked requirement/AC IDs and the PR template. Configure real GitHub reviewer handles/protected branches/status checks under G02. Documentation CI exists now; application CI becomes executable in P01. Do not create empty green build jobs.

## Budget and dates

The MVP staffing/timeline/costs are planning reference values. This handoff exposes previously under-described marketing/social/operations detail. Confirm workload against these prompts before setting a staffed schedule or committing expenditure; no unchanged-cost guarantee is implied.

## Definition of Phase 1 done

Every P0/P1 requirement and route works; all AC evidence and applicable gates pass; licensed data covers all launch asset classes; truthful reported-results labels and private isolation hold; Free/Pro/payment/support/moderation/recovery journeys pass; founder reviews the actual public/member/staff experience. Phase 2 remains deferred.

## Current local implementation boundary

P01–P14 have local implementation records. P10 covers the private journal, supported private trade lifecycle/corrections, Free/Pro analysis, watchlists, chart templates and CSV jobs; see [P10 evidence](evidence/P10.md) for actual checks and remaining browser gates. P11 notifications/preferences/durable delivery and consented measurement are recorded in [P11 evidence](evidence/P11.md); P12 billing is recorded in [P12 evidence](evidence/P12.md), P13 operational administration/support/privacy in [P13 evidence](evidence/P13.md); P14 production boundaries, recovery/load evidence and the release decision are in [P14 evidence](evidence/P14.md). Next work is gate remediation and the outstanding provider/manual acceptance; there is no additional authorized milestone or Phase 2 scope. No Phase 2 feature is implemented.
