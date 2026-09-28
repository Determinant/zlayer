# Direction and principles

[Documentation](../README.md) / Product

Build a fast, offline-capable route-planning and weather PWA, with a path to a quick EFB.
It remains a supplemental planning tool, not an official briefing source or certified EFB.

## Principles

- One persistent MapLibre/WebGL map; React is a thin, code-split shell.
- Responsive, efficient map and layer rendering is a core product quality. Treat
  interaction as a real-time rendering workload: reuse prepared data, keep camera
  movement responsive during acquisition, bound preparation and memory, and let
  the renderer become idle when nothing changes. Preserve chart sharpness and
  source correctness; measure improvements on repeatable workloads and devices.
- Each product owns its data, behavior, presentation and lifecycle.
- Continuous terrain beneath exclusive chart bases and optional additive overlays.
- Cached data first; background refresh never blocks unrelated interaction.
- Share weather acquisition and native-field preparation through one bounded,
  database-free service; publish complete generations. Keep user state, selected
  wind-altitude interpolation, rendering and offline use in the PWA. The
  [architecture](../architecture/overview.md#data-layout) defines the delivery boundary.
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
