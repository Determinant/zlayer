# Terrain

`src/layers/terrain/` owns the elevation client, worker, contour rendering, labels,
controls and map lifecycle. Workspace composition passes the displayed route plans
and saved visibility/coverage/altitude preferences. Terrain is enabled by default (including
older preferences without a terrain setting); an explicit saved Off choice is respected.
Coverage defaults to **Route**. In Route mode it has no demand
until a resolved leg is displayed. Expanded airway/procedure legs and displayed
route recommendations participate; unresolved route gaps do not.

## Route display

- The layer menu keeps terrain help behind an info icon, available on hover,
  keyboard focus or tap. Escape or an outside press dismisses the help.
- Elevations are feet MSL, converted from the source's meters.
- Every leg has a 4 NM core on **each side**, with full overlay opacity. Opacity
  eases continuously to zero between 4 and 8 NM from the centerline. End caps are
  rounded; joins and overlapping legs use minimum distance, never stacked alpha.
- The mask follows the displayed Mercator leg with latitude-adjusted ground
  distance and shortest-world wrapping across the antimeridian.
- A fine white dashed boundary with a narrow black trim marks the **4 NM edge on
  each side**. It follows the same distance calculation as the mask, merges
  overlapping legs without internal seams, and has rounded ends. The unfilled
  boundary draws above contours and below routes, at the same zooms as route
  terrain. A matching legend key identifies its width. It updates with route
  geometry, not pans or altitude changes, and is absent in Viewport coverage.
- Broad 1,000 ft elevation regions have prominent outlines even at overview scales;
  tile zoom 11 adds 500 ft regions and outlines. Major contours use dark brown
  strokes at 98% opacity. Their width grows smoothly from 1–1.4px at overview
  zooms 8–10 to 2.4px at zoom 13; intermediate contours remain thinner, reaching
  1.5px at zoom 13. Outlines are antialiased vector paths with screen-space widths,
  so fractional zoom and high-density displays cannot magnify rasterized strokes.
  Each region has a single yellow/orange/red color and **82% opacity** in the core.
  Only the outer 4–8 NM corridor changes opacity. Elevation mode describes absolute
  terrain elevation MSL; clearance mode compares it with a manually selected altitude.
- Terrain below the first contour (1,000 ft at overview scale; 500 ft in detail)
  is unshaded in elevation mode. Clearance mode includes this band so low terrain
  cannot disappear when the user selects a low altitude.
- Simplification operates on elevation samples before assigning bands. The painter
  interpolates heights, then quantizes to flat region colors at screen resolution.
  It never blurs colored fills or opacity to soften elevation boundaries. Nearest
  raster resampling preserves the distinct regions during fractional zooming.
  Each display DEM subtile is written directly to its final canvas offset with
  `putImageData` on a readback-friendly pixel canvas. CPU-oriented storage avoids
  the accelerated cross-thread bitmap corruption reproduced in WebKit; direct
  writes alone were insufficient. See [graphics compatibility](graphics-compatibility.md).
- Geographic contours and route fills use the same bilinearly interpolated surface heights
  in both coloring modes. Clearance colors compare the selected altitude with each band's
  upper elevation. Sampled highs and viewport shading retain maximum elevations.
  Switching coloring modes or changing altitude only updates the palette.
  Legacy Mercator sources retain their existing height processing.
- Outlines are traced from the surface height grid with marching squares,
  joined across cells, then rounded with two corner-cutting passes to soften grid
  stair steps at close zoom. Simplification first removes deviations below one
  tile-display pixel so tiny grid segments cannot pin the corners in place.
  Each pass trims at most 1.5 source-cell widths from an edge; open endpoints stay
  fixed at tile edges and missing-data gaps, and closed loops stay closed, including
  subpixel peaks. A final 0.2px simplification keeps straight spans compact. This
  only changes outline geometry; fill elevations and sampled highs retain their values.
  A spatial bucket check compares rounded outlines against both original and rounded
  neighbors of other elevations. Only conflicting paths retain their original geometry;
  an isolated saddle cannot disable smoothing across the tile. The check runs once
  during tile generation.
  Ambiguous saddles use the bilinear surface's diagonal decision to preserve
  region connectivity before rounding.
  Their 4–8 NM fade
  uses short spans grouped into 32 opacity levels; the core remains continuous.
  Vector updates are batched and cached alongside each display tile. Only current
  viewport tiles are published to MapLibre; panning back reuses cached geometry. Unchanged
  geometry is not republished when a fractional zoom only changes stroke width.
  Outlines reuse the existing elevation requests and 512px fill textures without
  supersampling either.
