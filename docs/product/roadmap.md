# Roadmap

[Documentation](../README.md) / Product

Build complete, testable features and resolve correctness and performance risks before
adding more data sources. Current capabilities and planned work are listed separately.

## Implemented baseline

- Static React/MapLibre PWA with product-owned layer lifecycles and a precached shell.
- Viewport/zoom-selected, prestitched VFR/IFR MBTiles with whole-file caching.
- Searchable FAA navigation with progressive fix decluttering and runway details.
- Persisted route entries and exact feature pins; direct/Victor/Tango routing,
  compact TEC routes, SID/STAR previews, anchored approaches with published entries or
  vectors to final, compact coordinate waypoints, map/touch/keyboard
  editing, text copying in three formats and sharing where the browser supports it.
- Local Route Stash with named structured snapshots, load/edit/remove/reorder,
  retained pins and approach attachments, and coordinated writes across windows.
- Restored map camera, panels, feature selection, recommendation choices and plate
  reading state; nearby-feature selection for overlapping map points.
- Historical filed-route, preferred and TEC recommendations with mapped previews.
- Airport plates and Chart Supplements in one exact-page PDF.js viewer, with an
  optional georeferenced IAP map overlay that restores independently of the viewer.
- Current/cached METAR categories and runway wind components, plus selected-airport
  TAF periods with local validity times and visible stale/error states.
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
2. Implement the [shared color-system plan](color-system-plan.md) and verify rendered
   contrast, focus, status and navigation/weather meanings across supported layouts.
3. Add shareable route/view URLs and explicit offline-region cycle migration without
   replacing a working saved download until its new edition is verified. Regions
   from different cycles can already be saved separately. Immutable publisher metadata
   and an atomic release descriptor would improve exact repair and date discovery;
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

## Approach geometry and coverage

The [ordered interpreter and reference export](../../src/layers/routes/approach-geometry.md) are
implemented and locally rebuilt. The [recorded coverage](../../src/layers/routes/approach-coverage.md)
has no gaps or geometry warnings in 1,676 selectable California entries or 403
Arizona entries. The 149 California and 35 Arizona unmatched instrument charts
remain availability gaps.

The [national coverage summary](../../src/layers/routes/approach-coverage.md#recorded-faa-2609-results)
distinguishes geographic scope, unmatched charts, unoffered feeder starts and
expected radar endings. U.S. coverage is 9,079/10,980 chart records (82.69%), with
1,854 unmatched charts and 132 unresolved entries across 47 matched charts after
the recorded radar/source-review exceptions. Passing available entries does not
establish nationwide chart coverage.

Remaining work: publish the coordinated client/feed revision, reconcile unmatched
chart identities and unsupported families with authoritative source data, and
review the national diagnostic inventory. Continue per-cycle audits of source
coverage, branches, course/turn constraints and schematic bounds. Connected
schematic geometry alone does not establish correctness.

## Weather expansion

### Observations and advisories

- Publish validated static AWC snapshots for production, with source health and one
  upstream rate budget; development's pass-through is not that publisher.
- Add PIREP/AIREP filtering/deduplication and altitude bands.
- Add SIGMET, G-AIRMET, Alaska AIRMET and CWA geometry/time slices.
- Introduce a unified UTC controller and route-corridor emphasis.

Acceptance: explicit source/valid times, bounded rendering at worst-case feature counts,
correct time boundaries, and one failed product never disabling the workspace.

### Surface analysis and imagery

- Capture current/archived WPC bulletin fixtures; validate fronts, troughs and centers
  against the authoritative chart before styling them.
- Compare NOAA GOES processing with available tile services; add NEXRAD and one
  visible/IR family with synchronized six-frame animation.
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
NHC tracks and model icing/turbulence are candidates. Each must pass the adapter
readiness checklist in [data sources](../data/sources.md).
