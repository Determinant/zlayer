# Engineering guide

[Documentation](../README.md) / Development

## Repository

```text
src/                   React/Vite PWA: product layers, shared core, workspace shell
public/                static app assets
tools/weather-server/  Node TypeScript AWC/NOMADS cache gateway
test/                  unit tests, browser fixtures and Playwright regressions
tools/                 import checks, local proxies, offline shell and boundary builder
packages/contracts/    shared data types and runtime document guards
packages/domain/       framework-free routing, search and weather logic
docs/                  contracts, decisions and verification guides
.github/workflows/      verification and production-build browser CI
```

The root package owns the application. Only the shared packages are npm workspaces;
development tooling is not a second application. Production publishes static `dist/`
and consumes the dated artifacts built by `faa-regs`.
The small [weather server](../../tools/weather-server/README.md) shares AWC, NOMADS
and Google HRRR acquisition, normalizes advisories, and prepares numeric grids in
bounded Node workers using the existing TypeScript algorithms. The PWA validates
and caches those artifacts through core, interpolates selected wind altitudes,
then renders and inspects numeric bands. One bounded server cache shares source
reads and native grids across viewers. Background updates prepare complete native
generations before publishing catalogs. HTTP forecast reads never acquire sources
or perform conversion; wind altitude interpolation remains in the PWA.
There is no weather database; user state stays in the PWA.

Each plugin's documentation starts at `src/layers/<plugin>/README.md`. Keep its
behavior, algorithms, design rationale and validation beside its implementation;
link longer notes from that README. `docs/` owns shared contracts, host architecture,
application-wide behavior, development guidance and history. The
[documentation index](../README.md#plugin-guides) connects both locations.

## Keep it simple

- Build the smallest design that satisfies a current use case.
- Prefer direct data flow and plain functions over framework or abstraction layers.
- Keep related logic together; split a module when it has a distinct responsibility,
  not merely to meet a line-count target.
- Add an interface, adapter or plugin boundary only for a concrete need.
- Fail visibly on ambiguous aviation data instead of hiding uncertainty behind heuristics.
- Preserve raw FAA/AWC identifiers, properties and times behind concise presentation.
- Use the shared [date, time, and currency formats](../features/date-time-display.md) for UI labels.
- Validate external documents before application state or durable storage accepts them.
- Test observable behavior and failure recovery, not source text or incidental markup.

One persistent map, product-owned lifecycle, exclusive chart bases with additive
overlays, and whole-file MBTiles caching are deliberate constraints, not incidental
implementation details. Changes must preserve them or document a measured reason
to revise the design. Opportunistic caching must never imply verified regional
completeness.

Plugin file downloads must use core's shared acquisition tools; see the
[file-download contract](../architecture/layer-plugins.md#file-downloads).
Do not add a feature-owned fetch loop, whole-response buffer or transfer queue.
Immutable bounded files that need optional offline browsing use the scoped
[plugin file cache](../architecture/layer-plugins.md#plugin-file-caches), with
product-defined identity, validation and retention limits.
Small structured responses use the shared JSON/client helpers. Import checks reject
direct `fetch` calls and low-level download-writer imports in plugin modules.

Follow the [plugin authoring guide](../architecture/layer-plugins.md#adding-a-product)
for registration, optional integrations and persistence. Ordinary plugin UI uses
core's [shared controls and lifecycles](../features/shared-ui.md#shared-controls);
feature layout, compact reports and specialized visualizations stay with the plugin.

## Recovery and source identity

- Expose asynchronous results only for the complete current resource identity,
  including digest and cache policy. A same-cycle replacement must not display
  old results against a new source URL.
- Treat reconnect and saved-file inventory changes as recovery signals for open
  views. Invalidate failed or partially rendered cache entries so repairing bytes
  can repair the view. Release observers and failed tasks during teardown.
- Optional cache/notification failures must not prevent a usable network response
  or turn an already committed save into failure. Verified offline persistence
  still requires successful storage.
- Coordinate shared read/change/write operations across windows; rereading just
  before writing is not atomic. Keep conflict checks inside the lock.
- Treat clock rollback and future timestamps explicitly. A future cached report
  must not permanently displace valid observations or suppress refresh.
- Remove renderer-only labels, styling and gesture metadata when turning a map
  hit into a reusable navigation feature. Display properties must not leak into
  route pins or saved selections.

These invariants came from the source reviews and now belong to the implementation
contract. Product details live in [layer recovery and freshness](../architecture/layer-plugins.md#demand-and-freshness),
[workspace persistence](../architecture/workspace-persistence.md), [PDF handling](../../src/layers/plates/README.md)
and [recording storage](../../src/layers/ahrs/recording.md).

## Where to look

- [Architecture](../architecture/overview.md): runtime, rendering order and chart I/O invariant.
- [Layer plugins](../architecture/layer-plugins.md): feature ownership and evolving internal boundaries.
- [Local development](local-development.md): configuration, compatibility traps and tests.
- [Chart feed](../data/chart-feed.md), [contracts](../data/contracts.md) and
  [procedures](../../src/layers/plates/README.md): publisher/client boundaries.
- [Offline storage](../features/offline-storage.md): downloads, integrity, quota, recovery and reset.
- [AHRS](../../src/layers/ahrs/README.md): experimental sensors, instruments and recordings.
- [Roadmap](../product/roadmap.md): implemented baseline versus remaining work.

Before committing, run `npm run verify:full`, which combines `npm run verify`,
all built-app regressions from `npm run test:browser`, and the complete configured
[graphics matrix](../verification/graphics-compatibility.md#run-the-checks). The individual commands
remain useful during development. Browser focus, touch/layout, installed-device offline behavior
and performance also need the separate checks in
[responsive checks](../features/shared-ui.md), [offline release checks](../features/offline-storage.md#release-checks)
and [deployment readiness](deployment.md); a passing Node suite is not device certification.
