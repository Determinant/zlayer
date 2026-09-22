# Product brief

[Documentation](../README.md) / Product

Status: product direction; implementation status reviewed from source 2026-09-20
Initial research date: 2026-09-12

The scope and acceptance scenario below include planned capabilities. The current
app provides VFR/IFR low charts, FAA navigation, persisted routes and recommendations,
METARs/TAFs, plates with optional georeferenced map overlays, anchored approach previews,
regional offline snapshots, packaged route/viewport terrain, FAA obstructions and optional
device GPS. An experimental AHRS toolbox provides attitude, GPS instruments,
HSI guidance for straight route legs and local recordings with GPX/JSON Lines downloads; device and
flight validation remain outstanding. The camera, open panels
and plate reading state restore across reloads. Settings offers a full reset of local
app data. A local Route Stash saves and manages named structured route snapshots.
Text route copying and sharing are implemented; shareable route/view URLs,
the shared timeline, advisories, radar/satellite and route-corridor downloads remain
planned. See the [roadmap](roadmap.md) for the implemented baseline and
remaining work, and [deployment readiness](../development/deployment.md) for release gates.

## Contents

- [Problem](#problem)
- [Primary users and jobs](#primary-users-and-jobs)
- [Experience principles](#experience-principles)
- [Target scope](#target-scope)
- [Non-goals for the first release](#non-goals-for-the-first-release)
- [Performance and quality budgets](#performance-and-quality-budgets)
- [Target acceptance scenario](#target-acceptance-scenario)

## Problem

Aviation weather is organized by producer and product, while a pilot's question is
usually spatial and temporal: what matters near this airport, along this route, and
during this time window? Existing pages often make the user switch views, reload
large layers, reconcile different clocks, or inspect imagery separately.

ZLayer should reduce that coordination cost without obscuring the authoritative
source or the age and validity of the data.

## Primary users and jobs

- A general-aviation pilot checks current conditions and adverse weather around a
  departure, destination, alternate, or route corridor, while keeping the familiar
  sectional or IFR chart visible.
- A dispatcher or frequent user scans several products quickly and needs keyboard,
  saved-layer, and shareable-state workflows.
- A weather enthusiast explores synchronized observations, analyses, and imagery
  without downloading the same national dataset on every pan.

The initial release is US/CONUS-first. Global AWC products should remain possible,
but they do not drive the first storage and basemap scope.

## Experience principles

1. **Time is a first-class dimension.** A single UTC timeline controls compatible
   layers. Analysis time, issue time, valid interval, and observation time remain
   distinct.
2. **Freshness is visible.** Each layer shows last success, expected cadence, age,
   and stale/degraded state. Stale data is never silently presented as current.
3. **Weather wins the visual hierarchy.** Roads and place labels are subdued;
   airports, airspace context, boundaries, terrain, and weather remain legible.
4. **Progressive disclosure.** The map answers “where?” at a glance; selection opens
   decoded detail alongside the source text and authoritative link.
5. **Fast by construction.** Fetch only active products, the visible extent, and a
   short time window. Cancel obsolete work during pan, zoom, or time scrubbing.
6. **Honest provenance.** Every feature and pixel layer can identify its producer,
   retrieval time, valid time, transformation, and source URL.
7. **Local first, refresh second.** Restore the last usable map and route immediately;
   check for new cycles and weather only after interaction is available.
8. **Offline is explicit.** A user can see exactly which route, chart, reference, and
   procedure artifacts are downloaded, verified, current, and ready without a network.
9. **Opened procedures persist.** A successfully opened procedure is cached by cycle
   for offline reuse without implying that its airport or region is fully downloaded.

## Target scope

### Map and navigation

- Responsive desktop/tablet layout; graceful narrow-screen layout.
- VFR sectional with TAC/flyway overlays, IFR low, and continuous basemap context;
  IFR high and a production basemap-provider decision remain planned.
- FAA airport, heliport, NAVAID, fix, and airway features rendered independently of
  the raster chart so they can be selected, searched, filtered, and updated.
- Airport/station search, geolocation, bookmarks, shareable URL state, and UTC clock.
- Simple multi-leg route entry by search, map selection, or a token string; reorder
  and remove waypoints and show great-circle leg/total distances.
- Add an airport, NAVAID, or fix to the route directly from its detail card.
- Airport detail groups airport diagrams, approaches, departures/ODPs, arrivals, and
  takeoff/alternate/radar minima and opens the exact selected FAA document location.
- Successfully opened procedure PDFs are cached on demand and remain visibly tied to
  their FAA cycle.
- A route-scoped offline action saves selected chart coverage, reference data, and
  airport procedures with size, cycle, expiration, progress, and readiness status.
- Chart edition/effective date is always visible; expired charts produce a prominent
  state and cannot silently fall back to an older cycle.
- Mutually comprehensible layer groups: observations, advisories, analysis, imagery,
  and reference.
- Layer opacity, legend, age, and loading/error state.
- Timeline with latest, pause, scrub, step, and short animation controls.

### Experimental attitude indicator

The experimental toolbox provides mounted-device attitude, GPS instruments, HSI
route guidance and local recordings. Keep calibrated attitude usable when optional
GPS aiding is absent, with explicit uncertainty and sensor warnings. Distinguish
heading, ground track and relative yaw visibly; a display reference must not imply
that the estimator has established heading. Give the pilot explicit control over
stopping or continuing a sensor session when stowing the toolbox.

The [AHRS guide](../../src/layers/ahrs/README.md) owns the
[calibration and recovery policy](../../src/layers/ahrs/README.md#calibration-and-validity),
[HSI reference and guidance rules](../../src/layers/ahrs/README.md#compact-hsi) and
[sensor lifecycle](../../src/layers/ahrs/README.md#sensors-and-display-lifecycle).
[Validation](../../src/layers/ahrs/validation.md) records the numerical evidence and
remaining device/flight checks. These detailed contracts live with the plugin.

### Observations and aviation products

- METAR stations colored by flight category, clustered or culled by zoom.
- Raw and decoded METAR/TAF detail with units kept explicit.
- PIREPs/AIREPs with age, altitude, type, and turbulence/icing filters.
- SIGMETs, G-AIRMETs, Alaska AIRMETs, and CWAs as selectable polygons.
- Stations, airports, NAVAIDs, and fixes only when useful at the current zoom.
- Route-corridor filtering that visually emphasizes weather relevant to the current
  route without hiding other enabled hazards.

### Products beyond the current core AWC map

- WPC high-resolution coded surface analysis rendered as native front/trough lines
  and high/low pressure centers.
- A tiled NEXRAD composite.
- A tiled GOES visible or infrared product with a short, synchronized loop.
- Optional phase-two products: NWS alerts, SPC outlooks, WPC QPF/excessive rainfall,
  lightning, forecast winds/temperature, icing/turbulence grids, and NHC tracks.

### Trust and safety

- Persistent “supplemental planning tool” notice and links to official products.
- Source attribution in the map and details: USGS for the default basemap, terrain
  source providers, and OpenStreetMap when an OSM-derived replacement is configured.
- Prominent stale-data indicators and a data-health panel.
- Offline packages show completeness, checksum state, cycle, expiration, storage use,
  and whether the browser granted persistent storage.
- Preserve raw source payloads for troubleshooting and transformation audits.
- Never decode away qualifiers or imply that missing data means benign conditions.

## Non-goals for the first release

- Filing flight plans or replacing an official briefing provider.
- Hazard avoidance, dispatch release, or go/no-go recommendations.
- Wind-corrected navigation logs, fuel/reserve calculations, performance calculations,
  or terrain/obstacle-clearance assurance.
- A certified EFB, a guaranteed nationwide preloaded navigation database, or a
  worldwide chart replacement.
- Long-range climatology or indefinite raw-data archival.
- Reimplementing every AWC, WPC, SPC, and satellite product at launch.

## Performance and quality budgets

Measure these on a representative mid-range tablet and a throttled network. Cached
launch measurements run with the network disabled:

- Installed cached launch to interactive last-used map: p75 under 750 ms, with no
  network response on the critical path.
- Shell and usable basemap: p75 under 2.0 seconds on warm repeat visits.
- First active weather layer: p75 under 3.0 seconds when upstream data is cached.
- Pan/zoom/time-scrub interaction: p95 frame time under 32 ms; target 60 fps.
- Layer toggle feedback: visible within 100 ms, even if data continues loading.
- Cached selected procedure to readable requested page: p75 under 1.0 second.
- iPhone downloads must not retain whole large books/archives in RAM. Stream to
  bounded local storage, bound concurrent transfers and retained bytes, and fail
  cleanly when storage is unavailable. The reported KVGT crash at approximately
  177 MiB downloaded is a required device regression; see
  [memory constraints](../verification/memory-resources.md#iphone-download-constraint-kvgt-2026-09-21).
- No application-generated task over 50 ms during steady-state map interaction on the
  reference device.
- No national point layer delivered as a single unbounded browser payload. This
  remains a target: today's feed downloads whole national reference exports lazily.
  Rendered density and cache retention are bounded; delivery-size budgets still
  need measurement, with tiled delivery an option if required.
- Latest cached product remains readable during a source outage and is marked stale.

Performance numbers are release targets, not measured guarantees. Release validation
must establish the test device, network profile, dataset sizes and baseline measurements.

## Target acceptance scenario

A user enters `KPAO SNS KSBP`, views the route over the current VFR sectional, selects
an airport pin for runway and METAR/TAF detail, enables PIREPs and the latest WPC
surface analysis, then plays six GOES frames. The map stays interactive; the chart
cycle, route distance, and all weather times/sources are clear. An upstream AWC timeout
changes only that source's health indicator while cached data remains visibly marked
with its actual age.

The user then saves the route offline with procedures for KPAO and KSBP. After an
airplane-mode restart, the same chart and route appear immediately, airport search
still works, and the user can open a selected approach and the KPAO takeoff-minimum
destination without searching a full TPP PDF. Weather snapshots remain labeled with
their actual observation/valid times and stale state.
