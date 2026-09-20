# Fix display

The IFR fixes toggle controls background reference fixes. The map enables this layer
by default and starts with low enroute fixes, using the FAA fix `charts` tags and
qualified airway endpoint records. Search and route resolution continue to use the
complete collection.

The layer menu provides two controls:

- **Show:** Enroute fixes, Enroute + SID/STAR fixes, or All fixes including approaches.
- **Enroute:** Low, High, or Both. All fixes includes both altitude bands.

Low enroute includes ENROUTE LOW, AREA, and published V/T airway members. High
enroute includes ENROUTE HIGH and J/Q airway members. Published oceanic route
fixes qualify in either view. SID, STAR, military SID/STAR, and SPECIAL DP tags
qualify for terminal detail. IAP-only, special/private/military approach-only,
unclassified, and other fixes require All fixes. A fix used both enroute and in an
approach remains an enroute fix. VFR waypoints retain their separate display layer.

Zoom only expands detail inside the selected categories. These are the earliest
eligible zooms; density limiting can defer crowded enroute fixes until zoom 10:

| Minimum map zoom | Background category |
| --- | --- |
| 6.5 (shared with airport circles) | All eligible enroute fixes; density/rank chooses the regional representatives |
| 11 | Terminal fixes, when enabled |
| 12 | Approach-only and other fixes, when All fixes is enabled |

Visibility cutoff and density are independent: background enroute fixes disappear
at the same zoom as the last airport circles, using a shared cutoff constant for
static and METAR-colored circles. A cross-layer regression test checks all three.
Above that cutoff, ranking favors junctions (two or more distinct relevant
airways), other airway fixes, then off-airway enroute fixes, with airway count and
stable identity breaking ties. Below zoom 10, only the highest-ranked eligible fix
in each Web Mercator cell is admitted (128 CSS pixels at integer zoom levels).
The cells are world-anchored and subdivide as zoom increases: panning does not
reshuffle winners, and zooming in admits more without demoting earlier winners.
Density uses integer tile zooms; the layer separately enforces the fractional
visibility cutoff. Density is computed when data or settings change, not on every
map movement. From zoom 10, normal symbol collisions handle enroute density.
Each background symbol and name is placed together; collision placement also
handles neighboring cell edges, other layers, and rotation.

This is our implementation of progressive decluttering, not ForeFlight's
undocumented ranking algorithm. ForeFlight documents [dynamic decluttering](https://foreflight.com/products/foreflight-mobile/maps/)
and [separate IFR/VFR waypoint controls](https://foreflight.com/enhancements/aeronautical-map-waypoint-settings).
Our ranking uses available FAA chart roles and airway membership, not traffic data.
Multiple airway names are a connectivity proxy, not proof of a geometric crossing.
Repeated segments or separate records for the same airway do not make a junction.
Airway matches use country, state, and ICAO region when provided; ambiguous
identifiers and navaid endpoints do not promote a fix. These priorities
describe chart/airway relevance, not measured flight frequency.

Selected fixes and active-route fixes use an independent source with no category
or background-toggle restriction, including below the airport-circle cutoff.
Their symbols remain visible, while labels can move or declutter.
Context is deduplicated by feature identity, not identifier.
Background copies are suppressed until the fix leaves the selection/route.

Route waypoint names use bright bold text on a 75%-opaque gray rectangular
backing. Nameplates stay horizontal, prefer the right side of the marker, and
fall back to the left when crowded. Their text and backing declutter together
above map circles. Navigation and weather omit duplicate labels for the displayed
route's feature IDs; clearing the route restores their ordinary labels. Selected
fixes outside the displayed route retain their normal label styling.

Fix shape uses the FAA NASR attributes in both background and context layers.
Waypoints (`WP`, `MW`, `NRS`) and fixes with an `RNAV` charting remark use a
four-point star; other fixes retain the standard triangle. Reporting points (`RP`
and `MR`) can carry that RNAV remark, so use code alone is insufficient. Shapes
follow the [ForeFlight legend](https://cloudfront.foreflight.com/docs/ff/15.9/Foreflight%20Legends%20Guide%20v15.9.pdf).

VFR waypoint diamonds and VPxxx labels share one placement decision from zoom 10,
so they appear and declutter together while staying hidden at wider map scales.

Airway data loads when IFR fixes are enabled and shares the existing request cache
with route planning. If it is unavailable, chart tags still filter the background;
junction ranking resumes after a successful fetch. The plate viewer does not
decode procedure legs, so opening a plate alone does not add its fixes to the map.
Those fixes remain accessible through search, route entry, or All fixes.

Run `npm run verify` for classification, search/route preservation, and layer
lifecycle checks. `/test/browser/fixes.html` provides a real MapLibre fixture for
zoom thresholds, detail controls, and selected-fix visibility with the background
disabled.
