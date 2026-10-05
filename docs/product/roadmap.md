# Roadmap

[Documentation](../README.md) / Product

Build complete, testable features and resolve correctness and performance risks before
adding more data sources. Current capabilities and planned work are listed separately.

## Implemented baseline

- [Glide Planner](../../src/layers/glide/README.md): adjustable ratio and MSL start altitude,
  terrain-aware merged airport coverage within 20 NM of the route, and distinct
  ownship and selected-point planning ranges, cached by origin across pan and zoom.
  Optional off-field coverage reads published numeric route-density tiles and
  original detailed candidates inside calculated ranges. Glide package dependencies
  share verified regional downloads and chart-region edition ownership; legacy feeds
  remain readable. Publication coverage and real-world suitability remain validation work.
- Static React/MapLibre PWA with product-owned layer lifecycles and a precached shell.
- Viewport/zoom-selected, prestitched VFR and IFR low/high MBTiles with whole-file caching.
- Searchable FAA navigation with progressive fix decluttering and runway details.
- Persisted route entries and exact feature pins; direct/Victor/Tango routing,
  compact TEC routes, SID/STAR previews, anchored approaches with published entries or
  vectors to final, coordinate waypoints with compact/slash-separated seconds and
  whole-minute input normalized to compact seconds, map/touch/keyboard
  editing, text copying in three formats and sharing where the browser supports it.
- Local Route Stash with named structured snapshots, load/edit/remove/reorder,
  retained pins and approach attachments, and coordinated writes across windows.
- Restored map camera, panels, feature selection, recommendation choices and plate
  reading state; nearby-feature selection for overlapping map points.
- Historical filed-route, preferred and TEC recommendations with mapped previews.
- Airport plates and Chart Supplements in one exact-page PDF.js viewer, with an
  optional georeferenced IAP map overlay that restores independently of the viewer.
- [METAR/TAF](../../src/layers/metar-taf/README.md): saved local observations remain
  the default in airport details, with selectable nearby reports. Map category colors
  expire with observation age, while details retain the original category and age.
  Runway wind components remain available; selected-airport TAF periods show local
  validity times and visible stale/error states.
- Route-corridor contours and viewport terrain shading, packaged elevation and manual altitude
  comparison; FAA Daily DOF obstructions with viewport/route decluttering; optional
  GPS aircraft position, track, accuracy and one-minute projection.
- Experimental [AHRS toolbox](../../src/layers/ahrs/README.md) with attitude, GPS
  groundspeed/altitude/VSI, HSI guidance for straight route legs, calibration and local recordings
  with GPX track and JSON Lines debug downloads.
  Device and flight validation remain outstanding.
- State/territory offline downloads including charts, navigation, available route/approach
  references, published terrain and all applicable books/individual plates; size,
  integrity, progress, retry and shared-file removal.
- Committed regional snapshots retain edition ownership through feed updates and
  eviction; staged updates activate only after verification. Latest date discovery
  and explicit browsing dates stay independent of those saved selections.
