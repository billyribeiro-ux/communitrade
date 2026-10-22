# P14 solo-maintainer review and merge

October 22, 2026. REQ-025–028, REQ-030 and REQ-031; G02. The sole maintainer explicitly authorized applying solo governance, running a separate code review, fixing actionable findings and merging PR #1 only after all checks pass. [ADR 0026](../../adr/0026-solo-maintainer-governance.md) records this material policy decision.

## Enforced settings

[Before](../artifacts/solo-maintainer/before.json) and [after](../artifacts/solo-maintainer/after.json) authenticated API readbacks were compared programmatically. Only three fields differ: required approvals 1→0, required code-owner review true→false and approval by someone other than the latest pusher true→false. Every other observed branch-protection field is identical. The CodeQL ruleset, Actions permissions/allowlist, CodeQL setup, private reporting and Dependabot security updates are unchanged. Secret scanning/push protection remain enabled and the repository remains public. No bypass actor was added.

The required-PR review object remains enabled with count zero; required checks, strict current-base validation, administrator enforcement, resolved conversations, and no force-push/deletion remain. CODEOWNERS remains ownership metadata. Historical evidence describing the superseded independent-human requirement is retained with this newer authority.

## Separate review and final validation

Review execution, findings, fixes and actual final checks are recorded here as they complete. Pending work is not represented as passed. The merge will use the normal protected PR path and an expected head revision; product launch remains NO_GO under the remaining gates.
