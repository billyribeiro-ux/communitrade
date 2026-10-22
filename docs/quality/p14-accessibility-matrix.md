# P14 accessibility review matrix

This is a source review of representative application components. It is not an assistive-technology or rendered-browser result. No browser interaction, screen-reader run, viewport/zoom measurement, contrast measurement, performance profile, or WCAG conformance test was performed for this record.

## Source review

| Area | Source evidence | Static review | Required acceptance evidence |
| --- | --- | --- | --- |
| Page navigation and focus | `apps/web/src/app/layout.tsx`, `apps/web/src/components/AppShell.tsx`, `apps/web/src/components/AppShell.module.css` | Global skip link targets `#main-content`; workspace main is focusable; primary and mobile navigation have names/current-page state; global `:focus-visible` rule exists. | Keyboard from page start through header, sidebar/mobile navigation, dialogs and content; verify focus remains visible and route changes give useful focus context. |
| Forms and validation | `apps/web/src/app/(account)/AccountFlow.tsx`, `apps/web/src/app/(workspace)/workspace-ui/ComposerForm.tsx`, `apps/web/src/components/publications/Composer.tsx`, `apps/web/src/components/community/CommunityActions.tsx` | Representative fields use wrapping labels, fieldsets/legends or explicit `aria-label`; async failures generally use `role="alert"` or `role="status"`. | Complete sign-in, onboarding, compose, report and support flows with keyboard and screen reader; confirm required/error states are announced and point to the affected field. |
| Public feed and actions | `apps/web/src/components/community/CommunityFeed.tsx`, `apps/web/src/components/community/CommunityActions.tsx` | Search has a named search landmark; feed tabs expose current page; action toggles use `aria-pressed`; async action feedback has a live region. | Verify status announcements, menu/report-form focus order, and meaningful button names in a screen reader. |
| Chart reading alternative | `apps/web/src/components/charts/InstrumentChart.tsx`, `apps/web/src/components/charts/ChartHost.tsx` | Plot has a named keyboard-focusable group and arrow/plus/minus/Home help; refresh/zoom/pan controls have labels; exact OHLCV values are also available in a captioned table with scoped headers. | Verify chart navigation and table on keyboard and screen reader at desktop/mobile; test that available readout updates are understandable without relying on canvas. |
| Chart authoring | `apps/web/src/components/charts/DrawingTools.tsx`, `apps/web/src/components/charts/DrawingTools.module.css`, `apps/web/src/components/charts/drawing-interaction.ts` | Toolbar is a named group; tools expose pressed state; form fields are labeled; object count is live; error feedback is an alert; source includes mobile input alternatives. | Exercise every drawing action and cancellation by keyboard; verify selected-object and validation announcements; confirm the plotted result has a semantic alternative. |
| Dialogs and overlays | `apps/web/src/app/(account)/design-preview/Controls.tsx`, `packages/ui/src/components/Dialog.tsx`, `apps/web/src/components/AppShell.tsx` | Shared dialog uses native `showModal()`, title/description IDs, Escape handling and focus restoration; the workspace “More” navigation is presented as a conditional surface. | Verify focus containment/restore, Escape behavior, background inertness, and accessible names in actual browser interaction. |
| Responsive and touch targets | `apps/web/src/components/AppShell.module.css`, `apps/web/src/components/charts/InstrumentChart.module.css`, `apps/web/src/components/charts/DrawingTools.module.css`, `apps/web/src/app/globals.css` | Styles include responsive layout breakpoints, 44px-or-larger controls in representative components, reduced-motion overrides, and a 320px minimum document width. This does not prove overflow-free rendering. | Measure at 320 CSS px and 200% zoom; inspect all core journeys for clipping, horizontal page overflow, target spacing and sticky/fixed navigation overlap. |
| Color and theme | `apps/web/src/app/globals.css`, chart styles and shared CSS tokens | Light/dark token sets and a visible-focus token exist; chart colors read from shared tokens. | Measure text, control, focus, status, and chart-line contrast in both themes; verify meaning never depends on color alone. |
| Motion and status | `apps/web/src/app/globals.css`, representative loading/error states in chart and community components | A reduced-motion media rule is present; loading/errors use status or alert semantics in sampled components. | Verify reduced motion in browser, announce async transitions once, and check no timed or animated content blocks task completion. |

## Manual matrix

All cells below remain **not run**. This review did not access the saved localhost session and did not use an alternate browser, headless browser, CDP, or screenshot workflow.

| Check | Desktop Chrome/Edge/Firefox/Safari | iOS Safari | Android Chrome |
| --- | --- | --- | --- |
| Keyboard-only core journeys | Not run | Not run | Not run |
| Screen reader: VoiceOver/NVDA/JAWS or platform equivalent | Not run | Not run | Not run |
| 320 CSS px and 200% zoom | Not run | Not run | Not run |
| Focus order, visible focus, dialogs and live announcements | Not run | Not run | Not run |
| Light/dark contrast and non-color cues | Not run | Not run | Not run |
| Chart keyboard reading and exact text table | Not run | Not run | Not run |

No WCAG 2.2 AA conformance or certification is claimed. No mobile LCP or other performance measurement is recorded here. Complete the manual matrix with a supported browser and assistive-technology setup before marking AC-028 complete.
