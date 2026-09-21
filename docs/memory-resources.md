# Memory and resource behavior

Reviewed 2026-09-20, starting from `3940014`. The reporter confirmed that bounded
obstruction decompression substantially reduced iPhone crashes, with occasional
failures remaining. This review identifies concrete allocation reductions; it
does not identify the cause of those remaining device terminations.

## Changes

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

Obstruction RPCs also permit only one query in flight. New view/route changes
replace the pending demand; after the active query completes, the worker receives
the latest view. Stale results are still rejected by revision. Disabling or
unmounting the layer terminates its worker and resets pending demand.

### Bound route-history decompression too

Route history still used `Blob.stream()` immediately before `DecompressionStream`,
the same pattern responsible for the previous WebKit obstruction spike. Both
loaders now share a 64 KiB compressed-blob reader. Route history also avoids a
whole-response ArrayBuffer and its subsequent Blob copy: it retains a Blob,
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

## Other paths inspected

| Path | Existing controls | Remaining considerations |
| --- | --- | --- |
| Terrain | Four render jobs, four DEM downloads, 128 decoded 256×256 Float32 DEMs (32 MiB), plus up to 32 geographic source grids (8 MiB); route/cell filtering before fetching; max pooling before contour work; explicit bitmap/canvas cleanup; worker termination on removal | Raster textures and normally 128 cached vector-tile results are additional memory. Current screen coverage stays resident if an unusually large viewport exceeds that budget. Vector results are count-bounded, not byte-bounded. Corridor union shares the terrain worker, with one job in flight and one completed outline cached on the main thread; that cache is released on unmount. |
| Modern chart packages | Spatial packages; 16 reader slots; 4 MiB fast-reader file limit; one SQLite decoder; copied tile buffers only when transferring; consumed bitmaps closed | Up to roughly 64 MiB of compressed package payloads, plus in-flight buffers, SQLite high-water heap and MapLibre textures. Idle readers/decoder remain for reuse. |
| Legacy charts | Six reader slots; SQLite workers terminated on eviction; whole-file requests coalesced; at most two large downloads; source images decoded sequentially during composition | Reader/file-count limits are not a total memory budget. Low-zoom overview SQL can materialize many compressed tile rows from a legacy sheet. Publisher-generated overviews/packages are preferable. |
| PDF plates | Blob range reads with auto-fetch disabled; serialized render jobs; each canvas capped at 8,388,608 pixels/32 MiB and 8,192 px per side; render buffers/pages/tasks released | The display plus replacement canvas can total 64 MiB, before PDF.js, fonts and document resources. Download work is shared and can continue after closing a viewer. |
| IAP on-map | One static MapLibre canvas source; each reprojection canvas capped at 4,194,304 pixels/16 MiB and 3,072 px per side; temporary and replaced canvases released | Preparation uses both a source and output canvas. The existing map plate, PDF viewer and GPU texture can overlap those allocations. The per-canvas cap is not a total plate-memory limit. Pans and zooms reuse the static texture. |
| Reference caches | Successful requests coalesced; failures retryable; generally 24 ready entries per ResourceCache; regional caches use WeakMap ownership | National navigation, airways, procedures and history still use whole-document parsing. Concurrent loads and multiple editions can overlap; entry counts do not bound bytes. |
| METAR/TAF | Station/area caches bounded; visible-demand refresh and aborts; handlers removed on unmount | Weather snapshots/joins still allocate per update, now with the early airport filter. |
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

The recorded cleanup pass passed 257 AHRS unit cases and eight focused cases in
each of Linux WebKit and Chromium, covering queued motion, scrolling recovery at
390×844 and 744×1133, visibility, Background operation and Stop with a separate GPS
lease. The WebKit fixture supplies an Event-based motion constructor when the
native interface cannot be constructed. Synthetic scrolling/sensor events do not
reproduce physical iOS scheduling, thermal conditions or process limits.

