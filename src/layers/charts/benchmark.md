# Rendering pipeline benchmark

[Charts](README.md) / Performance

Run from the repository root with Node 24 and the browsers/dependencies in
[local development](../../../docs/development/local-development.md#verification):

```sh
node tools/benchmark-rendering.mjs chromium desktop 3
node tools/benchmark-rendering.mjs webkit tablet 3
xvfb-run -a node tools/benchmark-rendering.mjs firefox desktop 3
```

The arguments are engine, profile (`desktop`, `tablet`, `phone`) and rounds (1–20).
Profiles use 1280×900 at 1×, 1024×768 at 2× and 390×844 at 3× respectively.
These are viewport/density profiles, not emulations of a physical device's GPU,
memory limits, touch scheduling or thermals. Firefox runs headed.

The runner starts its own production-build fixture server on port 4297 and closes
it afterward. Set `ZLAYER_TEST_PORT` to use another free port. It refuses an occupied
port; do not run other benchmarks or tests concurrently. This mode skips the
fixture server's weather preparation; weather is disabled in the measured
workspace. The installed Playwright container documented in local
development can run the same command in place of `npm run verify:full`.

Results, screenshots, server logs and the tracked working-tree diff go under
`tmp/rendering-benchmark/`; `ZLAYER_BENCHMARK_OUTPUT` chooses another directory.
Use `ZLAYER_BENCHMARK_NOTE` to record relevant run conditions, such as concurrent
host activity. CPU/OS information and starting/ending load averages are recorded;
container-reported hardware does not establish a dedicated CPU or memory allocation.
`results.json` is written only after every round passes the behavioral guards.
`partial-results.json` also preserves completed phases from a failed run, with
`failure.json` recording the error and run conditions. Untracked files are listed
in the recorded status but are not included in the
diff; retain the source checkout when comparing development runs.

## Workload and guards

Each round uses a fresh browser context, then runs these phases in order:

1. Cold workspace load with empty browser storage.
2. Reload with verified chart files and shell cached, but fresh page readers.
3. Four animated pan/zoom/rotation moves, ending at the original camera.
4. Repeat the same path with the acquired files cached.
5. Save the older California edition through Settings, return browsing to Latest,
   then reload across the California/Nevada boundary.
6. Repeat the camera path with regional edition clipping active.
7. Reload offline with the saved edition still authoritative.

The default last phase uses Playwright's browser offline mode. For a separate
origin-failure diagnostic, set `ZLAYER_BENCHMARK_OUTAGE=origin`: the fixture server
then drops every non-control request, including service-worker requests. The phase
is explicitly named `origin-outage-reload`, and the report records `outageMode`.
This proves cached rendering with the origin unavailable; it does not emulate
`navigator.onLine === false` or clear an offline-emulation failure. The server is
reconnected before the next round. No automatic fallback or retry hides failures.

The synthetic feed has two distinguishable editions, native zooms 6–10, up to
16 tiles per spatial package, and enough packages to exercise the resident pool.
Seeded raster linework/noise is deterministic; fixture hashes and byte/tile/package
counts accompany each result. This workload exercises real MapLibre, the custom
protocol, SQLite workers, service-worker whole-file acquisition, verified storage,
and saved-region ownership. Navigation remains loaded as a source-reuse guard;
terrain, weather, obstructions, ownship and AHRS are unloaded.

Every load must deliver nonempty charts, reach a rendered idle frame and execute
package and navigation instrumentation. Camera paths must produce rendered frames
without resubmitting navigation data. Boundary phases must execute composition.
Warm reload/revisit/offline phases must make no chart archive request at the origin.
Actual framebuffer samples verify both browsing and saved-edition colors; missing
charts cannot produce an apparently fast pass. Browser exceptions and measured
stage failures invalidate the run. Cancellation is reported separately.

## Interpreting the measurements

| Measurement | Meaning and limits |
| --- | --- |
| `chartSettledMs` | Navigation time origin to first map idle after nonempty chart delivery for loads; phase start to idle for interactions with new tile work. This is conservative settled readiness, not first visible chart pixel. A fully reused view can be null. |
| `movingFrameIntervals` | Distribution of consecutive MapLibre render-event intervals while the camera is moving. Excludes idle gaps between moves. These are main-thread events, not GPU presentation timestamps. |
| `moveToNextRender` | Camera `movestart` to next render event. Programmatic camera response, not physical input-to-display latency. |
| `stages` | Inclusive time/counts for tile requests, package opens, managed file reads, decoder RPCs, regional partitioning, regional rendering, and bitmap composition. Nested stages and concurrent requests overlap; their totals must not be added. Package-open includes acquisition and decoding; decoder RPC includes worker queueing and transfer, not just SQL execution. |
| `packageReopens` | Repeated open attempts for the same URL within a page lifetime. Reloads start a new lifetime; cancelled attempts can count. |
| `packages` | Exact compressed tile payload bytes/count retained by instrumented package readers, their phase peaks, and maximum simultaneous package opens. Excludes file buffers, SQLite heaps, bitmaps and GPU textures. |
| `sampledMainThreadHeap` | Chromium-only JS heap samples at roughly 100 ms. Sampling can miss brief peaks and excludes workers/GPU; other engines report null. Not a total allocation or process-memory measurement. |
| `originArchiveRequests` | Server-observed archive requests, including service-worker acquisition. Page requests alone cannot establish whether a cached file reached the origin. |
| `longTasks` | Browser long-task entries when supported; otherwise null. Unsupported measurement is never represented as zero. |

Timing distributions retain at most the first 4,096 samples per phase/stage and
report both total count and sampled count. The fixed workload normally stays below
that ceiling. Probes add overhead; keep instrumentation identical in comparisons.
The build transform fails if any expected measurement hook disappears. Only this
opt-in fixture build imports the probe; normal development/production builds have
no instrumentation, global map handle or sampling overhead.

Compare all rounds and p95/max as well as medians on the same engine, profile and
host. No universal millisecond CI threshold is imposed on software-rendered hosts.
The repeatable locality, pixel, cache and failure guards are mandatory. Synthetic
linework, tiny navigation collections and localhost delivery cannot establish
real-feed bandwidth, national-layer cost, physical-device memory or a performance
advantage over another app. Use the [graphics suite](../../../docs/verification/graphics-compatibility.md)
and physical-device checks before accepting rendering changes.

## Harness limitations, September 27, 2026

Initial harness checks used a working tree based on `8b35081`, Node 24.20 and
Playwright 1.63's Linux container while another verification job was active.
They are not an isolated timing baseline. Chromium desktop and phone exercised
all phases, including browser-offline reload and edition/pixel guards.
Two other paths need renewed verification before claiming full engine coverage:

- WebKit at 2× completed the explicit origin-outage diagnostic, while default
  browser-offline reload produced an internal navigation error. Origin outage
  does not validate `navigator.onLine === false` behavior.
- Headed Firefox reached camera reuse, then regional preparation remained at
  **Starting… / Preparing download…** until the 60-second timeout despite waiting
  for the older edition label. Boundary/offline phases were not reached.

These are recorded harness limitations, not a claim that a current run still
fails. The scenarios also exposed repeated synchronous partition work, motivating
the comparison below; inclusive composition time alone cannot identify a drawing
bottleneck.

## Uniform rectangle optimization, September 27, 2026

The shared partitioner now skips polygon operations when conservative edge bounds
prove that no region boundary can touch the query rectangle. A point test then
classifies the whole rectangle. Border tiles retain exact clipping; the
[ownership guide](../../../docs/features/offline-storage.md#geographic-regions)
describes holes, precedence and the fallback. This adds no retained index or cache.

Three fresh Chromium desktop rounds before and three after used the same fixture
hashes, Playwright 1.63 / Chromium and Node 24.20 Linux container, and the same
host (Ryzen AI MAX+ 395). No other Docker test/benchmark job was active. Recorded
tracked source patches differed only in `region-coverage.ts`; unrelated workspace
changes were retained. These are sequential synthetic software-renderer runs,
not physical-device or flight measurements.

Medians across the three rounds:

| Scenario | Total synchronous partition time, before → after | Reduction | Chart settled time, before → after |
| --- | --- | --- | --- |
| Saved-boundary reload | 237.1 → 72.6 ms | 69% | 939.6 → 678.1 ms |
| Saved-boundary pan sequence | 382.4 → 70.8 ms | 81% | 1753.3 → 1376.4 ms |
| Offline reload | 208.1 → 77.0 ms | 63% | 858.3 → 755.9 ms |

Each reload still made 81 partition calls. Animated pan counts varied from
153–154 before to 156–170 after, so the pan totals describe the same camera path,
not an identical call trace. Median pan render-event p95 was 30.1 → 28.6 ms;
the large geometry saving is not a comparable percentage increase in FPS.
Peak retained package payloads were unchanged: 3,732,909 bytes on reload and
10,612,764 bytes during the boundary pan. This does not measure total browser RAM.

All 21 phases passed on both versions, including the pixel/edition guards and
zero origin archive requests in required warm/offline phases. Twenty paired
screenshots were pixel-identical. The remaining offline pair differed only within
the existing basemap-failure warning panel; chart pixels outside that panel were
identical. The new unit comparison checks 98 region/viewport/precedence combinations
against full polygon clipping, plus explicit holes, islands, concavity, touching
edges and a remaining polygon with an earlier region cut out.

Cross-engine graphics coverage checks zoom, orientation, alpha, regional ownership
and missing-edition transparency. Those focused cases do not exercise the full
workspace download/offline paths identified above. Repeat the harness and full
verification for a new revision; device performance needs separate measurement.
