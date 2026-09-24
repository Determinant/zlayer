# Shared UI and layout

[Documentation](../README.md) / Features

This guide owns shared typography, controls, tabs, dialogs, scrolling and responsive
layout, followed by the interaction and layout checks that verify them.

Recorded layout review: 2026-09-18, local production build with Chromium touch emulation.
These are representative **CSS viewports**, not physical-device certification.
Display scaling and browser chrome can change the available viewport.

| Layout | Viewport |
| --- | --- |
| Small phone | 320 × 568 |
| iPhone portrait / landscape | 393 × 852 / 852 × 393 |
| Short landscape / reduced height | 568 × 320 / 393 × 400 |
| OnePlus Open, folded | 412 × 915 |
| OnePlus Open, unfolded / rotated | 832 × 906 / 906 × 832 |
| iPad mini, portrait / landscape | 744 × 1133 / 1133 × 744 |
| iPad, portrait / landscape | 820 × 1180 / 1180 × 820 |
| Large tablet | 1024 × 1366 |
| Desktop | 1440 × 900 |
| Intermediate widths | 561 × 700 / 640 × 700 / 641 × 700 |

## Contents

- [Layout contract](#layout-contract)
- [Startup status](#startup-status)
- [Typography](#typography)
- [Shared controls](#shared-controls)
- [Automated regression coverage](#automated-regression-coverage)
- [Route-validation regression checks](#route-validation-regression-checks)
- [Plate-modal regression checks](#plate-modal-regression-checks)

## Layout contract

- `core/ui/viewport.ts` observes the visual viewport once for the application.
  CSS handles ordinary resizing; visual-viewport differences account for keyboard
  occlusion and panning. Pinch zoom does not trigger a reflow that defeats magnification.
- `core/ui/viewport.css` defines the visible rectangle, safe-area bounds and touch
  minimum. The shell, search, recommendations and dialogs share these bounds.
  Map panels use their containing workspace's actual available size.
- At widths up to 880px, the logo becomes a 44px icon. Between 601px and 880px,
  the route heading aligns with it, with 12px gaps before both inputs. Each row
  allocates its own remaining space so its controls cannot widen another row. The
  logo, search and Settings share one row even on narrow phones. About and the FAA
  data cycle selector live in Settings on every screen size; “Default · Latest”
  restores automatic cycle selection. Toolbar heights are shared variables,
  so overlay bounds do not duplicate guessed offsets for each device.
- At widths up to 600px and heights of at least 400px, the route editor gets its
  own full-width row. Advise, Fit and warnings sit below it. The Route heading opens
  a menu with copying, supported sharing actions and Clear Route. Layout uses CSS
  viewport size, covering ordinary phone widths and folded cover screens. Short landscape windows
  keep one row to preserve map space. The Route menu stays outside the scrolling
  editor, and resizing preserves an in-progress edit.
- Feature cards keep the identifier, append action and close control outside one
  scrollable body. Metadata, tabs and details remain reachable even in short windows.
  Layers likewise has one scrollable body. Short maps arrange zoom controls horizontally.
  Map Display groups the METAR/TAF and advisory switches under **AWC Weather**;
  advisory, cloud, icing and wind controls use four content tabs inside its left toolbox.
- Chart/MBTiles status, GPS, Terrain and AWC Weather retain their compact contents and tuck away
  off the left edge. Clicking or tapping a tab toggles its panel open or closed, on
  desktop and touch devices alike. Moving across the map or hovering another tab
  never changes the open state. Opening another tab switches panels, and Escape
  closes the active panel for keyboard users. Hidden controls leave the tab order while
  GPS tracking, terrain rendering and selected altitude continue unchanged. The
  AWC Weather tab sits directly above Terrain; its time selection, filters and map
  weather remain active when stowed. Its Advisories, Cloud, Icing and Winds content tabs
  share core's keyboard navigation and retain selection while stowed. One forecast
  timeline above the content tabs keeps the same selected time across all four.
  The tab row scrolls horizontally, retaining normal text size and touch targets;
  active wind barbs remain over the selected shaded forecast when switching tabs.
  These toolboxes scroll within the available map height in short landscape windows. Edge tabs
  retain 44px touch targets without adding headers to the panels.
  When the map container is at most 300px tall, the bottom tab stack uses a second
  column 48px inward. AWC remains above Terrain, and the top/bottom stacks cannot
  cover each other's touch targets. Panel widths account for that inset.
- The experimental AHRS toolbox also opens from the left edge. Stowing an active
  session asks for confirmation and pauses display updates; calibration and
  estimation still receive every IMU sample. Stop ends the session. Full screen
  preserves calibration, selected leg and instrument state. See the
  [AHRS lifecycle](../../src/layers/ahrs/README.md#integration).
- A right-click, or a stationary long press on touch screens, queries a small map
  radius and opens a nearby-feature chooser when airport, navaid or fix points
  overlap. Ordinary clicks keep selecting the nearest rendered point directly.
  Empty-space context gestures open a temporary GPS waypoint with coordinates and
  terrain elevation, without editing the route. When a plugin contributes actions,
  the shared map menu combines them with nearby features or that coordinate waypoint.
  Plate actions apply inside the current plate footprint. **Inspect weather** applies
  while AWC weather is enabled and available at the point, including with its toolbox stowed; ordinary
  taps never inspect weather. Releasing a long press cannot activate a newly opened
  menu item. Moving the map dismisses the menu, and keyboard arrows/Home/End select
  its actions. Plugins retain ownership of the commands and revoke them on unload.
- Component styles consume the shared 44px touch minimum, including tablets with a
  mouse or trackpad. Text-entry controls use 16px on touch devices. MapLibre CSS is
  imported in a lower-priority cascade layer; lazy loading cannot override app controls.
- Map and PDF ResizeObservers preserve the mounted view through rotation and folding.
  PDF fitting fills the available width at 100% zoom, allows vertical scrolling,
  limits canvas memory, and preserves explicit zoom.

## Startup status

The splash lists requested startup work using registered plugin names, alongside
Workspace discovery and Map rendering. Hidden/disabled layers, empty routes, and
terrain/obstruction coverage that requests no data do not add placeholder rows.
Terrain's `idle` and `zoom` states mean there is no requested work, not an unfinished
download. Activation failures from any registered plugin remain visible.

Data adapters report loading, rendering, ready, cached, limited or unavailable from
the same state used by the feature UI. AWC includes enabled advisories and the selected
cloud/icing timeline's preparation count. METAR/TAF includes visible map reports and
the active airport report cards. Live weather work is labeled **In background** and
does not block a usable workspace. The progress bar counts required startup steps;
background rows remain informative and are not falsely counted as ready.
Startup still waits for required data, the first settled map and responsive frames.
The [finishing phase](../architecture/workspace-startup.md) is one-way: background
updates cannot rewind completed startup steps or alternate the final heading.
The existing slow-start recovery action remains available, and later refreshes never
bring the splash back.

## Typography

| Role | Treatment |
| --- | --- |
| Application UI and map attribution | Locally bundled B612, regular 400 / bold 700; synthesis disabled; native controls inherit the UI font |
| UI headings and titles | Natural B612 spacing (`letter-spacing: normal`), shared by `h1`–`h6`; no negative tracking |
| Raw TAF and Morse | Shared system monospace stack; preserve report spacing and letter groups |
| Map identifiers, terrain and GPS projection labels | Bundled Noto Sans Bold glyphs; preserve sizes and halos |
| Compact metadata and badges | 11 px minimum in application CSS; a design choice, not an accessibility-standard minimum |
| Dense controls and data | 12–14 px with clear weight/color hierarchy; region inventory supporting text stays 12 px |
| Explanatory prose | 14 px, line height 1.6–1.7 |
| Touch text-entry fields | 16 px minimum; terrain altitude input remains 18 px |
| Long airport and procedure names | Wrap without discarding identifying suffixes; search names use the full width below the identifier/category row |

Use the shared font stacks and `--text-muted` for secondary labels, with explicit
placeholder color and opacity. `src/core/ui/styles.css` owns the shared heading
spacing rule; panel and dialog styles should inherit it rather than tighten titles
individually. Compact uppercase section labels may retain positive tracking.
TAF categories and fix-setting labels must expand
with letter spacing; layer descriptions wrap without tight identifier tracking.
Map glyphs cover current identifier/numeric labels; arbitrary place names require
additional ranges (see [map fonts](../../public/fonts/README.md)). FAA chart and PDF
text remains publisher-supplied and readable through the existing zoom controls.

Check long names, all four TAF categories, cached weather, gusts/runways, expanded
fix controls, regional downloads, About, recommendations and both terrain modes:

- Review 1280×900 and 320×740, plus 640×450 at device scale 2 to emulate the layout
  and raster size of a 1280×900 window at 200% zoom. This is not native browser zoom.
- Repeat narrow/enlarged layouts with line height 1.5, letter spacing 0.12em,
  word spacing 0.16em and paragraph spacing 2em, following the
  [W3C text-spacing check](https://www.w3.org/WAI/WCAG22/Understanding/text-spacing.html).
- Measure text contrast against composited backgrounds using the
  [W3C contrast calculation](https://www.w3.org/WAI/WCAG22/Understanding/contrast-minimum.html)
  and inspect screenshots over actual map overlays. Ancestor colors alone do not
  establish contrast over every chart, gradient, hover state or backdrop.
- Compact status badges may ellipsize and closed native selects may shorten text;
  full chart/cycle choices must remain available in their controls. Scrollable
  editors and panels must keep their content reachable.

These methods retain the September 17 targeted review, which predated AHRS and
reset controls; they do not establish full WCAG conformance or current test status.
Physical iOS/Android rasterization, native selects and OS accessibility text
settings still require device checks.

## Shared controls

`core/ui/styles.css` is the shared UI entry: typography, native font inheritance,
viewport/touch tokens, scrolling and `core/ui/controls.css`. The application imports
it once through `src/styles.css`; standalone UI fixtures import it directly when
they do not load the application stylesheet. The shell owns workspace layout.

Use `ui-button` on native action buttons and `ui-input` on text/search/number inputs,
selects and textareas. Native fields use a dark color scheme so WebKit's select
surface stays readable with the shared light text. Core owns their border,
background, padding, typography,
hover, keyboard focus and disabled treatment. Keep native attributes, refs, labels
and event handlers with the feature; these classes add no JavaScript or wrapper DOM.

Use `ui-progress` on a native `<progress>` element for determinate or indeterminate
work, with an accessible label and product-owned `value`, `max` and `aria-valuetext`.
Startup and AWC forecast preparation share its compact track and fill styling.

```tsx
<label>Heading
  <input className="ui-input" type="number" value={heading} onChange={onHeadingChange} />
</label>
<button className="ui-button ui-button--primary" type="submit" disabled={busy}>Save</button>
```

Button modifiers are `ui-button--primary`, `ui-button--danger`, `ui-button--quiet`,
`ui-button--compact` and `ui-button--icon`. Icon buttons still need an accessible
name. `ui-input--compact` is for dense toolboxes. Ordinary controls are at least
44px high; compact controls start at 32px. Both honor the shared 44px touch minimum
in width and height, including short action labels such as Use. AWC's Prev/Now/Next
and product-tab buttons deliberately share a 32px height on all devices to preserve
room for forecast controls; both rows retain at least 44px button width.
Fields use 16px text; compact fields use the shared 14px/16px touch font size.
Native selects contain their internal painting so long values with expanded text
spacing cannot widen an enclosing scroller in WebKit; their full option labels
remain available in the native menu.
Pressed/selected buttons follow their ARIA state. Preserve text-entry minimums and
existing specialized geometry, including AHRS's compact bezel and 44px fullscreen
buttons; see its [toolbox contract](../../src/layers/ahrs/README.md#toolbox-and-full-screen).

Use `--primary` for the main action, `--quiet` for a low-emphasis alternative, and
`--danger` for deletion/removal instead of feature-specific button colors. Simple
confirmations use `core/ui/confirmation-dialog.tsx`; pass `destructive` for its
danger variant. It owns native modality, initial Cancel focus, cancellation and
cleanup. Keep feature-specific decisions and actions in the caller. Local focus
rules should target specialized controls, without overriding shared buttons/fields.
Dialogs with custom actions or live status use `core/ui/use-modal-dialog.ts` for
opening, initial focus and close-on-cleanup. Callers retain their native dialog
markup, cancellation policy, actions and any explicit focus handoff. Fullscreen
readers and instruments continue to use `PanelSurface` for inline/modal transitions.

AHRS, Ownship, Terrain, Ruler actions, navigation fix settings, weather station
selectors, route forms/pickers/recommendations, plate viewer actions, confirmations,
Settings and startup/error/reset actions use these styles. Feature CSS retains layout,
widths and meaningful states such as recording, selected terrain modes and route
procedure choices. Route chips, search-result rows, map tools, sliders,
radio choices and instrument graphics retain their specialized presentation.
Compact weather reports, including TAF formatting, stay plugin-owned; their
ordinary controls still use core's styles and compact variants.
Core's panel/tab/surface primitives continue to own their existing lifecycles.
Selected edge handles paint above both panel bodies so overlapping left/right panels remain
operable on narrow maps. Focusing a panel raises its body above the opposite edge;
both selections and their mounted content stay intact. Stowed tabs stay below open
bodies so short-map inset tabs cannot cover their controls. Core drives the body and
handle with the same measured offset and reveal fraction.
`ToolPanel` render children receive `(visible, panel)`, including the owning edge
panel controller. Feature actions can request `panel.setOpen(true, onCommit)` to
reveal their toolbox through core's existing stow guards; change local tabs only
on commit and wait for `panel.open` before focusing controls.

Selected navigation features and weather advisories use `core/ui/detail-panel.tsx`.
`DetailPanel` composes `EdgePanelFrame` with the existing detail-card presentation:
responsive bounds, heading/actions, close control, metadata fields and one focusable
scroll body. Its styles live in core's UI entry. Pass the feature's `useEdgePanel`
controller, labels, close callback and content; `wide` accommodates airport plates
while features request opening on selection through that controller. Features keep their report content,
tabs and demand decisions, without overriding the shared frame's width, header or
scroll layout.

Content tabs use `core/ui/tabs.tsx`: `TabList` owns the shared native buttons,
selected state, roving tab stop and Left/Right/Home/End navigation. Pair it with
`tabPanelProps` using the same base ID and tab values for panel IDs, labels and
visibility. Settings, Terrain, AWC Weather and Info/Plates use this primitive. Feature owners
retain selection storage and decide whether inactive content remains mounted;
Info/Plates keeps inactive panel shells empty so hidden weather and PDF catalog
content do not start work. Identification temporarily leaves both tabs unselected.
The optional `scrollable` variant keeps a single horizontal row with core
scrollbar styling and overflow-edge cues. Selection/resize reveals the active tab
by scrolling only the row, preserving the enclosing panel/page position. AWC uses
this variant so further product tabs do not require smaller labels or wrapping.

The shared `.switch` indicator is also defined in core controls. Its native button
owns `role="switch"` and `aria-checked`; local styles may adjust indicator dimensions
and row layout. For a standalone switch beside compact text, use `.ui-switch` on
the button with an accessible name and a decorative `.switch` child. GPS, AWC Weather
and Terrain use it in their toolbox headings. Its 27×16px indicator sits inside a
36×24px target that grows to at least 44×44px on touch devices, with shared keyboard
focus and disabled styling. The feature still owns state and activation:

```tsx
<button className="ui-switch" type="button" role="switch" aria-label="Show terrain"
  aria-checked={enabled} onClick={onToggle}>
  <span className="switch" aria-hidden="true"><i /></span>
</button>
```

Core's UI entry owns the reduced-motion policy as well as the shared
animations, so standalone UI imports receive the same behavior as the application.

Scrollbar appearance also comes from core: every scrollable element uses the shared
thin scrollbar and muted thumb on a transparent track, including nested plugin
content, plate readers and dialogs. No class is needed to opt in. `panel-scroll`
adds scroll containment and a stable gutter only; keep these layout choices local
instead of applying them globally. Plugins should not define separate scrollbar
palettes. The compact route editor retains its intentionally hidden horizontal bar.

## Automated regression coverage

`test/e2e/responsive.spec.ts` checks actual search text space after padding (at least
140px), touch target dimensions, zoom hit testing, scrollable card and layer content,
and the ability to scroll a plate target fully into view across all 17 sizes above.
It checks the single header row and cycle selector inside Settings, plus returning
from About to Settings with Escape and restored focus. Recommendations, Settings
and About are checked against simulated portrait and landscape safe areas.
A controlled visual-viewport fixture changes keyboard geometry without
resizing the layout viewport, verifies search results and Settings remain reachable,
and checks that pinch zoom does not resize the application.

`test/e2e/plate-fullscreen.spec.ts` checks fitting, focus restoration, touch controls,
fullscreen and explicit zoom. Reading buttons stay on one line down to a 320px
viewport; narrow readers use a Page picker for navigation and the source link.
The percentage button resets zoom, orientation and scroll without changing the page.
An open plate survives seven fold/tablet size changes
without another PDF request, and returns to the same airport edition and selected tab.
`test/e2e/route-editor.spec.ts` covers touch and keyboard editing through data refreshes
at 320, 360, 390, 430, 480, 600, 601, 744, 832 and 1280px. It checks the full-width
phone editor, Route menu access, accessible replacement fields, clearing and
focus restoration, and an unfinished entry through both sides of the phone breakpoint.
Screenshots were also inspected at small-phone, short-landscape, iPad mini and
unfolded OnePlus sizes; element bounds alone do not detect every overlap.

`test/e2e/map-edge-tools.spec.ts` checks compact bounds, touch toggles, hover stability,
keyboard focus and Escape, retained altitude and uninterrupted GPS tracking at
320×568, 393×852, 568×320, 744×1133, 832×906 and 1440×900.

The AHRS browser suites cover toolbox controls, full screen, attitude geometry,
rolling digits and local recordings. They also cover calibration without any GPS
fix, low-speed GPS, and continued horizon movement beneath the cross during
prolonged GPS absence and high uncertainty, followed by GPS-aided recovery. See
the [display policy](../../src/layers/ahrs/README.md#calibration-and-validity).
`test/e2e/reset.spec.ts` covers confirmation,
reset across open windows, interrupted reset and offline completion. These automated
cases do not establish physical sensor behavior.

Run `npm run verify` for imports, types, unit tests and bundling. Run the browser
regressions with:

```sh
npm run test:browser -- test/e2e/responsive.spec.ts test/e2e/route-editor.spec.ts \
  test/e2e/map-edge-tools.spec.ts test/e2e/nearby-picker.spec.ts \
  test/e2e/workspace-persistence.spec.ts test/e2e/plate-fullscreen.spec.ts \
  test/e2e/plate-pinch.spec.ts test/e2e/plate-rendering.spec.ts \
  test/e2e/ahrs.spec.ts test/e2e/ahrs-fullscreen.spec.ts \
  test/e2e/ahrs-geometry.spec.ts test/e2e/ahrs-drums.spec.ts \
  test/e2e/ahrs-recording.spec.ts test/e2e/reset.spec.ts
```

Physical Safari/iPadOS and Android checks remain necessary for real OS keyboards,
pinch and focus-driven viewport panning, fold transitions, browser chrome, suspension
and storage pressure. Desktop viewport emulation and CDP inset overrides do not certify
those behaviors. See [deployment readiness](../development/deployment.md).

## Route-validation regression checks

Use `test/browser/routes.html?open` to check route warnings and expanded explanations
without clipping at phone/tablet/desktop widths, including below the 880px breakpoint.
Gesture tests verify that adding a second touch, ending with a touch remaining,
or cancelling a touch cannot delete a route waypoint.

## Plate-modal regression checks

Check initial focus on Close, background controls outside the tab order, Escape
restoring the opening plate row, and keyboard access to native browser chrome.
Reopening and resizing must preserve reachable controls and a width-fitted page
without horizontal overflow at 100% zoom. New views start at the top and allow
vertical scrolling; reopening restores the saved reading position.
A cached PDF must reopen when its source is unavailable.

The plate dialog now remains mounted while the renderer and PDF load, with the
shared Settings skeleton and a fade into the completed page. Automated checks
hold both downloads to verify stable geometry, disabled zoom controls, close
availability and focus restoration before the renderer is ready.

Two-finger pinching inside the PDF updates the viewer's 50–400% zoom, anchored
between the fingers. The current bitmap previews the gesture immediately; PDF.js
redraws sharply after release. Non-passive touch and Safari gesture handlers prevent
browser magnification over the plate while preserving one-finger scrolling.
Anchor correction rounds scroll offsets to the nearest CSS pixel because WebKit
truncates fractional offsets; this keeps the zoom centered without a directional bias.
The same viewer handles Safari tabs and Home Screen apps. Trackpad wheel gestures use
the same zoom state. External browser magnification still increases the backing
resolution without changing the PDF layout. Each canvas is limited to 8,388,608
pixels (32 MiB), with at most one temporary buffer alongside the displayed canvas.
Tests cover live zoom percentages, finger anchoring, cancellation, remaining-finger
panning, zoom buttons after pinching, cold offline reopening, no repeated PDF fetch,
and the allocation bound.
Pinch geometry checks wait for the shared edge panel to finish sliding before
capturing canvas coordinates.
Chromium receives native multitouch input through CDP; WebKit tests touch/gesture
event handling. Physical iOS/Android gesture checks remain necessary.

The cold offline pinch test disconnects the test origin. Playwright's Linux WebKit
offline emulation rejects even a standalone service worker's generated response;
stopping the server leaves that response usable. Disconnecting the origin tests
cached navigation without this emulation limitation.

For a repeatable plate startup profile, measure from the plate-row click to the
completed bitmap's copy onto the visible canvas, separating verification from
PDF rendering. The September 18 profile used KPAO's 49,209,653-byte Southwest
Chart Supplement in Chrome mobile emulation (393×852, DPR 2, 4× CPU throttling).
Receipt reuse reduced application reads from 50,315,882 to 1,106,229 bytes;
these are historical observations, not device timing guarantees. Current release
gates remain in [deployment readiness](../development/deployment.md).

Receipt reuse still checks book identity, response type, PDF header and actual
length. New downloads, legacy migrations and missing/mismatched receipts require
full verification. This uses the stored book and receipt without retaining the
whole book in application memory; see [storage verification](offline-storage.md#storage-contract).
