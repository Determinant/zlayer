# Data-source register

[Documentation](../README.md) / Data

Initial research: 2026-09-12. Implementation status reviewed from source 2026-09-20;
AWC API limits and OSMF/COD access policies rechecked on 2026-09-18.

This register separates a useful product idea from permission to automate it. Each
adapter needs a named owner, documented cadence, request budget, attribution, sample
fixtures, fallback behavior, and a source-change monitor before production use.

## Contents

- [Source matrix](#source-matrix)
- [Tedyin aeronautical charts](#tedyin-aeronautical-charts)
- [FAA aeronautical reference data](#faa-aeronautical-reference-data)
- [Device sensors and magnetic reference](#device-sensors-and-magnetic-reference)
- [Historical filed routes](#historical-filed-routes)
- [FAA terminal procedures](#faa-terminal-procedures)
- [AWC constraints that shape the system](#awc-constraints-that-shape-the-system)
- [WPC surface analysis](#wpc-surface-analysis)
- [Satellite and radar](#satellite-and-radar)
- [Basemap policy](#basemap-policy)
- [Adapter readiness checklist](#adapter-readiness-checklist)

## Source matrix

| Priority | Product | Preferred source/access | Form | Current disposition |
|---|---|---|---|---|
| P0 | VFR sectional/TAC/flyway; IFR low charts | `faa-regs` output at `https://charts.tedyin.com/charts/` | coverage-limited raster layers | Whole-file spatial/zoom packages and legacy sheets implemented; IFR high remains planned |
| P0 | US airports, runways, NAVAIDs, fixes, airways | FAA 28-day NASR subscription via `faa-regs` | search/detail + GeoJSON map features and route geometry | Cycle-aware navigation, decluttering and V/T airway expansion implemented; vector tiles remain an option for measured density needs |
| P0 | Airport diagrams, approaches, departures, arrivals, and minima | FAA d-TPP XML/PDF via `faa-regs` | airport procedure catalog + selected PDFs | Exact-page books, individual FAA fallbacks, georeferenced IAP overlays and regional offline saves implemented |
| P0 | Chart Supplements | FAA d-CS XML/books via `faa-regs` | airport/page catalog + whole PDF books | Exact-page viewer and saved regional targets implemented; independent supplement interval retained |
| P0 | Preferred/TEC routes and SID/STAR topology | FAA preferred-route and NASR exports via `faa-regs` | recommendations and compact route previews | Optional national references shared by route planning and regional saves |
| P0 | Historical filed routes | Aeronautic AQ snapshot packaged by `faa-regs` | frequency-ranked recommendations | Gzip JSON decoded/indexed in a worker; source observation range retained |
| P0 | METAR, TAF | AWC through the TypeScript cache gateway | colored airport pins + detail | Latest coded METAR and AWC TAF periods, normalized and cached in the browser |
| P0 | Terrain | Packaged elevation from the chart feed; Mapzen Terrain Tiles on AWS (Terrarium) fallback | 500/1,000 ft route contours and translucent elevation bands; viewport elevation shading | [4/8 NM route corridor or viewport](../../src/layers/terrain/README.md), visible demand, bounded worker cache; regional saves include terrain packages |
| P0 | Obstructions | FAA Daily DOF packaged by `faa-regs` | worker-indexed point symbols with source date | [Viewport/route decluttering](../../src/layers/obstructions/README.md) and on-demand caching implemented; excluded from regional completeness |
| P0 | GPS aircraft | Device Geolocation API | position, true ground track and one-minute projection | Enabled by default with permission; saved Off preference respected; shared with AHRS; installed-device checks remain |
| Experimental | AHRS toolbox | Device Motion API and shared GPS; optional WMM2025 coefficients from the chart feed | attitude, GPS instruments, HSI and local recordings | Implemented with visible validity/uncertainty states; device and flight validation remain outstanding |
| P0 | PIREP/AIREP | AWC API/cache files | vector tiles + detail | Approved for spike within published limits |
| P0 | Domestic SIGMET, G-AIRMET, CWA | AWC through the TypeScript cache gateway | bounded GeoJSON | [Advisory timeline and server normalization](../../src/layers/weather-awc/README.md) implemented; [Weather service](../../tools/weather-server/README.md#deployment) |
| P0 | Alaska AIRMET, international SIGMET | AWC API/cache files | bounded GeoJSON candidate | Coverage/source qualification remains |
| P1 | Clouds, freezing height, icing probability/severity/SLD | NOAA HRRR and DAFS/IFI GRIB2 | immutable numeric grids; client shading and point values | [Server preparation and browser caching implemented](../../src/layers/weather-awc/grids/README.md); gateway on GCP behind DO’s HTTPS proxy, source caveats and reference-device validation remain |
| P1 | Winds and temperature aloft | NOAA HRRR CONUS pressure-level GRIB2 | numeric vectors/temperature; zoom-spaced barbs and optional shading | [Browser-derived MSL slices below 18,000 ft and flight levels from FL180](../../src/layers/weather-awc/grids/winds.md), with core caching; reference-device qualification remains |
| P0 | Station, airport, NAVAID, fix | AWC API; infrequent station cache | reference tiles/search | Approved for spike within published limits |
| P0 | Surface pressure charts, fronts and ridges | AWC Progs catalog and WPC GeoJSON | server-prepared vectors | [Progs implemented](../../src/layers/weather-awc/progs/README.md); NOAA isobars/labels represent ridges; operational comparison remains outstanding |
| P1 | NEXRAD mosaic | NOAA nowCOAST OGC services or another explicit NOAA distribution endpoint | raster tiles | Compare latency, coverage, and service policy |
| P1 | GOES visible/IR | NOAA GOES-R open object-store data or nowCOAST OGC service | COG/raster tiles | Preferred production path; benchmark both modes |
| Reference only | COD NEXLAB satellite imagery | Link to NEXLAB with credit | outbound link | No automated retrieval without written permission |
| P2 | NWS watches/warnings/advisories | NWS API/NOAA geospatial service | vector tiles | Separate aviation relevance and clutter spike |
| P2 | SPC outlooks | Official SPC GIS products | vector tiles | Source/cadence contract needed |
| P2 | WPC QPF/excessive rain/winter weather | WPC GIS files | vector/raster by product | Add only after time semantics are normalized |

## Tedyin aeronautical charts

The sibling `faa-regs` repository builds and maintains the MBTiles published at
`https://charts.tedyin.com/charts/`. The client supports VFR sectional/TAC/flyway and IFR low
chart overlays. Their upstream content is based on FAA chart products; preserve the
`faa-regs` build revision, Tedyin publication provenance, and FAA edition.

Coverage is discovered from all published chart records, with no California-only
allowlist. The client keeps the continuous basemap visible outside that coverage and
does not interpret an absent regional chart tile as an outage.

The feed publishes machine-readable chart, navigation and procedure manifests. The
client discovers available dates from the root `cycles.json` and validates the
selected date's manifests before using their bounds and file identities. The current
schemas and publication rules are in [chart feed](chart-feed.md). An atomic release
descriptor and immutable older metadata exports remain publisher improvements;
see [ADR 0005](../adr/0005-offline-snapshot-authority.md#publisher-boundary).

FAA publishes georeferenced VFR and IFR charts and updates the digital equivalents as
their paper editions change. Keep the FAA effective date visible in the app, even when
the delivery artifact comes from Tedyin.

References:

- [Tedyin chart feed](https://charts.tedyin.com/charts/)
- [FAA VFR raster charts](https://www.faa.gov/air_traffic/flight_info/aeronav/digital_products/vfr/)
- [FAA IFR raster charts](https://www.faa.gov/air_traffic/flight_info/aeronav/digital_products/ifr/)

## FAA aeronautical reference data

Use the FAA 28-day NASR subscription as the canonical structured source for airport
pins and routeable aviation references in the US and territories. NASR provides the
reference data underneath the chart: landing facilities, runways, NAVAIDs, fixes,
airways, and related records. The FAA publishes current, preview, and archived cycles
and warns when legacy TXT/CSV formats change, so ingest must be fixture-tested and
cycle-aware.

AWC station and airport endpoints remain valuable for global coverage and live-weather
joins, but they should not define whether a US airport exists. Preserve public/private
use, facility type, status, location/elevation, runway characteristics, and identifiers
needed for filtering, display ranking, search, and details. The user must still consult
NOTAMs for the latest operational changes.

NAVAID frequency details display Unicode Morse derived from the published facility
identifier, using the [FAA Morse alphabet](https://www.faa.gov/air_traffic/publications/atpubs/aim_html/chap4_section_2.html).
VOR, DME, TACAN, NDB, and their combined facilities use that identifier; VOT and
marker-beacon records are excluded. Localizer formatting includes the initial
`I` described in [FAA AIM 1-1-9](https://www.faa.gov/air_traffic/publications/atpubs/aim_html/chap1_section_1.html),
with LDA and SDF distinctions from [FAA Location Identifiers 1-2-7](https://www.faa.gov/air_traffic/publications/atpubs/LID/0102.htm).
The current `NAV_BASE` export does not include localizers; displaying those facilities
also requires an ILS source in the producer. Morse is shown only alongside an existing
published frequency and represents the expected identifier from reference data.

The blue **ID** action on every feature uses up to six VOR-family records within
100 NM from that feature's navigation edition, regardless of map visibility or
route membership. Stations 5–60 NM away rank first, with MON candidates preferred
inside that band and distance breaking ties. Outside it, proximity to the band
ranks fallbacks; stations within 0.05 NM of the point are omitted. The top three
receive dark-blue dashed map connections with a white rim, labelled with MB and distance while the ID list is open.

MON preference uses the [FAA VOR Candidate Retention List dated 2026-02-24](https://www.faa.gov/sites/faa.gov/files/VOR%20Candidate%20Retention%20List%202026-02-24.xlsx),
a bundled snapshot of 594 identifier/state pairs in `packages/domain/src/mon-vors.ts`.
The file records the source and workbook hash; refresh these pairs and date when
the FAA revises the list. Non-US records do not match. Candidate retention is
separate from the station's operational status and does not promise reception.

The producer preserves FAA station magnetic alignment from `NAV_BASE.csv` as
east-positive `stationDeclinationDeg`, so station-relative radials do not use a
current magnetic model in place of the station's recorded alignment. Distances
are geographic ground distances: [FAA AIM 1-1](https://www.faa.gov/air_traffic/publications/atpubs/aim_html/chap1_section_1.html)
distinguishes them from DME slant range. MB (magnetic bearing/radial) is prominent;
TB (true bearing) is displayed separately in the list. Missing alignment marks MB
as unavailable while retaining TB and distance, without substituting TB for MB. Published
non-operational stations and VOTs are excluded. Magnetic alignment comes from
the existing navigation export and its offline snapshot; ID uses no additional
online magnetic model or service.

For older saved exports missing alignment, ID revalidates that cycle's navigation
manifest and reads its versioned navaid export from the configured chart feed
(`charts.tedyin.com/charts` by default, `/chart-data` through the deployment proxy).
It fills only missing alignment on matching station identities and coordinates;
saved export bytes, membership, positions, and existing alignment stay unchanged.
The supplement uses the normal validated reference cache and works offline once
cached. If it is unavailable or does not match, ID retains TB and reports MB missing.

References:

- [FAA 28-day NASR subscription](https://www.faa.gov/air_traffic/flight_info/aeronav/aero_data/NASR_Subscription/)
- [FAA aeronautical data overview](https://www.faa.gov/air_traffic/flight_info/aeronav/aero_data/)
- [FAA airport data notice](https://www.faa.gov/air_traffic/flight_info/aeronav/aero_data/Airport_Data/)

## Device sensors and magnetic reference

GPS and AHRS use browser sensor APIs, with the permissions each browser requires.
The map and AHRS share one location watch. The GPS layer keeps no persistent position
history; optional [AHRS recordings](../../src/layers/ahrs/recording.md) store GPS fixes,
motion samples and estimator output locally. Nothing is uploaded automatically.

GPS is optional for AHRS calibration and continued attitude display, including
when no fix has ever been received. Missing/slow GPS and high tilt uncertainty
keep a red cross over the calibrated, live IMU indication. Usable GPS and acceptable
tilt uncertainty clear it; see the [display policy](../../src/layers/ahrs/README.md#calibration-and-validity).
GPS-derived readings and HSI guidance retain their own GPS requirements.

The HSI discovers optional [NOAA/BGS WMM2025 coefficients](https://doi.org/10.25921/aqfd-sd83)
through the browsing cycle's navigation manifest. It computes magnetic variation
from position, altitude and UTC date. The model is valid for 2025–2029, independently
of the FAA cycle. It is cached after loading but is not included in regional saves.
Missing, invalid or expired coefficients and weak polar fields make the HSI use
true north with an explanation. This conversion does not align AHRS heading, and it
does not replace a VOR's published station alignment. See the
[AHRS guide](../../src/layers/ahrs/README.md#compact-hsi) for model limits and heading gates.

## Historical filed routes

`faa-regs` converts the public Aeronautic AQ route-history SQLite snapshot into a
gzip JSON artifact alongside each cycle's navigation data. ZLayer reads this packaged
artifact rather than querying the source service. Recommendations retain the source
name, link and observation range, and rank routes by the snapshot's filed-route use
counts, optionally filtered by engine category. This dataset does not establish the
final ATC-cleared route or provide a guaranteed recent 15/30-day window.

The initial `nav/route-history.json.gz` package is about 9 MB. Browsers need neither
the upstream SQLite database nor an API key; worker decoding and indexing return
only query results to the UI.

The initial packaged snapshot spans 2025-02-14 through 2026-01-27; the chart cycle
must not be used to imply fresher route observations. See the producer's source
provenance in `nav/manifest.json` and [Aeronautic AQ](https://aq.aeronautic.ai/).

## FAA terminal procedures

Use the FAA digital Terminal Procedures Publication (d-TPP) and its XML metafile for
airport diagrams, instrument approaches, departures/ODPs, arrivals, and takeoff,
alternate, or radar minima. The XML exposes the cycle/effective interval and records
such as airport identifiers, chart code/name/sequence, procedure UID, action,
amendment, and PDF filename.

Most charts are individual PDFs. Minima and general-information products can be
multi-page volume PDFs; FAA search results deep-link to an airport inside them with a
PDF named destination such as `sw2to.pdf#nameddest=(PAO)`. Preserve and validate that
destination rather than scraping text or asking the user to search the whole volume.

`faa-regs` owns source discovery, XML normalization, checksums and bound-book indexing.
It publishes the small metadata catalog and original combined volumes. ZLayer loads
books when viewed or explicitly saved and uses the narrow FAA proxy for individual
plates without a bound target. Client startup never downloads the full collection.
See [offline procedures](../../src/layers/plates/README.md) for publisher commands and document identity.

ZLayer consumes the cycle-versioned catalog, groups entries by airport and procedure
kind, and lazy-loads the selected PDF. The original FAA chart code and all source
metadata remain available even when a new code is not yet understood by the UI.

References:

- [FAA d-TPP product catalog](https://www.faa.gov/air_traffic/flight_info/aeronav/productcatalog/DigitalProducts/dtpp/)
- [FAA current d-TPP and XML metafile](https://www.faa.gov/air_traffic/flight_info/aeronav/digital_products/dtpp/)
- [FAA d-TPP XML definitions](https://aeronav.faa.gov/d-tpp/Metafile_XML_Definitions.pdf)
- [FAA d-TPP search](https://www.faa.gov/air_traffic/flight_info/aeronav/digital_products/dtpp/search/)

## AWC constraints that shape the system

The [AWC Data API](https://aviationweather.gov/data/api/) currently provides up to
30 days of database access and documents METAR, TAF, aircraft reports, SIGMET,
G-AIRMET/AIRMET, CWA, TCF, station/airport/navigation, and related products.

- Maximum 100 requests per minute.
- Most endpoints return at most 400 entries.
- Browser CORS is not permitted.
- A custom user agent, bounded queries, delays between requests, and cadence-aware
  polling are requested.
- Full current cache files are recommended for large/frequent datasets; advertised
  cache cadence is one minute for several current datasets, ten minutes for TAFs,
  and daily for stations.
- Valid empty queries may return HTTP 204 (except GeoJSON) and must not be treated as a source outage.

ZLayer uses one [weather server](../../tools/weather-server/README.md) for AWC,
NOMADS IFI and HRRR from Google's public NOAA mirror. It respects source rate limits,
validates complete responses, normalizes advisory snapshots and prepares numeric
native grids in bounded workers through a shared cache. The PWA validates compact
artifacts, interpolates selected wind altitudes, and keeps rendering, point
inspection and durable offline caching. Valid empty responses and
failed refreshes remain different states. Forecast catalogs are published only after all their files are saved; HTTP reads
cannot start source acquisition or preparation. See the
[server contract](../../tools/weather-server/README.md).
The [METAR/TAF guide](../../src/layers/metar-taf/README.md#source-access-and-report-presentation)
owns station demand, freshness and forecast interpretation.

### Source choices and unresolved alternatives

AWC remains the report/advisory source through the shared server. The retired
NWS/GIS experiments did not preserve the complete contract: NWS sensor updates
could omit coded METAR text, TAF required separate XML/bulletin joins and had
incomplete nearby discovery, and advisory text/geometry differed in sampled
responses. NOAA GIS bulk reports had a roughly ten-minute publication cadence
and bounded text columns. Sampled G-AIRMET alternatives omitted forecast hours,
freezing contours or their heights. These are reasons for the current source
choice, not claims that every alternative always fails.

Google's public NOAA HRRR mirror supplies both indexes and ranges. Captured
[sample comparisons](../../src/layers/weather-awc/validation/2026-09-23-hrrr-direct.json)
matched selected Google/AWS bytes; unused index parameter names could differ, so
indexes must come from the same mirror as their GRIB data. Current reads happen
on the server, with no browser CORS dependency. The
[grid contract](../../src/layers/weather-awc/grids/README.md#browser-source-and-cache-contract)
owns source identity and numeric validation.

The [DAFS inventory](https://www.nco.ncep.noaa.gov/pmb/products/dafs/) identifies
operational IFI on NOMADS. A substitute must supply the same current cycles,
fields, 60 native levels and forecast hours. Historical RAP/NBM icing, surface ice
accumulation and similarly named NWS gridpoint fields do not meet that contract.
No equivalent replacement was qualified. Negative-SLD encoding, late-hour input
lineage and independent depiction checks remain in the
[owning source guide](../../src/layers/weather-awc/grids/README.md#source-meaning-and-limits).

## WPC surface analysis

WPC surface analysis and forecast charts reach Progs through the same catalog and
GeoJSON products used by AWC's web view. The [owning guide](../../src/layers/weather-awc/progs/README.md)
records exact source paths, chart identity, source bounds and the dependency on
AWC's web-product interface rather than a documented stable API. The weather server
prepares full pressure contours, source labels, H/L and tropical centers, distinct
front/boundary types and frontogenesis/frontolysis qualifiers. Each chart's own
reference cycle and absolute valid time are retained, including mixed-cycle
publication and daily forecasts through seven days.

Progs also acquires AWC's companion NDFD PNGs for precipitation/weather shading.
They have separate source checks and can be missing at otherwise published chart
stops. Original colors, source hashes, native valid times and explicit gaps are
retained; the filename cycle is not an NDFD issuance time. The
[coverage contract](../../src/layers/weather-awc/progs/README.md#precipitation-and-weather-coverage)
records bounds, legend meaning and the limits of this AWC web interface.

NOAA contours and chart annotations depict pressure ridges; no local ridge axis
is derived. The earlier coded bulletins omit isobars and combine several boundaries
into TROF, so they cannot satisfy the complete chart contract. Captured fixtures
cover all files in one source catalog. Broader archived-source and operational
comparison remains outstanding. WPC's general GIS directory should not be assumed
to contain every surface chart field.

References:

- [AWC Progs catalog](https://aviationweather.gov/api/data/progchart)
- [AWC API access policy](https://aviationweather.gov/data/api/)
- [WPC surface chart](https://www.wpc.ncep.noaa.gov/html/sfc2.shtml)
- [WPC surface-analysis description and schedule](https://www.wpc.ncep.noaa.gov/html/about_sfc.shtml)

## Satellite and radar

Implemented locally: [Radar](../../src/layers/weather-awc/radar/README.md) combines
NOAA MRMS quality-controlled composite reflectivity with FAA TDWR product 180
terminal detail. The weather server acquires numerical GRIB2/Level III observations,
prepares contours once, and publishes immutable files for all viewers. Current
observations expire after 15 minutes. A rolling two-hour history supports timeline
rewind: national scans backfill from NOAA S3, while terminal history accumulates as
scans arrive. An optional storm-motion overlay uses NOAA NEXRAD STI/product 58
forecast cell positions from NWS TGFTP, collected and cached independently by the
same server. Motion history accumulates as scans arrive and follows the displayed
radar time. Automatic playback remains planned.

College of DuPage demonstrates the desired high-resolution, multi-band, rapid-loop
experience. Its [terms](https://weather.cod.edu/terms/) permit linking to images with
credit but ask users not to automate downloads without explicit permission. ZLayer
therefore treats COD as a product reference/outbound link until permission exists.

NOAA provides native GOES-R data through public cloud object stores, including ABI
and GLM products. Direct use gives the project a stable, automatable production path
but requires projection/color processing and careful bandwidth control. nowCOAST
provides NOAA layers through OGC web services and is a useful lower-complexity option.
The imagery spike compares:

- source-to-screen latency and update cadence;
- effective resolution and available bands;
- time-dimension discovery and cache headers;
- tile reprojection/color quality and bandwidth;
- reliability, usage policy, and operational ownership.

References:

- [NOAA/NCEI GOES-R collection access](https://www.ncei.noaa.gov/access/search/datasets/goesr-abi-level-1b-radiances/)
- [NOAA nowCOAST](https://nowcoast.noaa.gov/)
- [COD NEXLAB terms](https://weather.cod.edu/terms/)

## Basemap policy

The current local style uses opaque USGS Topo tiles, which include shaded relief,
with USGS attribution and bundled identifier glyphs. It does not request the separate
USGS shaded-relief service. `VITE_ZLAYERS_BASEMAP_TILE_URL` replaces those default
tiles; `VITE_ZLAYERS_BASEMAP_STYLE_URL` replaces the complete style. These basemap tiles
are not bulk-downloaded by regional saves. Route terrain uses separate elevation
packages from the chart feed, including saved regional packages, with Mapzen Terrarium
as a fallback when no packaged source is available; see [route terrain](../../src/layers/terrain/README.md).

OpenStreetMap was the initial preferred basemap data source and remains a provider
option, not the current default or an unlimited production tile host. Both OSM
Foundation raster and vector services are best effort, require
visible attribution, identification/referrer behavior, and cache compliance, and
prohibit bulk downloading. Their URLs must remain configurable.

Before public beta, confirm the current provider or select a hosted/self-hosted build with
clear terrain, contours/topography, and hillshade, sized for expected traffic. Record
its style/data licenses, attribution string, update cadence, cost, SLA, privacy
behavior, and offline/prefetch terms. Basemap coverage is continuous and independent
of the regional FAA chart-overlay feed.

References:

- [USGS Topo service and included themes](https://basemap.nationalmap.gov/arcgis/rest/services/USGSTopo/MapServer)
- [OSMF raster tile policy](https://operations.osmfoundation.org/policies/tiles/)
- [OSMF vector tile policy](https://operations.osmfoundation.org/policies/vector/)
- [MapLibre GL JS](https://maplibre.org/maplibre-gl-js/docs/)

## Adapter readiness checklist

- [ ] Official endpoint and a human-readable product page are recorded.
- [ ] Permission/terms, attribution, user-agent, and contact requirements are recorded.
- [ ] Cadence, expected publication delay, history window, and revision behavior are known.
- [ ] Rate/concurrency budget and conditional-request behavior are configured.
- [ ] Success, empty, stale, malformed, rate-limited, and outage fixtures exist.
- [ ] Raw and normalized schemas have versions and bounds.
- [ ] Source-to-screen latency and data-quality metrics are emitted.
- [ ] UI legend, units, valid time, source link, and stale behavior are reviewed.
- [ ] Fallback/retention policy is explicit and tested.