- Protected browsing-cache expiry, temporary chart/PDF removal and safe shell cleanup.
- [Light/dark appearance](../features/shared-ui.md#appearance-and-colors) in General
  settings, with derived light colors and compatibility-preserving dark tokens.
- Coordinated PWA update prompts, complete-shell installation and installed-app Back
  navigation that unwinds active workspace controls.
- [Full local reset](../features/offline-storage.md#full-local-reset) with explicit confirmation,
  coordination across open windows and interruption recovery.
- Static-host deployment scripts and nginx data/weather/PDF proxies, bundled glyphs,
  TypeScript/unit/build gates, full Chromium regressions and a targeted
  Firefox/WebKit graphics matrix in CI.

## Next: release confidence and continuity

1. Complete the [remaining release gates](../development/deployment.md): installed
   iOS/Android offline, storage-pressure, GPS, AHRS, reset and terrain checks; broader
   WebKit offline-lifecycle coverage; and device timing/memory baselines. Keep each
   release's live host checks separate from local verification; a passing build does
   not publish it.
2. Review the remaining [color-system proposal](color-system-plan.md) separately
   from the implemented light/dark modes, and complete rendered contrast, focus,
   status and navigation/weather checks across supported layouts.
3. Add shareable route/view URLs. Explicit offline-region updates now discover Latest
   and replace the saved edition atomically after verification; different regions
   can retain different cycles. Immutable publisher metadata and an atomic release
   descriptor would further improve exact repair and date discovery;
   see [ADR 0005](../adr/0005-offline-snapshot-authority.md).
4. Extend regional downloads to route corridors, departure/destination/alternates,
   with an explicit inventory and the same shared whole-file cache.
5. Add a per-product storage breakdown beyond the existing origin usage/quota and
   cleanup controls, preserving saved regions and open views.
6. Expand performance/accessibility automation and select a production
   basemap/attribution policy before public beta.

Acceptance: cached launch stays interactive through source failure; saved data survives
an installed-device cold restart; incomplete data is never labeled complete; expiration
is visible rather than mistaken for freshness. See [offline storage](../features/offline-storage.md)
for today's guarantees and [product budgets](brief.md) for performance targets.

## Airport and procedure NOTAMs

Implemented with production collection enabled: the [NOTAM plugin guide](../../src/layers/notams/README.md)
owns the long-term contract. **Info | Plates | NOTAM** shows D/FDC notices with
conservative flairs and per-entry raw disclosures. Procedure rows and the expandable
red reader bar share snapshots and matching for the actual catalog/page/edition.

The existing info server maintains the full local NMS dataset under the guide's
[collection policy](../../src/layers/notams/README.md#collection-and-delivery), with
durable quotas and local-only browser queries. Staging and production authentication,
full loads and global deltas were exercised; see the guide's
[production verification](../../src/layers/notams/README.md#production-verification-october-5-2026).
Production UI notes identify FAA NOTAMs with their source-check time and actual
freshness/coverage state. Remaining work includes broader lifecycle/applicability
and alias qualification, sustained shared-weather capacity and installed-device checks.

## Radial/distance route positions

Implemented locally: [station-relative input and name/GPS/radial point descriptions](../../src/layers/routes/radial-distance-plan.md),
including multiple station choices, exact saved positions, explicit nearby named
replacement and display-only alternatives for published children. Copy, share and
ForeFlight handoff use destination formatting with coordinate fallback and visible
precision limits. Remaining qualification: live external-application import
comparison and physical-device checks; the owning design notes retain the scope
and regression requirements.

## Approach geometry and coverage

The [ordered interpreter and reference export](../../src/layers/routes/approach-geometry.md)
are implemented. The [coverage guide](../../src/layers/routes/approach-coverage.md#recorded-faa-2609-results)
owns dated state/national counts, unmatched charts, unoffered feeder starts and
radar/source-review exceptions. Passing selectable entries does not establish
nationwide chart coverage or correctness of every depicted maneuver.

Remaining work: publish the coordinated client/feed revision, reconcile unmatched
chart identities and unsupported families with authoritative source data, and
review the national diagnostic inventory. Continue per-cycle audits of source
coverage, branches, course/turn constraints and schematic bounds. Connected
schematic geometry alone does not establish correctness.

## Weather expansion

The `weather-awc` plugin implements G-AIRMET/domestic SIGMET/convective SIGMET/CWA display,
freezing contours, time selection and advisory normalization. See the
[plugin guide](../../src/layers/weather-awc/README.md) for current behavior.
The [grid pipeline and display](../../src/layers/weather-awc/grids/README.md) now add
cloud/freezing fields and native-altitude icing guidance to the same timeline.
The TypeScript AWC/NOMADS gateway is implemented with shared disk caching, bounded
refreshes, advisory normalization, numeric grid preparation and preserved source-check times.
HRRR uses Google as the server’s upstream; the PWA reads native prepared fields
and interpolates selected wind altitudes. The
[server guide](../../tools/info-server/README.md#deployment) owns backend and
HTTPS reverse-proxy deployment requirements, including release checks.
Independent operational comparison and reference-device
qualification remain outstanding; implementation is not flight validation.

### Observations and advisories

- METAR/TAF and SIGMET/CWA/G-AIRMET use the shared AWC gateway. METAR/TAF retain
  the original AWC batching, nearby queries and report presentation. Their direct
  NOAA/NWS adapters are retired; [source choices](../data/sources.md#source-choices-and-unresolved-alternatives)
  explain the coverage and freshness differences.
- Add PIREP/AIREP filtering/deduplication and altitude bands.
- Qualify Alaska AIRMET and international SIGMET as coverage extensions.
- Add route-corridor emphasis to the implemented UTC advisory timeline.

Acceptance: explicit source/valid times, bounded rendering at worst-case feature counts,
correct time boundaries, and one failed product never disabling the workspace.

### Cloud, freezing and icing forecasts

Implemented: HRRR cloud coverage/base/top and both freezing diagnostics; IFI
probability/severity/SLD at qualified native altitudes; worker conversion and core-cached numeric bundles,
point inspection, bounded optional caching and the shared timeline. Negative SLD
remains explicitly unknown and source bitmaps remain separate from terrain masks.

The server prepares HRRR from Google's public NOAA mirror and IFI from NOMADS.
Remaining: verify independent
operational depictions and late-hour input lineage; resolve negative-SLD encoding;
measure peak memory, scrubbing and readability on the reference tablet.

Acceptance: frame labels match rendered/numeric data, missing guidance remains
distinct from zero hazard, incompatible time/height grids are not combined, and
scrubbing/caching meets the existing product budgets. See the
[source limits](../../src/layers/weather-awc/grids/README.md#source-meaning-and-limits)
for the remaining qualification work.

### Winds and temperatures aloft

Implemented: HRRR CONUS hourly pressure-level winds and
temperature, independent zoom-spaced barbs over existing weather, optional
temperature shading, shared timeline, worker conversion and core caching.
The [winds guide](../../src/layers/weather-awc/grids/winds.md) specifies supported
levels and representative source/browser validation. MSL slices below 18,000 ft
and flight levels above are implemented. Extended forecast cycles and reference-device
benchmarks remain; repeat production
delivery checks for each release.

### Surface analysis and imagery

- Implemented locally: [Progs](../../src/layers/weather-awc/progs/README.md) adds
  AWC/WPC analysis and forecast isobars, source labels, fronts, distinct boundaries and H/L centers,
  prepared/cached independently by the info server. Captured source fixtures,
  native-time selection, optional offline snapshots and independent slim controls
  accompany the feature. Deploy the matching server and app to make the new
  endpoints available. Ridges use NOAA pressure contours and chart labels.
  NDFD precipitation/weather shading now uses independently prepared AWC images,
  an explicit chance/likely/fog legend and visible gaps at unpublished times.
  Broader operational-chart comparison and physical-device qualification remain.
- Implemented locally: [Radar](../../src/layers/weather-awc/radar/README.md) adds
  server-prepared current MRMS/NEXRAD composite and terminal TDWR contours, with
  source times, expiration, optional offline files and six slim product tabs.
  Deploy the matching server and app. Two-hour timeline rewind is implemented;
  an optional NOAA STI storm-motion overlay adds server-cached projected cell
  tracks aligned with the displayed radar. Captured-source motion regressions are
  part of local verification; physical-device rendering qualification, automatic
  playback and operational comparison remain.
- Compare NOAA GOES processing with available tile services; add a visible/IR
  family and synchronized six-frame animation.
- Bound frame preload, cancellation and memory; measure on the reference tablet.

Acceptance: source timestamps agree, degraded sources remain visible, and the full
map/route/weather scenario meets [product budgets](brief.md).

## Later planning and products

File-based route import/export, additional syntax/altitude metadata, alternate comparison,
bookmarks and printable source/time summaries can follow the core continuity work.
No filing or personal route-history service is assumed. A public beta also needs
tile/CDN cost measurements, operational-language review and support/runbooks.

Rank further sources by pilot value, reliability, rendering cost and time-model
compatibility: NWS alerts, SPC outlooks, WPC precipitation/winter products, lightning,
NHC tracks and model turbulence are candidates. Icing is covered by the expanded
weather plan above. Each source must pass the adapter
readiness checklist in [data sources](../data/sources.md).
