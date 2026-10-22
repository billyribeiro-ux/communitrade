# GitHub repository governance

October 22, 2026: the founder explicitly authorized Git publication and instructed that the repository stay public for now. Candidate `63710c210db70c96d2c9e5ab948df480df02316a` was pushed with `git push -u origin main` to [communitrade](https://github.com/billyribeiro-ux/communitrade). Remote controls were applied and read back. See [GitHub execution evidence](../implementation/evidence/github-setup.md); the founder subsequently authorized the [solo-maintainer policy](../adr/0026-solo-maintainer-governance.md).

## Enforced configuration

The repository remains public under the founder's latest instruction; default branch is `main`. Squash merging is enabled, merge/rebase commits are disabled and merged branches are automatically deleted. `@billyribeiro-ux` is the only current collaborator and code owner. Under the founder-approved solo-maintainer policy, PRs remain required with zero required approvals; mandatory code-owner review and approval by someone other than the latest pusher are disabled. CODEOWNERS retains ownership routing. No self-approval or automated review is represented as independent human assurance.

Applied branch protection on main: required PRs, passing required checks, resolved conversations and no force-push/deletion. Solo changes receive a separate read-only automated review with actionable findings resolved; the owner remains accountable for the merge. The actual workflow checks are now observed. Prepared API settings are in [.github/branch-protection.json](../../.github/branch-protection.json). Required job contexts are `checks` and `handoff`, bound to observed GitHub Actions app ID `15368`; strict up-to-date checks are enabled. These controls apply to administrators too. The first push preceded protection because the remote was empty; subsequent changes use [PR #1](https://github.com/billyribeiro-ux/communitrade/pull/1).

Private vulnerability reporting, Dependabot alerts/security updates, secret scanning and push protection are enabled. Native CodeQL default setup is enabled for Actions, JavaScript/TypeScript, Python and Java/Kotlin with weekly and supported change-triggered scanning. The additional [main security ruleset](../../.github/code-scanning-ruleset.json), applied and read back as ruleset `25659929`, requires CodeQL results and blocks high/critical security alerts and error-level findings, with no bypass actors. The hardened PR analysis has zero findings in all four languages; main baseline findings are resolved only by merging the fixes and scanning main. Actions are limited to GitHub-owned actions with full SHA pinning; default workflow tokens are read-only and cannot approve PRs. Actual monitored security contact coverage is still G07. Restrict collaborator access by role; require account MFA where organization settings permit. No production secrets in repository variables visible to untrusted PRs.

## Existing files

Root AGENTS/README/CONTRIBUTING/SECURITY/CODE_OF_CONDUCT/SUPPORT/CHANGELOG/LICENSE/THIRD_PARTY_NOTICES; issue and PR templates; documentation integrity workflow with SHA-pinned actions. Application CI now performs lint/types/tests/builds, contract/migration checks, dependency advisory/source review, release helper tests and production-image builds. Remote Actions and settings were exercised; initial CI failed during implicit pnpm cache setup. PR #1 disables that implicit cache before pnpm activation. See the dated evidence for actual run conclusions; repository security settings are not a security certification or staffed monitoring service.

## Commit and review policy

Small reviewable commits reference milestone/requirement IDs. PR describes final behavior and actual validation, not a chronological chat log. Run meaningful checks appropriate to the change. Update contracts/docs/notices/changelog in the same PR when behavior changes.

CODEOWNERS must cover root policies, architecture/security, domain calculations, API/contracts, DB migrations and deployments with real account names. Use the requirement/AC IDs to route specialist review rather than treating every screenshot as proof of correctness.

## Releases

Use versioned app releases after implementation; do not tag the documentation handoff as a shipped app. Attach build revision, migration/backfill notes, rollback plan, acceptance evidence, dependency/license inventory and external-gate record. Production deployment and service purchases follow the actual authorized task.

## Solo-maintainer merge procedure

The founder explicitly authorized the policy and merging PR #1 after review and checks. [ADR 0026](../adr/0026-solo-maintainer-governance.md) supersedes the earlier team-only approval prerequisite. Run a separate read-only code review of the complete PR diff; fix supported findings and review affected changes again. Keep the review record and exact revisions. Changes to code or workflows require the relevant tests and new hosted checks; docs-only follow-ups still receive the configured checks.

Before merging, verify that the current head is the reviewed head or differs only by examined evidence updates; require all current CI/CodeQL checks, no unresolved review conversations and an up-to-date base. Squash-merge through the normal protected PR path with the expected head SHA. Never use an administrator override, direct main push, status spoofing, security-alert dismissal or scanner exclusions to obtain a green merge. Verify main CI and CodeQL after merge; correct regressions through another protected PR. Automated review may miss defects. Actual production acceptance and any separate legal/operational review requirements remain in force.

When another trusted maintainer joins, restore one required independent approval, mandatory code-owner review and approval of the latest push by someone else. Assign real eligible code owners first.
