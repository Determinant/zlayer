# Responsive and recovery checks

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
- Chart/MBTiles status, GPS and Terrain retain their compact contents and tuck away
  off the left edge. Clicking or tapping a tab toggles its panel open or closed, on
  desktop and touch devices alike. Moving across the map or hovering another tab
  never changes the open state. Opening another tab switches panels, and Escape
  closes the active panel for keyboard users. Hidden controls leave the tab order while
  GPS tracking, terrain rendering and selected altitude continue unchanged. Terrain
  scrolls within the available map height in short landscape windows. Edge tabs
  retain 44px touch targets without adding headers to the panels.
- The experimental AHRS toolbox also opens from the left edge. Stowing an active
  session asks for confirmation and pauses display updates; calibration and
  estimation still receive every IMU sample. Stop ends the session. Full screen
  preserves calibration, selected leg and instrument state. See the
  [AHRS lifecycle](../src/layers/ahrs/README.md#integration).
- A right-click, or a stationary long press on touch screens, queries a small map
  radius and opens a nearby-feature chooser when airport, navaid or fix points
  overlap. Ordinary clicks keep selecting the nearest rendered point directly.
  Empty-space context gestures open a temporary GPS waypoint with coordinates and
  terrain elevation, without editing the route.
- Component styles consume the shared 44px touch minimum, including tablets with a
  mouse or trackpad. Text-entry controls use 16px on touch devices. MapLibre CSS is
  imported in a lower-priority cascade layer; lazy loading cannot override app controls.
- Map and PDF ResizeObservers preserve the mounted view through rotation and folding.
  PDF fitting uses both dimensions, limits canvas memory, and preserves explicit zoom.

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
fullscreen and explicit zoom. An open plate survives seven fold/tablet size changes
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
the [display policy](../src/layers/ahrs/README.md#calibration-and-validity).
`test/e2e/reset.spec.ts` covers confirmation,
reset across open windows, interrupted reset and offline completion. These automated
cases do not establish physical sensor behavior.

Before the cycle selector moved into Settings, a separate 160-case resize sweep
checked widths from 320px to 1000px in both directions, including both sides of
the 600px and 880px header breakpoints. Mouse
and touch layouts, with and without route warnings, retained consistent logo
alignment, bounded gaps and usable input widths. This also checked that the date
controls could not take space from the route input in compact layouts.

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
those behaviors. See [deployment readiness](deployment-readiness.md).

## Route-validation regression checks

The local `test/browser/routes.html?open` fixture was additionally checked in
isolated headless Firefox at 320×568, 393×852, 744×1133, 832×906 and 1440×900.
The route-warning control and expanded explanations remain visible without
viewport clipping, including below the 880px compact-layout breakpoint. These
are layout screenshots, not physical-device or multi-touch browser certification.
Gesture tests separately verify that adding a second touch, ending with a touch
remaining, or cancelling a touch cannot delete a route waypoint.

## Plate-modal regression checks

The 2026-09-16 production-build follow-up in isolated Firefox checked the KPAO
startup view and its Chart Supplement in PDF.js. At 1366×1024, initial focus reached
Close, background controls stayed out of the tab order, and Escape restored the
opening plate row. Native browser chrome remains keyboard-reachable.

Reopening/closing the viewer at 744×1133, 1100×1128, 390×844 and 360×640 preserved
focus restoration, reachable controls and a fitted page without horizontal overflow;
screenshots were inspected. The cached PDF also reopened with the local test server
returning unavailable responses. These are desktop viewport/recovery checks, not
physical-device certification or a fresh offline-install test.

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

The 2026-09-18 plate startup profile used KPAO's 49,209,653-byte Southwest Chart
Supplement in Chrome mobile emulation (393×852, DPR 2, 4× CPU throttling). Timing
ran from plate-row click to the completed bitmap's copy onto the visible canvas.
The initial 2.48 s offline reopen spent about 2.2 s hashing before PDF.js started:
verification, rather than PDF drawing, was the dominant measured delay. The first
WebAssembly optimization still scanned every byte using the same 1 MiB chunks and
two-verification limit. Receipt reuse then reduced application reads from
50,315,882 to 1,106,229 bytes, avoiding the repeated whole-book scan.
Streamed WebAssembly hashing and then persisted receipt reuse reduced cached-open
latency and bytes read. The local measurements above describe this review;
remaining release gates are listed in [deployment readiness](deployment-readiness.md).

Receipt reuse still checks book identity, response type, PDF header and actual
length. New downloads, legacy migrations and missing/mismatched receipts require
full verification. This uses the stored book and receipt without retaining the
whole book in application memory; see [storage verification](offline-storage.md#storage-contract).
