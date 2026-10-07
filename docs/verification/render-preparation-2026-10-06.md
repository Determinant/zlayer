# Rendering preparation measurements — October 6, 2026

[Documentation](../README.md) / Verification

This is dated evidence for review follow-up #6: AWC Weather prepared JSON,
Terrain contour stitching, Plates reprojection and Glide cold uploads. Current
contracts remain in the respective plugin READMEs. These measurements do not
establish iPhone process-memory limits, battery savings or GPU completion time.

## Method

`tools/benchmark-render-preparation.mjs` production-builds an isolated browser
entry, serves fixed local inputs, uses real PDF.js and MapLibre workers, and
records one warmup plus five measured rounds. Each browser runs separately.
Results below are medians across rounds, on an AMD Ryzen AI Max+ 395 host using
the installed `mcr.microsoft.com/playwright:v1.63.0-noble` container:
Chromium 153.0.8010.12 and WebKit 26.6, 390 × 844 CSS pixels, density 3.
Desktop WebKit at phone dimensions is not iPhone hardware.

Inputs:

- A valid synthetic national radar artifact: 8,067,565 JSON bytes, 800 separate
  polygons across eight thresholds, 256 vertices per ring plus closure.
- A captured September 24 WPC F168 chart normalized by the production parser:
  793,558 prepared JSON bytes, 186 features.
- Thirty-six 128² DEM grids with dense analytic ridges, one diagonal route,
  500-foot contour intervals: 24,891 stitched paths.
- A generated georeferenced PDF rendered at the production canvas limit, with
  asymmetric colored content and an exact red-corner pixel check.
- Sixty-four actual 256² Glide pyramids, nine mips each, all visible. The custom
  layer compiles real shaders and uploads/draws in the browser's WebGL context.

Fixture creation, downloads and shader compilation are outside the measured
stages. A 1 ms interval samples event-loop gaps; a trailing task lets synchronous
work be observed. These gaps also include browser scheduling, GC and rendering,
and are not precise attribution of every pause. Separate direct timings record
JSON decode/validation, seam generation, path joining and custom-layer rendering.
The plate probe groups actual `drawImage` calls by task and measures their span;
it does not include all PDF or canvas initialization work.

The harness compares Terrain's synchronous and cooperative versions in the same
run and asserts identical geometry. A benchmark-only worker measures input copy,
work, return delivery and event-loop gaps, with identical-result assertions.
The input buffers remain owned by the caller, as required for cache publication.
There is no new production Weather worker.

For Plates and Glide, the matched baseline loads only those two modules from
commit `3f01a2b` during the benchmark build, without editing the working tree.
The final run uses the current working tree. Raw JSON retains revision, dirty-file
list, baseline overrides, input hashes/sizes, browser and individual round values
under ignored `tmp/render-preparation/<label>-<engine>/results.json`.

With the browser's system dependencies installed, run from the repository root:

```sh
node --import=tsx tools/benchmark-render-preparation.mjs chromium comparison 5 3f01a2b
node --import=tsx tools/benchmark-render-preparation.mjs chromium final 5
node --import=tsx tools/benchmark-render-preparation.mjs webkit comparison 5 3f01a2b
node --import=tsx tools/benchmark-render-preparation.mjs webkit final 5
```

## Findings and decisions

### Terrain

| Dense visible-set preparation | Chromium | WebKit |
| --- | ---: | ---: |
| Synchronous stitch | 40.2 ms | 45 ms |
| Seam generation alone | 8.1 ms | 11 ms |
| Joining alone | 32.9 ms | 33 ms |
| Worker experiment: synchronous input copy | 19.7 ms | 35 ms |
| Worker experiment: complete round trip | 102.5 ms | 110 ms |
| Cooperative stitch: total elapsed | 74.5 ms | 65 ms |
| Cooperative stitch: largest sampled task gap | 10.7 ms | 11 ms |

Seam caching would leave the larger join pause. Sending the current cache's
coordinate graphs to a worker also leaves a significant input-copy pause and
creates another temporary graph. Moving the entire cache to the existing worker
could avoid that copy, but would change cache eviction, raster/vector recovery
and source ownership together. The implemented change instead keeps ownership
and splits the same algorithm into cancellable batches with a soft 4 ms budget.

