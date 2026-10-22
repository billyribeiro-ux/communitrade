# Chart engineering handoff

The complete tool/render/save/export contract is in [MVP chart implementation](../mvp-specification.md). This companion fixes the wire model, module boundaries and acceptance seam.

P06 implements rendering on actual instrument reference pages: [evidence](../implementation/evidence/P06.md), [ADR 0017](../adr/0017-chart-rendering-lifecycle.md). P07 implements semantic drawings, private draft setup and accessible drawing controls: [evidence](../implementation/evidence/P07.md), [ADR 0018](../adr/0018-semantic-chart-drafts.md). ChartDataAdapter performs focused runtime wire validation and preserves source decimals; ChartHost owns the v5 canvas lifecycle; InstrumentChart owns bounded/cancelable history requests and accessible controls/text tables. Options resolve their stock underlying and futures retain the selected contract. Data rights remain server-enforced. P08 implements frozen candidates, trusted worker capture and immutable publication evidence; see [P08 evidence](../implementation/evidence/P08.md) and [ADR 0019](../adr/0019-publication-snapshots-reported-lifecycle.md).

## Modules

ChartHost owns the browser canvas lifecycle and v5.2.1 chart instance. ChartDataAdapter normalizes bars/quotes/session metadata. DrawingController owns tool/selection/pointer/keyboard state and undo transactions. DrawingStore owns versioned semantic objects. PrimitiveRenderer maps objects to chart coordinates and requests redraw. ChartPersistence owns draft revisions/conflicts and publication snapshots. ChartImageExporter renders the committed version with required notices.

UI controls are React + CSS Modules + Phosphor. Chart instances, DOM nodes and canvas objects never enter persisted JSON. Text editing can use an accessible HTML editor, but final chart annotation text must render into the chart canvas for export.

## Contract

Use [chart-state.schema.json](../../contracts/chart-state.schema.json), embedded by the [API contract](../../contracts/openapi.json). Runtime schema validation is required on server and client. Draft write requires If-Match with chart revision; return ETag on reads/writes. Publish requires the last acknowledged draft/chart revision and freezes both.

ChartState includes schemaVersion, instrumentId, metadataVersion, interval, timezone, session, adjustment, viewport, indicators, provenance and <=50 drawings. Each drawing has stable UUID/type, typed anchors, text/style, and optional planField. Price is a decimal string; time is an ISO UTC timestamp with anchor session context. Horizontal/entry/target/invalidation objects have one anchor; line/rectangle/arrow have two. An underlying-price anchor cannot refer to an option-premium field.

Input boundaries: text <=500 characters per object; line width 1–4; line style solid/dashed/dotted; opacity 0–1; allowlisted CSS hex colors; all numbers finite. No raw HTML, scriptable expressions, remote SVG, CSS expressions, or unbounded nested metadata.

## Tool semantics

Create horizontal/text with one location. Create trendline/arrow/rectangle with two anchor placements and cancelable preview. Select topmost visible object, prioritize handles, show keyboard-accessible object list with edit/delete alternatives. Complete one gesture as one undo unit; redo clears when a new edit branches history.

Entry/target/invalidation overlays link to frozen plan fields. Draft edits validate and update both representations; published originals are read-only. Duplicate/clone is not required. Canvas-only dragging is not the only way to enter meaningful prices: structured form fields remain accessible.

Timeframe/session switches preserve original semantic anchors and do not destructively snap them to a new candle. Future/closed-session anchors render only through documented coordinate/whitespace handling; do not create fabricated price candles to fill the screen. Tests cover weekends, overnight futures sessions and DST.

The private draft setup catalog requires an enabled instrument with member-display and retained-bar capabilities. New-publishing permission and freshness are reported separately; a private draft may use entitled retained history while new publishing is held. Local synthetic/demo fixture rows are visibly labeled and production API guards reject synthetic use. Options link to stock-underlying prices, and futures link to the chosen dated contract. Entry/target/invalidation drawings are linked to plan values and cannot become an independent source of truth.

## Data and export

Freeze original chart state plus licensed image/data representation. A later live-context view is explicitly separate. Template layout quota and public chart evidence are different records. shareImage must reference publicationVersionId and capability snapshot. Snapshot failure can delay publication completion rather than mark an image ready that does not exist.

Use takeScreenshot(true, false) and explicitly compose any HTML labels/attribution that are not on the canvas. Hide selection handles/crosshair/transient preview. Public snapshots are produced by a trusted worker browser rendering the server-frozen candidate through a signed, short-lived internal render route; do not trust an arbitrary client-uploaded image as proof it matches the saved chart. The worker loads only configured local application/data resources, never user-supplied remote URLs. Its browser/runtime lives in the pinned worker container, not a new global host installation. Do not export private notes, a draft behind a public ID, or a hidden source image.

## Acceptance and delivery

P06: rendering, adapters, intervals/sessions, cleanup, responsive behavior.
P07: semantic drawing state, interactions, serialization, undo/redo, accessible alternatives, private draft setup, revisions and autosave. See [P07 evidence](../implementation/evidence/P07.md).
P08: complete publication composer, publish lock/corrections, capture and immutable evidence.
P09: public share/repost surfaces and derivative access.
P14: licensed-data and cross-device/browser/load acceptance.

See AC-007, AC-008, AC-009, AC-010, AC-017 and AC-028 in [acceptance](../quality/acceptance.md). Automated geometry/serialization checks must be supplemented by real browser inspection; no implementation is represented as proven by this contract alone.

## P08 capture execution

The composer at `/app/drafts/{id}/compose` reviews saved chart/draft revisions before a 202 freeze. The worker uses the exact Playwright package/browser image, a one-time signed internal route and same-origin resource allowlist, then `takeScreenshot(true, false)` without transient selections. It validates PNG dimensions, composes required reporting/source/attribution notices, re-encodes WebP and submits an immutable version-key/checksum. No browser-supplied chart image or remote URL can satisfy this path. Token routes use no-store/no-referrer/noindex. Public original/current/correction pages request frozen images by authorized version; current history is separately labeled. Automated product browser capture is separate from interactive user-interface acceptance.
