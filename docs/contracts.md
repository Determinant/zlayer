# Static data contracts

Top-level catalogs have `schemaVersion`; persisted route drafts use `version` as
documented below. Source-derived navigation and airway documents carry cycle metadata and are validated
against the catalog revision. Coordinates use WGS 84 GeoJSON order: longitude,
latitude.

Airway and preferred-route documents use `ZLayerAirways` and
`ZLayerPreferredRoutes` as their `type`. The reference loader normalizes the two
former product identifiers before validation so already published or cached chart
packs remain usable. All cycle, count, and record checks still apply.

The optional `CatalogResponse.routeHistory` resource comes from the navigation
manifest's `route-history` product. It includes gzip and decoded byte lengths, pair
and route counts, source provenance and observation dates. Its document is
`ZLayerRouteHistory`, version 1, with `countBasis: source-filed-route-use-count`.
The loader validates the chart cycle, source digest, observation bounds, unique pairs
and routes, and agreement between engine counts, route counts and pair totals. Source
observation dates are independent of the chart cycle and always remain visible in
recommendations. A malformed optional history resource does not disable FAA data.

## Catalog

```json
{
  "schemaVersion": 1,
  "generatedAt": "2026-09-12T20:00:00Z",
  "revision": "2026-09-03",
  "charts": [
    {
      "id": "vfr-sectional-san_francisco",
      "title": "Sectional · San Francisco",
      "kind": "vfr-sectional",
      "revision": "2026-09-03",
      "format": "mbtiles",
      "bounds": [-125.95, 35.86, -117.63, 40.64],
      "minZoom": 5,
      "maxZoom": 12,
      "byteLength": 132173824,
      "sha256": "00817bd5c6ec565386ab4e5603f3977581f085c6cb13c59b2132c9a29b23287c",
      "url": "https://charts.tedyin.com/charts/2026-09-03/vfr-sectional-san_francisco.mbtiles?sha256=00817bd5c6ec565386ab4e5603f3977581f085c6cb13c59b2132c9a29b23287c&bytes=132173824"
    }
  ],
  "navigation": [
    {
      "id": "fixes",
      "title": "IFR fixes",
      "count": 2882,
      "sourceCount": 70089,
      "minZoom": 9,
      "url": "./charts/2026-09-03/nav/fixes.geojson"
    }
  ],
  "airways": {
    "id": "airways",
    "title": "Victor and Tango airways",
    "count": 814,
    "sourceCount": 1553,
    "url": "./charts/2026-09-03/nav/airways.json"
  },
  "procedures": {
    "id": "procedures",
    "title": "Airport procedures",
    "cycle": "2609",
    "effectiveDate": "2026-09-03",
    "expirationDate": "2026-10-01",
    "airportCount": 112,
    "sourceAirportCount": 3197,
    "procedureCount": 854,
    "sourceProcedureCount": 24231,
    "url": "./charts/2026-09-03/tpp/catalog.json"
  },
  "weather": []
}
```

This is a minimal legacy-sheet example of the implemented runtime contract, not a
live inventory or a saved-region record. Package feeds also include `chartPackages`;
navigation may advertise `preferredRoutes`, `terminalProcedures` and `routeHistory`.
The client assembles this catalog from the publisher's separate manifests; see
[chart feed](chart-feed.md). Reference URLs include the export version, and committed
snapshots additionally retain `jsonSha256` identities where captured.

Each viewed MBTiles response is verified
against its publisher-provided byte length and SHA-256, then retained as one Cache
Storage object. A service worker answers SQLite range reads from its cached `Blob`. A
future transport change requires an explicit, runtime-validated schema revision while
product IDs and feature identity remain stable.

## Feature

```json
{
  "type": "Feature",
  "id": "navaid:US:CA:SNS:VORTAC",
  "geometry": { "type": "Point", "coordinates": [-121.60318413, 36.66383744] },
  "properties": {
    "kind": "navaid",
    "ident": "SNS",
    "type": "VORTAC",
    "name": "SALINAS"
  }
}
```

