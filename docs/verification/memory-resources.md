# Memory and resource behavior

[Documentation](../README.md) / Verification

This guide records allocation limits, cache behavior and remaining resource work.
Unless separately dated, measurements come from the September 20, 2026 reviews
starting at `3940014`; they do not measure a later build or physical-device RAM.
The reporter confirmed that bounded obstruction decompression substantially
reduced iPhone crashes, but occasional terminations remain unexplained.

## Contents

- [Plugin disabling and repeated use](#plugin-disabling-and-repeated-use)
- [iPhone download constraint: KVGT, 2026-09-21](#iphone-download-constraint-kvgt-2026-09-21)
- [Retained data and decompression](#retained-data-and-decompression)
- [Resource limits by path](#resource-limits-by-path)
- [AHRS session memory and scrolling](#ahrs-session-memory-and-scrolling)
- [Publisher preprocessing is the largest next reduction](#publisher-preprocessing-is-the-largest-next-reduction)
- [Reproducing the obstruction comparison](#reproducing-the-obstruction-comparison)
- [Rendering and cache behavior](#rendering-and-cache-behavior)
- [Recorded rendering comparisons](#recorded-rendering-comparisons)
- [Validation and device boundary](#validation-and-device-boundary)

## Plugin disabling and repeated use

Disabling plugins releases chart reader pools, SQLite/package-decoder workers and the
last route-history consumer's worker. Chart opens and queued readers carry a
cancellable generation; late completions cannot replace a reloaded reader or start
new decoder work. The service worker and explicit offline saves keep ownership of
durable downloads. No verified file is deleted by renderer teardown.

Navigation/route hooks release their transient loaded state, and detached METAR
adapters release airport collections. Selected store snapshots release their cache
when their last subscriber leaves. Bounded shared reference/report caches remain
available to other consumers. Stable workspace callbacks and narrow UI subscriptions
avoid republishing unrelated feature inputs on every application commit.

Regression coverage includes repeated reader disposal/reopening, failed ruler setup,
route-history consumer cancellation, data-hook reactivation and browser chart-worker
cleanup/restart when disabling and re-enabling Charts. These resource-count checks
do not establish a total device heap or GPU budget; long sessions on physical
iPhone/iPad remain a separate validation task.

## iPhone download constraint: KVGT, 2026-09-21

The reporter observed an iPhone crash during a KVGT chart download when the
display reached approximately **177 MiB**. Treat this as a known failing workload
for download changes. The iPhone model, iOS version, exact artifact and whether
the action was opening a plate or saving a region were not supplied. The displayed
transfer size is **not** a measured heap size or a universal iPhone RAM ceiling.
The device termination's cause remains unprofiled.

The download review found whole-response Blob accumulation in both chart archives
and PDF books, and a chart Blob cache bounded only by file count. Incremental
hashing alone did not bound those allocations. WebKit's
[Fetch body consumer](https://github.com/WebKit/WebKit/blob/main/Source/WebCore/Modules/fetch/FetchBodyConsumer.cpp)
builds Blob data from accumulated bytes, and its
[Cache Storage implementation](https://github.com/WebKit/WebKit/blob/main/Source/WebCore/Modules/cache/DOMCache.cpp)
accumulates streamed/Blob response data before committing it. Merely wrapping a
download in a stream, or passing a disk-backed File to `Cache.put`, therefore
does not establish bounded memory use.

The [stored-file contract](../features/offline-storage.md#stored-files) owns the
8 MiB memory fallback, disk-backed downloads, verified receipts, cross-window
reader locks and abandoned-file cleanup. The [core transfer contract](../architecture/layer-plugins.md#file-downloads)
owns 64 KiB awaited writes and the per-context queue: up to four small files,
with bodies above 4 MiB or still unknown in size reserving the whole queue.
PDFs additionally serialize transfers per page; completed chart Blobs have a
16 MiB retention cap. See the [resource table](#resource-limits-by-path).

Two implementation details are essential to those bounds:

- Write exact-sized buffers. In the Linux WebKit regression, writing a view
  wrote its entire backing buffer, expanding a 180 MiB input to 720 MiB.
  Closed-file length validation detected the error; exact copies corrected it.
  Fetch still chooses its own incoming chunk size.
- Publish a small Cache Storage receipt after validation, never the large body.
  Existing readers retain backing files through removal; cleanup must neither
  open whole legacy bodies nor recreate cache namespaces after a reset.

Large new downloads require writable local file storage (`createWritable`,
introduced in [Safari 26](https://developer.apple.com/documentation/safari-release-notes/safari-26-release-notes)).
Without it, existing files remain readable and new small downloads use the bounded
fallback; oversized downloads fail instead of accumulating an unbounded body.

These are local allocation/retention bounds, not a total Safari process budget.
The fallback can overlap its Blob copy and Cache Storage buffers. Different pages,
the chart service worker, terrain workers, map textures, PDF canvases and AHRS
also consume memory. Existing whole-body Cache Storage entries remain readable;
opening those legacy entries may still materialize their complete payloads.

The regression workload streams a synthetic **180 MiB** book to real browser file
storage, verifies it, reloads, reads it with network fetches disabled, and removes
both receipt and file. It asserts 64 KiB maximum writes and a zero-byte receipt
body. This verifies the storage path, not physical-device RAM or a valid rendered
FAA book. A two-window regression finishes overlapping downloads of the same book,
removes its receipt, and confirms both viewers can still read nested file slices.
It then checks reclamation after context shutdown and garbage collection, including
while another reader's page remains open. Physical iPhone validation must repeat
the actual KVGT download past 177 MiB, open the requested chart, then reopen offline,
with map/terrain/AHRS states recorded. Also test low storage, interrupted transfer
and repeated books.

```sh
npx playwright test test/e2e/download-memory.spec.ts test/e2e/plate-download.spec.ts
npx playwright test test/e2e/download-memory.spec.ts test/e2e/plate-download.spec.ts --browser=webkit
```

The large-file tests use fresh **persistent** browser profiles: WebKit's ephemeral
contexts deny OPFS. The chart test disables the real test origin; protocol-level
offline emulation in Linux WebKit rejected even local worker responses. Neither
the synthetic source nor desktop WebKit establishes a physical iPhone peak RAM
measurement or reproduces the original device termination.

## Retained data and decompression

### Filter obstruction records before retaining them

The September 18 FAA DOF snapshot contains 656,056 records. The existing display
rules, including route context, never show structures below 500 ft AGL:

| Height AGL | Records |
| --- | ---: |
| Below 500 ft | 632,287 |
| 500–999 ft | 22,830 |
| 1,000–1,499 ft | 714 |
| 1,500–1,999 ft | 192 |
| 2,000 ft and above | 33 |

The worker now validates every record, but allocates display columns and spatial
cells only for the 23,769 eligible records. Columns grow with the eligible count
and are trimmed after loading. Coordinates remain Float64; heights, elevations,
symbols, verification flags, labels and query order retain their previous values.
Duplicate validation covers **all** source IDs using a temporary Float64 array
sorted in place, replacing the national-size JavaScript Set. That array is released
after validation. Source hash, compressed/uncompressed size and total record count
checks still apply before the index is published.

| Retained typed storage | Before | After |
| --- | ---: | ---: |
| Six display columns, 34 bytes/record | 22,305,904 bytes (21.27 MiB) | 808,146 bytes (0.77 MiB) |
| Records in the spatial grid | 656,056 | 23,769 |

The byte figures exclude spatial-grid JavaScript objects, gzip storage, parser
temporaries and map/GPU memory. The 96.4% reduction describes the display columns,
not total application memory.

The [obstruction query contract](../../src/layers/obstructions/README.md#buffered-viewport-queries)
bounds in-flight work and releases the worker on disable/unmount.

### Bound route-history decompression too

Obstruction and route-history loaders share a 64 KiB compressed-blob reader before
`DecompressionStream`, avoiding the WebKit spike described in
[graphics compatibility](graphics-compatibility.md#obstruction-decompression-memory-spike).
Route history avoids a whole-response ArrayBuffer and subsequent copy: it retains a Blob,
reads two signature bytes, and inflates bounded slices. It still supports responses
that HTTP has already decompressed, and checks size/checksum/schema failures.

Route history ultimately parses a complete JSON string. This change bounds the
compressed input allocations; it does not turn history into a streaming index.

### Keep nested details out of map tiles

Named navigation features no longer send `runways`, `frequencies`, or `charts`
through MapLibre. Fix category/density processing runs before this projection.
The original navigation collections retain these details for search, routing and
detail panels. Clicks, nearby picking and drag snapping resolve complete records
using the feature ID **and** export identity. Anonymous records keep their fallback
details because they cannot be resolved by ID.

Drag movement uses the compact tile records; only the committed drop restores its
full navigation record. This avoids repeated national collection scans for every
nearby candidate on every pointer update, without adding another national index.
Cancelled drags perform no reference lookup.

For the published September 3 navigation export, comparing serialized map source
collections with identical identity/label fields:

| Source | Features | Before | After |
| --- | ---: | ---: | ---: |
| Airports | 19,411 | 14,530,668 bytes | 9,801,439 bytes |
| Fixes, before category filtering | 70,089 | 24,905,053 bytes | 22,989,483 bytes |

These are JSON payload sizes, not heap/GPU footprints. Regional provenance fields
and current fix settings change the actual source sizes. The projection also
applies to weather and priority-fix sources.

Weather joins now find a matching observation before cloning an airport for the
weather overlay. Previously, every refresh copied the entire airport collection
and then discarded airports without reports. Other callers retain the full join.

Camera listeners also capture only their callbacks, rather than retaining the
constructor's initial input object and its catalog/navigation/route references
after later editions replace them.

## Resource limits by path

| Path | Existing controls | Remaining considerations |
| --- | --- | --- |
| Terrain | Four render jobs, four DEM downloads, 128 decoded 256×256 Float32 DEMs (32 MiB), plus up to 32 geographic source grids (8 MiB); route/cell filtering before fetching; max pooling before contour work; explicit bitmap/canvas cleanup; worker termination on removal | Raster textures and normally 128 cached vector-tile results are additional memory. Current screen coverage stays resident if an unusually large viewport exceeds that budget. Vector results are count-bounded, not byte-bounded. Corridor union shares the terrain worker, with one job in flight and one completed outline cached on the main thread; that cache is released on unmount. |
| Modern chart packages | Spatial packages; 16 reader slots; 4 MiB fast-reader file limit; one SQLite decoder; copied tile buffers only when transferring; consumed bitmaps closed | Up to roughly 64 MiB of compressed package payloads, plus in-flight buffers, SQLite high-water heap and MapLibre textures. Idle readers/decoder remain for reuse until Charts is disabled or the map is destroyed; then the pools and workers are disposed. |
| Legacy charts | Six reader slots; SQLite workers terminated on eviction, disabling Charts or destroying the map; whole-file requests coalesced; one large transfer per execution context through core; completed archive Blobs capped at 16 MiB; source images decoded sequentially during composition | Large new downloads use local files as described above. Reader limits are not a total memory budget. Low-zoom overview SQL can materialize many compressed tile rows from a legacy sheet. Publisher-generated overviews/packages are preferable. |
| PDF plates | File/Blob range reads with auto-fetch disabled; disk-backed large downloads and one transfer per page; serialized render jobs; each canvas capped at 8,388,608 pixels/32 MiB and 8,192 px per side; render buffers/pages/tasks released | The display plus replacement canvas can total 64 MiB, before PDF.js, fonts and document resources. Download work is shared and can continue after closing a viewer. |
| IAP on-map | One static MapLibre canvas source; each reprojection canvas capped at 4,194,304 pixels/16 MiB and 3,072 px per side; temporary and replaced canvases released | Preparation uses both a source and output canvas. The existing map plate, PDF viewer and GPU texture can overlap those allocations. The per-canvas cap is not a total plate-memory limit. Pans and zooms reuse the static texture. |
| Reference caches | Successful requests coalesced; failures retryable; generally 24 ready entries per ResourceCache; regional caches use WeakMap ownership | National navigation, airways, procedures and history still use whole-document parsing. Concurrent loads and multiple editions can overlap; entry counts do not bound bytes. |
| METAR/TAF | Station/area caches bounded; visible-demand refresh and aborts; handlers removed on unmount | Weather snapshots/joins still allocate per update, now with the early airport filter. |
| AWC Weather | One admitted forecast decode/conversion per page, with two scalar acquisitions and one independent wind job, each capped at 16 MiB compressed input; 96 MiB decoded neighborhood and up to 48 MiB of nearby full-domain rasters; temperature shares wind data; core isolates persistent category budgets and protects complete same-altitude numeric cohorts from self-eviction | Wind interpolation can overlap two boundary levels, one incoming level and its output (about 101.6 MiB). Displayed/replacement bundles, terrain, decoder scratch, compressed inputs and raster/GPU copies are additional. These are working-set controls, not a total process RAM cap. [AWC grid budgets](../../src/layers/weather-awc/grids/README.md#time-recovery-and-budgets) own the persistent ceilings, allocation and eviction details. |
| AHRS | Sensor lifecycle tied to activity/visibility; bounded recording buffer (2 Mi characters), 128 Ki-character chunks, one storage writer; capture stops when storage falls behind. GPX/debug exports read 64 KiB pieces in a worker and append to an OPFS temporary file; unavailable/full storage falls back to at most 8 MiB. Repeated downloads reuse the recent URL; a different export releases the prior fallback payload first. | Estimator matrices produce short-lived allocations. Limits bound application buffers, not total browser memory; long-session capture/export still needs physical iPhone measurement. |
| Map | One resize owner; sources/layers removed on detach; terrain/chart bitmap cleanup covered by graphics tests | MapLibre caches and framebuffer size scale with viewport/device density. No new global density or tile-cache limits were imposed without an allocation profile. |

## AHRS session memory and scrolling

Stop/cancel and beginning a new calibration release estimator replay checkpoints
and the independent heading trajectory. Completing calibration discards the raw
calibration window and stops adding later GPS fixes to it. Background operation
and automatic recovery retain the active state they need. The removed retention
was the last session's history in a mounted layer, not unbounded accumulation
across sessions.

A 2026-09-20 Node 24.15.0 probe exercised the production layer for 120 simulated
seconds with synthetic 60 Hz level IMU input, no GPS and no recording. After an
event-loop turn and forced collection, process ArrayBuffer totals were:

| State | Before history cleanup | After history cleanup |
| --- | ---: | ---: |
| Active, at 30/60/90/120 seconds | 5,310,106 bytes | 5,310,106 bytes |
| Stopped, layer still mounted | 5,310,106 bytes | 36,466 bytes |

The stopped case released about **5.03 MiB**; the active sequence plateaued.
These are isolated Node process totals, not Safari RAM, peak allocations or GPU
memory. Compare active/stopped values in the same environment:

```sh
node --expose-gc --import=tsx tools/benchmark-ahrs-memory.ts
```

The layer has no scroll handler that deliberately pauses AHRS. Motion callbacks
and estimator work run on the main thread. The horizon and HSI share a capped
60 FPS animation clock; status controls publish at 20 Hz. Hidden displays stop
their display work while Background operation continues sensor processing.

Distinguish two symptoms when investigating a frozen horizon:

- Missing/delayed motion events retain the last observed attitude. Sensor age over
  0.5 seconds produces **Motion**; calibration retains progress without counting
  missing intervals, and calibrated operation resumes with uncertainty for the gap.
- Delayed rendering can freeze the visible instrument while sensor events still
  arrive. If the main thread cannot execute, its stale warning cannot update either.
  Record event and callback receipt times alongside CPU/render activity to separate
  input delivery from display delay. A prolonged foreground freeze, forced
  recalibration or reload needs device investigation.

Main-thread painting contention is a possible explanation, not a demonstrated
cause of every iPhone freeze. Use the [WebKit CPU timeline](https://webkit.org/blog/8993/cpu-timeline-in-web-inspector/)
and [memory tools](https://webkit.org/blog/6425/memory-debugging-with-web-inspector/)
on the actual device. The limits in the table above are overlapping local bounds,
not a shared RAM budget or a worst-case sum. Measure cold load with charts,
terrain, PDFs and AHRS together, then repeated toggles, panning, scrolling, Stop
and background/foreground cycles. Heap size alone omits image and layer memory.

Browser fixtures cover queued motion, scrolling recovery, visibility, Background
operation and Stop with a separate GPS lease. WebKit uses an Event-based motion
constructor when its native interface cannot be constructed. Synthetic events do
not reproduce physical iOS scheduling, thermal conditions or process limits.

```sh
npx playwright test test/e2e/ahrs.spec.ts --browser=webkit \
  --grep 'scrolling|queued motion|page visibility|Background freezes|stop clears GPS'
```

Repeat with `--browser=chromium`. [AHRS validation](../../src/layers/ahrs/validation.md) owns the
estimator evidence;
[deployment readiness](../development/deployment.md#verification-and-remaining-release-gates)
owns the outstanding physical-device checks.

## Publisher preprocessing is the largest next reduction

The national obstacle source measured in the September 20 review required
16,568,035 gzip bytes and 277,404,929 decoded JSON bytes for validation. Filtering
during indexing reduces retention but cannot eliminate that first-load parsing work.

A local projection experiment retained only the 23,769 displayable records and
the fields already consumed by the map, preserving all coordinates and values.
It produced **5,481,374 JSON bytes / 384,679 gzip bytes** (Node gzip level 9).
This is an experiment, not a published artifact or new supported feed contract.

The `faa-regs` publisher should supply an additional, versioned map artifact with
an explicit height floor/field contract, digest, source identity and counts. Keep
the complete canonical DOF available separately. A client can then validate the
small map artifact directly and fall back to the current feed for older publishers.
Spatial partitions would also let a future lower-height display fetch only nearby
records. Do not silently filter the canonical dataset or lose safety-significant
height/verification information.

For navigation, separate compact map/search records from airport detail records
and precompute stable fix classifications at publication time. Keep edition
ownership and route/search completeness when introducing regional partitions.
The client now persists a verified, versioned filtered binary index to avoid
repeated obstruction parsing after toggles/reloads. Its storage cost is 8 header
bytes plus the retained numeric columns (808,154 bytes for the recorded snapshot).
See the [obstruction storage contract](../../src/layers/obstructions/README.md#source-and-lifecycle)
for integrity and migration. This does not reduce the initial download or validation
work; the publisher optimization above remains useful for first loads.

## Reproducing the obstruction comparison

Download the manifest and the immutable gzip file named by it, then run:

```sh
node --expose-gc --import=tsx tools/benchmark-obstructions.ts MANIFEST.json OBSTACLES.geojson.gz
```

An optional third argument selects another compatible index module for comparison
in a separate process. The benchmark verifies the compressed hash/size, parses
the same source, and hashes the complete output of 70 combinations of world/local/
dateline views, seven zooms and routes present/absent. Before and after both
returned 101,370 total query features and output SHA-256
`670a53eeff4f5e210ebd1538cfb4c0e5feb39134c637fe27aee561033271a4fd`
for source SHA-256
`4a9eda931c0a54fd5b89809f99666ace472db5b7e2465c6fcf12bb103908b8f6`.

A single local Node 24 run took 2.48 → 1.93 seconds to index and 293 → 145 ms for
the query/hash batch. These timings are diagnostic, not a device performance
guarantee. Typed-storage totals and identical query digests are the stronger
evidence. The benchmark reports Node memory/RSS for further controlled runs;
those figures are not Safari process footprints.

## Rendering and cache behavior

The opt-in [chart pipeline benchmark](../../src/layers/charts/benchmark.md) measures
cold/warm loads, pan/zoom/revisit and saved-edition boundaries in the built workspace.
It records package payload retention and Chromium heap samples separately; neither
is a total browser/GPU memory budget. Use it alongside physical-device profiling.

### Large map, limited viewport

The map keeps its geographic extent and camera independently of plugin lifetime.
One viewport-sized WebGL canvas draws the current view at display density. MapLibre
owns camera animation, visible-tile selection, tiling and symbol placement; React
receives settled camera changes. Charts select spatial/zoom packages, terrain
publishes visible cached geometry, obstructions retain a bounded pan buffer, and
map weather requests only rendered airport stations. Navigation retains broader
reference collections for search/routing and lets MapLibre tile and declutter the
render sources; it is not a viewport-streamed reference database.

`test/e2e/map-locality.spec.ts` checks the built workspace at desktop and phone
widths. Repeated settings/layer-menu changes, pans and zooms must preserve the
canvas, make no additional navigation GeoJSON uploads, and return WebGL drawing
to idle. The probes assert that initial uploads and drawing occurred so a broken
instrumentation path cannot silently pass. `map-resize.spec.ts` checks canvas
dimensions at 1×/2×/3× density; `terrain-locality.spec.ts` checks warm pans without
new terrain renders and revisits after more than 150 unique tiles. Obstruction
and weather regressions check buffered refills during gestures and no station
queries on unrelated repaint frames. These checks protect work reuse and bounded
presentation; they do not measure the physical-device frame-time target.

### Map inputs

Plugin guides own input reuse and publication rules:
[navigation ranking and priorities](../../src/layers/navigation/fix-display.md#input-reuse),
[METAR station queries and source updates](../../src/layers/metar-taf/README.md#demand-refresh-and-recovery),
[route preview submission](../../src/layers/routes/README.md#edit-lifecycles), and
[chart-family compilation](../../src/layers/charts/README.md#startup-and-recovery).
The [recorded comparisons](#recorded-rendering-comparisons) below retain payload,
allocation and timing evidence, including the preview burst-latency tradeoff.

### Buffered obstruction queries

The [obstruction guide](../../src/layers/obstructions/README.md#buffered-viewport-queries)
owns padding, refill timing, stale-result rejection and visible counts. Its bounded
pan buffer is distinct from Navigation's retained national reference data.

### Terrain recovery and parsed indices

The [terrain guide](../../src/layers/terrain/README.md#cache-recovery-and-source-identity)
owns vector-cache retention, raster/vector recovery and parsed-index identity.
Warm caches must still expose missing files or invalid receipts. The resource
table above and the recorded comparisons below retain cross-plugin limits and
measurement scope.

## Recorded rendering comparisons

September 20 Node probes used 70,089 national fixes, including 69,416 non-VFR fixes.
Heap samples followed an event-loop turn and forced GC; they exclude the original
export, MapLibre workers and GPU allocations.

| Probe | Before | After |
| --- | ---: | ---: |
| Retained fix index, without airway enrichment | About 25.3 MiB | About 5.3 MiB |
| Index including cached default ranking | About 25.3 MiB | About 6.0 MiB |
| Source writes for 100 equivalent empty-priority updates | 200 | 0 |
| Station queries for 120 unrelated stationary render notifications | 120 | 0 |

The 4.34 MiB JSON payload for 12,091 default-mode fixes was preserved. All 54 fix
output comparisons and 440 route/label states matched; 180 national obstruction
comparisons retained in-view features/properties/counts across route fades, zoom
cutoffs, high latitudes and world wrapping. These are dated preservation checks.

A Linux browser probe compared frame-batched and immediate preview submission:
48 sequential positions at 0/4/8/12 ms after a frame, excluding four warmups. The
endpoint was a render event with the new position in rendered-feature queries.

| Single update | Previous render median | Immediate render median | Previous/immediate submission median |
| --- | ---: | ---: | ---: |
| Chromium | 26.2 ms | 10.7 ms | 7.8 / 0.0 ms |
| WebKit | 37.0 ms | 27.5 ms | 9.0 / 0.0 ms |

Zero means below timer precision. Bursts of eight distinct updates now submit eight
primary-source writes instead of one. WebKit burst p95 rose from 42 to 50 ms despite
a lower median. These results support removing the unconditional frame delay, not
universal tail-latency improvement or physical input-to-display timing.

## Validation and device boundary

Regression coverage includes source validation and duplicate IDs across filtered
records, full-record selection/snapping, bounded decompression, buffer reuse and
continuous panning, stale-result rejection, retry/remount, terrain cache pressure
beyond 150 tiles, bitmap cleanup, saved-source identity and storage eviction/repair.
Unrelated catalog refreshes must preserve source objects/order and ready status
without terrain worker jobs or source-loading events. See
[terrain verification](../../src/layers/terrain/README.md#verification) and
[graphics checks](graphics-compatibility.md#run-the-checks) for rendering coverage.

```sh
node --import=tsx --test test/obstruction-coverage.test.ts test/obstruction-layer.test.ts test/obstructions.test.ts test/terrain-layer.test.ts test/terrain-vector-cache.test.ts test/route-layer.test.ts
npx playwright test fix-display.spec.ts weather-map.spec.ts route-map.spec.ts obstructions.spec.ts terrain.spec.ts terrain-locality.spec.ts
npx playwright test fix-display.spec.ts weather-map.spec.ts obstructions.spec.ts terrain.spec.ts terrain-locality.spec.ts --browser=webkit
```

For browser regressions, distinguish unsupported native input injection and
offline emulation from application failures. Cover report interception, reachable
route controls, obstruction cache reuse and cold offline navigation before
attributing a failure to terrain or memory. Current runs determine current status.

On-device allocation profiling and retesting remain necessary. Record iPhone/iOS
version and whether failures occur during cold load, panning, layer changes, PDF
use or AHRS; test warm starts, repeated toggles, saved-edition changes and
background/foreground transitions. A Linux WebKit pass cannot establish device
peak footprint or eliminate every crash. Keep release evidence with the
[remaining gates](../development/deployment.md#verification-and-remaining-release-gates).
