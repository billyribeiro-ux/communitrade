# Design system and interaction specification

Status: engineering-selected visual baseline for the first implementation. It replaces the rejected sketch; it is not represented as founder-approved visual artwork. Engineers can build from these explicit defaults and present actual browser evidence for review.

## Visual direction

A restrained financial-research workspace: neutral surfaces, strong typography, dense but readable data, clear attribution, minimal decoration. No cartoon illustrations, neon gradients, fake terminal clutter, glass effects, gamified profits, or trophy-based credibility. Use the same identity across marketing, checkout entry, application, and staff tools.

System font stack: -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif. Numeric columns use tabular numerals. No separately downloaded/bundled font files in Phase 1. Body 16px marketing / 14px workspace; metadata 12–13px; headings 48/36/28/22/18px scaled for narrow widths. Line height 1.5 body / 1.15 large headings. Respect browser zoom and user font scaling.

## CSS tokens

| Token | Dark default | Light |
| --- | --- | --- |
| --surface-page | #0B0D10 | #F5F6F8 |
| --surface-card | #12161C | #FFFFFF |
| --surface-raised | #1B222C | #E8EDF3 |
| --text-primary | #F3F5F7 | #111827 |
| --text-secondary | #A8B3C2 | #526070 |
| --border-subtle | #334155 | #CBD5E1 |
| --accent | #8AB4FF | #174CD3 |
| --on-accent | #0B0D10 | #FFFFFF |
| --positive | #6ED6A4 | #166534 |
| --negative | #FF9E9E | #991B1B |
| --warning | #F5C96A | #854D0E |
| --focus-ring | #B8D1FF | #174CD3 |

Use positive/negative colors with labels and symbols; never encode position direction or result only by color. Chart candlesticks combine color and body/border styling. Validate actual text/button/focus contrast in both themes; decorative borders do not qualify as text contrast. Do not put secondary light-theme text on the raised surface without checking contrast.

Spacing: 4, 8, 12, 16, 24, 32, 48, 64px. Radius: 6px controls, 10px cards, 14px dialogs; circular avatars. Border 1px; use restrained elevation. Desktop input/button height 40px; mobile touch targets >=44px. Textareas show limits. Focus ring is visible with 2px offset and not clipped.

Author CSS in globals.css (reset/tokens/base typography) and component.module.css. Use native Grid/Flexbox, media/container queries, logical properties, reduced-motion preferences. No Tailwind/shadcn styling, Sass, or CSS-in-JS framework. Canvas chart rendering consumes CSS token values; rendering API options and SVG geometry are not a second UI styling system.

## Layout

Marketing max content width 1200px, readable prose 720px. Header logo/Features/How It Works/Pricing/FAQ/login/CTA; mobile menu supports focus management and Escape. Footer includes About/Contact/Support/policies/status. No sticky upsell that hides risk/disclosure text.

Workspace desktop: 224px navigation rail, flexible central content, optional 288px contextual sidebar when width >=1280px. Below 1024px collapse rail; below 768px use top app bar and accessible bottom/overflow navigation. Do not squeeze a desktop options leg table into an unreadable mobile strip; use stacked leg cards with the same fields.

Publishing desktop: chart and plan panels with a review step; mobile uses ordered panels and the agreed reduced drawing subset. Chart must have a real height (minimum 320px desktop, 260px mobile), loading skeleton, no-data/error/freshness overlay, keyboard-accessible toolbar, and textual trade levels.

## Shared components

| Component | Required variants and behavior |
| --- | --- |
| Button / link | Primary, secondary, text, destructive; busy prevents duplicate submit; explanation when unavailable |
| Form field | Label, help, required marker, error association, character count; retain invalid input |
| Dialog / menu | Focus entry/trap/restore where appropriate, Escape, outside dismissal for non-destructive actions; no inaccessible home-grown trap |
| Tabs / segmented filter | Correct roles, keyboard movement, visible selection; URL-backed public filters |
| Toast / banner | Nonblocking status; actionable persistent errors; no disclosure only in a timed toast |
| Avatar / author card | Initials/image, display name, handle, paid marker, timestamp, follow/menu |
| Trade card | Asset/instrument/contract, strategy, thesis excerpt, snapshot, lifecycle and evidence labels, author, comments/reaction/bookmark/share |
| Stat | Value, denominator, period, exclusion tooltip/text; no unexplained “verified” badge |
| Quota meter | Current use/limit, reset timezone, clear upgrade option; preserve existing records |
| Table | Header associations, sort state, empty/loading/error; mobile card alternative where needed |
| Confirmation | Summarize actual effect; confirm destructive delete/cancel actions, not routine saves |

Use reviewed unstyled accessibility primitives for complex menus/dialogs when needed; style them only with CSS Modules. The precise primitive package is resolved and pinned in P03 against the selected React version; behavioral criteria above are mandatory. This dependency choice cannot silently add a styling framework.

## Profile sharing and dashboard layouts

Author byline always has circular avatar, name/handle, publication timestamp, evidence label and account menu. Profile header includes editable bio/links, interests, follow controls and public stats. Show the difference between Pro membership, email verification, and performance evidence.

Share action is visible in feed cards and detail pages; its menu has distinct Copy link, external destinations, download image if licensed, and Repost internally actions. Native share is conditional on browser support. Show clipboard confirmation and a useful fallback if permission is denied.

Dashboard is personal workflow status, not a trading-signal recommendation engine: drafts, journal review/open/unresolved positions, recent followed activity, plan usage, and watchlist shortcuts. Every module has a first-use action and a data-failure state.

## Visual acceptance

Present marketing home/pricing, dashboard/feed, options composer, publication detail with replies/share, profile/avatar editor, journal, billing, and moderation views. Capture desktop 1440px, tablet 768px, and mobile 390px plus 320px overflow checks. Inspect both themes, long names/theses, missing avatars, empty data, error states, 200% zoom, keyboard focus and reduced motion.

Review is based on rendered pages; HTML sketches and token files alone do not pass. The founder can revise the visual baseline through a recorded design change while engineering acceptance remains traceable.

## P03 implementation record

The local implementation uses exact tokens and CSS Modules, Phosphor, native modal dialog focus behavior and native disclosure sharing; no third-party primitive/styling package was added. Shared form/segmented/status/stat/quota components are exported by `@trading/ui`. `/design-preview` provides local component fixtures. Every account/community/staff record is synthetic and explicitly local-only. Primary application views expose bounded `?state=loading|empty|error|denied` preview states; actual asynchronous account/data integration is later work. [P03 evidence](../implementation/evidence/P03.md) records automated token contrast, route and boundary checks. Real browser viewport/zoom/keyboard/visual acceptance remains blocked and is not implied by this implementation.