Stable feature IDs identify exact route pins; display identifiers are not unique.
Airport features may include `frequencies[]` from the same cycle's FAA `FRQ.csv`.
Each record has `type` (`ATIS`, `D-ATIS`, `AWOS`, `ASOS`, `TOWER`, `CTAF`, or
`GROUND`) and numeric `frequencyMHz`, plus optional published `use`, `sector`,
`hours`, and `remarks`. The producer joins the serviced FAA facility identifier,
state, country, and facility type; it never substitutes a nearby station's radio.
The Info summary shows elevation, longest runway, weather broadcast, Tower/CTAF,
and Ground. Frequencies use compact aligned rows; matching Tower/CTAF channels
combine, and sectors remain visible. A chevron expands hours, remarks, and additional
UHF channels. VHF channels lead the summary. Frequency precision is retained to
three decimal places.
`hours` preserves FAA `TOWER_HRS` verbatim and is labeled **Tower hours** only
under Tower; its presence on an ATIS or Ground source row does not establish that
service's operating hours. `remarks` preserves the source `REMARK` text.
Older exports without frequencies remain valid and show the available airport
facts. Rebuild and publish `faa-regs` navigation with the `FRQ` ZIP to add the
frequencies; existing saved regional snapshots retain their original data.

VOR-family records may include `stationDeclinationDeg`, the published station
alignment in degrees relative to true north, east positive (finite, −180 to 180).
The NASR producer derives it from `NAV_BASE.csv` `MAG_VARN` and `MAG_VARN_HEMIS`;
missing or invalid values remain absent. It is the facility's recorded alignment,
not a current geomagnetic model estimate. Feature ID details show MB (magnetic
bearing/radial) prominently and TB (true bearing) separately; map labels show
only MB and distance. Older exports remain valid: missing alignment marks MB as
unavailable while retaining distance and TB in the details. The normal `faa-regs`
chart build includes station alignment through its existing NASR stage. Rebuild
and publish the cycle's `nav/` products to enable magnetic radials; previously saved
snapshots retain their original data.
ID can supplement missing alignment from a validated rebuild of the same cycle
when station identity and coordinates match, without modifying those snapshots.
The versioned supplement shares the normal offline reference cache.

Published typed waypoints must resolve uniquely. A missing pinned feature or
unavailable required point is an error, not permission to substitute another feature.
The [routing guide](routes.md) owns parsing, ambiguity, airway/TEC expansion and edit
rules; [SID/STAR previews](terminal-procedures.md) owns procedure limitations.

Every airway segment must publish a boolean `gap` from FAA `AWY_SEG_GAP_FLAG`.
Only explicitly present segments with `gap: false` may be traversed in either
direction. Exports without gap flags fail validation. Rebuild and upload `nav/`
with `npm run build:nav` in faa-regs; a dated local rebuild requires
`--source-dir=/path/to/zips --cycle=YYYY-MM-DD`. Chart MBTiles need no rebuild.
Invalid cached airway documents are discarded and retried on the next load.

Optional `preferredRoutes` and `terminalProcedures` resources supply typed FAA
route definitions. Route loading is keyed by national source identity and resource
metadata, including URL, count, cycle and captured JSON digest. Planning and
recommendations use one national edition without clipping it to chart coverage;
partial availability is reported explicitly.

## METAR

AWC METAR snapshots use GeoJSON points with the source station ID, observation time,
reported flight category, ceiling/visibility, wind, and raw observation preserved.
The client joins them to FAA airports by ICAO ID. On the rendered airport feature,
normalized presentation fields use `flightCategory`, `metarObservedAt`,
`metarCeilingFt`, `metarVisibilitySm`, and `rawMetar`.
`metarCeilingStatus` distinguishes measured, no reported ceiling, and unknown sky
conditions so the decoded METAR section keeps its Ceiling field visible. Ceiling
uses AWC GeoJSON's hundreds-of-feet values, falling back to the lowest broken,
overcast, or vertical-visibility layer. When decoded layers are unavailable, only
cloud groups in the raw observation are parsed; remarks and forecast trends are
excluded. Missing heights remain unknown rather than becoming a clear-sky claim.
When a ceiling layer has an unknown base, other measured layers still bound the
ceiling: an 800 ft overcast layer retains the known IFR restriction even if another
broken layer's base is missing. That bound is not displayed as an exact ceiling.
Without an AWC-supplied category, an unknown ceiling can establish a restrictive
category from known layers or visibility, but cannot establish VFR.

Catalog, navigation, airway, and METAR documents are runtime-validated before entering client
state. A matching report without enough ceiling/visibility information remains
available for details and renders with category `N/A`; it is not discarded.

METAR and TAF station choices rank current reports before stale/expired reports,
then by distance, treating the airport's own report as zero distance. The local
report remains selectable after it ages; a manual selection survives refreshes.
NIL observations and NIL/cancelled forecasts are excluded from station choices.

## TAF

