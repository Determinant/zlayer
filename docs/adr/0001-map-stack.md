# ADR 0001: MapLibre with a terrain-oriented OSM basemap

- Status: accepted for Phase 0; production tile host deferred
- Date: 2026-09-12

Implementation update (2026-09-17): the MapLibre decision is implemented. The current
local style uses USGS Topo over shaded relief in development and production, with
USGS attribution and bundled label glyphs. OSM remains the original provider direction,
not the deployed default. The final provider/offline policy remains open; custom
tiles or a complete style can be configured. See [data sources](../data-sources.md#basemap-policy).

## Context

ZLayer needs to render many time-varying point, line, polygon, and raster products
smoothly. The map must be styleable for aviation, have no proprietary-renderer lock-in,
and keep basemap hosting separate from the weather-data pipeline.

## Decision

This section records the original provider direction; the implementation update above
describes the current USGS default. Configuration uses Vite build-time variables.

Use MapLibre GL JS as the browser renderer and OpenStreetMap as the underlying
basemap data source. Load a terrain/topography-oriented basemap, including legible
hillshade, through a configurable style/TileJSON endpoint. Render VFR/IFR
charts as optional, coverage-limited raster overlays above it. Render weather points
and polygons as MapLibre layers, using GeoJSON first and vector tiles when measured
density requires them. Render radar/satellite as raster layers in the same WebGL map.

Chart availability never defines the map extent. Outside the currently published
chart coverage, the terrain basemap remains usable and missing chart tiles
are treated as normal coverage boundaries. Switching a chart layer does not move the
viewport.

Do not make the public OSM Foundation tile servers a production dependency. Use them
only for compliant low-volume evaluation if needed, then choose a hosted OSM-derived
provider or self-hosted tile build before beta.

The development client boots from a local style using USGS Topo raster tiles so an
external style failure cannot prevent FAA overlays from initializing. A full MapLibre
style URL remains configurable for provider evaluation. These are replaceable
development defaults, not the offline or production-provider decision.

## Why

- GPU-backed vector rendering matches the density and frequent visibility/style
  changes of weather layers.
- OSM provides broad, editable geographic coverage without coupling the project to a
  specific commercial renderer.
- MapLibre accepts vector and raster sources, supports data-driven styling, and has a
  mature worker/tile model.
- A configurable tile source makes policy, cost, regional coverage, and provider
  changes operational choices instead of application rewrites.

## Consequences

- We own an aviation-focused style and must test label/layer priority carefully.
- Terrain shading must remain useful without competing with chart, weather, or route
  symbology; chart overlays may obscure it where their source raster is opaque.
- Attribution follows the selected provider; OSM-derived styles must show OSM attribution.
- Hosting is not free at scale: budget for a provider/CDN or for generating and
  operating our own tiles.
- Public OSM tiles cannot be bulk-downloaded or used for offline packs.
- Offline basemap packages require a provider/build whose license explicitly permits
  prefetching; chart-package coverage and basemap-package coverage are independent.
- Weather performance still depends on tiling, density control, animation bounds, and
  source lifecycle; choosing MapLibre alone does not make the map fast.

## Alternatives considered

- **Leaflet:** excellent for simpler raster/feature maps, but dense, frequently updated
  multi-layer rendering would require more custom canvas/WebGL work.
- **OpenLayers:** technically capable and strong on OGC formats, but MapLibre better
  matches the intended vector-tile styling and GPU-first interaction model. It remains
  a fallback if direct OGC integration dominates after Phase 0.
- **Commercial map SDK as the core:** reduces hosting/setup work but couples renderer,
  pricing, tokens, and terms. A hosted tile provider can still sit behind MapLibre.
- **Custom canvas/WebGL renderer:** maximum control with unjustified implementation,
  accessibility, projection, and interaction risk.

## Revisit when

- Direct WMS/OGC layers dominate the product mix and are materially harder in MapLibre.
- Reference-device benchmarks miss the budgets after proper vector/raster tiling.
- A production basemap provider requires an incompatible SDK or license.
