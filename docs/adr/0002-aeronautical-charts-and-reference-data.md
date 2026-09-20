# ADR 0002: Separate raster charts from interactive aeronautical data

- Status: accepted for Phase 0
- Date: 2026-09-12

Implementation update (2026-09-17): navigation uses validated GeoJSON and persisted
typed route entries. V/T airway topology, TEC expansion and SID/STAR waypoint previews
are implemented; altitude/clearance validation and weather-corridor filtering remain
outside the route planner. See [routes](../routes.md) and the [roadmap](../roadmap.md).

## Context

ZLayer should support familiar VFR/IFR chart viewing and simple route planning.
Raster charts already depict airports and navigation features, but their pixels are
not searchable or selectable and cannot carry live weather. The project has access to
reliable current chart MBTiles at `charts.tedyin.com`, built and maintained by the
sibling `faa-regs` project.

## Decision

Use the `faa-regs` output as the build feed for cycle-versioned Tedyin raster charts
and normalized FAA reference data. Within that feed, chart artifacts and the FAA
28-day NASR subscription retain independent cycle metadata. Treat NASR as the
canonical structured source for US airports, runways, NAVAIDs, fixes, and airways.
Join AWC observations/forecasts to FAA facilities without making AWC weather-station
coverage define the airport inventory.

Serve chart rasters and structured reference data as separate MapLibre sources. Start
with validated GeoJSON; move dense products to vector tiles only when measurement
justifies the added publishing complexity. The route references stable typed features,
not chart pixels or rendered map-layer IDs.

## Why

- Chart imagery preserves the dense symbology and familiar presentation pilots expect.
- NASR makes features searchable, selectable, filterable, and usable as waypoints.
- Separate cycles let chart, reference, and weather data update on their own cadences
  while the UI states every effective/valid time honestly.
- The same route and weather overlays work over VFR, IFR, or the configured basemap.
- No OCR, image-coordinate heuristics, or proprietary third-party pin database is
  required.

## Consequences

These describe the original scope; the implementation update above records later
route expansion. Weather-corridor filtering is still planned.

- Some airport symbols appear both in the raster and as interactive overlays. The UI
  needs a subtle selectable hit target or optional pin visibility rather than covering
  chart labels with large markers.
- Identifiers differ across FAA and AWC datasets; crosswalks and ambiguity handling are
  required.
- Chart and NASR cycle changes need staged validation, atomic activation, rollback,
  and visible effective dates.
- The first route planner is intentionally limited to ordered waypoints, geodesic
  distance, and a weather corridor. Airway validity, altitude constraints, winds,
  fuel, performance, NOTAM interpretation, and flight-plan filing are separate work.

## Alternatives considered

- **Use chart pixels alone:** visually authentic but not interactive or searchable.
- **Use AWC airport/station endpoints alone:** convenient weather joins and global
  reach, but weather coverage is not a complete canonical US airport/navigation set.
- **Rebuild FAA charts as vectors immediately:** attractive long-term, but faithfully
  reproducing chart selection, placement, decluttering, and symbology is a much larger
  product and safety-review effort.
- **Use a commercial aviation map SDK/database:** faster initial coverage but adds
  licensing, redistribution, pricing, and platform coupling that are unnecessary for
  the first US-focused release.

## Revisit when

- A vector aeronautical source demonstrably matches chart fidelity and cycle handling.
- Browser/device benchmarks favor a different chart container or delivery protocol.
- Route planning expands into airway/altitude validation or regulated operational use.
