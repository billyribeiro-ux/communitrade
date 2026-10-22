# P14 GitHub publication and release controls

October 22, 2026. REQ-025–028, REQ-030 and REQ-031. This supplements the historical [local release preparation](release-closure.md). The founder authorized direct Git publication and explicitly said to leave the repository public for now. That final instruction determines visibility.

## Published source and enforced controls

`git push -u origin main` published the complete 687-file candidate at `63710c210db70c96d2c9e5ab948df480df02316a` to [communitrade](https://github.com/billyribeiro-ux/communitrade). GitHub administration used the existing authenticated CLI; no plugin or tool installation was needed. Visibility remains public. Subsequent fixes and evidence use [PR #1](https://github.com/billyribeiro-ux/communitrade/pull/1), branch `release/github-setup`.

[Settings readback](../artifacts/github-setup/settings.json) records actual authenticated API responses:

- Main requires current `checks` and `handoff` results from the observed GitHub Actions app `15368`, one code-owner approval, dismissal of stale reviews, an approver other than the latest pusher and resolved review conversations. Administrators are included; force-push and deletion are disabled.
- Default workflow tokens are read-only and cannot approve PRs. Actions are limited to GitHub-owned actions with full commit-SHA pinning. Existing workflow action/runtime versions remain pinned.
- Dependabot alerts and security updates plus private vulnerability reporting were enabled. Secret scanning and push protection were already enabled and were verified. The observed alert summaries are empty; that does not prove complete initial ingestion or a complete security review.
- Squash merging is enabled; merge/rebase commits are disabled and merged branches are automatically deleted. CODEOWNERS parsing reports no errors.
- Only `billyribeiro-ux` currently has collaborator access. The independent reviewer handle/invitation and code-owner eligibility remain founder inputs. No review was fabricated, no collaborator invited and no main protection bypassed. An independent reviewer must be eligible under the protected branch’s actual code-owner rules; write access alone does not replace that rule. Reviewer onboarding must account for the current owner-only CODEOWNERS baseline before attempting the bootstrap merge.

The controls follow the verified [GitHub branch-protection API](https://docs.github.com/en/rest/branches/branch-protection) and [repository security settings](https://docs.github.com/en/repositories/managing-your-repositorys-settings-and-features/enabling-features-for-your-repository/managing-security-and-analysis-settings-for-your-repository). They enforce repository workflows, not application launch approval or a staffed security service. No independent code/OS vulnerability assessment or CodeQL configuration is claimed.

## Actual CI execution

The initial [application run](https://github.com/billyribeiro-ux/communitrade/actions/runs/39820813659) and [documentation run](https://github.com/billyribeiro-ux/communitrade/actions/runs/39820813526) failed before application checks because setup-node automatically attempted pnpm caching before pnpm activation. PR #1 disables implicit package-manager caching; it preserves Node 24.22.0, pnpm 12.14.0 and every dependency pin.

The next [documentation run](https://github.com/billyribeiro-ux/communitrade/actions/runs/39821028454) passed. The [application run](https://github.com/billyribeiro-ux/communitrade/actions/runs/39821028490) then passed install/lint and the production advisory audit but failed because ripgrep was absent on the hosted runner. Source enumeration now uses Git’s NUL-delimited tracked and untracked nonignored file list. Existing explicit private/build/test path exclusions remain in effect. This removes an unnecessary runner tool dependency without installing or updating a runtime. Local source review still covers 380 files with three explicitly reviewed synthetic/template matches and no unreviewed secret-pattern findings.

The [next application run](https://github.com/billyribeiro-ux/communitrade/actions/runs/39821265720) exercised all 372 tests: 355 passed, sixteen failed and one skipped. Failures were missing CI-only local cleanup mode/authentication settings. The workflow now scopes local mode and synthetic auth configuration to the test step, generates fresh ephemeral test keys without committing values, and provisions the existing exact-pinned Mailpit image on the hosted runner. Only that disposable runner receives a `mailpit` loopback host mapping; no Mac toolchain/global setting is changed. Synthetic SMTP is captured by Mailpit, enabling the previously skipped delivery test. Production build settings/guards are unaffected.

Final PR CI results will be appended after execution. Any later documentation-only commit receives its own checks; a previous run does not establish a later revision passed.

## Release decision and remaining work

G02 has actual publication, enforced controls and CI execution evidence. It remains open until independent review governance and all required checks pass. [The gate register](../p14-release-status.json) stays **NO_GO** for public paid launch. Public source publication is distinct from deploying the product.

The [founder checklist](../../handoff/release-closure.md) still requires legal operator/brand/domain, independent reviewer, licensed data rights, counsel/IP approval, provider account access and budget, processor acceptance, sender/support ownership, permitted browser/assistive-technology review, managed recovery and genuine beta evidence. Existing local recovery/load/license work remains useful evidence; it cannot supply those external approvals. No product deployment, service purchase, live charge or outside recipient message occurred.