AWC TAF JSON is an array of runtime-validated `TafReport` objects with `icaoId`,
`issueTime`, epoch-second `validTimeFrom`/`validTimeTo`, `rawTAF` and `fcsts`.
Forecast periods retain `timeFrom`, `timeTo`, `timeBec`, `fcstChange`, probability,
visibility in statute miles and cloud bases/vertical visibility in feet. These
units differ from the METAR GeoJSON representation. The original coded text is
preserved; period colors are derived separately and never joined into METAR map
categories. Missing or mismatched forecast data is shown without a category color.
The forecast cache retains the latest issuance/amendment for each selected station;
failed refreshes do not update the last successful check or erase a saved forecast.

## Route

```json
{
  "version": 2,
  "entries": [
    {
      "id": "entry-1",
      "text": "KPAO",
      "pinnedFeatureId": "airport:02022."
    }
  ]
}
```

The current route draft uses localStorage key `zlayer-route-draft-v1` with version 2
records. Version 1 text/index pins migrate on read. Entry IDs persist through edits;
`pinnedFeatureId` is optional and identifies an explicitly chosen feature. Resolved
coordinates, legs and distances are derived from the active routing references,
not persisted as truth. A missing pinned feature is an error, not a substitute point.
See [routes](routes.md) for entry ownership, compatibility and editing rules.

## Workspace persistence

The map camera uses localStorage key `zlayers-map-view-v1` with version 1 records
containing a validated `[longitude, latitude]` center and zoom. It restores the
camera before map creation, including bearing and pitch (older records default
these to zero). Wrapped longitudes are valid. Movement completion, page hiding,
and map teardown save synchronously, including interrupted pan/zoom animations.
GPS's automatic first fix and restored recommendation previews do not recenter a
restored view. Explicit GPS centering and route fitting still move the camera.
Missing, invalid, or unavailable storage falls back to the KPAO regional default.

Workspace presentation uses independent `zlayer-ui:<key>` localStorage records,
each `{ version: 1, value }`, through `core/storage/ui-state.ts` and
`core/ui/use-persistent-state.ts`. Each owner validates its own record, restores
before rendering, and writes synchronously on actions. Defaults are never written
just because a component mounted; unavailable async data must not erase an open
panel or a selection. Explicit closing persists as well as opening. Denied/full
storage leaves session controls usable. These records are local to this origin.

The first-visit installation and safety notice uses
`zlayer-ui:welcome-acknowledged` with `{ version: 1, value: true }` after **I understand**.
Missing, invalid or false values show the notice before mounting the workspace,
so restored panels cannot cover it. Escape cannot dismiss it. If storage is denied
or full, acknowledgement still opens the workspace for that page session, but
the notice can return on reload. Full local reset clears the acknowledgement.
The flag is not tied to an app release or notice revision: ordinary updates,
including notice edits, do not request acknowledgement again. Requiring renewed
acknowledgement would need an explicit change to this persistence contract.

Restored presentation includes Layers, Settings and its region query/storage
details, nested About, the selected map-edge toolbox, feature details and their
Info/Plates tab, route details, and recommendations (aircraft filter, selection,
expanded conditions and row limits). Feature snapshots retain their source key;
unavailable editions remain unavailable rather than adopting another edition.
Plate selection retains the exact document URL, integrity metadata, edition and
original target; page, zoom, fullscreen and scroll position are remembered per
document/plate. Actual PDF page counts bound restored pages. PDFs and live data
still use their normal loaders, caches and validation. Loading/error flags,
in-progress gestures and transient context menus are not durable UI state.