- Contours stop at each DEM's outer sample centers. When neighboring tiles are
  visible, their cached edge samples supply the intervening cells, including
  four-tile corners. Matching spans join into continuous paths and closed loops.
  This uses at most 4 KiB of border samples per native DEM and makes no additional
  elevation requests. Seams are rebuilt only when the published tiles change;
  absent tiles, unknown samples and the corridor fade still leave real gaps open.
- Labels show major contours and sparse **sampled highs** (`^ ~… ft`), rounded
  upward to the next 100 ft. These are maxima among available core samples per
  display tile, not surveyed summits or guaranteed route maximum elevations.
- Terrain fills and outlines draw above charts and below route lines and navigation.
  Altitude labels draw in the foreground above route lines and waypoint circles;
  elevation and clearance both use 15px bold text, matching full-size fix labels.
  Below zoom 8, a prominent **Zoom in to see terrain contours** hint appears above
  both toolbox tabs; no elevation tiles are loaded and the hint disappears on zooming in.

## Viewport coverage

The **Route / Viewport** buttons in Layers and the terrain toolbox select coverage
independently of **Elevation / Clearance** coloring. The coverage choice persists;
older, missing or invalid preferences select Route. The terrain toolbox tab always
stays available, including without a route and when terrain is disabled. Its On/Off
switch controls the same preference as Layers. Route mode without a leg explains
that a route or Viewport coverage is needed; it makes no elevation requests.

Viewport shades all visible tiles without requiring a route. It skips corridor
distance calculations, contour tracing, vector sources and terrain labels. It uses
the same elevation reader, packaged sources, request limits and decoded cache as
Route. Each display tile reads at most four native 256px DEMs, one source zoom
above the display tile and capped at DEM zoom 13. Unlike Route, Viewport also
loads coarser tiles below display zoom 8; available source detail determines what
small features can be seen.

The worker stores integer feet in RGB (`R * 65536 + G * 256 + B - 40000`), rounding
each valid native sample upward by less than one foot. Encoding precision is not
source accuracy. Zero bytes denote missing data and always render transparently;
visible missing/failed tiles report incomplete terrain. At the maximum source
zoom, nearest expansion preserves the native samples without interpolating peaks
away. The same numeric canvas transfer and high-precision GPU sampling safeguards
used by Route apply here.

The GPU applies a small palette to those heights. Elevation colors vary with
sampled height, retaining the existing 500/1,000 ft lowland shading cutoff.
Clearance uses sampled height with the same clearance categories below, rather
than Route's upper contour-band elevation. Route edits do not invalidate viewport
tiles, and altitude changes update only the palette. Switching coverage cancels
obsolete jobs and replaces the source so the two texture encodings cannot mix;
disabling terrain or unmounting releases the worker and rendering resources.

A local Node comparison of one 512px tile's CPU preparation (synthetic sinusoidal
ridges, five warm-up runs and 20 measured runs) measured Viewport medians of
1.98/2.11/2.54 ms at display zooms 9/11/13, versus 16.33/41.74/29.27 ms for Route's
simplification, fill, contour and sampled-high work. This excludes downloading,
decoding, canvas transfer, MapLibre processing and GPU drawing; it is not a device
frame-rate measurement. Browser regressions compare actual viewport pixels to
native elevation samples, including areas beyond 8 NM, and cover route-independent
loading, source reuse, mode restoration, low zoom, failures and saved preferences.

## Selected altitude and clearance

