# ADR 0010 Commercial ownership and dependency licensing

Date: October 19, 2026
Status: Conservative engineering baseline

## Context

The user requested repository licensing for a commercial business but did not grant an open-source license or identify a legal entity.

## Decision

Use a proprietary rights-reservation notice; do not choose MIT/Apache for project code. Preserve third-party licenses/NOTICE, data rights and trademark rules. Record actual owner/IP assignments before distribution.

## Consequences

GitHub templates and a LICENSE are not legal clearance or a third-party license inventory. Review actual lockfile/container distribution before release.

## Alternatives and revisit trigger

Use [system architecture](../architecture/system-design.md), [integration contracts](../architecture/integrations.md), and [requirements](../product/requirements.md) for the detailed boundary. Revisit if supported versions, measured performance, legal/supplier terms, founder scope or release evidence invalidate the decision. Preserve the original decision and document the replacement rather than silently changing the stack.