```sh
npx playwright test test/e2e/ahrs.spec.ts --browser=webkit \
  --grep 'scrolling|queued motion|page visibility|Background freezes|stop clears GPS'
```

Repeat with `--browser=chromium`. These are dated focused results, not a current
full-suite pass. [AHRS validation](ahrs-validation.md) owns the estimator evidence;
[deployment readiness](deployment-readiness.md#verification-and-remaining-release-gates)
owns the outstanding physical-device checks.

## Publisher preprocessing is the largest next reduction

The browser still downloads 16,568,035 gzip bytes and scans 277,404,929 JSON bytes
to validate the national obstacle source. Filtering during indexing reduces
retention but cannot eliminate that first-load parsing work.

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
A verified, versioned local binary index is another option for avoiding repeated
obstruction parsing after toggles/reloads, but needs its own integrity and migration
contract; it would not reduce the initial download.

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

## Validation and device boundary

Unit regressions cover retention with mostly ineligible records, dynamic column
growth, duplicates spanning retained/filtered records, corrupt source data,
bounded multi-chunk history reads, source-detail preservation, and full-record
selection/snapping. Browser regressions cover graphics, density/resize, obstruction
tiers/corridors, rapid route/view changes, toggles/remounts, routes and weather.

Validation used an isolated copy of `3940014` plus this review's changes, because
unrelated route UI edits were being made concurrently in the shared workspace:

- Import boundaries, strict TypeScript, **967 unit tests** and production build
  passed. The final listener cleanup also passed its focused map/gesture tests,
  type checks and a rebuilt production bundle.
- **41 Chromium cases passed**, including the final weather-join changes and a
  real map-symbol selection restoring airport frequencies, followed by offline
  reload. **25 WebKit cases passed** and one case was skipped by its existing
  browser condition. The final 1×/2×/3× resize cases passed in both engines.
- **15 WebKit cases failed on both the original commit and this change**: six
  weather cases, six route-editor refresh cases, two airport-summary cases, and
  the previously recorded obstruction cache-reuse assertion (three downloads
  rather than one). Baseline checks used the same container and test configuration.
  No new failing browser case remained; this is not an all-green WebKit suite.

Browser checks used Playwright 1.63's Linux container. The normal graphics pixel
assertions passed in Chromium and WebKit; no physical iPhone memory measurement
was taken during this review.

The occasional iPhone termination still needs an on-device allocation profile and
retest. Record the iPhone/iOS version and whether it occurs during cold load,
panning, layer changes, PDF use or AHRS. Check cold/warm starts, repeated toggles,
saved-edition changes and background/foreground transitions; a Linux WebKit pass
cannot establish the device's peak footprint or eliminate every crash.

## Map rendering follow-up, 2026-09-20

The next pass preserves the existing display rules while reducing work when map
inputs have not changed:

- Fix indexing retains low/high airway counts. Temporary membership Sets exist
  only for airway fixes during indexing and are then released. Duplicate airway
  components still count once, and low/high names remain disjoint. A WeakMap
  retains only the current settings' sorted ranking. Priority exclusions still
  run before density placement, so promoting a fix frees the same cells as before.
- Navigation compares effective priority identities and setting values. Reordered
  priorities update their own source without rebuilding background density;
  refreshed feature objects still update their coordinates and properties.
- Weather station queries run after relevant camera, style, resize or airport
  source changes. Late tiles still trigger a query after rendering. Status-only
  observation updates and visibility changes avoid resubmitting GeoJSON. The
  cache keeps input identities, not an additional joined GeoJSON collection.
- Route previews submit immediately to MapLibre. A later latency review removed
  the initial animation-frame batching, which delayed worker processing (see
  below). Label IDs, occurrence keys and unchanged alternative plans are reused;
  equivalent previews skip source updates, and normal/comparison editability still
  invalidates the primary. Snapping and committed drops remain synchronous.
- Chart family definitions are compiled per immutable catalog in a WeakMap.
  Movement continues to evaluate the original viewport visibility rules, including
  antimeridian/world copies. Catalog replacement and layer ordering are unchanged.

Local Node probes used the saved 70,089-feature national fix export, with 69,416
non-VFR fixes. These figures exclude the original export, MapLibre workers and GPU:

| Probe | Before | After |
| --- | ---: | ---: |
| Retained fix index, no airway enrichment | About 25.3 MiB | About 5.3 MiB |
| Index including cached default ranking | About 25.3 MiB | About 6.0 MiB |
| Source writes for 100 equivalent empty-priority updates | 200 | 0 |
| Station queries for 120 unrelated stationary render notifications | 120 | 0 |

Heap measurements used `--expose-gc` after an event-loop turn. The previous source
payload was 4.34 MiB as JSON for 12,091 default-mode fixes; its content is preserved.
Equivalent updates now avoid rebuilding and submitting that payload. These are
Node allocation measurements and instrumented call counts, not iPhone memory or
frame-rate measurements.

Preservation checks compared the pre-change workspace snapshot with this pass:

- All **54 national fix output comparisons were byte-identical**, covering every
  detail/airspace combination, three priority selections, and both absent airway
  data and duplicated synthetic low/high memberships.
- All **440 route/label states matched**, including waypoint/leg previews, snaps,
  dateline coordinates, repeated occurrences, procedure/TEC gaps, comparisons
  and clearing. Unit tests also exercise immediate submission, cancellation,
  stale revisions and remounting.
- The isolated snapshot passes import boundaries, TypeScript, **1,008 unit tests**
  and production build. Isolation preserves the starting workspace while other
  UI work continues in the shared tree.
- **49 Chromium cases pass** across targeted runs covering fixes, routes, direct-to behavior, weather, chart startup
  and graphics. New real-map fixtures test fix modes/selection and weather scope
  after late tile loads, camera changes and toggles, including 20 forced renders
  that must perform no new station queries.
- **29 WebKit/WebKit Retina cases pass** across targeted runs, including graphics pixel checks for rotation,
  resize, WebGL restoration and chart transparency. The new fix and weather map
  fixtures also pass in Chromium and WebKit.
- The broader WebKit run has **15 pre-existing failures**, reproduced on the
  untouched workspace snapshot: nine weather/TAF interception cases and six
  route-editor cases that call Chromium-only CDP APIs. No new failing case remains;
  this is not an all-green WebKit suite or a physical-iPhone crash guarantee.

Focused commands (run in the Playwright container where needed):

```sh
node --import=tsx --test test/fix-display.test.ts test/navigation-layer.test.ts test/metar-layer.test.ts test/route-layer.test.ts test/route-geometry.test.ts test/route-gestures.test.ts test/chart-layer.test.ts
npx playwright test fix-display.spec.ts weather-map.spec.ts route-map.spec.ts metar.spec.ts metar-taf.spec.ts chart-startup.spec.ts
npx playwright test fix-display.spec.ts weather-map.spec.ts --browser=webkit
npx playwright test --config=playwright.graphics.config.ts --project=webkit --project=webkit-retina graphics.spec.ts
```

## Buffered obstruction coverage and immediate route previews, 2026-09-20

The locality review found that putting an animation-frame wait before MapLibre's
GeoJSON worker delayed ordinary route previews. The route layer now submits
immediately and retains the renderer's identity checks, cached occurrence keys,
label identities and unchanged alternatives. Ending a preview and replacing a
route also submit immediately; no queued frame can restore an old preview.

A controlled browser probe compared the previous frame-batched implementation
with the actual corrected layer. Each case used 48 sequential positions, with
inputs at 0, 4, 8 or 12 ms after a frame; the first four samples were excluded.
The endpoint was a MapLibre render event with the new preview position available
in rendered-feature queries, rather than physical input-to-display latency.

| Single preview update | Previous render median | Corrected render median | Previous/corrected submission median |
| --- | ---: | ---: | ---: |
| Chromium | 26.2 ms | 10.7 ms | 7.8 / 0.0 ms |
| WebKit | 37.0 ms | 27.5 ms | 9.0 / 0.0 ms |

Reported zero submission time means below the browser timer's precision. All
eight timing cases completed, including eight distinct updates per sample. That
burst now submits eight primary-source updates instead of one, while equivalent
previews, alternative sources and labels still avoid redundant updates. WebKit
burst render p95 was 50 ms versus 42 ms in the frame-batched case, despite a lower
median. These Linux container measurements support removing the unconditional
delay; they do not establish universal frame-rate or tail-latency improvement on
an iPhone or with a large route.

Obstructions now load a margin of half the viewport on each side, measured in
Mercator space and capped at one world's longitude span and the map's latitude
limits. A refill begins when less than a quarter-viewport margin remains.
Movement uses an 80 ms throttle that is not restarted by each event, so continuous
panning can load its next area before `moveend`. Pans within the buffer reuse the
existing source. Integer zoom changes refresh coverage and keep the working set
appropriate to the new view; the renderer's existing fractional-zoom height
cutoffs remain unchanged.

Only one worker query runs at a time. Pending movement collapses to the latest
view; results must cover that view at the current zoom tier and route generation.
Changing routes immediately removes the previous corridor contribution while
retaining height-eligible points. Returning to a warm buffer keeps it available
even if an obsolete overlapping refill fails. Disabling/unmounting still releases
the worker. Status counts use the actual viewport and current height/corridor
eligibility, excluding prefetched points.

This trades a bounded increase in nearby source data for fewer source replacements
and continuity while panning. One requested rectangle is at most four times the
viewport's Mercator area before world clipping; feature counts depend on local
density. The compact national index, source validation, geometry, height tiers,
symbol styling and route-corridor rules are unchanged. Navigation still retains
complete reference data and a complete eligible render collection; this change
does not add navigation streaming or a new publisher feed contract.

Validation for this follow-up:

- **180 comparisons against the 656,056-record national obstruction export**
  preserve every in-view feature/property and the visible count, including route
  fades, fractional zoom cutoffs, high latitudes and dateline/world copies.
- Unit coverage exercises buffer reuse, continuous pans, latest-view coalescing,
  distant/reversed pans, failed obsolete refills, route/zoom changes, online retry,
  disable, remount, and immediate route previews.
- The isolated starting workspace plus this change passes import boundaries,
  TypeScript, **1,022 unit tests** and production build.
- The real-map panning test verifies that an offscreen buffered obstruction
  becomes visible during movement without another worker query, and a longer pan
  starts its next query before the gesture ends, in Chromium and WebKit.
- Two route-panel browser failures reproduce on the untouched starting snapshot:
  the existing remove button is blocked by the page's pointer-event layout. A
  WebKit obstruction cache assertion also reproduces unchanged, observing three
  gzip requests instead of one across toggle/remount. These are not new failures
  from the rendering change; they remain separate integration issues.

Focused commands:

```sh
node --import=tsx --test test/obstruction-coverage.test.ts test/obstruction-layer.test.ts test/obstructions.test.ts test/route-layer.test.ts
npx playwright test obstructions.spec.ts route-map.spec.ts
npx playwright test obstructions.spec.ts --browser=webkit
```

## Terrain cache recovery and foreground ordering, 2026-09-20

Terrain's vector cache now keeps current screen coverage resident and uses recent
visibility to choose which other entries to evict. Cache access preserves the
geometry's insertion order so visiting a tile does not reshuffle label placement.
The normal budget remains 128 entries; only current screen coverage can exceed
it, and the cache shrinks again when that coverage leaves the view.

MapLibre's raster cache can outlive a vector entry. A missing vector no longer
reports ready: after raster demand has been updated, the layer recovers missing
current tiles through the same worker and source-selection path as ordinary tile
loads. There are at most four recovery requests, sharing the worker's existing
four-job allocation limit. Recovery closes its unused raster bitmaps, cancels
offscreen requests, rejects obsolete route/source generations, and stops retrying
failed tiles until an explicit retry. Viewport-only shading does not request
route-vector recovery.

During movement, changed tile coverage publishes cached contours and labels
without waiting for `moveend`. Moves within the same coverage do not rewrite the
GeoJSON sources. New worker results still use the existing 100 ms coalescing
window. The foreground host supplies stable insertion anchors so terrain source
replacement and individual layer remounts preserve route-label and ownship order.
Terrain-source errors request a completion frame because MapLibre completes
failed raster requests without emitting `sourcedata`.

Regression coverage includes cache pressure beyond 150 terrain tiles, immediate
warm-pan updates without worker requests, bounded recovery, late/canceled bitmap
cleanup, failure/retry, mode changes, and ordering across edits/toggles/remounts.
Existing terrain browser tests also check fractional zoom, Retina pixel alignment,
mobile texture precision, clearance recoloring, touch responsiveness, and worker
release on disable. Browser runs use desktop Chromium and Linux WebKit, not a
physical iPhone.

Final validation passed import boundaries, TypeScript, all **1,053 unit tests**
(935 application, 16 contracts, 102 domain), and the production build. The terrain
suite passed **14 cases in Chromium and 14 in WebKit**. Six additional Chromium
cases passed for ownship, route interaction with mouse/touch, and weather scope.

```sh
node --import=tsx --test test/terrain-layer.test.ts test/terrain-vector-cache.test.ts test/navigation-layer.test.ts test/layer-module.test.ts
npx playwright test terrain.spec.ts terrain-locality.spec.ts
npx playwright test terrain.spec.ts terrain-locality.spec.ts --browser=webkit
```

## Preserve terrain across catalog refreshes and reuse parsed indices, 2026-09-20

Terrain now derives its source identity from the first eligible source for each
shard, including saved-region precedence, resolved archive URLs, content hashes,
and byte lengths. Catalog timestamps, unrelated metadata, saved-file health,
shard ordering, and fully shadowed sources do not discard visible terrain or
cancel pending renders. Changing an effective source still replaces the raster
and vector generation and rejects late results from the previous source.

Packaged elevation shares parsed and validated indices across native DEM reads.
The cache retains at most eight entries, including pending parses, with up to
1,024 archive descriptors per index. Recent use determines eviction, and archive
lookup uses a tile-key map. Four DEMs of one displayed map tile now require one
index parse instead of four. Canceling a caller stops its wait without canceling
other consumers; failed parses are removed so a later read can retry.

Persistent-storage checks still run before parsed-cache lookup. Offline health
checks detect missing files or invalid verification receipts even with a warm
index, while ordinary reads retain the existing storage-repair path. The cache
identity includes the expected shard location so validated content cannot be
reused for an incompatible shard.

Regression coverage checks unchanged-source refreshes in route and viewport modes,
real source replacement, saved-region selection and health, bounded eviction,
shared parsing, cancellation, failure/retry, and persistent-storage eviction and
repair. Browser catalog refreshes assert unchanged source objects and layer order,
continuous ready status, zero terrain worker jobs, and zero source-loading events.

Validation of a frozen working-tree snapshot passed import boundaries, TypeScript,
all **1,065 unit tests** (947 application, 16 contracts, 102 domain), and the
production build. Terrain browser checks passed **20 cases in Chromium**,
including cold offline reload, and **five cases in Linux WebKit**, including both
catalog-refresh modes. The terrain production files match that snapshot; six
current DEM lifecycle tests also passed after additional test coverage arrived.

Linux WebKit's cold offline reload reports an internal browser navigation error
on both the starting version and the changed version, so that case remains
unverified in WebKit. These checks do not substitute for a physical iPhone run.
