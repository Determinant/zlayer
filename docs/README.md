# Documentation

Each built-in plugin keeps its behavior, algorithms and validation guides beside
its implementation in `src/layers/<plugin>/`, starting with `README.md`. This index
links those [plugin guides](#plugin-guides) alongside shared application contracts,
project direction and history under `docs/`.

Start with the principles, then read the guide for the part you are changing.
Architecture, data and feature guides describe current contracts unless a section
explicitly says **planned**. The roadmap owns implementation status and future work;
product proposals describe intended experience. Dated verification records apply
only to the source, build and environment recorded.

## Start here

1. [Project overview and quick start](../README.md): run the app and understand its scope.
2. [Direction and principles](product/direction.md) and
   [engineering guide](development/engineering.md): preserve the design philosophy
   and recovery invariants before changing behavior.
3. [Local development](development/local-development.md): configure data sources,
   understand compatibility constraints and choose verification commands.
4. [Architecture](architecture/overview.md), then
   [layer plugins](architecture/layer-plugins.md): follow runtime ownership and
   find the source modules responsible for a change.

AI contributors also have a short repository entry point in [AGENTS.md](../AGENTS.md).
The same engineering and feature contracts apply to human and AI contributors.

## Find the guide for your task

| Task | Read first | Follow through |
| --- | --- | --- |
| Add or change a workspace feature | [Plugin authoring](architecture/layer-plugins.md#adding-a-product) and the [feature guides](#features-and-interface) | [Workspace restoration](architecture/workspace-persistence.md), [shared UI controls](features/shared-ui.md#shared-controls), [layout and typography](features/shared-ui.md) |
| Change shared controls, dialogs or layout | [Shared UI and layout](features/shared-ui.md) | [Panel lifecycle](architecture/layer-plugins.md#stowable-panels), [installed-app Back navigation](features/pwa-back-navigation.md) |
| Change a feed, schema or data loader | [Data contracts](data/contracts.md), [chart feed](data/chart-feed.md) | [Source access policies](data/sources.md), [resource identity and recovery](development/engineering.md#recovery-and-source-identity) |
| Change routing or procedure geometry | [Routes](../src/layers/routes/README.md), [approach geometry](../src/layers/routes/approach-geometry.md) | [SID/STAR source limits](../src/layers/routes/terminal-procedures.md), [coverage and unresolved cases](../src/layers/routes/approach-coverage.md) |
| Debug offline data, stale state or restoration | [Offline storage](features/offline-storage.md), [workspace persistence](architecture/workspace-persistence.md) | [Committed-snapshot rationale](adr/0005-offline-snapshot-authority.md), [PWA updates](features/pwa-updates.md) |
| Investigate rendering, memory or device failures | [Graphics compatibility](verification/graphics-compatibility.md), [memory and resources](verification/memory-resources.md) | [Responsive checks](features/shared-ui.md), [retained evidence](evidence/README.md) |
| Verify or release a change | [Verification commands](development/local-development.md#verification) | [Deployment contract and remaining release gates](development/deployment.md) |

## Product and direction

- [Direction and principles](product/direction.md): the enduring design choices.
- [Product brief](product/brief.md): user needs, experience principles, scope,
  non-goals and performance budgets; includes planned capabilities.
- [Roadmap](product/roadmap.md): implemented baseline, remaining work and acceptance criteria.
- [Color-system plan](product/color-system-plan.md): proposed palette and staged migration.

## Development

- [Engineering guide](development/engineering.md): simplicity, ownership and recovery rules.
- [Local development](development/local-development.md): setup, proxies, configuration and tests.
- [Deployment](development/deployment.md): static-host contract, release gates and dated checks.

## Architecture and design

- [Overview](architecture/overview.md): publisher/client boundaries, runtime, rendering and chart I/O.
- [Layer plugins](architecture/layer-plugins.md): authoring, registration, lifecycle, optional integrations and map/panel contributions.
- [Workspace persistence and restoration](architecture/workspace-persistence.md): saved records, ownership and deliberate session-only state.
- [Workspace startup](architecture/workspace-startup.md): loading screen and usable-workspace readiness.

## Data and publisher contracts

- [Source register](data/sources.md): provenance, access policies and adapter readiness.
- [FAA chart feed](data/chart-feed.md): publication layout, identity, caching and compatibility.
- [Client data contracts](data/contracts.md): schemas, runtime validation and persistence formats.

## Features and interface

### Plugin guides

Every plugin's `README.md` is its entry point. Longer design notes and validation
guides stay in that same folder or its implementation subfolders.

| Plugin | Guide and supporting docs |
| --- | --- |
| Charts | [Selection, rendering and MBTiles](../src/layers/charts/README.md) |
| Navigation | [Data, search and details](../src/layers/navigation/README.md); [fix display](../src/layers/navigation/fix-display.md) |
| METAR/TAF | [Weather demand, freshness, nearby stations and report display](../src/layers/metar-taf/README.md) |
| Plates | [Airport plates, document viewer and georeferenced overlays](../src/layers/plates/README.md) |
| Routes | [Editing and recommendations](../src/layers/routes/README.md); [SID/STAR previews](../src/layers/routes/terminal-procedures.md), [approach geometry](../src/layers/routes/approach-geometry.md), [coverage and validation](../src/layers/routes/approach-coverage.md) |
| Terrain | [Route/viewport elevation, sources and verification](../src/layers/terrain/README.md) |
| Obstructions | [FAA DOF symbols, demand and lifecycle](../src/layers/obstructions/README.md) |
| Ownship | [GPS aircraft and device checks](../src/layers/ownship/README.md); [shared core GPS service](architecture/layer-plugins.md#shared-gps-service) |
| AHRS | [Toolbox, calibration and estimator](../src/layers/ahrs/README.md); [recordings](../src/layers/ahrs/recording.md), [validation](../src/layers/ahrs/validation.md) |
| Ruler | [Map measurement and magnetic bearings](../src/layers/ruler/README.md) |

### Shared application behavior

- [Offline storage and regional downloads](features/offline-storage.md).
- [PWA releases and update prompts](features/pwa-updates.md),
  [installed-app Back navigation](features/pwa-back-navigation.md).
- [Shared UI and layout](features/shared-ui.md),
  [typography](features/shared-ui.md#typography),
  [date, time and currency labels](features/date-time-display.md),
  [bundled map glyphs](../public/fonts/README.md).

## Verification and device limits

- [Graphics compatibility](verification/graphics-compatibility.md): rendering requirements and browser matrix.
- [Memory and resources](verification/memory-resources.md): limits, investigations and preprocessing opportunities.

Plugin-specific validation lives with its plugin, including
[approach coverage](../src/layers/routes/approach-coverage.md) and
[AHRS validation](../src/layers/ahrs/validation.md). These guides retain both durable
requirements and explicitly dated observations.
A historical pass does not close a current release gate or establish device/flight validation.

## Decisions

ADRs preserve why a design was chosen. Later implementation changes belong in the
current guide and should be linked from the affected ADR without erasing the original rationale.

- [0001: Map renderer and basemap direction](adr/0001-map-stack.md)
- [0002: Raster charts and interactive reference data](adr/0002-aeronautical-charts-and-reference-data.md)
- [0003: Product layer runtime](adr/0003-product-layer-runtime.md)
- [0004: Offline packages and procedure documents](adr/0004-offline-packages-and-procedure-documents.md)
- [0005: Committed offline snapshots](adr/0005-offline-snapshot-authority.md)

## Reviews and evidence

- [Reviews](reviews/README.md): investigations that still need a standalone record,
  plus a map from consolidated reviews to their owning guides.
- [Evidence](evidence/README.md): retained audits and images, their purpose and retention rules.

Resolved findings and lasting guidelines belong in the owning feature, architecture
or engineering guide. Evidence substantiates those requirements; it is not another
source of current implementation status. Keep dates, hashes, scope and limitations
with historical results. Scratch scans and intermediate downloads belong in ignored
`tmp/` or outside the repository.

## Keeping the docs useful

- Give each contract one owning guide; link to it instead of copying its rules.
- Keep plugin behavior, algorithms, design notes and validation in
  `src/layers/<plugin>/`; link supporting docs from that plugin's `README.md`.
- Keep shared application behavior in `docs/features/`, host architecture in
  `docs/architecture/`, shared formats and publisher boundaries in `docs/data/`,
  and cross-plugin/browser investigations in `docs/verification/`.
- Keep proposals visibly planned and update the roadmap when implementation status changes.
- When consolidating, preserve rationale, failure cases, constraints and unresolved work;
  update inbound links and this index. Preserve unique evidence a guide still relies on.

See the project [license](../README.md#license) for documentation and source terms.
