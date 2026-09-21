# Documentation

Use the roadmap for current capabilities, feature guides for behavior, and contracts
for data formats. Plans describe intended work; dated verification records describe
only the build and environment tested. ADRs retain decision history and identify
later implementation changes.

## Start here

- [Project overview and quick start](../README.md)
- [License](../README.md#license)
- [Plan and principles](../plan.md), [product scope and budgets](product.md),
  [implemented baseline and roadmap](roadmap.md)
- [Local development and verification](local-development.md)
- [Engineering guide](implementation.md), [architecture](architecture.md),
  [internal layer boundaries](layer-modules.md)
- [Source register and access policies](data-sources.md),
  [publisher chart-feed contract](chart-feed.md), [client data and persistence contracts](contracts.md)

## Feature behavior

- [Date, time, and currency labels](date-time-display.md)
- [Routes and recommendations](routes.md), [SID/STAR previews](terminal-procedures.md)
- [Fix display](fix-display.md), [route terrain](route-terrain.md), [GPS aircraft](gps-aircraft.md)
- [Route obstructions](route-obstructions.md)
- [Experimental AHRS toolbox](../src/layers/ahrs/README.md),
  [calibration and attitude-display policy](../src/layers/ahrs/README.md#calibration-and-validity),
  [attitude uncertainty, including yaw](../src/layers/ahrs/estimator/uncertainty.md),
  [magnetic vector fusion and calibration policy](../src/layers/ahrs/estimator/magnetic-fusion.md),
  [kinematic AHRS algorithm revision](reviews/ahrs-algorithm-2026-09-19.md),
  [local recordings and JSON Lines downloads](../src/layers/ahrs/recording.md)
- [Airport plates](offline-procedures.md), [offline storage and regional downloads](offline-storage.md)
- [PWA releases and update prompts](pwa-updates.md)
- [Installed-app Back navigation](pwa-navigation.md)
- [Workspace startup and loading screen](startup.md)
- [Saved workspace state and restoration](workspace-state.md)

## Quality and release

- [Responsive layout and recovery](responsive-checks.md)
- [Typography review](typography-checks.md), [proposed color system](color-system.md)
- [Graphics compatibility and browser matrix](graphics-compatibility.md)
- [Memory/resource review and preprocessing opportunities](memory-resources.md)
- [iPhone memory and AHRS scrolling review](reviews/iphone-memory-ahrs-2026-09-20.md)
- [AHRS magnetic aiding implementation review](reviews/ahrs-magnetic-aiding-2026-09-19.md)
- [Hosting contract, local verification and remaining gates](deployment-readiness.md)
- [Bundled map glyphs](../public/fonts/README.md)

## Decisions

- [0001: Map renderer and basemap direction](adr/0001-map-stack.md)
- [0002: Raster charts and interactive reference data](adr/0002-aeronautical-charts-and-reference-data.md)
- [0003: Product layer runtime](adr/0003-product-layer-runtime.md)
- [0004: Offline packages and procedure documents](adr/0004-offline-packages-and-procedure-documents.md)
- [0005: Committed offline snapshots](adr/0005-offline-snapshot-authority.md)
