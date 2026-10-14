# Direction and principles

[Documentation](../README.md) / Product

Build a fast route-planning and weather PWA that works offline and can grow into an EFB.
It remains a supplemental planning tool, not an official briefing source or certified EFB.

## Principles

- One persistent MapLibre/WebGL map; React is a thin, code-split shell.
- Treat map and layer interaction as a real-time rendering workload. Keep map
  movement responsive while data loads. Reuse prepared data, limit preparation
  work and memory, and stop rendering when nothing changes. Preserve chart
  sharpness and source correctness; measure improvements on repeatable workloads
  and devices.
- Each product owns its data, behavior, presentation and lifecycle.
- Keep a continuous basemap beneath the selected chart. Show one chart base at a
  time, with optional overlays.
- Cached data first; background refresh never blocks unrelated interaction.
- Share weather acquisition and native-field preparation through one bounded,
  database-free service; publish complete generations. Keep user state, selected
  wind-altitude interpolation, rendering and offline use in the PWA. The
  [architecture](../architecture/overview.md#data-layout) defines the delivery boundary.
- Keep data immutable and tied to its publication cycle. Show its source, time,
  freshness and expiration.
- Network/storage caching by whole MBTiles or PDF file, never by rendered chart tile.
- On-demand caching for browsing; explicitly verified regions for offline completeness.

## From principles to implementation

The [product brief](brief.md) explains the user needs, experience, scope and budgets.
The [engineering guide](../development/engineering.md) turns these principles into
implementation and recovery rules. The [architecture](../architecture/overview.md)
and [layer-plugin contract](../architecture/layer-plugins.md) define ownership.

`faa-regs` owns FAA chart, navigation and document generation. The
[feed contract](../data/chart-feed.md) defines publication layout, identity and whole-file
caching rules, including the separation of intermediate sheet archives from published
packages and independently versioned terrain/obstruction products.

## Current and planned work

The [roadmap](roadmap.md) lists implemented features and remaining work.
[Local development](../development/local-development.md#run-and-configure) describes
launch defaults and restoration; [deployment](../development/deployment.md) tracks release gates.
