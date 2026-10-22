# P03 CSS design system complete marketing site and application shell

Use this as a complete milestone assignment inside the repository. Implement the assigned work; do not expand into deferred phases.

## Authority and prerequisites

Read [AGENTS.md](../../AGENTS.md), [documentation index](../README.md), [MVP baseline](../mvp-specification.md), [requirements](../product/requirements.md), and [execution plan](../implementation/execution-plan.md). User instructions take precedence.

Prerequisites: P01 with recorded evidence.
Requirement IDs: REQ-001, REQ-005, REQ-025, REQ-028.

Required detail:
- [docs/design/design-system.md](../design/design-system.md)
- [docs/product/routes-and-journeys.md](../product/routes-and-journeys.md)
- [docs/product/marketing-and-policy-content.md](../product/marketing-and-policy-content.md)

## Work

1. Implement exact dark/light tokens, system typography, CSS Modules, responsive layout and Phosphor conventions. Build accessible shared controls with reviewed unstyled primitives as needed and pin actual dependencies.
2. Build every marketing/policy/help route with factual copy, full pricing comparison, shared header/footer, login-aware CTA interfaces and draft-policy release protection.
3. Build Dashboard/Feed/Explore/Publish/Journal/Profile shell and all secondary/staff route layouts. Use explicit loading/empty/error/denied states; do not replace required routes with dead links.
4. Implement canonical/SSR/social metadata, sitemap/robots behavior and preview/private noindex boundaries.
5. Present real browser views for Home/Pricing, dashboard/feed, options composer layout, profile, publication, journal, billing and staff shell. Later milestones wire their real data; label demo fixtures.

## Acceptance and evidence

- Keyboard/focus/dialog/menu behavior, both themes/contrast, 320/390/768/1440px, 200% zoom, long names, missing avatar, reduced motion.
- Marketing factual claims, plan-intent preservation and SEO/private route metadata. Inspect actual browser output.

Use the relevant AC identifiers in [acceptance](../quality/acceptance.md). Record actual commands/outcomes, browser evidence where applicable, migrations/contracts changed, unresolved failures and external dependencies in docs/implementation/evidence/P03.md. Do not claim a test or supplier approval passed without evidence.

## Completion

Complete public marketing and consistent application shell, with component and visual evidence and clearly identified later integration seams.

Update CHANGELOG.md, affected specs/contracts/notices and milestone evidence. Preserve unrelated work and report the final result, checks actually run, unresolved gaps and next milestone. Stop at this milestone's boundary. Routine decisions already covered by the handoff are executable defaults; missing commercial approvals are tracked gates, not permission to silently omit behavior.
