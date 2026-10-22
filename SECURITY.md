# Security policy

No production release currently exists. Security requirements and release criteria are in [security and privacy](docs/quality/security-and-privacy.md).

Do not put credentials, personal data, exploit details, or real journal records in public issues. Use [GitHub private vulnerability reporting](https://github.com/billyribeiro-ux/communitrade/security/advisories/new), enabled October 22, 2026. A monitored security contact and response coverage still require a named owner before external beta; enabling this channel alone does not establish staffed monitoring.

Engineering lead owns triage, containment, patching, regression evidence, and incident records. Founder owns affected-user and supplier communications with appropriate advisers. The release gate requires a named on-call contact and response coverage; this document does not claim an unstaffed response SLA.

Before each release: review supported dependencies, session/ownership protections, uploads, public-cache boundaries, billing signatures and replay handling, restore evidence, and secrets scanning. A critical/high unresolved security or privacy defect blocks release.

Do not run destructive security experiments against production or third-party systems. Use authorized local/staging environments and synthetic accounts.
