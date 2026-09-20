# ADR 0003: Product layers with optional map and panel contributions

- Status: accepted; product folders and surface boundaries implemented 2026-09-15
- Date: 2026-09-12

## Context

ZLayer needs to combine independently updated charts, aeronautical references,
observations, advisories, analyses, imagery, routes, and interaction affordances. A
React-component-per-layer design would make map lifecycle and render performance hard
to control. A fully general plugin system would add compatibility and security work
before the supported product contracts are understood.

The design also needs a credible path from an online weather map to offline planning
without binding aeronautical domain logic to one browser renderer or backend.

## Decision

Define a layer as a complete workspace feature, including data, behavior, UI, and
lifecycle. A chart overlay, METAR information, and a sliding plate viewer are all
product layers. MapLibre style layers are internal rendering resources, not the
product boundary.

Group each product's implementation under `src/layers/<product>/`, with a
small internal entry. Keep renderer-specific entry points separate from UI/data entries
and share only infrastructure under `core/`. Product instances expose the capabilities
they need: commands and snapshots, a panel, or a map adapter. Do not require a map
lifecycle for a panel-only feature.

Maintain one MapLibre instance behind `MapRuntime`. Map adapters have stable IDs,
ordered slots, typed inputs, and mount/update/unmount lifecycles. `MapLayerHost` owns
ordering and teardown. Product logic owns its transport, time semantics, interaction
targets, and freshness policy. Optional snapshot stores let React observe data without
owning competing fetch loops.

The implemented boundary is documented in [Layer by layer](../layer-modules.md).
These built-in entry points are still evolving; there is no supported external plugin API.
Chart families use separate instances of one chart adapter; METAR owns visible-station
demand, its observation cache, periodic refresh, and its own map source. Plates owns
selection, lazy PDF loading, viewer state, and close behavior. Shared navigation
services remain available to map products, search, and routes.

React renders product controls and panels. The application composes them and passes
cross-product actions, such as opening a plate from an airport card. It sends coarse
commands to the map runtime; it does not mirror MapLibre's transient state or render a
DOM element for every map feature.

Separate product identity from transport. The current static feed uses GeoJSON and
MBTiles in development and production. A catalog can later select another measured
transport without changing route, selection, detail, time, or attribution semantics.

Keep route calculation, typed feature references, time/cycle rules, and units in a
renderer-independent domain package.

## Consequences

- Product additions expose only the surface capabilities they need; map contributions
  follow stable rendering order.
- MapLibre sources and layers can be updated without remounting the map or React tree.
- Stable feature IDs and feature state handle hover/selection cheaply.
- Product definitions require runtime schema validation and namespace enforcement.
- A small `MapLayerHost` orders map lifecycle calls, isolates failures, and tears
  map contributions down. Panels mount and unmount through React.
- Native or offline clients can reuse contracts and domain logic, but their render
  adapters remain separate implementations.

## Guardrails

- No arbitrary third-party code or unvalidated MapLibre expressions in catalogs.
- No DOM markers for national aviation/weather layers.
- No direct upstream API calls from a product UI module.
- No map adapter may insert style layers outside its assigned slot or namespace.
- Full details remain outside vector tiles; map payloads contain bounded render and
  identity properties.
- One product's fetch/parse/render failure cannot remove unrelated products.

## Alternatives considered

- **React components directly managing each source and layer:** approachable initially,
  but effects and remounts make ordering, cancellation, and animation performance
  increasingly fragile.
- **General external plugin API:** potentially flexible, but premature schema,
  compatibility, sandboxing, and support burden.
- **Separate map instance per chart/product mode:** simple isolation with unacceptable
  WebGL, state-transfer, interaction, and memory costs.
- **One hard-coded global style document:** fast for a static map but awkward for
  independently versioned time products and graceful source failures.

## Revisit when

- an external product author needs a supported extension API;
- MapLibre cannot meet measured performance budgets after proper tiling and lifecycle
  control; or
- a native client reveals contracts that are accidentally browser-specific.
