# Data-source register

Initial research: 2026-09-12. Implementation status reviewed from source 2026-09-20;
AWC API limits and OSMF/COD access policies rechecked on 2026-09-18.

This register separates a useful product idea from permission to automate it. Each
adapter needs a named owner, documented cadence, request budget, attribution, sample
fixtures, fallback behavior, and a source-change monitor before production use.

## Source matrix

| Priority | Product | Preferred source/access | Form | Current disposition |
|---|---|---|---|---|
| P0 | VFR sectional/TAC/flyway; IFR low charts | `faa-regs` output at `https://charts.tedyin.com/charts/` | coverage-limited raster layers | Whole-file spatial/zoom packages and legacy sheets implemented; IFR high remains planned |
| P0 | US airports, runways, NAVAIDs, fixes, airways | FAA 28-day NASR subscription via `faa-regs` | search/detail + GeoJSON map features and route geometry | Cycle-aware navigation, decluttering and V/T airway expansion implemented; vector tiles remain an option for measured density needs |
| P0 | Airport diagrams, approaches, departures, arrivals, and minima | FAA d-TPP XML/PDF via `faa-regs` | airport procedure catalog + selected PDFs | Exact-page books, individual FAA fallbacks, georeferenced IAP overlays and regional offline saves implemented |
| P0 | Chart Supplements | FAA d-CS XML/books via `faa-regs` | airport/page catalog + whole PDF books | Exact-page viewer and saved regional targets implemented; independent supplement interval retained |
| P0 | Preferred/TEC routes and SID/STAR topology | FAA preferred-route and NASR exports via `faa-regs` | recommendations and compact route previews | Optional national references shared by route planning and regional saves |
| P0 | Historical filed routes | Aeronautic AQ snapshot packaged by `faa-regs` | frequency-ranked recommendations | Gzip JSON decoded/indexed in a worker; source observation range retained |
| P0 | METAR, TAF | AWC Data API; AWC full-dataset caches where appropriate | colored airport pins + detail | METAR map observations and selected-airport raw TAF periods implemented; shared static snapshot publisher remains |
| P0 | Terrain | Packaged elevation from the chart feed; Mapzen Terrain Tiles on AWS (Terrarium) fallback | 500/1,000 ft route contours and translucent elevation bands; viewport elevation shading | [4/8 NM route corridor or viewport](route-terrain.md), visible demand, bounded worker cache; regional saves include terrain packages |
| P0 | Obstructions | FAA Daily DOF packaged by `faa-regs` | worker-indexed point symbols with source date | [Viewport/route decluttering](route-obstructions.md) and on-demand caching implemented; excluded from regional completeness |
| P0 | GPS aircraft | Device Geolocation API | position, true ground track and one-minute projection | Enabled by default with permission; saved Off preference respected; shared with AHRS; installed-device checks remain |
| Experimental | AHRS toolbox | Device Motion API and shared GPS; optional WMM2025 coefficients from the chart feed | attitude, GPS instruments, HSI and local recordings | Implemented with visible validity/uncertainty states; device and flight validation remain outstanding |
| P0 | PIREP/AIREP | AWC API/cache files | vector tiles + detail | Approved for spike within published limits |
| P0 | SIGMET, G-AIRMET, Alaska AIRMET, CWA | AWC GeoJSON/API/cache files | vector tiles | Approved for spike within published limits |
| P0 | Station, airport, NAVAID, fix | AWC API; infrequent station cache | reference tiles/search | Approved for spike within published limits |
| P0 | Surface fronts, troughs, highs/lows | WPC high-resolution coded surface bulletin | parsed vectors | Validate endpoint and parser before integration |
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
see [ADR 0005](adr/0005-offline-snapshot-authority.md#publisher-boundary).

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
history; optional [AHRS recordings](../src/layers/ahrs/recording.md) store GPS fixes,
motion samples and estimator output locally. Nothing is uploaded automatically.

GPS is optional for AHRS calibration and continued attitude display, including
when no fix has ever been received. Missing/slow GPS and high tilt uncertainty
keep a red cross over the calibrated, live IMU indication. Usable GPS and acceptable
tilt uncertainty clear it; see the [display policy](../src/layers/ahrs/README.md#calibration-and-validity).
GPS-derived readings and HSI guidance retain their own GPS requirements.

The HSI discovers optional [NOAA/BGS WMM2025 coefficients](https://doi.org/10.25921/aqfd-sd83)
through the browsing cycle's navigation manifest. It computes magnetic variation
from position, altitude and UTC date. The model is valid for 2025–2029, independently
of the FAA cycle. It is cached after loading but is not included in regional saves.
Missing, invalid or expired coefficients and weak polar fields make the HSI use
true north with an explanation. This conversion does not align AHRS heading, and it
does not replace a VOR's published station alignment. See the
[AHRS guide](../src/layers/ahrs/README.md#compact-hsi) for model limits and heading gates.

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
See [offline procedures](offline-procedures.md) for publisher commands and document identity.

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

Implication: one controlled scheduled publisher should feed many viewers. Use cache files
where they reduce query count and parse cost, and use constrained API calls for
products without caches or for explicit detail/history queries.

The client reads same-origin `/weather/metars.geojson`. Vite and the production
nginx configuration proxy it to bounded AWC GeoJSON queries. While an airport's
Info card is open, an absent or older-than-two-hours METAR triggers a `bbox`
search within 50 NM. As with TAFs, the nearest current observation is selected
by default, and a matching dropdown lists station IDs, distances, and directions.
Older saved reports remain selectable with a Stale label. Nearby observations
stay in the labeled METAR section; they do not supply the selected airport's map
category or runway wind components. TAFs use
`/weather/tafs.json?ids=<ICAO>&format=json`, proxied to `/api/data/taf`, only while
an airport's Info card is open. If its own forecast is unavailable, cancelled, NIL,
or expired, a bounded `bbox` query finds TAF stations within 50 NM. The card defaults
to the nearest current forecast, shows the source station's distance and direction,
and offers the other stations in a dropdown. Expired saved forecasts remain
selectable and explicitly labeled when current data is unavailable. The nearest
station is a geographic default; it is not a claim of equivalent local weather.
This follows [ForeFlight's nearby-forecast convention](https://support.foreflight.com/hc/en-us/articles/203723849-How-are-TAF-and-MOS-forecasts-selected-to-display-for-an-airport).

METARs and TAFs both keep product-owned, per-station caches in memory and localStorage
(`zlayers.metars.v1` and `zlayers.tafs.v1`). Both retain the latest saved report after
empty or failed requests, restore reports without claiming freshness, revalidate
online, and bypass service-worker weather fallback with `cache: 'no-store'`.
Both endpoints also explicitly bypass that fallback regardless of request cache
mode. TAFs refresh every five minutes while the Info card is visible, versus one
minute for demanded METARs, and retain up to 200 stations versus 5,000 METAR stations.
Nearby METARs and TAFs share their respective caches with direct station lookups,
including station coordinates for offline discovery; switching among fetched alternatives needs no
extra station request. Cached observations and forecasts remain available
offline with their timestamps and stale state visible. Only fetched weather is
saved; regional chart downloads do not prefetch weather. A shared scheduled snapshot
publisher remains a future alternative to per-viewer API queries.

TAF text stays coded. The AWC JSON `fcsts` entries supply visibility in statute miles
and cloud bases/vertical visibility in **feet**, unlike METAR GeoJSON cloud bases
in hundreds of feet. Raw change groups are matched to the decoded periods by type
and start/end time and probability, tolerating wrapped whitespace and case variants.
Australian `INTER` groups match AWC's decoded `TEMPO` representation. Coloring uses the more restrictive ceiling/visibility category;
TEMPO/PROB and BECMG inherit unchanged elements from prevailing conditions, while
FM starts a new forecast. Unknown or mismatched data stays neutral. Temporary groups
spanning multiple prevailing periods use the most restrictive applicable category.
The match is deliberately conservative: if raw and decoded periods disagree, raw
text remains visible without category colors. This is not a general raw-TAF decoder.
The opening line shows the full validity range in the device's time zone; FM
lines show their local start time. These muted, right-aligned labels include the
abbreviated month, day, 24-hour time, and zone, plus the year when it differs from
the current year. Same-day ranges share their date and zone unless the zone
changes; see [date and currency labels](date-time-display.md).
The timestamps come from the AWC report's validity bounds or matched FM period,
so month/year rollover and daylight saving are handled as dated instants rather
than guessed from the current date.
See the [AWC API schema](https://aviationweather.gov/data/schema/openapi.yaml) and
[ForeFlight flight categories](https://support.foreflight.com/hc/en-us/articles/204019615-What-do-the-colors-of-the-Flight-Category-dots-mean).

## WPC surface analysis

WPC publishes surface analyses every three hours and documents both standard and
high-resolution coded surface bulletins. The high-resolution bulletin represents
fronts/troughs as ordered coordinates precise to tenths of a degree and pressure
centers as pressure-coordinate pairs. This is preferable to georeferencing a chart
image because it produces selectable, stylable vector features.

The WPC integration spike must pin the authoritative latest/archive URLs, save fixtures,
and implement rollover-safe valid-time parsing. Keep a link to the corresponding WPC
chart as the authoritative visual cross-check. WPC's general shapefile directory is
useful for later products but its advertised subset should not be assumed to contain
the surface analysis.

References:

- [WPC surface-analysis description and schedule](https://www.wpc.ncep.noaa.gov/html/about_sfc.shtml)
- [High-resolution bulletin format](https://www.wpc.ncep.noaa.gov/html/read_coded_bull_hr.shtml)
- [WPC GIS products](https://www.wpc.ncep.noaa.gov/html/about_gis.shtml)

## Satellite and radar

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
as a fallback when no packaged source is available; see [route terrain](route-terrain.md).

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
