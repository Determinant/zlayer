# Engineering guide

[Documentation](../README.md) / Development

## Repository

```text
src/                   React/Vite PWA: product layers, shared core, workspace shell
public/                static app assets
tools/info-server/     Node TypeScript weather preparation and FAA NMS service
tools/theme/           build-time palette definitions and color derivation
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
The [info server](../../tools/info-server/README.md) shares weather acquisition and
preparation, with separate durable NOTAM collection. Forecast requests only read
prepared output; user state and selected wind-altitude interpolation stay in the
PWA. See the [delivery boundary](../architecture/overview.md#data-layout) and
[server cache contract](../../tools/info-server/README.md#source-and-cache-contract)
for source, worker, publication and storage rules.

Read the relevant [plugin guide](../README.md#plugin-guides) before changing its
behavior. Follow the [documentation ownership and editing rules](../README.md#keeping-the-docs-useful)
when recording the change.

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
- Keep source adaptation separate from the canonical wire contract. Accept equivalent
  source representations only when their meaning is preserved; retain the original
  evidence. Missing optional metadata, unsupported parser syntax and demonstrated
  contradictions are different outcomes, not one generic validation failure.
- For ingestion fixes, test the affected rule across source families and combinations
  of equivalent representations, alongside the captured failure and recovery path.
  Account for every unavailable member; test envelope completeness separately from
  member interpretation. The [advisory policy](../../src/layers/weather-awc/README.md#advisory-ingestion-policy)
  is an implemented example.
- Test observable behavior and failure recovery, not source text or incidental markup.

Preserve one persistent map, product-owned lifecycles, one chart base at a time
with optional overlays, and whole-file MBTiles caching. Document a measured reason
before changing these constraints. Do not label a region complete based only on
files cached while browsing.

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

## Rendering performance

Target responsive interaction at 60 Hz. A frame then has about 16.7 ms;
blocking preparation competes with input, camera updates and drawing for that time.
Use measured frame-time distributions, especially slow frames, rather than average
FPS alone. Measure each device against this target.

- Reuse unchanged sources, geometry and imagery. Keep expensive acquisition and
  preparation outside the interaction path, with bounded admission and cancellation.
- Distinguish storage warmth, decoded-data warmth and GPU readiness. A cached file
  can still require expensive preparation; another cache needs measured benefit
  and explicit ownership, byte limits and disposal.
- Bound transient work as well as retained caches. Loading concurrency and useful
  cache capacity are different controls; overlapping allocations matter on phones.
- Stop drawing when idle. Preserve immediate route/selection feedback and current
  data identity when coalescing background work.
- Preserve visual sharpness, geographic alignment, alpha and edition ownership.
  Do not reduce density, coverage or detail merely to improve a benchmark number.

Use the [chart pipeline benchmark](../../src/layers/charts/benchmark.md) for
repeatable cold/warm, interaction and saved-boundary measurements. Pair performance
results with graphics correctness tests; record workload, browser, density, source
revision and limitations. Broader layer workloads and physical-device profiling
remain separate. Comparisons with other products require comparable measurements.

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

Source reviews identified these recovery requirements. Details are in
[layer recovery and freshness](../architecture/layer-plugins.md#demand-and-freshness),
[workspace persistence](../architecture/workspace-persistence.md), [PDF handling](../../src/layers/plates/README.md)
and [recording storage](../../src/layers/ahrs/recording.md).

After a feature or refactor batch, include the
[periodic repository cleanup](local-development.md#periodic-repository-cleanup):
consolidate completed notes and repeated test setup while retaining design
rationale, unresolved evidence and distinct regression coverage.

## Where to look

- [Architecture](../architecture/overview.md): runtime, rendering order and chart I/O invariant.
- [Layer plugins](../architecture/layer-plugins.md): feature ownership and evolving internal boundaries.
- [Local development](local-development.md): configuration, compatibility traps and tests.
- [Chart feed](../data/chart-feed.md), [contracts](../data/contracts.md) and
  [procedures](../../src/layers/plates/README.md): publisher/client boundaries.
- [Offline storage](../features/offline-storage.md): downloads, integrity, quota, recovery and reset.
- [AHRS](../../src/layers/ahrs/README.md): experimental sensors, instruments and recordings.
- [Roadmap](../product/roadmap.md): implemented baseline versus remaining work.

Before committing, follow [verification](local-development.md#verification),
subject to the [server-only scope rule](../../AGENTS.md#verification-and-documentation).
Device and deployment checks remain in [deployment readiness](deployment.md#verification-and-remaining-release-gates).
