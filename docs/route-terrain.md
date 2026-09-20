# Route terrain

`src/layers/terrain/` owns the elevation client, worker, contour rendering, labels,
controls and map lifecycle. Workspace composition passes the displayed route plans
and saved visibility/altitude preferences. Terrain is enabled by default (including
older preferences without a terrain setting); an explicit saved Off choice is respected. It has no demand
until a resolved leg is displayed. Expanded airway/procedure legs and displayed
route recommendations participate; unresolved route gaps do not.

## Display

- The layer menu keeps terrain help behind an info icon, available on hover,
  keyboard focus or tap. Escape or an outside press dismisses the help.
- Elevations are feet MSL, converted from the source's meters.
- Every leg has a 4 NM core on **each side**, with full overlay opacity. Opacity
  eases continuously to zero between 4 and 8 NM from the centerline. End caps are
  rounded; joins and overlapping legs use minimum distance, never stacked alpha.
- The mask follows the displayed Mercator leg with latitude-adjusted ground
  distance and shortest-world wrapping across the antimeridian.
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
  Each DEM subtile is written directly to its final canvas offset with
  `putImageData` on a readback-friendly pixel canvas. CPU-oriented storage avoids
  the accelerated cross-thread bitmap corruption reproduced in WebKit; direct
  writes alone were insufficient. See [graphics compatibility](graphics-compatibility.md).
- Outlines are traced from the same simplified height grid with marching squares,
  joined across cells and simplified within 0.2 display pixels. Ambiguous saddles
  use the bilinear surface's diagonal decision so outlines match the filled regions.
  Their 4–8 NM fade
  uses short spans grouped into 32 opacity levels; the core remains continuous.
  Vector updates are batched and cached alongside each display tile. Only current
  viewport tiles are published to MapLibre; panning back reuses cached geometry. Unchanged
  geometry is not republished when a fractional zoom only changes stroke width.
  Outlines reuse the existing elevation requests and 512px fill textures without
  supersampling either.
- Labels show major contours and sparse **sampled highs** (`^ ~… ft`), rounded
  upward to the next 100 ft. These are maxima among available core samples per
  display tile, not surveyed summits or guaranteed route maximum elevations.
- Terrain fills and outlines draw above charts and below route lines and navigation.
  Altitude labels draw in the foreground above route lines and waypoint circles;
  elevation and clearance both use 15px bold text, matching full-size fix labels.
  Below zoom 8, a prominent **Zoom in to see terrain contours** hint appears above
  both toolbox tabs; no elevation tiles are loaded and the hint disappears on zooming in.

## Selected altitude and clearance

The corner legend has Elevation / Clearance tabs. Elevation shows only the
elevation color scale. Clearance adds an editable altitude field and a
touch/keyboard-accessible slider from 0 to 25,000 ft MSL that snaps in 500 ft steps, initially
set to 4,500 ft. Typed values apply on Enter or blur, rounded to the nearest 100 ft
and limited to that range; an empty field restores the current altitude. The slider
shows the nearest 500 ft mark for typed values between steps. Switching tabs
remembers the selected altitude. Active altitude/mode survives reloads.
This is a manual comparison, never live aircraft altitude.

Clearance is **selected MSL altitude minus terrain MSL elevation**. Colors use
the upper elevation of each 500/1,000 ft contour band so the fill does not overstate
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

The worker encodes a band's upper elevation and corridor fade in a 512px indexed
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

The default is [Mapzen Terrain Tiles on AWS](https://registry.opendata.aws/terrain-tiles/),
using [Terrarium PNG encoding](https://github.com/tilezen/joerd/blob/master/docs/formats.md):
`R * 256 + G + B / 256 - 32768` meters. Attribution links to the
[source providers](https://github.com/tilezen/joerd/blob/master/docs/attribution.md).
`VITE_ZLAYERS_TERRAIN_TILE_URL` can supply an equivalent 256px Terrarium service.

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
and at most four network requests run at once. Completed or canceled render jobs
release their canvas backing stores. A 128-tile LRU holds at most 32 MiB of decoded elevations;
ordinary HTTP caching is also respected. Route changes invalidate contour tiles
without replacing the map. Zooming preserves the source and cached contour tiles;
revisiting an overview does not restart its elevation requests. Removing or hiding the route cancels obsolete
requests, including work waiting for a render or network slot, and terminates the
worker to release its decoded cache. Unmounting also removes all owned map resources. Tile requests outside the corridor are
rejected before starting a worker job, and worker messages include only nearby legs.

Failed requests leave gaps, never zero elevation. **Terrain incomplete** tracks
failed tiles at the current view and zoom, and missing elevation inside the route
corridor. Missing samples elsewhere in a downloaded tile do not trigger the
warning unless interpolation spreads the gap into the corridor.
Successful tile retries clear their failures; returning to an unresolved gap
shows the warning again. Re-enabling terrain or reconnecting while the current
view is incomplete retries failures. Healthy views are not invalidated by focus
or reconnect events. This initial module has no
explicit offline terrain download or persistent elevation package: browser HTTP
cache and the live worker cache are opportunistic, not offline coverage guarantees.

## Verification

`test/terrain.test.ts` covers units, masks, overlap, latitude, wrapping, route gaps,
nodata inside/outside the rendered corridor, flat region colors/opacity, zoom work
bounds, simplification, sampled highs, joined contour paths, closed peaks and
outline fading.
`test/terrain-elevation.test.ts` checks the four-download limit, prompt cancellation
of queued reads, and cache reuse after waiting for a network slot.
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
textures, up to 128 cached vector tile results, temporary grids and canvases add
memory. Physical iPad/iPhone profiling is still needed to establish frame-rate,
total memory and battery costs.

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
