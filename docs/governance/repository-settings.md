# GitHub repository governance

October 22, 2026: local Git is initialized on `main` with the founder-supplied `https://github.com/billyribeiro-ux/communitrade.git` remote. Read-only inspection confirmed that repository is public and empty. Nothing has been pushed or changed remotely. Publication visibility/authorization and independent reviewers remain founder inputs; see [release closure](../handoff/release-closure.md).

## Repository setup when authorized

Create a private repository under the founder's intended account/organization. Record remote URL and primary branch. The supplied repository owner `@billyribeiro-ux` is configured locally in CODEOWNERS. Add actual independent engineering/security reviewers with write access before the applicable review. Do not invent GitHub identities.

Enable branch protection/rulesets on main: PR review, passing required checks, resolved conversations and no force-push/deletion; require independent review for financial calculations, authorization, migrations and release changes. Apply required status names after the relevant workflow exists. Prepared API settings are in [.github/branch-protection.json](../../.github/branch-protection.json). Required job contexts are `checks` and `handoff`; verify actual completed checks and bind their source app when configuring the remote. Templates alone enforce nothing.

Enable private vulnerability reporting and the monitored security contact before external beta. Restrict collaborator access by role; require account MFA where organization settings permit. No production secrets in repository variables visible to untrusted PRs.

## Existing files

Root AGENTS/README/CONTRIBUTING/SECURITY/CODE_OF_CONDUCT/SUPPORT/CHANGELOG/LICENSE/THIRD_PARTY_NOTICES; issue and PR templates; documentation integrity workflow with SHA-pinned actions. Application CI now performs lint/types/tests/builds, contract/migration checks, dependency advisory/source review, release helper tests and production-image builds. Remote Actions and security/dependency settings still need execution and readback; no updater or monitoring enforcement is claimed.

## Commit and review policy

Small reviewable commits reference milestone/requirement IDs. PR describes final behavior and actual validation, not a chronological chat log. Run meaningful checks appropriate to the change. Update contracts/docs/notices/changelog in the same PR when behavior changes.

CODEOWNERS must cover root policies, architecture/security, domain calculations, API/contracts, DB migrations and deployments with real account names. Use the requirement/AC IDs to route specialist review rather than treating every screenshot as proof of correctness.

## Releases

Use versioned app releases after implementation; do not tag the documentation handoff as a shipped app. Attach build revision, migration/backfill notes, rollback plan, acceptance evidence, dependency/license inventory and external-gate record. Production deployment and service purchases follow the actual authorized task.
