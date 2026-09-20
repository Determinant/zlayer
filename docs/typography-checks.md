# Typography review

Reviewed 2026-09-17. Scope: application text, controls, dialogs, search, navigation
details, METAR/TAF, runway tables, plates, route recommendations, GPS, terrain,
map attribution, and the bundled font assets.

This records that build's review. Later AHRS instruments and reset controls were
outside its scope; their browser coverage is listed in [responsive checks](responsive-checks.md).

## Changes in the reviewed build

- Raised 9–10 px annotations to 11 px, including route-history notes, terrain
  clearance labels, runway metadata, and plate controls. This is the app's compact
  caption size, not a claim that an accessibility standard specifies an 11 px minimum.
- Settings explanations now use 14 px text with a 1.6 line height. Region inventory
  rows retain 12 px supporting text; About already uses 14 px prose with generous leading.
- Replaced faint search categories, layer descriptions/counts, airport field names,
  inactive detail tabs, plate metadata, route placeholders, and muted route summaries
  with the shared `--text-muted` color. Placeholders have explicit color and opacity.
- Restricted explicit CSS font weights to the two supplied B612 faces, 400 and 700.
  Previous 500/600/650/750/800/900 declarations relied on nearest-face matching.
- Centralized UI and monospace font stacks. Native form controls inherit the UI
  font, and map attribution now uses B612 instead of MapLibre's default Helvetica.
- Search identifiers and categories share a heading row; airport names wrap across
  the full width below it. Procedure names wrap in both the list and viewer heading.
  Layer descriptions also wrap, and airport identifiers no longer have tight tracking.
- TAF category and fix-setting label columns can expand when letter spacing grows.

## Font and layout rules

| Role | Treatment |
| --- | --- |
| Application UI | Locally bundled B612, regular 400 / bold 700; synthesis disabled |
| Raw TAF and Morse | Shared system monospace stack; preserve report spacing and letter groups |
| Map identifiers, terrain and GPS projection labels | Bundled Noto Sans Bold glyphs; existing sizes and halos preserved |
| Compact metadata and badges | 11 px minimum in application CSS |
| Dense controls and data | 12–14 px with clear weight/color hierarchy |
| Explanatory prose | 14 px, line height 1.6–1.7 |
| Touch text-entry fields | Existing 16 px minimum; terrain altitude input remains 18 px |
| Long airport and procedure names | Wrap without discarding their identifying suffixes |

The map's bundled glyph range covers its current identifier/numeric labels.
Arbitrary place-name labels need additional ranges; see [map fonts](../public/fonts/README.md).
FAA chart and PDF typography is supplied by the publisher and is read through the
existing map/PDF zoom controls, rather than restyled by application CSS.

## Browser checks

The review used a production test build in Chromium, with synthetic navigation,
weather, route and PDF data. Screens were inspected at 1280 × 900 and 320 × 740.
Additional checks used 640 × 450 CSS pixels at device scale 2, representing the
layout and raster size of a 1280 × 900 window at 200% zoom. This is an emulated
zoom check, not a physical-device or native browser zoom-button test.

The narrow and enlarged layouts were also exercised with line height 1.5,
letter spacing 0.12em, word spacing 0.16em and paragraph spacing 2em. Those values
follow the [W3C text-spacing check](https://www.w3.org/WAI/WCAG22/Understanding/text-spacing.html).
The scenarios included long airport/procedure names, all four TAF flight categories,
cached METARs, wind gusts, runway tables, expanded fix controls, region downloads,
About, route recommendations and both terrain color modes.

Text colors were checked from computed styles against composited ancestor backgrounds,
using the [W3C contrast calculation and thresholds](https://www.w3.org/WAI/WCAG22/Understanding/contrast-minimum.html).
Screenshots supplemented those measurements for translucent map overlays. This is
a targeted typography review, not a complete WCAG conformance audit: computed ancestor
colors alone do not certify every chart, gradient, hover state, or backdrop.

Compact map-status badges retain ellipsis, and native select values can shorten in
their closed control under expanded spacing. Full chart selections remain available
in Layers, and full cycle options in the selector. Scrollable editors and panels
remain intentional; offscreen text in a scrollable panel is not treated as clipping.

Physical iOS/Android font rasterization, native select presentation, and OS accessibility
text settings still need device checks. The desktop checks do not establish those behaviors.

## Regression checks

The final changes passed all 457 unit tests, all 79 Chromium browser tests,
TypeScript/import checks and the production build. These counts describe the
2026-09-17 review. Dated bundle measurements and remaining performance checks are
recorded in [deployment readiness](deployment-readiness.md).
Visual review included 18 standard screen captures and 60 captures
covering narrow/enlarged layouts with normal and expanded text spacing.

Run `npm run verify` and `npm run test:browser`. The existing browser suite covers
the production shell and fonts offline, search selection, keyboard-sized viewports,
portrait/landscape panels, plate reading controls, route editing, weather, GPS and
terrain. The typography work adds no dependency or additional font download.