Only one preparation and one latest pending snapshot are retained. The job borrows
cached coordinate arrays, discards obsolete work before another preparation
starts, and publishes only complete geometry through the existing source receipt.
Unchanged coverage remains a no-op. Temporary seam/index/output containers still
exist during preparation; the unchanged 32 MiB cache weight is not a total-memory
cap. Cooperative scheduling increases completion latency and has some iteration
overhead. MapLibre's later geometry serialization/indexing remains separate work.

### Glide

| Cold 64-tile set | Chromium | WebKit |
| --- | ---: | ---: |
| Baseline: largest upload/draw frame | 14.2 ms | 5 ms |
| Final: largest upload/draw frame | 4.2 ms | 2 ms |
| Baseline: frames with uploads | 1 | 1 |
| Final: frames with uploads | 6–7 | 6 |
| Baseline: set-to-final-upload elapsed | 15.4 ms | 9 ms |
| Final: set-to-final-upload elapsed | 140.5 ms | 73 ms |

The layer admits up to 4 MiB of mip/vertex bytes per frame and checks a soft
4 ms time slice between whole tiles. The initial 2 MiB experiment needed about
13 frames; 4 MiB reduced redraws while retaining the CPU time check. A tile is
atomic and at least one can progress even when its own cost exceeds the limits.
Already-ready tiles draw during the progressive reveal. Only remaining eligible
visible uploads request another frame. Offscreen/hidden/failed work and warm draws
do not sustain a repaint loop. CPU bodies live until their successful upload;
the existing 64-tile residency/recovery ownership remains unchanged.

### Plates

The baseline's complete 1,152-draw mesh submission span was only 2.9 ms in
Chromium and 2 ms in WebKit on this host. Final mesh tasks had median maximum
spans of 2.5 ms and 3 ms respectively. Chromium split into two tasks; WebKit's
mesh remained within one. Whole PDF preparation was roughly 18–26 ms, and sampled
browser gaps were noisy. The data does **not** demonstrate a large desktop mesh
speedup or identify every preparation pause as mesh work.

The small production change nevertheless bounds mesh work on slower devices:
check the 4 ms budget after each pair of triangles, yield through an event-loop
task, and honor cancellation before continuing. It preserves geometry, antialias
overlap and canvas resolution. The two canvases remain the only mesh backing
stores; cancellation releases both, and publication remains atomic. PDF.js
rendering and deferred browser/GPU work are outside that budget.

### AWC Weather

| Large radar artifact | Chromium | WebKit |
| --- | ---: | ---: |
| Direct authentication/decode + validation | 27 ms | 23 ms |
| Worker experiment: complete round trip | 53.1 ms | 63 ms |
| Worker experiment: largest sampled task gap | 13.6 ms | 21 ms |
| MapLibre source acceptance elapsed | 125.8 ms | 135 ms |

Worker parsing reduces some main-thread work but adds copying, roughly doubles
completion latency on this fixture, and leaves the larger MapLibre submission
pause untouched. The smaller Progs fixture took only a few milliseconds to
decode/validate; the worker increased its latency as well. No production parsing
worker or additional cache is adopted. A future change should measure a format
or ownership design that avoids copying coordinate graphs through the main
thread, including the MapLibre handoff. This remaining limit is recorded rather
than claimed as fixed. Radar is synthetic; native national scans and a complete
Progs horizon still need device measurements.

## Correctness and measurement boundaries

Regression coverage includes cancellation during the plate mesh and canvas release;
Terrain geometry equivalence, supersession, source/route reset and failure
settling; and Glide bounded progress, atomic mip upload, idle/hidden/offscreen
behavior, allocation failure recovery and resource release. Existing tests retain
plate orientation/opacity and terrain seams, nodata and antimeridian checks.
The graphics matrix includes the actual off-field heat renderer through
`glide-landings.spec.ts` and `glide-packages.spec.ts`.

The browser fixture issues found during this investigation were resolved on
October 7. Their lasting engine and input constraints are recorded in the
[graphics verification guide](graphics-compatibility.md#run-the-checks). Rerun
[verification](../development/local-development.md#verification) for current status;
those repairs do not change the timing measurements above. Physical iPhone
native-data memory pressure, foreground/background cycling, thermal behavior and
energy measurements remain separate device evidence.
