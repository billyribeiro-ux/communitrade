# ADR 0026: Solo-maintainer governance

Date: October 22, 2026. Status: explicitly approved by the founder in chat. Scope: P14, REQ-025–028, REQ-030 and REQ-031; repository governance G02.

## Context and authority

The founder confirmed they are the sole maintainer and explicitly instructed: apply the solo-maintainer policy, run a separate code review, fix findings and merge PR #1 once all checks pass, keeping all automated security protections. This supersedes the development-merge independent-review prerequisite in earlier governance documents. A second maintainer or an independent human review is not invented.

## Decision

Keep protected PRs with zero required approving reviews. Disable mandatory code-owner review and approval by someone other than the latest pusher. Preserve stale-review dismissal, strict current `checks`/`handoff` results bound to GitHub Actions, conversation resolution, administrator enforcement, force-push/deletion protection, and the active CodeQL rule without bypass actors. CODEOWNERS continues to identify the actual owner. Preserve read-only default Actions tokens, SHA-pinned GitHub-owned actions, Dependabot, secret scanning/push protection and private vulnerability reporting.

Use a separate read-only automated review of the complete PR, record actual findings, address actionable defects, and review fixes again. Require current hosted checks on the final head. Squash-merge via the normal protected PR path, binding the operation to the expected reviewed SHA; verify main checks and scan results after merge. No admin bypass, direct main push, fabricated approval or alert dismissal is authorized by this decision.

## Limits and revisit

Automated review cannot provide independent human assurance and may miss defects. The founder owns the decision to proceed. Repository merge authorization does not grant production deployment, billing/data/legal acceptance or waive the independent operational evidence required by other gates. Keep the release decision NO_GO while applicable gates remain open.

Restore required human approval, code-owner review and approval of the latest push by someone else when another trusted maintainer joins. Compare actual settings with the desired policy after changes and retain redacted evidence. [Execution evidence](../implementation/evidence/solo-maintainer.md).
