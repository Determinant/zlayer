# Glide Planner

[Documentation](../../../docs/README.md) / Plugins / glide

Glide is a planning overlay in `src/layers/glide/`. Its descending-aircraft tab
sits immediately above AWC Weather. The inputs are an editable glide ratio
(3–20:1) and a 0–18,000 ft **MSL** start-altitude slider in 100 ft steps. The default
is 8:1 at 6,500 ft, with coverage initially off. These preferences persist in the
plugin's version-2 `preferences` record. Stowing the panel keeps coverage active;
unloading the plugin stops its worker and removes its map resources.

8:1 is a deliberately reduced planning starting point for light singles such as
C172/DA40/SR22-class aircraft, not a model-specific POH performance claim. Actual
configuration, airspeed and wind matter; use the aircraft's POH and a suitable
margin. The [FAA Airplane Flying Handbook, Chapter 3](https://www.faa.gov/sites/faa.gov/files/regulations_policies/handbooks_manuals/aviation/airplane_handbook/04_afh_ch3.pdf)
explains glide ratio and wind effects. Wind, obstacles, turns, approach alignment
and landing maneuvers are not modeled.

## Coverage and point inspection

- **Amber airport coverage** grows outward from eligible airports, representing
  places from which a straight glide can reach a field. Airport origins must be
  within **20 NM of the displayed route centerline**. Bringing an origin on
  screen discovers its complete range, including terrain beyond the screen edge.
  Completed ranges remain cached as the camera moves; their merged coverage stays
  clipped to the route corridor. No displayed route means no airport
  coverage. Curves, approach extensions, planning connections and displayed route
  previews use the same core route geometry as Terrain.
- **Teal solid ownship ring** grows outward from the current ownship position,
  showing a straight glide from that point. It is independent of the route.
  Ownship must be enabled, tracking a fresh fix with accuracy within 100 m, and
  visible when a new position is first calculated. Panning away retains a completed
  ring for the same position. Stale/unavailable GPS or provider removal clears it;
  a changed off-screen GPS position never inherits the previous position’s range. The ring follows live **position**, using the **selected planning MSL
  altitude**; raw browser GPS altitude is not substituted. Both the legend and
  status explain this distinction. No second GPS watch is acquired.

- **Teal dashed selected-point range** starts at a labeled **Glide from here** pin.
  Right-click or long-press anywhere on the map and choose **Show glide range**.
  This enables coverage, opens Glide and focuses the altitude slider. It needs
  neither a route nor GPS. Selecting another point replaces the pin; the card's
  clear button or **Clear selected glide point** menu action removes it without
  affecting airport or ownship coverage. The selection lasts for the current
  session and clears on plugin unload. The complete range is retained off screen
  while that point and the planning inputs stay unchanged.

Airport regions use a 32% amber fill; ownship and selected-point regions use 24%
teal fills. Dark outline casings keep boundaries legible where the regions overlap.
Solid versus dashed outlines and the point label distinguish live position from
manual planning. All ranges use the same ratio, slider altitude and 200 ft terrain buffer.
Their outlines also include a 0.1 NM horizontal inset and inward-only smoothing.
Airport coverage additionally reserves 500 ft above field elevation on arrival.
The camera clips drawing, not the calculated footprint. Complete origin-centered
work windows allow cached airport, ownship and selected-point ranges to survive
pan, zoom and rotation unchanged. Unvisited off-screen origins are not eagerly
calculated. A route edit reselects cached airport origins and clips their complete
footprints to the new corridor; it does not invalidate ownship or selected-point
ranges. Changed glide/data inputs invalidate the ranges that depend on them.

## Airports and elevation

The navigation data API supplies the current browsing/saved-region airport data,
independently of Navigation symbol visibility or plugin activation. Eligible fields
have a published finite elevation and at least one positive-length land runway.
Private fields, turf, gravel and gliderports are included. Explicitly nonoperational
fields, heliports, seaplane bases, water/closed runways and missing runway/elevation
records are excluded. Missing airport operating status is not inferred as closed.
Positive published dimensions are only an eligibility screen; they do not prove
landing suitability, permission or current NOTAM status.

Viewport and route filters run before calculation. No nearest-airport cap silently
drops fields: views with more than 160 eligible visible candidates, below zoom 7,
or spanning over 45° longitude/25° latitude pause new origin discovery and ask the
user to zoom in. Cached footprints can still be reconciled after a route edit at
those overview scales, without acquiring terrain or discovering new origins.
Airport markers include eligible candidates even where terrain is incomplete. Airport footprints
are unioned before drawing, so touching/overlapping footprints share a perimeter
and enclosed holes remain. World wrapping keeps date-line coverage local.

`core/terrain/elevation.ts` supplies a bounded maximum-height mosaic service with
an injected tile reader and optional cell mask. Terrain's data-only `data.ts`
provides that reader using its existing `ElevationTiles`, package/source selection
and core file acquisition. Glide never reads rendered terrain colors or invents
elevation from map pixels. Saved source precedence, content identity, units,
maximum cells, missing data and fallback Terrarium tiles retain Terrain's
[data contract](../terrain/README.md#elevation-and-precision). This works when the
Terrain overlay/plugin is disabled.

## Direction and terrain

For glide ratio R and start distance d from an airport, a straight return needs:

```
minimum start MSL(d) = d/R + max(field MSL + 500,
                               max over s in [0,d](terrain MSL(s) + 200 - s/R))
```

Distances and heights use feet. This is evaluated outward from each airport, so
terrain anywhere along the return path matters. A higher selected altitude can
clear a ridge and arrive with excess height; a fixed field-anchored glide cone
would incorrectly rule out those glides.

The forward ownship and selected-point calculation instead requires, at every distance s along the
outbound path, `start MSL - s/R >= terrain MSL(s) + 200`. It stops at the first
obstructing or unknown terrain. The algorithms share a terrain profile but apply
the two directions separately. The return formula permits arriving above the
reserve, which is necessary to represent glides over intervening ridges. It does
not force every flight onto a cone anchored at field elevation. Both feasibility
requirements increase with distance along a bearing, so stopping at the first
failed interval and using a star-shaped footprint is valid for this model.

The worker prepares **360 one-degree sectors** from entire terrain cell
footprints, including terrain between sector edges. Angular limits come from the
actual square cell corners; nearest/farthest distances bound the whole square.
This retains isolated peaks without spreading a valley wall across bearings
that miss it, as a circumscribed-circle approximation would. Radial bins retain
maximum heights and conservative distance bounds. Unknown cells stop affected
sectors. One-degree sectors distinguish narrower valleys while keeping the same
terrain resolution and bounded profile cache.
Mercator distances use a cumulative upper path-length bound for each one-degree
sector. Every radial interval uses the largest local ground-distance scale anywhere
in that sector interval. Both travel directions use differences of the **same**
cumulative bound; every difference still bounds that part of the path. Using a
window-wide upper bound at one endpoint and a lower bound at another unnecessarily
shrinks long/high-latitude glides. The acquisition radius uses the mosaic's minimum
scale so the farthest possible path is sampled. Within the final known interval,
solve the glide inequality for its partial-bin distance instead of discarding the
whole bin. This recovers up to one planning cell of numerical rounding loss without
interpolating terrain heights or changing the clearance reserves. Inscribed route
buffers stay within 20 NM; their conservative width can narrow slightly with
latitude variation.

## Planning resolution and conservative outlines

Source acquisition retains DEM zoom 11 and existing maximum-height overviews when
needed to keep each origin's source window within **262,144 cells**. Whole source
cells are combined by **maximum height**, never by average or by skipping samples.
Core pools each immutable decoded tile once per factor, then copies its maxima
directly into small origin mosaics. Nearby airports share those preparations through
a **4 MiB** pooled-tile LRU. Weak source keys do not retain raw decoded tiles. Source
acquisition zoom and peak/unknown semantics are unchanged; one missing child keeps
its parent unknown. Only tiles intersecting the requested cell mask are acquired.
Calculation-window caps use a three-planning-cell perpendicular inset on every
side so partial boundary cells cannot masquerade as missing terrain. Origin
windows include enough padding to keep normal glide limits inside these caps.
A power-of-two block size targets roughly **0.1–0.2 NM** cells at local latitude;
already coarser overviews remain at their existing resolution. No finer terrain is
fetched for cosmetic outline detail. All origins share the terrain reader and its
bounded decoded-tile cache; prepared DEMs and radial profiles are reused per origin.

Contours are made conservative before airports are unioned. The horizontal inset
uses the minimum local distance scale so it is at least 0.1 NM across the work
window; smoothing distances are nominal planning margins, not survey precision.
The simplification tolerance uses the maximum scale to stay within 0.05 NM.

1. Each angular boundary takes the smaller of the adjacent sectors' proven radii,
   then applies a **0.1 NM inset**. Joining shared corners removes the old double
   vertices and radial stair steps. Both endpoints of an edge lie inside the same
   proven sector triangle, so the entire edge does too. Sharp mountain notches may
   widen by one sector; they are never bridged outward. If a sector extends more
   than 0.2 NM beyond both neighbors, retain an additional mid-sector tip inside
   its proven triangle, with the 0.1 NM inset plus another 0.1 NM smoothing margin.
   This prevents two neighboring valley walls from deleting an isolated clear
   direction. Tips use the same path for fills and forward-range outlines.
2. Two short, inward-only averaging passes soften small radial spikes. Each shared
   corner moves inward by at most another nominal 0.1 NM at this stage. A low or unknown
   radius can never increase.
3. A constrained Douglas–Peucker pass removes redundant vertices within **0.05 NM**
   of a shortcut. It works in spans of at most 90° and rejects any shortcut with a
   skipped vertex on its inward side. Thus every replacement edge stays inside
   the star-shaped input; ordinary distance/topology simplification alone would
   not establish that property. This is the same containment objective as an
   [inner polygon hull](https://postgis.net/docs/ST_SimplifyPolygonHull.html),
   implemented for these radial contours without adding a geometry dependency.

Smoothing runs on individual airport footprints before union and corridor clipping,
so it cannot fill terrain holes or extend airport coverage past the route corridor.
Forward glide rings use the same boundary method. Their gaps are classified using the
**unsmoothed** sector limits and explicit missing-terrain flags, so an inset cannot
turn a calculation-window cap or a terrain-data gap into a false glide boundary.
Known reachable fill can end at a gap, but ownship/selected-point range lines remain
open there. Degenerate zero-length paths are omitted.

These approximations deliberately understate reach. The 200 ft terrain buffer and
500 ft airport-arrival reserve remain in the glide calculation. Source accuracy,
coarse maxima, angular wedges and ignored obstacles/flight maneuvers still limit
the result; a smoother line is not a higher-precision or guaranteed-clearance claim.

## Work and recovery

One lazy worker calculates one request at a time. `GlidePlanner` discovers new
origins from the visible map, then asks `GlideCalculator` to prepare their complete
ranges in camera-independent geographic windows. Each calculator owns exactly one
origin grid and profile; only the planner owns discovery, completed geometry and
LRU eviction. Range demand is rounded up to
4 NM buckets with sampling padding. Each calculation still masks terrain work to
its glide disk; it does not prepare the entire route or arbitrary off-screen areas.
Whole source files/tiles can extend beyond the requested disk. A single shared
Terrain reader coalesces and caches source acquisition across origins.

Completed airport footprints occupy a separate LRU of **512 airports / 8 MiB of
estimated serialized geometry and metadata**, whichever limit is reached first.
Visiting a new field adds its complete, unclipped footprint to the cache; the
current route selects eligible cached fields and clips their coverage to the
corridor. Touching/overlapping coverage has one perimeter. Revisiting an origin
touches its LRU entry and performs no terrain or profile work. Zoom, rotation and
panning reuse the same geometry; a smaller or empty camera view never replaces it
with a truncated range. Oldest
visited fields may be evicted when this bounded cache fills. Current ownship and
selected-point results have their own slots, keyed by position, altitude and ratio.

Prepared numeric DEM/profile buffers have an independent **32 MiB LRU**. Evicting
those buffers keeps the completed footprint. Slider changes within a resident
origin window scan cached profiles; altitude decreases reuse larger windows.
Larger demand expands the window and rebuilds only that origin. Route changes
reselect and reclip visited airports, including off-screen origins, without terrain
work. Removing a route hides airport coverage but retains bounded footprints for
later route edits. Altitude, ratio or navigation-source changes clear affected
airport geometry. Terrain-source changes invalidate all terrain-derived results.
No coverage is saved to disk.

Origin changes coalesce at 250 ms without canceling airport preparation. Each
published airport union carries a revision; a completed-but-discarded response
cannot make a later cached response skip an unpublished union. Each published
forward result must match its current origin; late results cannot
restore a moved or cleared point. Old forward-origin profiles are replaced within
the shared resident budget. Unchanged completed geometry is not republished to
MapLibre when the camera moves, including calculated empty forward ranges.
Ownship and selected-point results share one representation: `null` for an
uncalculated origin, or a completed range containing its identity, line, fill and
terrain completeness. This distinguishes unvisited origins from calculated empty
ranges throughout planning, publication and status. Bringing an unvisited origin
into view still acquires terrain. GPS loss clears both geometry and status
immediately; a pending result cannot restore either.

Performance and terrain changes clear obsolete ranges; navigation-source changes
clear only airport coverage. Route edits debounce 180 ms and replace the airport
union when its current result is ready, with the preceding union labeled as
loading in the meantime. Route removal clears that union immediately. Unchanged
ownship and selected-point geometry remains published throughout route edits,
including at overview zoom. Forward status distinguishes a retained calculated
range from an uncalculated origin that needs zooming in. Camera movement and
hiding cancel pending work but keep completed ranges and the idle worker/cache.
Zoomed-out or empty views retain them as well. Returning to a visited area uses
the cache immediately; only newly discovered origins need terrain calculation.
Each calculation owns an abortable wait for shared navigation acquisition.
Cancelling obsolete demand releases that wait without cancelling other consumers'
downloads. Active worker calculations still drain before another request starts;
late results cannot publish against a newer route or source identity.
Cancellation yields between origins. Core reads at most four DEM tiles
concurrently. Disable and unmount release the worker and all caches.
The plugin owns every map source, layer, listener and timer. Optional typed bridge
subscriptions to Routes and Ownship clear on provider removal and recover on return.

Failures preserve unknown terrain, never distance-only circles. Partial airport
or terrain coverage is labeled separately from ownship and selected-point status; Retry, reconnect
and offline inventory recovery reload failed inputs. Navigation acquisition uses
the existing validated data API and shared caches. No new network queue or
persistent DEM representation is introduced. A failed discovery keeps previously
completed coverage; Retry, reconnect and inventory recovery explicitly reset the
worker cache so repaired inputs can be recalculated. Recovery need is retained
separately from loading/zoom presentation, so an inventory notification during
camera motion or overview cannot hide an earlier data failure. Cancelled work also
remains eligible for recovery: its worker may have cached incomplete origins that
the view never received. Inventory changes during active acquisition invalidate
that attempt too.

## Verification

`test/glide-math.test.ts` compares both glide directions against an independent
piecewise-path feasibility/bisection oracle, verifies distance bounds by numerical
integration across headings and latitudes, and checks flat-ground physical range
through 80° latitude. It also checks partial-bin precision, open boundaries at
terrain gaps, shared maxima, unknown propagation, memory eviction and date-line
mosaic alignment.

`test/glide-planner.test.ts` verifies camera-independent full footprints, zero-work
revisits, cumulative polygon union, off-screen route reclipping, overview discovery
limits, settings/source invalidation, forward origin identity, independent memory
budgets, unknown terrain and cancellation.

`test/glide.test.ts` covers the bounded calculation kernel: field eligibility, private runways, route/date-line
selection, the 20 NM boundary, MSL/reserve arithmetic, reverse and forward terrain
constraints, unknown cells, peaks between rays, polygon union, rotated viewport
work-window masks, window-limited arcs, core acquisition cancellation, profile reuse and source
invalidation. Selected-point cases verify independence from routes/GPS, profile
reuse, offscreen exclusion and missing-terrain behavior. Its planner cache test reports cold/warm timing for diagnosis; assertions use
actual cell reads, profile builds and plan reuse rather than unstable time limits.

`test/glide-smoothing.test.ts` verifies maximum-height pooling of isolated peaks,
unknown-cell propagation, conservative coarse profiles, containment for randomized
sharp/zero-radius notches, vertex reduction, physical resolution, and open ownship
arcs. Rotated synthetic valleys test both glide directions after smoothing;
crossing ridges and unknown strips must cut their lobes back. A narrow isolated
sector must retain its long tip while the complete simplified polygon stays
inside the proven sectors. These are geometry/work-count assertions rather than
timing thresholds.

`test/e2e/glide.spec.ts` runs in the full Chromium suite and the WebKit/Firefox
graphics matrix (CDP touch injection is Chromium-only). It exercises the real
worker/MapLibre boundary, merged coverage,
slider updates, distinct ownship styling, passive provider connections, GPS loss,
route removal, cached offscreen origins, route edits at overview zoom, delayed
obsolete route results, cancelled navigation waits, missing terrain/retry,
inventory recovery during movement/overview and after discarded results,
teardown/remount, tab order,
phone layout, saved inputs and compact contours over a serrated synthetic mountain
ridge in the production-built app. Desktop right-click and touch long-press tests
cover point selection, replacement, clearing, pending calculations, automatic panel
opening, session lifetime and plugin unload. Camera regressions keep every source
visible during drag and a held worker response, reject late pre-pan results, and
verify retained empty-view geometry and disabled-state cleanup. Zooming out and
back, rotating, and revisiting explored route airports perform no new terrain
requests and preserve the same rendered sources. A built-app valley fixture checks
long, compact lobes from airports, ownship and the selected map point.

Before origin caching, the 2026-10-01 synthetic 14-origin comparison used the same 71,332 DEM cells
before and after the valley correction. Median cold calculation was 56.6 → 67.2 ms;
a cached altitude change was 17.6 → 19.1 ms, with zero terrain/profile-cell reads
and all 14 profiles reused. These are diagnostic desktop timings, not phone
performance guarantees. Flat outlines still simplify to 33 vertices.


## Accuracy limits and next improvements

The calculation is conservative **relative to its supplied terrain and still-air,
straight-path model**. Distance bounds refer to core's spherical Earth metric;
ellipsoidal geodesy is not implemented. The result does not establish actual
aircraft performance or obstacle clearance. Useful next improvements, in order:

- **Wind plus aircraft speed/sink information.** Ratio alone cannot convert a wind
  vector into ground range. Wind must use the direction of travel, including the
  opposite sign for airport-return paths, and a defined time/altitude profile.
  A headwind can consume a substantial part of the nominal ratio margin; see the
  [FAA discussion of glide range](https://www.faa.gov/sites/faa.gov/files/regulations_policies/handbooks_manuals/aviation/00-80T-80.pdf).
- **Expose terrain provenance and resolution.** Packaged maxima retain the supplied
  source highs. The Terrarium fallback is resampled elevation; its upstream
  [SRTM resampling](https://github.com/tilezen/joerd/blob/master/joerd/source/srtm.py)
  uses cubic/Lanczos filters, not a maximum envelope. Max pooling cannot recover
  peaks already lost upstream. This is a source-accuracy limit, and the fixed 200 ft
  buffer does not prove it is covered. DEMs also do not establish current obstacles,
  runway suitability, or consistent survey-level vertical datums.
- **Worker transport and airport indexing.** Use the map's acknowledged union
  revision to omit unchanged airport GeoJSON from worker responses. The map already
  skips unchanged `setData`, but worker responses still clone the cached union.
  A spatial index over the navigation collection can also avoid scanning every
  airport when only a small viewport is being explored.
- **Adaptive angular work and incremental union.** Refine only angular sectors
  whose proven limits differ materially, and merge new footprints into spatially
  grouped existing unions. Both can reduce larger-route CPU cost, but need the same
  whole-cell/sector containment proof and correct removal on eviction. Current
  one-degree wedges and complete union remain bounded and easier to validate.
- **Moving-ownship work reuse.** A shared terrain tile pool now avoids repeated
  sample reduction. Further reuse must still recompute the polar profile for the
  actual position; reusing an old center without a proven displacement margin
  would compromise clearance.

An open straight valley can produce a long lobe. Following a **bending** valley
requires a different reachability model with turn geometry and turn-related height
loss; an unrestricted terrain flood fill would imply unmodeled maneuverability.
The forward model also retains a conservative zero-MSL terrain floor, preventing
bathymetric data from implying flight below water; this understates reach over
below-sea-level land. A land/water-aware model would be needed to remove that floor.

For repeatable CPU diagnostics, run `node --import=tsx tools/benchmark-glide.ts`.
The synthetic workload has 12 nearby airports, ownship and a selected point, a
0.8 NM straight valley, 6,500 ft / 8:1 inputs, and four camera changes. Five runs
use fresh planners and shared immutable decoded tiles; the first is warm-up.
On the 2026-10-01 desktop review, the complete-origin implementation before shared
pooling/distance fixes took a median 223.5 ms cold versus 86.9 ms after; origin-mosaic
cell copies fell from 1,697,890 to 130,482, with the same 129,120 profile cells.
Four cached camera changes took about 0.2 ms and no terrain/profile work. These
numbers exclude network, decoding, worker transport, rendering and phone behavior.
The flat-ground high-latitude regression at 18,000 ft / 20:1 has a 58.59 NM ideal
range; displayed vertices at 80° now lie around 58.42–58.46 NM, retaining the inset
and conservative distance bounds instead of a several-NM window-scale penalty.
