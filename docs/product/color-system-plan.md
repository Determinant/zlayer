# ZLayer color system

[Documentation](../README.md) / Product

Status: proposed palette and implementation plan, 2026-09-17.
Scope: the current dark interface, application-owned map overlays, and branding.

## Contents

- [Direction](#direction)
- [Main palette](#main-palette)
- [Interaction rules](#interaction-rules)
- [Navigation and route meaning](#navigation-and-route-meaning)
- [Application status](#application-status)
- [Weather palette](#weather-palette)
- [Contrast targets and checks](#contrast-targets-and-checks)
- [Implementation sequence](#implementation-sequence)
- [Completion criteria](#completion-criteria)

## Direction

Use deep navy surfaces, cool readable text, teal interaction cues, and cyan route
geometry. Give navigation categories stable identities across search, layer
controls, route tokens, and map symbols. Preserve the existing weather color
families and make their text variants explicit.

This supports the product principle that weather remains prominent while the
surrounding interface stays quiet. Color communicates a role; labels, shapes,
line patterns, and control states make that role understandable without color.

## Main palette

Names below become shared semantic tokens. Components choose a role instead of
introducing another approximate shade.

| Role | Token | Value | Usage |
| --- | --- | --- | --- |
| Canvas | `surface.canvas` | `#08111F` | Application background and deepest chrome |
| Panel | `surface.panel` | `#0C1A2B` | Toolbars, dialogs, popovers, detail cards |
| Raised surface | `surface.raised` | `#122638` | Inputs, nested cards, secondary buttons |
| Hover surface | `surface.hover` | `#1A3347` | Hovered neutral controls and rows |
| Selected surface | `surface.selected` | `#143B3E` | Active tabs, selected menu options |
| Primary text | `text.primary` | `#EAF6FF` | Identifiers, values, headings, button labels |
| Secondary text | `text.secondary` | `#B2C7D7` | Descriptions and supporting information |
| Muted text | `text.muted` | `#91A9BB` | Metadata, timestamps, placeholders, small labels |
| Decorative border | `border.subtle` | `#294052` | Dividers and nonessential panel edges |
| Control border | `border.control` | `#6D879B` | Boundaries needed to identify an input or control |
| Primary accent | `action.primary` | `#61D6C5` | Main actions, links, toggles, focus indicators |
| Accent hover | `action.hover` | `#82E8DA` | Hovered primary buttons and links |
| Accent pressed | `action.pressed` | `#42B8A8` | Pressed primary buttons |
| Text on accent | `text.onAccent` | `#08111F` | Labels on solid accent buttons |
| Active route | `route.active` | `#33C6FF` | Route line, route legend, route geometry previews |
| Alternative route | `route.alternative` | `#BAC4CE` | Alternative route lines and their legend |

`focus.ring` aliases `action.primary`; it is not a separately adjustable shade.
The same rule applies in the route editor, search, settings, and plate viewer.

The existing logo retains its cyan `#38C9E6`, shaded cyan `#1A809F`, and light
lettering `#ECF7FD`. These are named artwork colors with a limited scope. The UI
uses the interaction and text tokens above. Route cyan and logo cyan are deliberate
roles; components should not borrow either for arbitrary buttons or focus rings.

## Interaction rules

| State or component | Treatment |
| --- | --- |
| Primary button | Solid primary accent with `text.onAccent`; named hover and pressed fills |
| Secondary button | Raised surface, primary text; hover surface on pointer hover |
| Input | Raised surface, primary text, muted placeholder, control border |
| Focus | Solid 2px teal ring with a visible gap; use a navy isolation ring over map content or solid teal controls |
| Selected tab or option | Selected surface plus teal indicator and a check, underline, or positional cue |
| Enabled toggle | Teal thumb plus its changed position and accessible checked state |
| Link in prose | Teal text with an underline |
| Disabled control | Muted text, quiet surface, actual disabled semantics; retain readable labels |
| Loading | Neutral skeleton plus an explicit loading label where needed |
| Invalid input | Error indicator and explanation; keyboard focus remains teal and separately visible |

Use one solid primary action per local action group when an action needs emphasis.
Close, zoom, navigation, and other utility buttons normally use secondary styling.
Selection tint and low-contrast borders never carry the entire state indication.
Focus rings must remain visible inside scrollable panels and at clipped edges.

Use opaque panel surfaces as the default so the chart behind a panel does not
change label contrast. If a translucent surface is retained, define a named
overlay token and verify its composited contrast over both light and dark content.
Blur or a shadow alone does not establish contrast. Keep shadows neutral and
remove persistent decorative glows from status dots and ordinary controls.

## Navigation and route meaning

| Category | Shared identity token | Color | Additional identification |
| --- | --- | --- | --- |
| Airport | `navigation.airport` | `#58D3FF` | Airport identifier and airport glyph / APT label |
| NAVAID | `navigation.navaid` | `#B9B8CE` | Existing VOR, VORTAC, DME, or NDB symbol and subtype text |
| IFR fix | `navigation.fix` | `#42CDE3` | Existing triangle or RNAV symbol and FIX label |
| VFR waypoint | `navigation.vfrWaypoint` | `#FFBD66` | Diamond and VFR waypoint label |
| Airway, SID/STAR, TEC construct | `route.construct` | Alias of `text.secondary` | Explicit airway, SID, STAR, or TEC designation |
| Pending route entry | `route.pending` | Alias of `text.muted` | Pending state text or loading indicator |
| Unresolved route entry | `route.invalid` | Alias of `status.error` | Dashed outline and readable error explanation |

Apply identity colors to glyphs, swatches, and token accents. Keep identifiers in
primary text on neutral token surfaces. Route-token keyboard focus is teal;
it does not replace the category accent. Retain NAVAID subtype geometry while
removing the unrelated NDB-only chip color. Airway/procedure/TEC constructs use
textual type identification instead of adding more category hues.

The route line uses route cyan regardless of the kinds of waypoints along it.
Procedure-preview segments retain their dashed pattern. Alternative routes retain
their separate weight and neutral color. The route editor's buttons and focus use
the same interaction rules as other controls; its map legend remains route cyan.

Airport map centers are an explicit semantic exception: with weather enabled they
show flight category, and missing categories are gray. Without weather they remain
neutral gray, matching the current map behavior. The cyan airport identity applies
to search, layer controls, and token accents; it must not resemble a weather report.
Label this distinction in the legend when applicable.

Map selection, route membership, and drag feedback use additional rings, outlines,
or handles. Keep category glyphs and available weather centers visible beneath
those indicators. Use teal for a confirmed snap and a neutral outlined handle
while dragging; reserve warning amber for an actual warning. Verify the overlap
case where a weather airport is also a selected route waypoint.

Map labels use primary text with a shared dark halo or opaque panel nameplate.
Category color remains on the associated symbol. Retain symbol geometry, collision
rules, and chart legibility while consolidating label colors.

## Application status

| Meaning | Foreground token | Foreground | Surface token | Surface |
| --- | --- | --- | --- | --- |
| Successful operation / verified saved data | `status.success` | `#73D6A2` | `status.successSurface` | `#13352C` |
| Stale, incomplete, or degraded result | `status.warning` | `#FFC16E` | `status.warningSurface` | `#3A2D1B` |
| Invalid entry or failed operation | `status.error` | `#FF8B94` | `status.errorSurface` | `#3B222C` |
| Informational notice | `status.info` | `#8FD2FF` | `status.infoSurface` | `#163248` |

Pair status colors with a word and an icon or pattern. Use the status foreground
for the indicator and concise status text; longer explanations use normal text.
Ordinary controls retain their interaction colors inside status containers.

Caching and freshness are separate facts. A current cached report can use a
neutral "Cached" label and its observation time. Amber identifies actual age,
incompleteness, or degradation; it does not mark every cached response as suspect.
Failed refresh with usable cached data is a degraded result with a clear message.
A failed requested operation or unavailable result uses error styling.
"Saved" communicates verified storage completeness, separately from edition age.

## Weather palette

Keep the existing VFR green, MVFR blue, IFR red, LIFR magenta, and unknown gray
families. These values describe ZLayer's presentation, not a claim that exact RGB
values are mandated by an aviation authority.

| Category | Marker / legend fill | Text on dark UI |
| --- | --- | --- |
| VFR | `#20C66B` | `#20C66B` |
| MVFR | `#2787FF` | `#62A9FF` |
| IFR | `#F04444` | `#FF7070` |
| LIFR | `#D847E8` | `#E97BF5` |
| Unknown | `#8795A1` | `#9EAFC2` |

Define `weather.<category>.marker` and `weather.<category>.text` together. METAR map
points and legend dots use marker tokens; TAF category text uses text tokens. This
preserves the current readable text variants while eliminating independent copies.
Put raw report text in primary text, and show category with its acronym and a
colored rule or badge. Timestamps use muted text.

Use a light marker outline and dark outer halo on maps. Keep category acronyms
in the legend and selected-airport detail, and provide a non-color category cue
on map markers where flight category must be read directly. Validate the cue at
the supported marker sizes. Never infer good conditions from an unknown category.
Application success and weather VFR remain separate semantic tokens even where
their color families are similar.

Source chart rasters, procedure PDFs, and externally supplied imagery retain their
own colors. PDF paper white and basemap fallback colors are explicit source/map
tokens, not candidates for replacement with the navy UI palette. Future weather
products define documented product-specific scales and legends.

## Contrast targets and checks

Require at least 4.5:1 for ordinary interface text, including placeholders and small
metadata. Aim for 7:1 for frequently read text on the main panel. These targets use
the [WCAG text contrast guidance](https://www.w3.org/WAI/WCAG22/Understanding/contrast-minimum.html).
Require at least 3:1 against adjacent colors for essential control boundaries,
state indicators, and meaningful graphics, following the
[non-text contrast guidance](https://www.w3.org/WAI/WCAG22/Understanding/non-text-contrast.html).
Color is supplemented by labels, shape, or pattern, following the
[use-of-color guidance](https://www.w3.org/WAI/WCAG22/Understanding/use-of-color.html).

Calculated sRGB contrast for the proposed opaque pairs:

| Pair | Ratio |
| --- | --- |
| Primary text / panel | 15.96:1 |
| Secondary text / panel | 10.05:1 |
| Muted text / panel | 7.17:1 |
| Muted text / hover surface | 5.34:1 |
| Muted text / selected surface | 4.98:1 |
| Text on accent / primary accent | 10.75:1 |
| Control border / selected surface | 3.24:1 |
| Success / success surface | 7.54:1 |
| Warning / warning surface | 8.34:1 |
| Error / error surface | 6.46:1 |
| Info / info surface | 8.10:1 |

All weather text variants exceed 5.7:1 on the raised surface. Ratios shown are
rounded for display; future automated checks must use the unrounded results. The decorative
border is intentionally subtle and cannot substitute for an essential boundary.
These calculations validate token pairs, not a completed rendered accessibility
audit. Chart compositing, browser focus, actual text size, and map-symbol overlap
still need visual checks.

## Implementation sequence

1. **Establish shared tokens.** Add a dependency-free
   `src/core/theme/palette.ts` containing primitives and semantic aliases. Export
   resolved color values for Canvas and MapLibre consumers. Generate
   `src/core/theme/tokens.css` with `tools/generate-theme.ts` and import it first in
   `src/styles.css`. Provide write and check modes; the check mode fails on stale
   generated CSS without modifying files. Keep this module free of React, DOM,
   MapLibre, and feature imports so current import boundaries remain intact.
2. **Migrate shell and common UI.** Apply surfaces, text, borders, focus, and
   controls in `src/shell/`, `src/core/ui/`, and the feature-details panel. Include
   settings downloads, search, dialogs, offline banners, and loading/error states.
   Replace low-contrast metadata and remove unregistered fallback colors.
3. **Align feature controls and category meaning.** Update navigation search
   glyphs and definitions, route tokens/recommendations, and plate controls.
   Normalize route focus to teal; make category accents and construct labels
   consistent. Consolidate freshness, caching, download, and error treatments.
4. **Migrate map and weather colors together.** Consume shared tokens in navigation
   symbols/renderers, route rendering, shared map labels, METAR rendering/legend,
   and TAF text. Preserve weather visibility on selected/route airports. Retain
   category geometry, route dash patterns, and existing map lifecycle behavior.
5. **Verify and document the result.** Capture representative screens and verify
   contrast in default, hover, focused, selected, disabled, loading, and error
   states. Update this document with any intentional deviations and the completed
   visual checks.

Add focused contrast tests for meaningful foreground/background pairs and a
generated-CSS freshness check to the existing check command. Extend browser
coverage where it can catch semantic regressions, such as a changed weather color
or missing selected-state indicator. Avoid broad color snapshots that merely
repeat every implementation literal.

## Completion criteria

- [ ] Shell and feature CSS use shared semantic colors; exceptions are documented.
- [ ] Navigation identities agree across search, layers, tokens, and map glyphs,
      including the explicit airport/weather exception.
- [ ] Teal consistently identifies UI actions and keyboard focus; route cyan
      identifies route geometry and its legend.
- [ ] Weather marker and text variants come from the same shared definitions.
- [ ] Important labels and state indicators meet their contrast targets in the
      rendered interface, including hover and selected backgrounds.
- [ ] Category, selection, error, freshness, and offline meaning remain clear
      with color removed or color-vision simulation applied.
- [ ] Check the main shell, open Layers, search results, route recommendations,
      airport weather/TAF, plates, settings, and degraded/offline states.
- [ ] Review bright VFR charts, IFR charts, and the basemap at representative
      desktop, tablet, and phone widths from `docs/features/responsive-layout.md`.
- [ ] `npm run verify` and relevant browser checks pass after implementation.

Shared token generation and the coordinated migration remain unimplemented. Some
existing runtime colors already match this palette; that does not establish shared
token ownership or completion of the rendered contrast checks.