GPS waypoint details retain any elevation supplied by the feature; otherwise they
sample terrain at the waypoint's saved coordinate, for both route points and
temporary map inspections. This uses DEM zoom 13 (or the
packaged source's finest geographic level), retaining maximum heights just like
Viewport clearance. It is independent of map zoom, contour intervals and terrain
visibility. The card displays an approximate height rounded to 10 ft MSL. A bounded
worker query reuses the terrain readers and saved-source precedence; it releases
the worker when complete or canceled. Selecting another point or closing the card
cannot publish a stale result. Missing data remains unavailable, with a retry action;
reconnection, source changes and offline inventory updates refresh the lookup.

The corner legend has Elevation / Clearance tabs. Elevation shows only the
elevation color scale. Clearance adds an editable altitude field and a
touch/keyboard-accessible slider from 0 to 25,000 ft MSL that snaps in 500 ft steps, initially
set to 4,500 ft. Typed values apply on Enter or blur, rounded to the nearest 100 ft
and limited to that range; an empty field restores the current altitude. The slider
shows the nearest 500 ft mark for typed values between steps. Switching tabs
remembers the selected altitude. Active altitude/mode survives reloads.
This is a manual comparison, never live aircraft altitude.

Clearance is **selected MSL altitude minus terrain MSL elevation**. Colors use
the upper elevation of each 500/1,000 ft contour band in Route mode so the fill does not overstate
the clearance within that band. Labels retain their original MSL elevation and
add a signed difference above it (for example, `+1,500 ft`). Sampled highs use their displayed elevation,
rounded upward to 100 ft, for the subtraction.

| Difference | Color |
| --- | --- |
| At or below zero | Red |
| Above zero, below 500 ft | Orange |
| 500–999 ft | Yellow |
| 1,000–1,999 ft | Green |
| 2,000 ft and above | Unshaded (transparent) |

In Route mode, the worker encodes a band's upper elevation and corridor fade in a 512px indexed
texture. MapLibre's `color-relief` layer applies a 512-stop GPU palette using a
private `raster-dem` source with custom unpacking. These values are **palette indices**,
not a geographic DEM for 3D terrain or other elevation consumers. Missing/outside
samples use index zero and remain transparent in both modes. The source's positive
blue factor supports MapLibre's palette-stop packing even though index pixels use
only the red/green channels.
The numeric texture samplers use explicit high precision. This prevents mobile
GPU rounding from turning transparent corridor-edge samples into an opaque
neighboring palette band; see [the precision regression](graphics-compatibility.md#terrain-fade-precision).

Altitude updates change the palette and label expression at most once per animation
frame. They do not fetch elevation, rebuild contour geometry, replace map sources,
or rerun terrain workers. Touch and pointer interaction stays inside the toolbox.

## Elevation and precision

Published `charts/terrain/manifest.json` packages take precedence, with saved region
indices preferred over newer browsing metadata. The fallback is
[Mapzen Terrain Tiles on AWS](https://registry.opendata.aws/terrain-tiles/),
using [Terrarium PNG encoding](https://github.com/tilezen/joerd/blob/master/docs/formats.md):
`R * 256 + G + B / 256 - 32768` meters. Attribution links to the
[source providers](https://github.com/tilezen/joerd/blob/master/docs/attribution.md).
`VITE_ZLAYERS_TERRAIN_TILE_URL` can supply an equivalent 256px fallback service.
Transient fallback failures receive two short retries within a 15-second deadline;
permanent failures and cancellation do not retry. Missing samples remain missing.

`faa-regs`'s `build:terrain` reads current USGS 3DEP **1-arc-second** GeoTIFFs and
checks source ETags on subsequent builds. Schema 2 publishes a geographic grid
anchored at (-180, 90), with **2.45 arc-seconds** in both axes at native level 11.
Levels 10–1 double that spacing successively. These geographic levels are distinct
from the displayed Web Mercator zoom. Default U.S. coverage is approximately
25,956 archive pairs / 25.3 GiB of maximum and surface grids before compression. The earlier maximum-only national build verified
on 2026-09-21 used 2.91 GB compressed, including indexes/provenance; retained
older versions consume additional disk space.

Each `ZDEM0002` archive contains four adjacent 256×256 grids of gzip-compressed
little-endian **int16 metres**, with -32768 reserved for missing data. The builder
takes the maximum contributing valid source elevation, disabling source overviews,
and rounds upward to whole metres. This retains source peaks with less than one
metre of additional quantization; it does not recover features missing from the
30-metre source. Heights preserve source orthometric datums. The publisher records
per-source datums, revisions, grid spacing and processing provenance. New builds also
publish optional `surface` archive descriptors in each spatial index. These companion
`ZDEM0002` files use bilinear source sampling, nearest-metre quantization, and averaged
overviews. Offline plans include both files; old saved maxima remain supported.
The full alignment improvement requires rebuilding and publishing this paired dataset.

The browser converts metres to feet on read. The worker maps geographic cells onto
the requested Mercator tile and retains maxima over each display pixel footprint.
Close-up display zooms reuse the finest level advertised by the source (11 for
2.45 arc-seconds, 10 for saved 4.9-arc-second terrain).
Adjacent tiles share a bounded 32-grid / 8 MiB decoded geographic cache. Pending
reads stay separate from that cache, with at most four native geographic reads
active. Canceling one consumer preserves its peers; canceling the last stops the
remaining read and decompression work. Terrain rendering retains its worker and
output-cache limits. Any missing cell within a display pixel's footprint keeps
that pixel unknown, including missing neighbours at saved-region edges; corrupt
data is rejected. Route contours interpolate geographic cell centers, using optional surface companions
when present and the saved maximum grid otherwise. Both channels share the existing
cache limits. Interpolation reads neighboring cells across tile edges; unavailable
contributors leave gaps rather than invented connections.

The reader also accepts schema 1 `ZDEM0001` float32-feet Mercator packages at zooms
1–13, so saved selections survive the transition. Saved sources retain precedence
over browsing sources across formats and geographic resolutions. The 2.45-arc-second
extension preserves levels 1–10 exactly and adds native level 11. Saved 4.9-arc-second
selections continue to work; **Verify / update** acquires the finer archive set.
Publish the updated client before the 2.45-arc-second terrain manifest. Old immutable
archives and source caches are retained until explicit cleanup.

The top manifest contains spatial index identities, not millions of individual tile
records. Each immutable `.terrain` index covers a 64×64 tile area at one native zoom.
Workers fetch only indices needed for the current view; offline preparation reads
only those intersecting the selected region. Both indices and DEMs use the verified
whole-file archive cache, SHA-256 and byte-length receipts, bounded shared downloads,
and content-addressed URLs. No persistent per-tile cache is introduced.

Data and geometry detail follow the display scale. Each 512px display tile reads
at most four 256px DEM tiles, at one source zoom above the display tile (capped at
DEM zoom 13). This replaces the previous fixed zoom-12 demand of up to 256 DEM
tiles for one overview tile. MapLibre rounds fractional raster zoom; the legend
and labels use that same zoom so their intervals match the regions on the map.

| Display tile zoom | DEM zoom | Height grid per display tile | Display |
| --- | --- | --- | --- |
| 8–9 | 9–10 | 128 × 128 | Broad 1,000 ft regions, strong outlines and sampled highs |
| 10 | 11 | 256 × 256 | 1,000 ft regions with sparse outlines |
| 11 | 12 | 256 × 256 | 500 ft regions and outlines |
| 12–13 | 13 | Up to 512 × 512 | Finer 500 ft contour geometry |

Close views retain approximately 30 m native samples at 37° latitude at DEM zoom
12, and finer samples at zoom 13. Overview data is deliberately coarser and may
omit small terrain features; zoom in to inspect detail. Source resolution, age and
vertical accuracy vary by contributing dataset. Encoding precision is not source
accuracy. Max pooling retains the highest available sample in each simplified
cell instead of averaging away a narrow ridge. Sampled-high labels use the
original fetched samples and positions independently of display simplification.

Only tiles intersecting the visible corridor are requested (plus conservative
tile-edge coverage). A dedicated worker decodes elevation and generates indexed
fill textures and simplified vector contours; MapLibre draws the fills, outlines and
collision-managed labels. At most four render jobs allocate canvases/grids at once,
and at most four DEM reads run at once. The shared archive cache separately limits
downloads to four; these can finish populating the cache after a consumer cancels,
so overlapping fallback PNG requests can briefly add to that network work.
Completed or canceled render jobs
release their canvas backing stores. A 128-tile LRU holds at most 32 MiB of decoded elevations;
ordinary HTTP caching is also respected. Concurrent consumers of the same DEM
share one download and decode, even when request slots are free. Canceling one
consumer leaves its peers running; canceling the last stops queued/active work.
Packaged DEM cancellation also stops the decompression stream. Route changes invalidate contour tiles
without replacing the map. Zooming preserves the source and cached contour tiles;
revisiting an overview does not restart its elevation requests. Removing or hiding the route cancels obsolete
requests, including work waiting for a render or network slot, and terminates the
worker to release its decoded cache. Unmounting also removes all owned map resources. Tile requests outside the corridor are
rejected before starting a worker job, and tile-render messages include only nearby legs.

The same worker builds the dashed 4 NM corridor boundary, including the polygon
union for curved approaches. This work starts at route terrain's visible zoom,
with at most one corridor job in flight; further route edits replace the waiting
geometry instead of queuing every intermediate route. Old outlines disappear as
soon as the route changes, and late results cannot restore an obsolete route or
map attachment. The layer retains only its latest completed outline. That cache
survives altitude/camera changes, DEM-source refreshes and terrain/coverage toggles,
and is released on unmount. No additional worker or DEM allocation is needed for
the boundary. The layer stays loading until the current boundary is available;
a boundary failure reports incomplete terrain and an online/inventory retry can
repair it without invalidating healthy elevation tiles.

Failed requests leave gaps, never zero elevation. **Terrain incomplete** tracks
failed tiles at the current view and zoom, and missing elevation inside the route
corridor. Missing samples elsewhere in a downloaded tile do not trigger the
warning unless interpolation spreads the gap into the corridor.
Successful tile retries clear their failures; returning to an unresolved gap
shows the warning again. Re-enabling terrain retries failures. Reconnecting or
changing the saved-file inventory also retries while any failed tiles remain,
including offscreen failures, so repaired data cannot leave a cached gap on a later
pan. With no failures, these events do not invalidate terrain; focus alone does
not trigger a refresh. New region downloads include published terrain at DEM zooms
1–13, including the low zooms used by viewport shading. Preparation expands the
region's immutable indices into required DEM files before quota checks and transfer.
Completion and later verification require retained files and index membership;
an in-memory grid or index never proves offline coverage. Overlapping regions
share files and removal retains files owned by another region.

Use **Verify / update** on older downloads to add terrain after the publisher has
built and uploaded it. Feeds without the terrain product remain usable; Settings
explicitly states that their downloads exclude terrain. PNG fallback HTTP caching
remains opportunistic. See [offline storage](offline-storage.md) for rollout details.

## Verification

`test/terrain.test.ts` covers units, masks, overlap, latitude, wrapping, route gaps,
nodata inside/outside the rendered corridor, flat region colors/opacity, zoom work
bounds, simplification, sampled highs, joined contour paths, closed peaks and
outline fading.
`test/terrain-elevation.test.ts` checks the four-download limit, shared download/decode,
independent consumer cancellation, late bitmap cleanup, retry after cancellation
and the 128-entry decoded LRU bound.
`test/terrain-archive.test.ts` checks decompression size/value validation and active
stream cancellation.
`test/terrain-packages.test.ts` reads real producer fixtures, rejects malformed
archives, checks regional membership/eviction and queue sharing, and exercises
transient fallback retries. `test/e2e/terrain-offline.spec.ts` saves a region through
the real browser backend, reloads offline, reads all zooms in fresh workers without
network access, detects eviction, and repairs the download.
This cold offline-reload test runs on Chromium: [Playwright's service-worker test
support is Chromium-only](https://playwright.dev/docs/service-workers). WebKit's
offline navigation emulation failed before terrain code even with a cached app
shell and no terrain fixture. Rendering/lifecycle tests still run on WebKit at 1×
and 2× density; offline reload on physical Safari remains a separate device check.
`test/terrain-work-limit.test.ts` checks bounded render work and queue progress after
cancellation or failure, including cancellation while a slot is being handed over.
`test/terrain-clearance.test.ts` verifies palette encoding, clearance signs/color
thresholds, lowlands, nodata, fade opacity and two-line label expressions.
`test/e2e/terrain.spec.ts` exercises the
production-built MapLibre protocol and dedicated worker with continuous synthetic
Terrarium tiles, source detail changes, zoom cache reuse, clearing, toggling,
remounting, failures/reconnects, recovery across pans and zooms, offscreen geometry
removal, fractional close zoom at 2× display density, direct altitude entry and
slider dragging. It also checks
the low-zoom toolbox hint and absence of DEM downloads while zoomed out.
GPU pixel checks verify red coloring and transparent 2,000 ft+ clearance, while
request/source counters ensure altitude changes reuse elevation and contour geometry.
An additional 2× display check compares shading pixels across subtiles with
the expected elevation bands and geographic corridor opacity, catching displaced fills even when
contour geometry and tile load status are correct.
Phone-size Chromium at 3× pixel density and 4× CPU throttling exercises touch altitude
controls and repeated enable/disable cycles, checking that at most one terrain worker
is live and that disabling/clearing the route releases it.
The terrain suite also runs in the graphics matrix, for example:
`npm run test:graphics -- test/e2e/terrain.spec.ts --project webkit --project webkit-retina`.
See [browser setup](graphics-compatibility.md#run-the-checks) for dependencies. Only Chromium
uses the CDP CPU-throttling setting; WebKit runs the same touch/lifecycle checks
without that setting.
The synthetic terrain fixture is excluded from ordinary production builds.

## Performance review (2026-09-17)

The expensive work is first-time decoding and geometry generation in the terrain
worker. Ordinary map draws use cached textures/vectors, and altitude changes only
update a 512-stop color palette and label expression once per animation frame.
Contour generation scans the simplified grid and its contour crossings; corridor
masking scales with the number of nearby legs, not every leg in the route.

A local Node benchmark measured the same max-pooling, interpolation, indexed fill,
isoline and sampled-high functions for one complete 512px display tile. It used
four warm-up iterations and ten measured iterations, with one diagonal route leg:

| Synthetic terrain | Zoom 9 median | Zoom 11 median | Zoom 13 median |
| --- | --- | --- | --- |
| Smooth ridges | 16.0 ms | 11.0 ms | 7.7 ms |
| Dense ridges | 40.7 ms | 40.3 ms | 15.2 ms |

These are local CPU timings, excluding network, PNG decoding, canvas transfers,
MapLibre vector tiling, GPU drawing and label placement. They are not iOS device
measurements. Dense contours, many overlapping route legs and large viewports
remain the heavier cases. The 32 MiB cap covers decoded DEMs only; MapLibre's raster
textures, cached vector tile results, temporary grids and canvases add
memory. Physical iPad/iPhone profiling is still needed to establish frame-rate,
total memory and battery costs.

The 2026-09-20 review removed the unused CPU color/stroke/label painter. The route
fill now only encodes band and opacity bytes; vector contours remain the sole
outline implementation. Eight before/after fill comparisons across zooms 8, 9,
11 and 13, both contour intervals, nodata and fades were byte-identical. Geometry,
sampled highs and clearance semantics are unchanged. The worker shares numeric
pixel copying and cancellation yields between Route and Viewport.

Run `node --import=tsx tools/benchmark-terrain.ts` for a reproducible comparison
of both modes using smooth and dense synthetic ridges, five warmups and 20 measured
runs at zooms 9, 11 and 13. It measures preparation of one 512px display tile;
network, decoding, canvas transfer and GPU work are excluded. Viewport work stays
proportional to its sample count, while Route additionally traces contour crossings
and calculates corridor distances. Cache tests check reuse during warm pans and
after more than 150 distinct tiles, and that unrelated catalog metadata causes
no terrain downloads or renders. Vector storage normally holds 128 tiles; only
the current visible set may exceed that budget on a very large viewport.

On the review machine (Node 24), Viewport medians were 1.6–3.0 ms per tile across
these fixtures; Route medians were 11.8–22.6 ms for smooth ridges and 25.3–89.0 ms
for dense ridges. These synthetic CPU costs explain the benefit of omitting
contours in Viewport mode; they do not establish end-to-end loading time or device FPS.

The follow-up review corrected uneven-saddle contour connectivity and added the
render-job allocation limit and immediate worker/canvas cleanup described above.
The graphics compatibility follow-up isolated intermittent bitmap corruption
before GPU drawing, using a reproducer without MapLibre. Terrain numeric canvases
now request readback-friendly storage at creation. The geographic shading check
passed 20 repeated high-density WebKit runs after that change. See
[graphics compatibility](graphics-compatibility.md) for the cause, transfer stress
test, rendering audit and browser matrix. The reporter confirmed that the fix
resolved the display issue on the affected iPad mini. The exact browser-internal
cause and device performance have not been independently measured on iPadOS.
