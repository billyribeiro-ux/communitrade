# P04 Identity authorization profiles avatars and media pipeline

Use this as a complete milestone assignment inside the repository. Implement the assigned work; do not expand into deferred phases.

## Authority and prerequisites

Read [AGENTS.md](../../AGENTS.md), [documentation index](../README.md), [MVP baseline](../mvp-specification.md), [requirements](../product/requirements.md), and [execution plan](../implementation/execution-plan.md). User instructions take precedence.

Prerequisites: P02, P03 with recorded evidence.
Requirement IDs: REQ-002, REQ-003, REQ-004, REQ-024, REQ-027.

Required detail:
- [docs/quality/security-and-privacy.md](../quality/security-and-privacy.md)
- [docs/architecture/integrations.md](../architecture/integrations.md)
- [docs/architecture/api-contract.md](../architecture/api-contract.md)

## Work

1. Configure local Keycloak realm, registration/verification/recovery/MFA and same-issuer browser/container routing. Implement OIDC code+PKCE/state/nonce, server validation, opaque sessions, CSRF, revocation and backchannel logout.
2. Implement onboarding, safe return/plan intent, account/security/preferences routes, recent admin step-up, session list/logout-all and suspended/unverified behavior.
3. Implement profiles, handle history/reserved names, bio/links and avatar upload/crop/remove with a real processing worker.
4. Implement owner-bound upload intent, local raw-byte transport, completion, re-encode/metadata removal, processed-media access and filesystem StoragePort. Never expose quarantine.
5. Wire account/avatar/bio UI and author cards to real APIs. Keep passwords and provider tokens out of app storage/browser bundles.

## Acceptance and evidence

- AC-002/003/004/024/027 with two owners, moderator and admin; invalid state/nonce/issuer/logout token, expired session, CSRF and cross-owner IDs.
- Avatar MIME/size/pixel bounds, rejected image recovery, crop/reset, duplicate handle, stale profile revision and public email/private-media leakage.

Use the relevant AC identifiers in [acceptance](../quality/acceptance.md). Record actual commands/outcomes, browser evidence where applicable, migrations/contracts changed, unresolved failures and external dependencies in docs/implementation/evidence/P04.md. Do not claim a test or supplier approval passed without evidence.

## Completion

Working local identity, private authorization and complete public profile/media journeys with security evidence.

Update CHANGELOG.md, affected specs/contracts/notices and milestone evidence. Preserve unrelated work and report the final result, checks actually run, unresolved gaps and next milestone. Stop at this milestone's boundary. Routine decisions already covered by the handoff are executable defaults; missing commercial approvals are tracked gates, not permission to silently omit behavior.