AHRS remembers its full-screen preference, but calibration and estimator state do
not resume after reload. A fresh IMU calibration does not require a GPS fix. During
a calibrated session, the warning cross does not imply absent or frozen attitude:
live IMU indication remains visible with no fix, slow GPS or high tilt uncertainty.
See the [display policy](../src/layers/ahrs/README.md#calibration-and-validity).
Optional recordings use separate IndexedDB metadata and JSON Lines chunks; see the
[recording contract](../src/layers/ahrs/recording.md).
Settings' [full local reset](offline-storage.md#full-local-reset) deletes these
records along with saved regions, caches and preferences. Shareable route/view URLs
remain planned; text route copying and native sharing are already available.

## Procedure

```json
{
  "id": "2609:KHWD:3fded428ae46bf2e",
  "kind": "approach",
  "name": "RNAV (GPS) RWY 28L",
  "pdfUrl": "https://aeronav.faa.gov/d-tpp/2609/05015R28L.PDF",
  "namedDestination": null,
  "volumeTarget": {
    "volumeId": "SW2",
    "section": null,
    "printedPage": "94",
    "pageIndex": 219
  },
  "source": { "chartCode": "IAP", "chartSequence": "53525" }
}
```

The zero-based volume page is builder-verified; it is not derived from the printed
page number in the browser. Individual FAA URLs and named destinations remain as
fallbacks. Unknown chart codes and source fields are preserved.

## Offline package

A saved region plan records its ID, title, FAA revision, required reference URLs,
and whole-file dependencies. Hosted chart/books carry their URL, byte length and
SHA-256. Individual-only FAA PDFs use cycle/export-versioned URLs and receive local
size/hash receipts after downloading. Source catalogs retain validity and attribution.

The client persists selection intent in IndexedDB before downloading. Committed
selections reference immutable catalog snapshots and exact reference identities,
including validated JSON digests captured during preparation. Verified files
go directly into the shared whole-file caches, not a separate staging copy. Completion
is derived from cached file receipts and schema/cycle-valid reference documents when
Settings checks a selection; transfer progress is not a persisted completeness claim.
Activation commits only after verification. A failed update retains the previous
snapshot; later eviction degrades availability without changing edition ownership.
See [offline storage](offline-storage.md) for repair, compatibility and retention.

## Airport runway details and wind components

Airport navigation properties may contain `runways[]`, each with an `id`, optional
`lengthFt`, `widthFt`, `surface`, `condition`, and `lighting`. The FAA publisher joins
`APT_RWY_END.csv` to `APT_RWY.csv` by `SITE_NO`, `SITE_TYPE_CODE`, and `RWY_ID` and
adds optional `ends[]`:

```ts
{ id: string; trueHeadingDeg?: number; trafficPattern?: 'left' | 'right' }
```

`TRUE_ALIGNMENT` supplies the true heading (0–360 degrees). The right-hand traffic
flag maps `Y` to `right` and `N` to `left`; blank values remain absent. Unspecified runway patterns display as “Left” under the
[AIM 4-3-3 default](https://www.faa.gov/air_traffic/publications/atpubs/aim_html/chap4_section_3.html),
with a tooltip distinguishing the fallback from explicit data. Published right
patterns take precedence; the default does not apply to helipad ends (`H…`). The client accepts earlier feeds
without runway ends and shows their runway identifiers and dimensions. It does not
infer true headings from runway numbers or pattern directions from L/R suffixes.

Map selection restores full airport properties from navigation reference data, since
MapLibre can serialize nested GeoJSON properties. Search and map clicks therefore
open the same runway data.

Navigation owns runway metadata and the Runways section at the end of airport Info.
METAR contributes per-end components and notation notes using the existing
visible-airport observation cache. The reported wind remains in the Info table and
is not repeated in the Runways section.
The compact table groups each runway end’s heading, traffic pattern, and wind; G
marks gust components and L/R indicates wind from the left/right. Opening airport
Info starts no separate weather fetch. Observation time and cache status remain
visible above the airport details. Shared domain code calculates components from the
METAR wind FROM direction and the runway true heading:

- Headwind = speed × cos(wind direction − runway heading); negative means tailwind.
- Crosswind = speed × sin(wind direction − runway heading); positive means FROM right.
- Gust components use the reported gust speed at the same reported mean direction.

Both directions use true north. Components display rounded knots, with “<1” for
small nonzero components. Calm, variable (`VRB`), missing winds, and missing headings
have explicit states. Directional variation groups are shown separately; components
use the reported mean, not the extrema. The display estimates wind components and
does not determine the active runway, closures, or aircraft limits.

Sources: [FAA NASR subscription](https://www.faa.gov/air_traffic/flight_info/aeronav/aero_data/NASR_Subscription/)
and [AWC METAR wind definitions](https://aviationweather.gov/help/data/#metar).
The richer fields require rebuilding and publishing the FAA `nav/` export along
with the client update; earlier published data remains compatible.

## Chart Supplement catalog

`cs/catalog.json` is a small, independently refreshed metadata feed, loaded only
when an airport's Plates tab opens or Settings prepares regional downloads.
Saved airports use the captured supplement targets from their read context.
`ChartSupplementCatalog` includes the original
book URLs, SHA-256 hashes, sizes, page counts, and airport FAA IDs mapped to exact
zero-based page indexes. Printed page labels are display metadata, never viewer
indexes. The validator rejects duplicate/unknown books, duplicate airport/page
targets, invalid hashes, and out-of-range pages. The CS validity interval must
contain the selected chart revision; it need not equal the shorter TPP interval.
