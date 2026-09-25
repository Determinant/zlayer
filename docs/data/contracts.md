# Client data contracts

[Documentation](../README.md) / Data

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

## Contents

- [Catalog](#catalog)
- [Feature](#feature)
- [METAR](#metar)
- [TAF](#taf)
- [AWC advisories](#awc-advisories)
- [AWC forecast grids](#awc-forecast-grids)
- [WPC surface snapshots](#wpc-surface-snapshots)
- [Route](#route)
- [Workspace persistence](#workspace-persistence)
- [Procedure](#procedure)
- [Offline package](#offline-package)
- [Airport runway details and wind components](#airport-runway-details-and-wind-components)
- [Chart Supplement catalog](#chart-supplement-catalog)

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
The [routing guide](../../src/layers/routes/README.md) owns parsing, ambiguity, airway/TEC expansion and edit
rules; [SID/STAR previews](../../src/layers/routes/terminal-procedures.md) owns procedure limitations.

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

`ZLayerTerminalProcedures.approaches`, when present, is a `ZLayerApproachRoutes`
document from the same effective date. Its airport-scoped procedure identifiers,
published transition branches and common/final/missed coded legs retain fix
coordinates and roles, RF centers, turn directions and explicit endpoint-free
legs. It is optional for older exports. Approach entry selection requires this
data; the chart catalog alone cannot supply route geometry. Existing national
reference identity and offline guards validate the nested document.

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

Default METAR acquisition uses AWC through the shared weather gateway for map,
card and nearby queries. `X-Weather-Checked-At` preserves the upstream check time
on cache hits; attempt time and observation time remain separate. Station batches,
nearby area queries and card refreshes retain the original AWC semantics. Older
reports cannot replace newer usable observations. Saved reports from the retired
direct adapters retain `source: NOAA` or `source: NWS` for honest offline labels;
legacy raw-less NWS sensor records are discarded on restore. See the
[plugin source contract](../../src/layers/metar-taf/README.md#source-access-and-report-presentation).

## TAF

The report contract follows AWC TAF JSON: runtime-validated `TafReport` objects with `icaoId`,
`issueTime`, epoch-second `validTimeFrom`/`validTimeTo`, `rawTAF` and `fcsts`.
Forecast periods retain `timeFrom`, `timeTo`, `timeBec`, `fcstChange`, probability,
visibility in statute miles and cloud bases/vertical visibility in feet. These
units differ from the METAR GeoJSON representation. The original coded text is
preserved; period colors are derived separately and never joined into METAR map
categories. Missing or mismatched forecast data is shown without a category color.
The forecast cache retains the latest issuance/amendment for each selected station;
failed refreshes do not update the last successful check or erase a saved forecast.
The gateway forwards AWC TAF JSON without joining or reconstructing bulletins.
Nearby TAF discovery retains AWC area-query coverage.

## AWC advisories

`AwcAdvisorySnapshot` version 1 carries one family (`gairmet`, `sigmet`, `cwa`),
the successful upstream `checkedAt`, source URI, explicit `frameTimes`, and validated
advisories. Times are UTC epoch **milliseconds**. Each advisory has an opaque
content identity, native identifier/issuer/hazard, nullable issue time, geometry,
altitude description, original bulletin text and preserved source properties. An
absent or null CWA hazard normalizes to `UNK` (displayed as **Unspecified hazard**),
with `sourceProperties` preserved unchanged; no hazard is inferred
from bulletin text. Other supplied hazard codes remain intact. An
optional `severity` string preserves G-AIRMET qualifiers; older snapshots use the
preserved source property when displaying severity. Domestic SIGMET numeric
severity codes are not interpreted as G-AIRMET text qualifiers.
G-AIRMET stores a forecast hour and instantaneous valid time; interval advisories
store an exclusive `validTo` and no forecast hour. The guard rejects mixed families,
duplicate identities, invalid coordinates/rings, inconsistent forecast frames and
invalid timestamps. Do not infer issue time from validity or model history from a
successful check. Complete empty snapshots replace prior data; failures retain it.
The server normalizes AWC collections into snapshots, retaining full bulletin text
and weather properties. G-AIRMET normalizes its atomic five-frame package, including
freezing contours. The browser validates these snapshots before using or saving them.
The [plugin guide](../../src/layers/weather-awc/README.md) owns delivery, time
selection, completeness limits and cache labeling.

## AWC forecast grids

The server discovers a validated native-source manifest from NOAA GRIB indexes.
Its shared plugin contract retains exact field ranges, source-index digests, model
cycle and altitude identity. Background Node workers verify GRIB metadata and
prepare the complete native generation before its catalog becomes public. HTTP
forecast requests only read these saved files. The browser verifies artifact
identity, checksum and numeric bounds before rendering or saving through core. See the
[grid guide](../../src/layers/weather-awc/grids/README.md#browser-source-and-cache-contract).
Winds retain pressure-coordinate source catalogs and derive selected MSL/flight-level
slices with a separate converter/altitude identity; the [winds guide](../../src/layers/weather-awc/grids/winds.md#source-and-levels)
owns interpolation and saved-preference migration.
The older preconverted format below remains for archived feeds and fixtures.

`AwcGridManifest` version 1 separately validates HRRR cloud/freezing/winds and IFI icing
families, immutable generation paths, native time/altitude identities, numeric
field order, bounds/dimensions, byte limits and SHA-256. Cloud bundles contain five
fields; icing bundles contain three compatible fields at one altitude. Wind bundles
contain pressure-surface height, true east/north wind components and temperature,
with an explicit `pressureHpa` value (100–1000, 25 hPa steps) and null MSL altitude.
Cloud/icing frames cannot carry a wind pressure coordinate. See the
[owning grid contract](../../src/layers/weather-awc/grids/README.md#published-contract)
for the binary header, units, sentinels, sampling and lifecycle. The browser
validates numeric data before displaying or caching it. Advisory snapshots and
numeric grids have independent generations and source clocks.

## WPC surface snapshots

`SurfaceCatalog` version 3 describes a prepared WPC `analysis` or `forecast`
family from AWC's public Progs catalog. The small catalog contains freshness,
ordered frame identities, bounded geometry/document counts, and immutable chart
paths with byte lengths and SHA-256. `SurfaceArtifact` version 1 files retain the
processing revision and full chart. Source-check updates do not rewrite these
files. The browser assembles `SurfaceSnapshot` version 2 for existing selection,
rendering and inspection consumers. It preserves the original catalog,
source URL, family source hash and minimum `checkedAt`. Each ordered frame has
its own `validTime`, `referenceTime` (cycle, not issuance), source URL, byte SHA-256,
source check, complete original GeoJSON and normalized features. All times are
UTC epoch milliseconds. Forecast families may contain mixed reference cycles.

Features retain source properties: H/L and tropical centers, independent text
labels, isobars, and directed cold/warm/stationary/occluded/trough/dry-line/squall
lines with forming/weakening qualifiers. Pressure numbers remain source-positioned
labels; no inferred center/contour association is published. Isobar and front/boundary
geometry contains prepared AWC-style cardinal curves, retaining every source control
point and all 16 subdivisions per segment. Families are bounded to 8 MiB and
400,000 positions to accommodate the complete smoothed forecast horizon.
Date-line splits use MultiLineString geometry. Raw-file hash and source ordinal
identify each feature; family identity also includes the processing revision.
The runtime guard bounds frames, features, coordinates and source bytes and
rejects malformed times, duplicate identities and unsupported feature types.
The server validates every catalog-listed chart before atomic family publication;
the browser revalidates before state or optional storage accepts it. See
[Progs](../../src/layers/weather-awc/progs/README.md) for source interface dependency,
ridge representation, frame selection, freshness and recovery.

`ProgsCoverageCatalog` version 1 separately describes AWC's NDFD weather shading
at native chart stops. Each frame has `validTime`, `chartReferenceTime`, source
URL and `checkedAt`; `chartReferenceTime` is a filename cycle, not NDFD issuance.
An optional `file` carries an immutable `coverage/<sha256>.png` path, SHA-256 and
byte length. Its absence means AWC returned 404 for that stop; it breaks coverage
selection rather than extending an earlier image. The catalog retains the original
source catalog and its hash. PNGs have fixed AWC Web Mercator bounds, supported
900×600/1800×1200 RGBA geometry, and unchanged source colors. Limits are 32 stops,
64 KiB per catalog, 1 MiB per image and 8 MiB for all listed images. The server
validates images before independent atomic publication; the browser authenticates
their hashes before rendering or saving. The [Progs coverage guide](../../src/layers/weather-awc/progs/README.md#precipitation-and-weather-coverage)
owns source limitations, image gaps, time selection, rendering and cache recovery.

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

The current route draft uses localStorage key `zlayer-plugin:routes:draft` with version 2
records. The former `zlayer-route-draft-v1` slot and version 1 text/index pins migrate on read. Entry IDs persist through edits;
`pinnedFeatureId` is optional and identifies an explicitly chosen feature. Resolved
coordinates, legs and distances are derived from the active routing references,
not persisted as truth. A missing pinned feature is an error, not a substitute point.
See [routes](../../src/layers/routes/README.md) for entry ownership, compatibility and editing rules.

## Workspace persistence

The map camera uses localStorage key `zlayers-map-view-v1` with version 1 records
containing a validated `[longitude, latitude]` center and zoom. It restores the
camera before map creation, including bearing and pitch (older records default
these to zero). Wrapped longitudes are valid. Movement completion, page hiding,
and map teardown save synchronously, including interrupted pan/zoom animations.
GPS's automatic first fix and restored recommendation previews do not recenter a
restored view. Explicit GPS centering and route fitting still move the camera.
Missing, invalid, or unavailable storage falls back to the KPAO regional default.

Plugin presentation uses independent `zlayer-plugin:<plugin-id>:<key>` localStorage
records through core-managed storage scopes. Host presentation retains `zlayer-ui:<key>`.
Both use `{ version: 1, value }` and `core/ui/use-persistent-state.ts`. Each owner validates its own record, restores
before rendering, and writes synchronously on actions. Defaults are never written
just because a component mounted; unavailable async data must not erase an open
panel or a selection. Explicit closing persists as well as opening. Denied/full
storage leaves session controls usable. These records are local to this origin.
Routes retain their versioned entry format; each plugin stores its own version-2
preference record. Valid legacy records migrate when a namespaced record is absent;
existing invalid or unknown-version records never revive older legacy choices. The [saved workspace inventory](../architecture/workspace-persistence.md) lists owners,
coverage, migrations, intentionally transient state and cross-window limits.

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
details, nested About, the selected map-edge toolbox, the active/stowed right panel,
feature details and their Info/Plates tab or navaid identification, route details, and recommendations (aircraft filter, selection,
expanded conditions and row limits). Feature snapshots retain their source key;
unavailable editions remain unavailable rather than adopting another edition.
Plate selection retains the exact document URL, integrity metadata, edition and
original target; page, zoom, rotation, fullscreen and scroll position are remembered per
document/plate. Actual PDF page counts bound restored pages. PDFs and live data
still use their normal loaders, caches and validation. Loading/error flags,
in-progress gestures and transient context menus are not durable UI state.
The on-map IAP has a separate `plate-on-map` selection record. It rebuilds its
original approach from the exact document, preserving the camera, reader and
active panel; its effective dates remain visible. Failure offers Retry/Hide without
discarding the selection. Explicit hiding persists and cancels pending restoration.

AHRS remembers its full-screen and device-mount preferences, but calibration and estimator state do
not resume after reload. A fresh IMU calibration does not require a GPS fix. During
a calibrated session, the warning cross does not imply absent or frozen attitude:
live IMU indication remains visible with no fix, slow GPS or high tilt uncertainty.
See the [display policy](../../src/layers/ahrs/README.md#calibration-and-validity).
Optional recordings use separate IndexedDB metadata and JSON Lines chunks; see the
[recording contract](../../src/layers/ahrs/recording.md).
Settings' [full local reset](../features/offline-storage.md#full-local-reset) deletes these
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
See [offline storage](../features/offline-storage.md) for repair, compatibility and retention.

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

## Radar observations and history

`RadarCatalog` and `RadarContours` (schema version 1) describe server-prepared NOAA
MRMS/TDWR scans. Every immutable path pins station, observation time and SHA-256;
scan metadata retains the original source URL/hash and geographic bounds. Contours
carry dBZ thresholds. The catalog identifies failed station checks separately from
latest saved files. Its optional `history` array adds up to 1,200 immutable scan
references within two hours of publication, retaining schema-version-1 compatibility.
Each station/observation pair is unique within history; latest and history arrays
may reference the same file. Read-only prepared endpoints, numerical decoding,
observation-age limits, history retention, viewport demand and bounded whole-file caching are owned
by the [Radar guide](../../src/layers/weather-awc/radar/README.md).

`RadarMotionCatalog` and `RadarMotionSnapshot` (schema version 1) add independent
NOAA STI cell tracks. Catalog references pin immutable snapshot SHA-256 and size;
`availableAt` denotes collection time. Each snapshot keeps station observation
times, raw source URL/hash, cell IDs, forecast interval and current/projected
positions. Guards bound stations, tracks, coordinates, history and bytes. Motion
is never substituted across a historical gap or shown newer than the displayed
composite; [Storm motion](../../src/layers/weather-awc/radar/README.md#storm-motion)
owns selection and expiration rules.
