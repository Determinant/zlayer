# Graphics compatibility

[Documentation](../README.md) / Verification

Three rendering boundaries need explicit handling: numeric terrain canvases must
preserve pixel values across worker transfers, composed charts must premultiply
alpha, and terrain texture samplers must use high precision. The regressions below
check the resulting pixels; [run the checks](#run-the-checks) before changing these paths.

## Contents

- [Map resizing and iPhone crash investigation](#map-resizing-and-iphone-crash-investigation)
- [Terrain incident and cause](#terrain-incident-and-cause)
- [Chart alpha contract](#chart-alpha-contract)
- [Terrain fade precision](#terrain-fade-precision)
- [Preparation performance (2026-09-17)](#preparation-performance-2026-09-17)
- [Rendering audit](#rendering-audit)
- [Run the checks](#run-the-checks)
- [Device verification boundary](#device-verification-boundary)

## Map resizing and iPhone crash investigation

MapLibre 6.9 already observes and throttles container resizing. The workspace
relies on that observer: its former second observer and initial animation-frame
resize caused redundant writes to the WebGL canvas backing size. The resize
regression checks the real workspace at 1×, 2× and 3× through portrait/landscape
rotation, keyboard-sized viewports and container-only resizing, then selects an
airport. Map density and tile-cache sizing use MapLibre's defaults.

The shared map class in `core/map/map.ts` skips resize while WebGL reports a lost
context. In MapLibre 6.9, the built-in guard becomes active only when the queued
`webglcontextlost` event arrives. A resize between loss and event delivery can
store the lost drawing buffer's zero dimensions as the GPU canvas limit, leaving
the map blank after restoration. The guard checks the immediate WebGL state;
MapLibre still owns the observer and resizes to the current container on restore.
The graphics regression forces this ordering, checks that the canvas dimensions
survive loss, and verifies the restored symbols, weather and route pixels. This
is a repair for the reproduced resize/loss race, not a diagnosis of the separate
iPhone process crash below. Revisit the guard when upgrading MapLibre.

An iPhone 15 Pro reported Safari's “a problem repeatedly occurred” screen, while
the reporter's iPad was unaffected. The reporter subsequently confirmed that the
crash persists after an update. A fresh visit in Linux WebKit did not reproduce
the process crash; the iOS version and exact trigger remain unknown. The device
difference alone does not establish memory pressure:
an iPad's larger viewport can have more total backing pixels. The resize cleanup
removes redundant work, but is not a confirmed repair of the reported failure.

A trial 2× density cap and tile-cache limits (two viewports, 64 tiles per source)
were removed: they lacked an iPhone allocation profile, reduced vector/label
sharpness and increased work when revisiting evicted tiles. An explicit pixel
ratio also froze density at map creation instead of following display changes.
The trial did not reproduce the phone crash. Keep MapLibre's defaults until
device measurements justify changing them; chart resolution and PDF canvas
budgets have separate owners.

### Obstruction decompression memory spike

The reporter subsequently confirmed that bounded decompression substantially
reduced iPhone crashes, with occasional failures remaining. The follow-up
[memory/resource review](memory-resources.md) adds early obstruction filtering,
smaller map payloads and bounded route-history inflation. Its measurements and
remaining publisher/device work are recorded separately from this historical
investigation.

Follow-up isolation found a concrete allocation problem in the obstruction
loader. For the 656,056-record published dataset (16,568,035 gzip bytes expanding
to 277,404,929 JSON bytes), Playwright 1.63 Linux WebKit read `Blob.stream()` in
two chunks, up to 8 MiB each. `DecompressionStream` emitted two correspondingly
large chunks, up to 142,775,846 bytes. The incremental parser therefore still
decoded and scanned roughly half the national document at once.

The loader now reads at most 64 KiB of compressed data per pull, before passing
it to the decompressor. In an isolated worker parsing the same dataset, the
largest decompressed chunk fell to 1,386,852 bytes and sampled WebKit content
process peak RSS fell from 2,043 to 513 MiB. Both runs parsed all 656,056 records.
The 64 KiB input bound does not promise an identical output chunk size for other
datasets or browser implementations.

A fresh full-app comparison at 3× iPhone 15 Pro viewport density, with layers
enabled and ownship disabled, reduced sampled content-process peak RSS from
2,768 to 1,548 MiB. The comparison used the same published app/data, substituting
only the rebuilt obstruction worker in the second browser context. These are
Linux WebKit RSS measurements, not iOS memory footprints or a reproduced phone
termination. An on-device retest is still required to confirm the crash is fixed.

The regression checks bounded reads independently of browser blob chunking and
complete record recovery across multiple compressed chunks. Existing validation
still checks gzip integrity, hash/size/count mismatches, cache receipts and
corrupt downloads. Layer visibility, symbol detail and map density are unchanged.

Cache reuse across toggles/remounts requires its own regression: bounded
decompression alone does not prove that a verified source avoids another download.

## Terrain incident and cause

The symptom was tile-sized displaced terrain shading while separately generated
vector contours stayed aligned. The reproduced failure is in bitmap transfer,
before GPU map drawing: decoded tile values sometimes exactly matched another
tile, despite correct numeric values in the producing worker.

A small reproducer without MapLibre creates distinct 512px tiles in four
concurrent worker jobs and transfers each bitmap through the main thread to a
second worker. Linux Playwright WebKit returned another tile's pixels or a blank
image with the original tile ID. It reproduced with both scratch-canvas copies
and direct `putImageData`, with `createImageBitmap(ImageData)`, and without resetting
the source canvas. Consequently, direct writes alone were not the fix, and this
was not evidence that JavaScript drawing commands execute out of order.

Terrain now uses `createPixelContext` for numeric DEM decoding and assembly. It
requests `{ willReadFrequently: true }` **when creating** the 2D context, so the
browser can keep this CPU pixel workload in readback-friendly storage. On the
reproducing WebKit engine, this removes the accelerated bitmap transfer failure.
Subtiles are written directly at their final offsets, eliminating an unnecessary
scratch canvas and drawing copy. Work remains in the existing bounded worker;
map rendering, cached tiles, vector contours and GPU altitude recoloring retain
their existing behavior. DEM decode canvases are also released promptly.

The context option is a browser hint, not a standards guarantee of a particular
backing store. The regression verifies the resulting pixels across real worker
transfers; it does not infer correctness from the option alone. See the
[HTML canvas specification](https://html.spec.whatwg.org/multipage/canvas.html#concept-canvas-will-read-frequently).

Upstream WebKit has documented accelerated-image transfer/context defects:
[278908](https://bugs.webkit.org/show_bug.cgi?id=278908), its
[follow-up 283704](https://bugs.webkit.org/show_bug.cgi?id=283704), and a
[later synchronization repair](https://github.com/WebKit/WebKit/commit/48db7480703cf267922ad0b91f1ef965d8fa64a4).
These reports concern the GTK/WPE/Skia backend. They are related precedent, **not
confirmation of this exact regression or of an iPadOS bug**. The reporter subsequently confirmed that the terrain display is fixed on the
affected iPad mini; the iPadOS/browser versions and device timings were not recorded.

The previous tests checked loading, vector feature presence and interactions, and
saved screenshots for inspection. Those assertions could all pass despite the
incorrect shading. Graphics checks now also assert actual pixel positions,
colors, alpha and orientation.

## Chart alpha contract

The additional GPU pixel test found a separate compatibility problem in composed
chart tiles. `transferToImageBitmap()` supplied straight-alpha pixels to WebKit's
WebGL upload, while MapLibre's raster blend expects premultiplied colors. For a
half-transparent orange pixel, a direct texture read returned `[255,127,0,128]`
instead of `[128,64,0,128]`; this made chart edges/colors too bright.

All three chart composition paths now use `renderRasterBitmap`, which calls
`createImageBitmap(canvas, { premultiplyAlpha: 'premultiply' })`. Alpha format is
chosen at the image boundary rather than inferred from browser defaults or WebGL
unpack flags (those flags do not convert ImageBitmap inputs; see the
[WebGL specification](https://registry.khronos.org/webgl/specs/latest/1.0/#6.10)). The test verifies
both native PNGs and composed bitmaps through actual MapLibre upload and blending.
The shared renderer owns the canvas through drawing and snapshot completion.
It releases the canvas on every exit and closes snapshots that finish after
cancellation. Numeric terrain data uses a separate path to preserve exact channels.

## Terrain fade precision

An Android screenshot showed isolated red/orange stripes at the 8 NM corridor
edge in Clearance mode at 3,800 ft. MapLibre 6.9's color-relief shader uses
unqualified `sampler2D` inputs for numeric terrain and palette-stop textures.
Those default to low precision even though the shader's float arithmetic is
high precision. Sampling normalized bytes as half floats can move a packed value
just below the transparent stop into the previous band's opaque end.

A browser regression reproduces this by rounding unqualified terrain texture
samples to half floats while retaining precise palette fetches. It produced the
same bright fringe, exceeding the background by 149 channel levels; the corrected
edge stays within four levels in both Elevation and 3,800 ft Clearance modes.
This models the precision failure; it is not a trace from the reporting device.

`tools/terrain-sampler-precision.ts` qualifies both numeric samplers as `highp`
when Vite loads the pinned MapLibre bundle, in development and production. The
palette encoding and tile pipeline remain intact. The transform requires exactly
one matching declaration and fails the build if the dependency changes; remove
it when upstream supplies the qualifiers. See the
[upstream shader](https://github.com/maplibre/maplibre-gl-js/blob/v6.9.0/src/shaders/glsl/color_relief.fragment.glsl)
and [GLSL ES precision rules](https://registry.khronos.org/OpenGL/specs/es/3.2/GLSL_ES_Specification_3.20.html).

## Preparation performance (2026-09-17)

The isolated terrain benchmark writes four 256px subtiles into each 512px tile,
yields between writes, then transfers through two workers and checks the received
pixels. Four jobs run concurrently. After warm-up, five rounds per path each
process 128 tiles, alternating order. Values below are medians of the five rounds
on the same Linux host in the Playwright 1.63 container; other tests were stopped.

| Engine | Default context, median tile latency | Pixel canvas, median tile latency | Default / pixel corrupted tiles |
| --- | ---: | ---: | ---: |
| WebKit | 8 ms | 3 ms | 13 / 0 of 640 |
| Chromium | 3.4 ms | 3.4 ms | 0 / 0 of 640 |
| Firefox (headed, Xvfb) | 5 ms | 5 ms | 0 / 0 of 640 |

Median 128-tile batch times were 445 → 134 ms, 143.9 → 147.4 ms, and
215 → 208 ms respectively. Chromium's small batch increase prevents claiming a
universal speedup; the median per-tile latency was unchanged. This benchmark
isolates the context/storage choice with direct writes on both paths. It excludes
terrain calculations, network/PNG decode, map drawing and iPad hardware; it is
not an FPS or battery benchmark. Removing the scratch canvas separately removes
one 256px canvas (512px at the maximum DEM zoom) and the redundant copy for each subtile.

Reproduce with the fixture server running in one terminal:

```sh
node test/e2e/server.mjs
# In another terminal; install browser dependencies as described below.
node tools/benchmark-graphics.mjs webkit
node tools/benchmark-graphics.mjs chromium
xvfb-run -a node tools/benchmark-graphics.mjs firefox
```

The accelerated control intentionally retains the defective path for diagnosis;
it can corrupt pixels or terminate the reproducing WebKit process. The normal
regression only runs the production pixel-canvas path and checks its output.

The chart snapshot benchmark composites four images into a 256px tile, creates
the bitmap and uploads it to WebGL. It uses five alternating 128-tile rounds
following warm-up, with GPU completion at batch boundaries:

| Engine | Default transfer, median batch | Explicit alpha, median batch |
| --- | ---: | ---: |
| WebKit | 57 ms | 36 ms |
| Chromium | 15.4 ms | 15.7 ms |
| Firefox | 36 ms | 50 ms |

The alpha correction has a measurable preparation cost in Firefox: about
0.11 ms per 256px tile in this workload. One Firefox corrected batch took 296 ms,
so these medians are not worst-case guarantees. This does not add work to cached
map redraws. Use `node tools/benchmark-graphics.mjs webkit raster` (or another
engine; Xvfb for Firefox) to repeat the snapshot/upload comparison.

## Rendering audit

| Rendering path | Relevant behavior | Verification |
| --- | --- | --- |
| Terrain DEM decoding, worker transfer, raster shading and contours | Readback-friendly numeric canvases; direct subtile writes; decode without color conversion | 256 distinct tiles through two worker transfers; geographic elevation bands and corridor opacity at fractional zoom/2× density; altitude recoloring; 3× touch controls and worker cleanup |
| Chart decoding, overview and overzoom | Draws decoded images; explicitly premultiplies composed color bitmaps for GPU upload; closes consumed inputs | Asymmetric quadrant colors, TMS north/south ordering, all four overzoom children, alpha and sparse transparent areas; PNG and composed tiles through MapLibre GPU upload |
| Regional chart clipping | Immutable source bitmaps, even-odd geographic masks, explicit output alpha format | Polygon holes, missing coverage and real California/Nevada edition boundaries |
| Navigation symbols, weather, routes and labels | Canvas-generated ImageData plus MapLibre vector layers | Every generated icon's bounds/center; rendered fix/VOR/VFR and weather colors; route pixels through rotation, resize and WebGL context restoration; screenshot inspection of labels |
| Aircraft icon and track | Canvas-generated image, map-relative heading | Nose pixels before/after 90° map rotation, stale-fix fallback, remount and clearing |
| PDF plates | Awaits one completed render buffer before one display copy; releases the buffer; caps pixel count and side length | Asymmetric PDF corner/center colors after zoom, fullscreen, rotation and reopening; phone/tablet fit and touch controls |

The chart composition paths draw decoded image sources in the main thread before
MapLibre's raster upload; they do not use terrain's worker-to-main-to-worker
bitmap path. Their asymmetric GPU tests verify orientation and alpha. The map
itself stays GPU accelerated. Image composition, resampling, clipping and PDF
rendering continue using the drawing operations appropriate to those tasks.

## Run the checks

```sh
npx playwright install --with-deps chromium firefox webkit
npm run verify:full
```

Full local CI runs all checks, unit tests, browser tests and all four graphics
projects. On Linux, its Firefox stage runs headed and automatically uses
`xvfb-run -a` when `DISPLAY` is unset. Install Xvfb for that environment.
Tests that explicitly construct their own density and touch contexts run once per
engine under `@explicit-density`; WebKit's 2× project runs the remaining cases at
its own density. This preserves the explicit 1×/2×/3× resize and phone/tablet
scenarios without repeating identical WebKit contexts.
The matrix includes Glide's off-field heat renderer and published packages as
well as airport ranges: retained textures, polygon holes, source replacement
and offline reuse exercise its custom WebGL layer in every engine.
Glide's cache-persistence cases use a fresh persistent WebKit profile. In the
Playwright 1.63 Linux ephemeral profile, terminating the last worker owning a
cache can discard its entries; a disk-backed profile preserves them. The fixture
keeps the project's viewport, touch and density settings. Offline shell checks
disconnect the fixture origin instead of enabling WebKit network emulation,
which also rejects service-worker responses. Native held-touch injection uses
Chromium CDP; the other engines exercise the DOM gesture handlers explicitly.
Firefox graphics use Mozilla's `dom.storageManager.prompt.testing` and
`.allow` preferences to accept the native persistence prompt while exercising
real `StorageManager` and offline files. Without these, the Linux automation run
left `persist()` pending even with Playwright permission grants. These are
[browser test preferences](https://searchfox.org/firefox-main/source/modules/libpref/init/all.js),
not application storage overrides.

To run only the graphics suites independently on Linux:

```sh
npm run test:graphics -- --project chromium --project webkit --project webkit-retina
xvfb-run -a npm run test:graphics -- --project firefox --headed
```

With a desktop display, `npm run test:graphics -- --headed` runs all four projects.
The test server builds production bundles and uses local synthetic data. The
graphics fixture is excluded from ordinary production builds. Failures retain
traces; screenshots are saved alongside test results for visual review.

Automatic GitHub CI runs a Chromium smoke check for map pixels, rotation, resize
and WebGL recovery. Full local CI keeps the entire graphics matrix.
**Actions → Verify → Run workflow** with **full** enabled runs
all Chromium graphics checks within the complete browser suite, plus separate
jobs for Linux Firefox, WebKit and 2× WebKit, and macOS 2× WebKit. See the
[CI commands](../development/local-development.md#verification) for the manual CLI equivalent.
Graphics tests use deterministic GPS inputs. Playwright 1.63's Linux WebKit
geolocation override was observed returning a timestamp 1000× too large; the
application's rejection of invalid/future fixes is deliberately unchanged.
Firefox touch tests exercise touch events and small viewports without the
unsupported `isMobile` emulation option. CPU throttling is Chromium-only.

For future rendering changes, include asymmetric fixtures and pixel assertions
that fail when tiles are flipped, shifted, missing or assigned the wrong color.
Cover cancellation during snapshot creation and canvas cleanup after drawing or
snapshot failure. Keep native geolocation integration separate from deterministic
graphics fixtures. List current cases with `npm run test:graphics -- --list`.
Keep CSS coordinates separate from backing pixels, test at more than one device
pixel ratio, and cover zoom/resize/context recovery when the changed path uses them.

## Device verification boundary

Browser-engine tests cannot establish behavior on every physical GPU, iPadOS
release, memory-pressure condition, private-browsing setting or embedded WebView.
Playwright WebKit is not the installed Safari binary; macOS coverage is closer to
Safari than Linux WebKit but still does not replace a device check.

Before a graphics release, check an actual iPad/iPhone and an Android device with
terrain visible across tile boundaries, fractional zoom, map rotation, chart
edition boundaries, aircraft symbols, PDF zoom/fullscreen, orientation changes,
and background/foreground transitions. Record device/OS/browser versions and any
remaining failures; an engine-suite pass alone is not a zero-defect guarantee.
