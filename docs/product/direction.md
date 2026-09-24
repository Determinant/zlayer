# Direction and principles

[Documentation](../README.md) / Product

Build a fast, offline-capable route-planning and weather PWA, with a path to a quick EFB.
It remains a supplemental planning tool, not an official briefing source or certified EFB.

## Principles

- One persistent MapLibre/WebGL map; React is a thin, code-split shell.
- Each product owns its data, behavior, presentation and lifecycle.
- Continuous terrain beneath exclusive chart bases and optional additive overlays.
- Cached data first; background refresh never blocks unrelated interaction.
- Weather uses a static app and one small TypeScript server for AWC, NOMADS and
  HRRR from Google’s NOAA mirror. The server normalizes advisories and prepares
  native forecast fields once in a bounded shared cache. Background updates prepare
  original source levels; retained grids serve every client without repeated work.
  The PWA interpolates wind altitude, validates, renders, inspects and saves them offline. Bounded background workers
  publish only complete prepared generations; HTTP reads saved files. They live in the same service; no database is required.
- Immutable, cycle-aware data with visible source, time, freshness and expiration.
- Network/storage caching by whole MBTiles or PDF file, never by rendered chart tile.
- On-demand caching for browsing; explicitly verified regions for offline completeness.

## From principles to implementation

The [product brief](brief.md) explains the user needs, experience, scope and budgets.
The [engineering guide](../development/engineering.md) turns these principles into
implementation and recovery rules. The [architecture](../architecture/overview.md)
and [layer-plugin contract](../architecture/layer-plugins.md) define ownership.

`faa-regs` owns FAA chart, navigation and document generation. The
[feed contract](../data/chart-feed.md) owns publication layout, identity and whole-file
caching rules, including the separation of intermediate sheet archives from published
packages and independently versioned terrain/obstruction products.

## Current and planned work

The [roadmap](roadmap.md) owns the implemented baseline and remaining work.
[Local development](../development/local-development.md#run-and-configure) describes
launch defaults and restoration; [deployment](../development/deployment.md) tracks release gates.
The [approach geometry design](../../src/layers/routes/approach-geometry.md) is implemented
locally; [coverage and rollout evidence](../../src/layers/routes/approach-coverage.md) records
publication limits, unmatched charts and remaining national diagnostics.
The [color-system plan](color-system-plan.md) remains a proposed palette and interface migration.
