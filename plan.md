# ZLayer plan

Build a fast, offline-capable route-planning and weather PWA, with a path to a quick EFB.
It remains a supplemental planning tool, not an official briefing source or certified EFB.

## Principles

- One persistent MapLibre/WebGL map; React is a thin, code-split shell.
- Each product owns its data, behavior, presentation and lifecycle.
- Continuous terrain beneath exclusive chart bases and optional additive overlays.
- Cached data first; background refresh never blocks unrelated interaction.
- Immutable, cycle-aware data with visible source, time, freshness and expiration.
- Network/storage caching by whole MBTiles or PDF file, never by rendered chart tile.
- On-demand caching for browsing; explicitly verified regions for offline completeness.

## Implemented baseline

`faa-regs` publishes spatial/zoom files in `charts/<cycle>/mbtiles/`, reference data in
`nav/`, plate indexes in `tpp/` and `cs/`, and original PDF books at the cycle root.
Intermediate sheet MBTiles stay outside the publish tree. See the
[feed contract](docs/chart-feed.md) for layout, identity and publication rules.

ZLayer renders VFR/IFR low charts, searchable FAA features, current/cached METARs,
selected-airport TAFs, and exact-page PDF.js plates/Chart Supplements. Persisted route
drafts support direct and Victor/Tango legs, compact TEC entries and SID/STAR previews;
recommendations include historical, preferred and TEC routes. Routes can be copied
as text or shared where supported. Route terrain shows elevation and manual altitude
comparisons; optional device GPS shows position and track. The experimental AHRS
toolbox adds attitude, GPS instruments, an HSI and local JSON Lines recordings.
It still needs device and flight validation.

Settings saves complete state/territory selections with progress, retry, shared-file
reuse and committed edition ownership. Latest discovers published dates independently
of saved regions. The first camera centers KPAO at zoom 9; later launches restore
the camera, panels and plate reading state. Chart selection does not move the map.
Settings also offers a confirmed full reset of local app data across open windows.

## Next

The [color-system plan](docs/color-system.md) defines the shared palette, navigation
and weather color roles, contrast targets, and staged interface migration.

Production hosting/proxies, local glyphs, route persistence, cache cleanup and browser
CI are implemented. Installed-device checks, shared route/view state, route-corridor
downloads, automatic cycle migration, immutable publisher metadata and additional
weather products remain future work. The [roadmap](docs/roadmap.md) owns that backlog;
the [engineering guide](docs/implementation.md) describes how to extend it without
losing the design principles above.
