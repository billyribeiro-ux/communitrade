# P14 release closure follow-up

October 22, 2026. REQ-025–028, REQ-030 and REQ-031; gates G01–G12. Founder requested closure of remaining gates and all feasible local work, then supplied `https://github.com/billyribeiro-ux/communitrade.git`. This record supplements the historical [P14 evidence](P14.md); it does not rewrite that earlier execution state.

## Work completed

Local Git was initialized on `main`; `origin` points to the supplied repository. `git ls-remote --heads origin` returned no heads and read-only GitHub metadata confirmed an empty, public repository. No push, repository visibility change, collaborator invitation, branch-protection mutation, deployment, purchase or external message occurred. [Repository observation](../artifacts/release-closure/repository.json).

The actual repository owner is configured in CODEOWNERS. [Protection settings](../../../.github/branch-protection.json) are prepared for `checks` and `handoff`, code-owner review, dismissal of stale reviews, a different approver for the latest push, resolved conversations, administrator enforcement and no force-push/deletion. These are local desired settings, not proof of GitHub enforcement. Founder must decide public versus private publication and supply an independent reviewer with write access. Official [branch-protection schema](https://docs.github.com/en/rest/branches/branch-protection) was checked.

Added a read-only production input preflight and an exact-artifact inventory collector. They do not provision resources, load application code, launch a browser, install/update tools, send email, upload images or expose environment values. Only public exact-version npm/Maven metadata is retrieved; no provider account credentials are used. All authored application styling remains CSS/CSS Modules; no UI/runtime dependency, data model, migration or API contract changed. Five existing source/test files received whitespace-only baseline cleanup for Git checks. Attributes preserve original upstream notice bytes, including CRLF. Phase 2 remains deferred.

## License inventory evidence

[Inventory JSON](../artifacts/release-closure/inventory.json) identifies exact image IDs, architectures, npm packages, OS packages, JAR hashes/coordinates, notice hashes and remaining review qualifiers. Four notice archives retain available upstream bytes. They are license evidence, not application backups or legal approvals.

- Workspace production closure: **196 external npm entries and five internal workspaces**. All external entries have license metadata. The old 37 missing entries comprised five internal links and 32 optional-platform artifacts absent on the Mac; exact registry metadata resolves the latter. Legacy `licenses` fields are now recognized. Internal packages remain subject to the proprietary project notice and unconfirmed business rights holder.
- API final image: **264 installed npm packages, 88 OS packages, 343 retained notice files**.
- Worker final image: **38 installed npm packages, 511 OS packages, 544 retained notice files**, including available browser/FFmpeg notices. No browser was launched. Browser/platform license obligations still require review.
- Identity final image: **44 RPM packages and 354 JARs, 220 retained notice files**. Published license metadata covers 343 JARs; the remaining eleven have embedded notices. Some coordinates are taken from Quarkus distribution filenames, clearly labeled for upstream-identity review; embedded Maven metadata is preferred. No JAR lacks both metadata and retained embedded notices. This is not a claim that every notice/obligation has been legally cleared.
- All archive SHA-256 values and retained per-file bytes/hashes were verified, with no absolute or parent-traversing paths. No collection path remains unresolved. Temporary inventory containers were removed.

Relevant upstream formats: [RPM headers](https://rpm-software-management.github.io/rpm/manual/format_header.html), [RPM export API](https://rpm.org/docs/6.0.x/api/group__header.html); primary npm/Maven metadata URLs and response hashes are recorded per component. Registry metadata for an optional uninstalled platform does not prove its bytes were inspected. Maven metadata does not replace a signed supplier agreement or counsel review. GPL/LGPL/EPL, bundled browser/codecs/database drivers, attribution and business/contributor rights remain G11 review items. Production target architectures and the final deployed frontend/runtime artifacts need their own matching inventories.

## Executed checks

| Check | Result |
| --- | --- |
| `pnpm release:inventory` | Passed collection of exact host/image artifacts and public metadata; produced inventory and notice archives. An initial RPM parser assumed file magic that rpmdb export omits; bounded support for both forms was added and exercised successfully. The SQL Server JDBC embedded version omits its published `.jre11` suffix; explicit distribution-filename metadata fallback is recorded. |
| `pnpm test:release` | Passed **seven tests**: three Node preflight tests and four Python inventory tests. Secret sentinel reflection, server-only scopes, local/insecure web refusal, RPM formats/bounds/missing identity and exact safe notice bytes/hashes are covered. |
| API preflight against ignored `.env.local` | Expected **exit 1 / incomplete**; required production key names and guard reason only, no secret values. [Observed result](../artifacts/release-closure/local-preflight.json). Local fixture configuration cannot appear production-ready. |
| Archive verification | All four archive checksums and every retained image notice digest/byte check passed; paths are safe relative archive labels. |
| Initial Git candidate checks | Passed staged whitespace check, byte-for-byte preservation of the two CRLF upstream licenses and comparison against actual private environment secret values (none present among 687 staged files; no values printed). |
| `git check-ignore` | Private `.env.local`, identity personas, generated Prisma and node_modules remain ignored; Python caches are also ignored. |
| `pnpm lint`, `pnpm check:contracts`, `pnpm check:docs`, `pnpm check:p14:source` | Passed: no lint warnings, 158 operations/146 schemas, links/traceability for 32 requirements/14 milestones/25 ADRs, 380 source files and three reviewed synthetic/template matches with no unreviewed secret pattern. Internal links and optional platforms are now reported separately. |
| `pnpm test:local`, `pnpm check:p14:release` | All nine local smoke checks passed; the report remains NO_GO with 12 open full gates. |

Application runtime behavior is unchanged from the P14 candidate that passed 372 tests, types/build and connected P04–P13; only baseline whitespace and documentation/audit helpers changed, so that historical suite was not needlessly repeated. CI now includes the seven helper tests; actual remote Actions have not run. No container vulnerability scanner or independent legal/security certification is claimed by this inventory.

## Remaining inputs and decisions

The [founder checklist](../../handoff/release-closure.md) names every required decision, account access scope, document and test input. Supplier and counsel briefs plus a blank real-beta worksheet are prepared locally and have not been sent. New helper commands and local artifacts close engineering preparation subtasks, not the complete commercial, manual or operational gates.

G02 now has a real remote and local repository/configuration, while publication choice, remote CI, enforced protections and an independent reviewer remain. G11 has concrete inventories/notices and resolved metadata gaps, while legal/license/IP and target-distribution review remain. G08/G12 still need permitted rendered browser/assistive-technology and visual/content approval. Actual provider credentials, account/contract approval, DNS, support coverage and managed recovery are required for G01/G03–G07/G09. G10 requires genuine community participation and elapsed beta observation.

**NO_GO** remains the correct public-release decision. Configuration presence, a local commit or a report cannot authorize a public source push, provider spending, deployment or paid charging.
