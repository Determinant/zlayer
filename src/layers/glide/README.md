# Glide Planner

[Documentation](../../../docs/README.md) / Plugins / glide

Glide is a planning overlay in `src/layers/glide/`. Its parachute-icon tab
sits immediately above AWC Weather. The inputs are an editable glide ratio
(3–20:1) and a 0–18,000 ft **MSL** start-altitude slider in 100 ft steps. The default
is 8:1 at 6,500 ft, with coverage initially off. These preferences persist in the
plugin's version-2 `preferences` record. Stowing the panel keeps coverage active;
unloading the plugin stops its workers and removes its map resources.

The main **Show glide coverage** switch enables the planner. A separate **Airport
coverage** switch controls the amber airport regions, markers and labels; it
defaults off, including for older saved preferences without that field. Turning it
off keeps ownship and selected-point ranges visible and stops airport acquisition
and preparation. Its saved setting survives toggling the main planner switch.

The panel follows [shared UI typography and controls](../../../docs/features/shared-ui.md#typography):
inherited B612, core switches/buttons/inputs and touch sizing. Its compact hierarchy
follows Terrain and AWC Weather: titles, labels, legends and explanatory paragraphs
use the panel's 12 px base and 1.5 line height. Planning assumptions and landing-area
explanations keep this same size; the map-gesture hint joins supporting notes,
status, metadata and slider limits at 11 px. The altitude value and MSL units share
a bold 14 px baseline, wrapping below the label on narrow panels. Compact padding,
spacing and dividers group coverage switches, planning inputs and one **Map legend**.
The legend places range and landing-candidate swatches together, with concise color
and line-style labels followed by density/detail guidance and map actions. Live
ownship, airport and landing-area status, preparation date and retry actions sit
directly below the planning-altitude hint in the inputs section.
Actions use core's compact controls, and the selected-point
card uses shared theme colors.
Text inputs retain core's 14 px desktop / 16 px touch sizing. The native slider,
switches, actions and disclosure retain shared touch sizing and keyboard-focus treatment.

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
  ring for the same planning origin. Drift under 25 m retains that origin;
  larger movement requests a new range. Stale/unavailable GPS or provider removal clears it;
  a changed off-screen GPS position never inherits the previous position’s range. The ring follows live **position**, using the **selected planning MSL
  altitude**; raw browser GPS altitude is not substituted. The altitude hint and
  ownship status explain this distinction. No second GPS watch is acquired.

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

Glide and Ownship are independently registered plugins. Glide uses core's scoped
`bridge.watch('ownship')` connection to observe the read-only `OwnshipApi.position`
store, and similarly observes Routes' displayed plans. Neither is an activation
prerequisite: losing Ownship clears only its ring, and losing Routes clears
airport coverage and route density shading. Ownship/selected-range landing detail and selected-point planning need
neither provider. Disabling Glide releases its subscriptions without changing
Ownship or acquiring/releasing a GPS
lease. See the [inter-plugin bridge contract](../../../docs/architecture/layer-plugins.md#inter-plugin-communication).

## Off-airport landing candidates

**Off-field coverage** is a separate, persisted switch, initially off. It requires
Glide and either a displayed route or a calculated ownship/selected-point range,
independently of Airport coverage. The publisher does the surface, vegetation, hazard, width and length screening; this
client reads compact conclusions from the feed-wide `glide/manifest.json`.
It performs no imagery analysis or landing-surface DEM work.

- Vivid green (`#53e52d`): preferred tier, a screened straight fit of at least **2,000 ft** (3,000 ft in legacy schema 4).
- Vivid purple (`#a23bff`): last-resort openings ranked within each connected patch. Schema 8
  prefers **1,500 × 100 ft** but retains measured fits down to **600 × 60 ft**.
  These are screening floors, not aircraft stopping-distance guarantees. It may
  include flagged scrub, sloped/uneven ground, bare ground or mixed open surfaces.
  Scrub stays best effort even when its fit exceeds 2,000 ft. Preferred screening
  retains strict terrain and vegetation criteria; these priorities do not estimate landing-success probability.
- Detailed boundaries display the supplied connected area, clipped to calculated
  ownship/selected-point ranges, with retained holes. The internal
  straight-fit witness is never drawn as a runway. Selecting a candidate uses its measured fit for arrival planning.

The route overview shades the approximate density of screened candidate ground
within **20 NM** of the route. Stronger shading means more candidate ground, not
landing-success probability. Each density cell uses its predominant tier’s color (purple on a tie), avoiding
a gray intermediate hue when both tiers occur. Density still measures their union. Blank
ground can be unassessed, rejected, below raster resolution or not yet loaded.

Detailed polygons appear only within the calculated ownship range and ranges
selected through **Show glide range** (including a selected site’s arrival range).
No route is required for this detail. Altitude/ratio changes change its geographic
mask, not the publisher’s qualifications. The screened sites themselves do not
establish approach or landing feasibility. Right-click or long-press a detailed
area and choose **Inspect landing area**. The
existing shared context menu selects the original decoded record, preserving its
fit dimensions, maximum fit elevation and flags rather than inheriting the
merged tier's combined flags. Hole interiors are not selectable. Where records
overlap, prefer green, then the largest measured fit area; this is selection
ordering, not an aircraft suitability score.

An inspected record retains the manifest URL and a digest of its schema, builder,
input digest, complete inventory and preparation coverage. Packaged sources also pin
the accepted root manifests and shared chart-region ownership masks. A changed source
clears the selection and its arrival range, including after a map remount or when
the preparation timestamp stays the same. Remounting against the same source
preserves the selection. Inspection replies must match the displayed source;
transient loading/idle status is not the authority for a selection's identity.

A selected site's fit midpoint and maximum elevation drive an on-demand reverse
arrival calculation using the same bounded terrain engine as airports, including
500 ft arrival reserve, 200 ft terrain clearance and inward-only smoothing. A
**dashed purple** outline and **Glide to selected area** pin distinguish this
from a forward point range. The slider and ratio update that arrival range. The
panel shows route distance inside the calculated footprint; empty or incomplete
terrain is not filled optimistically. This does not establish approach alignment,
landing direction, surface condition or stopping performance. Only the selected
site is calculated, keeping preparation proportional to user demand.

The panel combines landing colors with glide-range colors in **Map legend**, with
short guidance on density shading, detailed boundaries and map gestures. Landing
status, preparation date and retry actions accompany the glide status below the
planning-altitude hint.
The collapsed-by-default **Planning assumptions** disclosure
groups glide-model limits with off-field screening caveats when Off-field coverage
is enabled. Concise, labeled paragraphs explain surface uncertainty, last-resort
allowances, obstacles, conflicting vegetation evidence and unassessed ground;
flag-specific caveats appear only when reported for the displayed coverage.
Neither an unflagged area nor either length tier establishes current landing
suitability; the disclosure explains that candidates are unverified and boundaries
approximate, and calls for visual inspection of the ground and approach.

### Delivery and validation

The preferred feed is **glide-packages delivery schema 1**, independent of engine
version and the embedded record schema (8 or 9). Catalog discovery captures the
complete accepted root in its immutable catalog snapshot. Regional saves include
its exact regional inventory, dependency pages, local index pages, coverage,
provenance, and all intersecting detail/overview archives at every published zoom.
An inventory is used only when its ID and download envelopes match; other envelopes
enumerate intersecting root indexes. Saved ownership uses the same state polygons
as charts, including holes and date-line copies. Eviction never substitutes a newer
release inside a saved region. Existing selections keep their original scope until
**Update to latest**. Legacy feeds remain readable but are not regional glide packs.

`packages/contracts/src/glide.ts` owns delivery guards. Content-addressed `.gld`
and `.glo` files use the shared verified whole-file archive cache, also used by
regional downloads. There is no second plugin-cache copy. Each archive is at most
2 MiB: `GLIDEP01`, a little-endian directory length and reserved zero word, then a
bounded JSON directory and independent gzip members. Directory offsets are relative
to the payload; index offsets are absolute. The reader checks their agreement and
inflates only requested members, checking compressed hash/length and exact raw size.
Index pages are capped at 512 KiB / 512 entries. Eight parsed pages and the last
spatial query of each kind are retained; discovery reads at most 32 intersecting
pages per query and reports a limit if that budget is exceeded.

Ordinary detail blocks are capped at 256 KiB compressed / 1 MiB raw, 4,096 records,
65,536 vertices and 16,384 rings. Explicit single-record exceptions have separate
1,792 KiB compressed / 8 MiB raw / 524,288-vertex / 65,536-ring ceilings. Whole
polygon bounds select detail, even when its owner tile lies outside the view.
The `{source, indices, areas}` payload preserves the original source-digest/record
IDs and unchanged qualifications, flags, rings and holes. Repackaging never turns
an archive or block address into a candidate's identity.

Overview members contain **256 × 256 × 3 uint8** values: preferred, best-effort-only,
and prepared fractions divided by 255, north to south in EPSG:3857. Preferred plus
best effort cannot exceed prepared. Zooms 0–10 (optionally 11) are independently
published. The publisher computes candidate unions, holes and ground-area weighting;
route browsing reads these fractions without acquiring or rasterizing candidate
polygons. Prepared coverage describes preparation, not a per-pixel suitability
assessment. Archive transfers require ordinary unencoded binary responses; publish
immutable files before replacing discovery `manifest.json`, retaining old files.

Record schema **9** (or **8**, with legacy feeds **4/5/6/7**) must declare `geometryMeaning: generalized-candidate-area` and
`status: experimental-candidates`. Older runway-oriented schemas are rejected.
In the legacy feed, each shard is a hash-named gzip JSON array, capped at 2 MiB compressed / 16 MiB
raw; manifest shard counts (at most 10,000), per-tier counts, bounds and each file size
are checked before use. There is no 64 MiB national inventory cap: that value
belongs to the independent local disk cache. Each area is `[qualification, rings, flags]`, where
qualification is `[lon1E6, lat1E6, lon2E6, lat2E6, widthFt, lengthFt, maxElevationM, tier,
alongGradePermille, crossGradePermille]`. Schema 9 requires ten values; earlier schemas
retain eight. The signed overall grades come from a plane fitted to the DEM within
the measured footprint. Inspection displays their magnitudes in percent, not a
maximum local slope or a recommended landing direction.
All values are integers; endpoints use millionths of a degree and maximum witness
elevation is in metres MSL. Wire tier **1** is best effort and wire tier **2** is preferred;
the manifest's `tiers` counts follow that same order. Ring pairs are cumulative E6
longitude/latitude deltas, starting from zero independently for each ring; closure is implicit. The exterior
is first and holes follow. Flags bit 0 means cultivated ground with unverified
field condition; bit 1 means uncertain shrub surface; bit 2 means the broader
shrub band was needed and requires bit 1. Bit 3 flags tree-canopy model disagreement
(in legacy schemas it requires shrub bits 1 and 2 and denotes corroboration by RCMAP). Builders v16/v17 stopped emitting that legacy allowance. In schema 7, bit 3 instead requires mapped open ground where the Science estimate is 6–20%, with mapped forest/wetland excluded. It no longer requires shrub bits and never permits green.
Schema 5 adds bit 4 for smooth-slope fallback, bit 5 for developed open space,
and bit 6 for the narrower building setback. Those allowances remain purple even
with long fits. Schema 6 adds bit 7 for bare/sandy substrate or a nonzero impervious fraction within the open-ground limit; neither establishes surface firmness. All fallback flags are rejected on preferred records. Schema 4
retains its original 3,000/1,500 ft minimums and four-bit flag contract.
Schemas 4–6 require 200 ft width in both tiers. Schema 7 permits purple widths
down to 100 ft only with the constrained-fit flag; preferred records always
require 200 ft. The decoder enforces these floors independently of polygon size.
Schema 8 retains the compact tuple and flags but permits the constrained dimensions above;
older schema minimums remain enforced. Green remains 2,000 × 200 ft.
Schema 9 adds bit 10 (value 1024) for corroborated land-cover disagreement, allowed
only on purple records. Coarse forest recovery requires both mapped and fine-raster
open-ground evidence plus low canopy/impervious estimates. Older fine-raster tree
evidence can be overridden only with newer NLCD, canopy and mapped open-ground
sources under the same low limits. Mapped exclusions and water still win. These
reconciliations indicate uncertain source agreement, not verified absence of trees.
An optional `coverage[].shrubEvidenceMissing` flag reports regions without both
shrub source families; it is not a per-pixel completeness mask. The panel explains
that unmarked ground can be unassessed or rejected.
Schema 7 adds bit 8 for a narrower fit or reduced ground setback, and bit 9 for a reduced obstacle exclusion. Purple may use a 100 ft width; green retains 200 ft. The panel exposes both allowances. These are screening policies, not aircraft landing-performance guarantees.
Builder v18 screens two complete masks. Green ground remains usable by purple qualification, and green draws above overlap; every published polygon retains a checked full-width fit. The panel explicitly calls out the fallback conditions. Shrub flags are rejected on preferred
records. Unsupported flag bits are rejected. The panel calls out shrub uncertainty
independently of fit length; these bits add no raster payload. The loader checks SHA-256,
exact compressed/decompressed lengths, count/tier consistency, ring coordinates
and published geometry bounds. It preserves the publisher's simplification;
the display outline is not a precise obstacle-clearance mask. The decoder keeps
stable shard-digest/record IDs, both fit endpoints, dimensions and elevation for
inspection. The downloader has brought the stricter obstacle policy back into
its main working tree: both tiers retain reported position uncertainty and
mast/guy-wire clearance, while identified ordinary structures receive their own
physical buffers. The completed schema-8 publication remains readable; it can
contain mixed original/stricter checkpoints from the interrupted first run.
Flags alone cannot identify which policy produced those historical records.

`landing-loader.ts` keeps core's validated JSON loading and scoped plugin file
cache for legacy feeds only. Immutable shards have a **64-file / 64 MiB / 30-day unused** optional disk
budget; identity includes the digest, compressed/raw sizes, total/per-tier counts,
bounds and decoder version. Cached browsing can work offline but does not add verified regional
save coverage. Packaged glide uses the verified regional storage described above.
A failed manifest load or missing shard never means clear land.
Before publication the panel reports that data is unavailable, and Retry landing
areas retries acquisition without resetting airport/ownship calculations. Legacy manifest reads
try the network first with a validated saved fallback. Eligible queries after
camera movement or resume recheck the manifest once the previous check is at least
five minutes old; Retry and reconnect request revalidation on the next eligible
query. A missing manifest retries on subsequent demand after a one-minute failure
backoff, which explicit revalidation bypasses. No background interval polls this
feed. Catalog discovery probes the small optional packaged root independently of
layer activation; its accepted identity stays pinned until catalog refresh/update.
The landing worker acquires no coverage, indexes or blocks while the feature is off
or has neither a route nor a calculated range. Both feeds are independent of FAA cycles.

### Geometry, caching and lifecycle

Detailed polygons already visited stay in the worker's bounded cache when the
camera moves. A partial shard adds newly visible whole areas, retaining older
ones while the vertex budget permits. Bounds of omitted records avoid reopening
a shard when the new view cannot reveal anything new. Failed or cancelled
reloads preserve the previous entry; visible candidates take priority only after
a successful replacement. Cache limits still apply.

One lazy worker owns acquisition and display preparation. Discovery requires zoom
7 or above and viewport spans no larger than 45° longitude and 25° latitude.
Only files intersecting the visible **20 NM route corridor** or visible calculated
ownship/selected-point ranges are eligible; the national inventory is never fetched
as a batch. Route removal clears shading while retaining independent range detail.
GPS loss, point clearing and changed planning inputs clear the corresponding detail.

The landing display separates acquisition, preparation and drawing:

- `landing-display.ts` accepts one source identity, coordinates overview/detail
  results and their independent publication acknowledgments, and owns recovery.
- `landing-overview.ts` owns overview acquisition, bounded resident grids, source
  ownership across zooms and residency. Acquisition limits never select which
  already resident grids may draw.
- `landing-heat-composition.ts` integrates the resident raster field into display
  cells. It does not fetch data or choose which files to retain.
- `landing-heat-tiles.ts` retains geographic textures, their complete zoom pyramids
  and route/source clipping meshes. `landing-heat-layer.ts` owns GPU residency and
  drawing. Vector and dense raster detail keep their separate geometry and
  inspection lifecycles.

Packaged route views request overview zoom `floor(mapZoom) - 1`, capped by the
source’s published maximum. Each query acquires **two overview blocks concurrently**, then publishes before
the next pair. New camera demand waits 150 ms; progressive batches yield to the
event loop and continue without repeating that delay. Completed and hidden views
have no continuation timer. At most **32 blocks per view are selected for acquisition**;
the independent cache retains **64 grids**, including during cancellation. All
resident grids remain eligible to draw, even when discovery is disabled
or more than 32 cached blocks intersect the view. Loading progress counts the
requested blocks, not cached fallback inputs. Failure records are also bounded to 64.
Shared blocks appearing in overlapping regional indexes are deduplicated. Repeated
queries reuse the selected descriptors and decoded grids. Each manifest retains
one regional metadata selection and up to 32 decoded index pages per kind. Pans
within the same page set and overview zoom changes reuse that metadata without
storage reads, receipt checks or parsing. Overview inventories contain all blocks
at the requested level in the selected pages; exact viewport, corridor and scope
filtering still determine acquisition. Detail selection continues to use polygon
bounds. Refresh discards metadata failures, and canceled reads cannot poison later
requests. This live cache is independent of offline-save verification.

An unchanged route and viewport also reuse the coverage mask, shard eligibility
and ordered acquisition plan across progressive batches and range updates. Only
the remaining downloads and resident status need updating. Density fractions remain
numeric through composition; they are not converted to binary candidate pixels.
Within each release and regional ownership scope, the finest resident tile owns
its whole rectangle, including known zero-density pixels. Coarser parents supply
only the remainder. This preserves fine observations when coarse publication has
rounded a small fraction to zero, counts each location once, and keeps unrelated
cached coverage. Cached tiles remain usable while a requested level loads or fails.
Fallback never crosses source ownership into another regional edition. Genuine
cache eviction, changed source identity and changed route demand can still remove
coverage. Leaving the viewport and zooming alone never evict prepared assets.
Loading new blocks can eventually evict the least recently used inputs once the
64-grid budget is full; this is a bounded session cache, not an offline-save claim.

Legacy feeds derive an immutable tier raster from each validated polygon file with
worker `OffscreenCanvas` and even-odd holes, capped at 512 × 512 bytes. Their scoped
`landing-shading` cache retains up to 128 derived summaries / 16 MiB. Only that
compatibility path needs a polygon transfer/decode on its first route visit.

The worker prepares each resident geography once, independently of the camera.
A render tile has power-of-two dimensions up to **256 × 256**, with every mip level
prepared through **1 × 1**. Each level averages numeric covered/preferred fractions
before applying the palette. This retains sparse candidates when zooming out and
avoids blending tier colors into a third color. The map chooses an existing level
for roughly 2–4 CSS pixels per density cell (or the finest available source level).
No viewport bitmap, screen-cell probing or padding cache remains in route shading.

Preparation keys contain the intersecting immutable input identities and only the
route segments near that tile, clipped in its fixed geographic coordinates. Editing
a leg invalidates nearby tiles; unrelated legs, camera bounds, zoom, bearing, GPS
ranges and acquisition priority do not invalidate their pixels or meshes. New
intersecting source data and eviction rebuild affected tiles. A source identity
change resets all overview assets. This gives leg-local reuse without storing a
second copy of the shading for each overlapping leg. The source dependency graph
is built only when resident inputs change. Warm queries with an unchanged route
return the prepared tile set before graph construction or local-leg clipping;
route edits reuse the graph and rebuild only affected tiles. Scope geometry is
cached per immutable input. Eviction immediately releases graph references to
removed grids, even if the current acquisition batch is canceled before preparation.

All prepared tiles remain attached to one plugin-owned Mercator WebGL layer while
off screen. Camera changes cull draws, update tile-local projection matrices and
select a cached mip; they do not recompose, transfer or upload retained textures.
Individual content keys let the map acknowledge retained assets. A new snapshot
transfers pixel pyramids and meshes only for keys the map does not already own;
retained assets are represented by their keys alone. After the first successful
visible upload, the main thread releases the CPU pixel and vertex arrays. The
worker owns the recovery copy; the renderer retains GPU resources and small draw metadata,
including precalculated tile coordinates and mip-selection scale. Source/route
revision guards reject obsolete replies. Route edits hide old shading until the
new snapshot arrives, while retaining reusable assets. Disable, worker replacement,
source replacement and teardown release residency. The workspace's `style.load`
lifecycle remounts the plugin after context restoration.
Removing the custom layer also clears its keys, so a replacement renderer cannot
acknowledge textures that belonged to a lost context.

Buffer and mip uploads commit together. Allocation errors, including GPU memory
exhaustion without context loss, discard the new GPU resources and retain the CPU
body. Such a key still acknowledges a reproducible asset, not a successful draw;
the map reports the render failure independently of worker readiness. Each asset
gets one automatic retry after 100 ms. Later camera settles, resizing, foreground
return or explicit recovery permit another attempt. Ordinary redraws and repeated
worker snapshots cannot restart failed uploads. Hiding or teardown cancels the
retry timer, and a hidden document does no retry work. Successful upload or removal
of the failed asset clears its error. GPU error checks run only around new uploads.

Clipping geometry is independent of mip resolution: every level uses the same
20 NM corridor and regional ownership mesh, including holes. Smaller resident
source rectangles own overlapping draw geometry, and each tile integrates all its
local contributing grids, so legacy overlaps draw once. Earcut triangulates each
clipped polygon with explicit hole offsets and spatial indexing for larger rings.
Triangulation uses double-precision tile-local coordinates before packing float
vertices. A polygon with N boundary vertices and H holes needs at most N + 2H - 2
triangles; storage is allocated from that bound. The mesh does not split every
edge at every other vertex's height or simplify the geographic mask.
The shader consumes straight RGBA bytes and emits premultiplied color.
The current workspace uses Mercator; this custom layer does not implement globe
projection or terrain draping.

Composition integrates source-pixel area instead of probing a few sample points.
Disjoint inputs integrate directly; overlapping fields use scan-line unions, so
legacy overlap cannot inflate density. Green wins overlapping binary tiers; the
predominant integrated tier determines the cell color, with purple on a tie.
This is an approximation of the published Mercator raster, not new landing
qualification. Source/scope/corridor boundaries split integration strips; sloping
edges use their strip-midpoint crossings. Each source mask prepares an edge sweep:
successive rows admit edges once and visit only edges still crossing that row,
rather than rescanning the whole boundary at every integration cut. Per-polygon
even-odd pairing retains holes and separate components. Exact clipping meshes keep
even coarse mips inside the requested geographic mask. Density aggregation can fill small
candidate holes at overview scales; fine levels retain their source resolution.

At 64 full 256² tiles, RGBA pyramids total less than **21.4 MiB** in the worker and
another **21.4 MiB** on the map side, where each asset holds either pending CPU
pixels or its uploaded GPU texture. Uploads temporarily overlap those copies;
uploaded pixels are not retained on the main thread. Immutable input grids,
clipping meshes, metadata, protocol copies and composition scratch space are
additional. Composition
uses two 256² float grids plus row accumulators; pyramid reduction releases numeric
intermediates after color preparation. These are allocation bounds, not device
memory, frame-rate or battery measurements. Warm route shading has no polling or
animation loop; off-screen assets have no draw calls. Cold acquisition, affected
route edits and new source data still require worker computation and uploads.
Missing data stays transparent and failed or
unprepared coverage remains labeled. Route shading never unions candidate polygon
records or exposes an inspection hit target.

Vector detail keeps the independent **24-block / 24 MiB source raw JSON /
300,000-vertex** accounting budget. These are retained-input limits, not total JS
heap limits. Exceeding a detail budget switches the display to progressive images
of the original polygons, so larger calculated ranges do not stop partway across
their prepared candidate coverage. An explicitly oversized singleton may raise the vertex allowance to
its advertised vertices plus ring closures (at most 589,824); other retained geometry
counts against that allowance. Whole records are never truncated to fit a budget. Only polygons intersecting the visible calculated range are selected,
nearest the ownship/selected-point calculation origins first, preserving whole polygons and their holes. Dense
files can supply useful detail even when all their off-screen geometry would exceed
the budget. Partial file selections are refreshed from verified source cache when
the view changes. Original records remain available for inspection in vector mode; render unions
are clipped to the range and fused by tier, with preferred ground winning overlap.
Candidate selection and rendering prepare range bounds and edge boxes once per
mask. A candidate box with no possible boundary crossing is accepted or rejected
by containment; cases near any exterior or hole boundary still use exact polygon
clipping. This avoids rebuilding clipping sweeps for interior candidates without
changing their boundaries, holes, flags or inspection records.

Dense detail releases the vector cache and processes **two blocks per result,
sequentially**, retaining one decoded block at a time. Pending blocks are ranked
by distance from the published ownship and selected-point origins to their bounds,
with stable ID ties; nearby blocks appear first and outer blocks follow. Origin
metadata travels with each completed footprint, so an asymmetric terrain range or
a pan does not shift priority to the map center. Both origins receive priority
when two ranges are displayed, and completed blocks survive reprioritization.
The vector path uses the same order for blocks and individual candidates. Callers
without origin metadata use the view center. A worker canvas unions the
original rings by tier, with even-odd holes and the same saved-region ownership
masks as vector detail. Independent color channels preserve preferred dominance
regardless of arrival order. No candidate simplification, fit recalculation or
publisher changes are required. This image is polygon coverage at display
resolution; route density remains a separate numeric overview.

The canvas targets two samples per CSS pixel, capped at **1536 × 1536** including
camera padding. Each RGBA image is at most 9 MiB, with a temporary tier array of
at most 2.25 MiB; canvas storage, worker replies, map uploads and decoded source
allocations are additional. These bounds replace retaining an entire dense
range's coordinates, not a claim about total device memory. Camera padding keeps
small GPS-follow moves and bearing changes in the same frame while the viewport
still fits at the same zoom; rotated bounds do not invalidate its pixel scale.
The canvas retains candidates before
range clipping: new range positions/heights reuse completed blocks and apply a
fresh even-odd row mask to the published pixels. Larger pans or resolution/source
changes rebuild that bounded frame. Unchanged frames skip decoding and uploads.
Completed blocks retain their immutable descriptors alongside the canvas, so
inspection follows all retained pixels even if a later metadata refresh returns
only part of the acquisition inventory. These descriptors contain no decoded
candidate geometry and clear with the frame or source. Inspection snapshots that
completed set; changing the frame or range cancels an obsolete selection.
Once detail exceeds the vector budget, raster mode owns subsequent camera/frame
changes until the ranges clear or source identity changes; zoom does not restart
vector selection. When discovery is disabled, the existing frame and completed
blocks remain available at their original geographic coordinates. Range changes
still reclip that frame; unvisited ground remains empty. Returning to an eligible
view resumes frame preparation when necessary.
A thin inside casing separates candidates without painting across holes or the
calculated range boundary.

Dense-image inspection first checks a shaded pixel, then reads only completed
blocks whose bounds contain the coordinate through the existing verified cache.
It checks original polygons, region ownership and the current range, returns the
original stable ID and individual fit/flags, and retains no polygon afterward.
Range/frame replacement and worker teardown discard pending inspections as empty
selections; actual read failures for current demand still report an error.
Missing blocks remain visibly incomplete and retryable; cancellation preserves
already completed blocks, while source changes discard them. A capacity limit
alone does not offer Retry: retrying cannot enlarge the budget. Metadata discovery
and overview limits still report that zooming in is required.

Area fills use 62% opacity and saturated green/purple shared with the legend.
Vector outlines retain a 0.75 px tier-colored stroke over a 1.5 px dark casing at 75%
opacity; contrast comes from color and opacity rather than thicker linework.
Nonempty density cells use alpha `64 + 160 × sqrt(covered fraction)` (up to
224/255), keeping sparse candidates visible over chart detail while empty cells
stay transparent. The palette is presentation only, so cached numeric summaries
remain reusable after color changes.
For vector detail, MapLibre generates zoom-dependent vector tiles with 0.75-pixel simplification
tolerance and maximum source zoom 16, so lower zooms draw less boundary detail.

Unchanged shading and geometry are omitted from worker replies and MapLibre
uploads. Ready heat is returned before starting detailed polygon acquisition or
union; the immediate continuation prepares remaining summaries and then detail.
Heat and detail have independent acknowledgments and publication validity. A
nonempty range update cannot discard a still-valid heat result or its refresh
receipt, and a failed vector upload does not invalidate accepted heat.
Route textures upload the received arrays directly. Dense detail gives `ImageData`
the received RGBA array directly and shares it with image hit testing.
Range changes preserve route shading; route changes preserve independent
range polygons. Manual camera motion/hiding cancels obsolete work, while GPS-follow
camera movement preserves active preparation. Nonempty range updates also let
in-flight file acquisition finish, coalescing a query for the latest range without
restarting the admission timer. Old detail clears immediately and replies for an
older range cannot publish; the next query clips cached records to the current
range. Removing all ranges, route edits, retries, disable and teardown still cancel
obsolete demand. Queries are serialized. The display worker supplies its accepted
manifest whenever detail runs, including route-only clearing, so a refresh or
cancelled refresh cannot leave the next detail query using an older inventory.
Refresh requests are acknowledged only after a completed worker result confirms
manifest acceptance. Cancellation leaves refresh demand pending; failed refreshes
wait at least 60 seconds before later demand can retry, with no cooldown timer.
Explicit Retry, reconnect and inventory changes bypass that cooldown. A refresh
also remains pending for the raster detail stage when heat publishes first.
Manifest identity changes invalidate derived resident data.
Disabling or teardown releases the worker and map resources; optional disk caches
remain reusable. Core admission bounds full-file acquisition/validation to two
concurrent jobs. Completed camera-independent detail can remain off-screen within
the retained budget; the renderer clips drawing to the camera.

`test/glide-landing-display.test.ts` covers density encoding, progressive two-file
admission, retained tiles across pans/zoom/revisits, range-only demand, GPS/range
loss, failures, cancellation and source invalidation. `test/glide-heat.test.ts`
compares area composition against an independent geometric-union oracle, including
numeric fractions, overlaps, scopes, holes, world copies and sparse pixels through
the full zoom pyramid. `test/glide-overview.test.ts` covers mosaics, zero-valued
child ownership, more than 32 resident blocks, bounded eviction, failed-level
fallback and reuse after an unrelated leg edit. `test/glide-landing-map.test.ts`
covers independent heat/detail acknowledgments, continuation, movement, hiding and
teardown. Existing contract/geometry tests retain candidate validation and inspection.
`test/e2e/glide-landings.spec.ts` reads rendered framebuffer colors and exercises
cached revisits and zoom changes through the real worker, independent ranges,
GPS loss during inspection, selection identity and unpublished-feed recovery.
Camera-reuse cases observe worker replies for redundant tile publication.
`test/glide-packages.test.ts` decodes the complete publisher conformance fixture,
checks original IDs/holes, corruption and inflate limits, numeric-only route reads,
region-local indexes, shared-file retention and cache-only eviction detection.
`test/e2e/glide-packages.spec.ts` covers real worker rendering, inspection, offline
reload and service-worker regional downloads/removal/eviction.
`test/e2e/glide-raster.spec.ts` covers whole-range completion beyond the vertex and
block limits, original rings and holes, tier precedence, origin-based loading order, scoped ownership, world
copies, inspection, offline reload, moving ranges/cameras, track-up rotation on
phone/desktop viewports, cancelled inspections, combined limits/failures, retry
and source replacement. Dense map detail also retains its original holes and
completed blocks through zooming below the discovery cutoff and back. These verify software
behavior; landing suitability is not validated.

For repeatable worker CPU diagnostics, run
`node --import=tsx tools/benchmark-glide-landings.ts`. It uses 32 synthetic tier
grids and 768 detailed candidates, with holes and a 180-vertex range, and reports
five-run medians after one warm-up plus output digests. Network acquisition,
decoding, raster preparation, worker transport and map/GPU costs are excluded.
The original grids use legacy binary tiers. A separate published-format workload
uses four 256 × 256 × 3 numeric overviews at zoom 11, six measured runs after two
warm-ups, and injected reads. It reports composition, full progressive preparation,
unchanged views, small pans and revisits, including reads and image publications.
Camera admission timers are excluded from these CPU measurements.

The following measurements and browser results predate retained geographic
textures and their zoom pyramids. They document the earlier viewport-image design;
they do not establish performance or correctness of the current renderer.

A local Node 24.15.0 comparison on 2026-10-03 against `6689354`, with the same
fixture and unchanged output digests, measured these CPU changes:

| Workload | Before | After |
| --- | ---: | ---: |
| Heat composition, adjacent grids | 74.4 ms | 14.5 ms |
| Heat composition, overlapping grids | 93.1 ms | 22.0 ms |
| Heat composition, point corridor | 37.6 ms | 7.1 ms |
| Cold polygon selection/rendering | 162.7 ms | 90.9 ms |
| Cached polygons with a changed range | 143.2 ms | 92.2 ms |

The warm camera change remained about 1 ms, with no geometry upload or additional
file read. These synthetic measurements describe the sample and implementation
above, not device frame rates or real-feed loading times.

A local Node 24.15.0 comparison on 2026-10-04 against `07cdf45`, using the four-overview workload,
measured composition at **12.4 → 4.9 ms**, progressive preparation at
**23.9 → 14.3 ms**, and a small pan at **12.7 → 0.2 ms**. Small pans and immediate
revisits omitted the image upload; both versions read four grids. The unpadded
numeric image digest and the existing legacy/geometry digests were unchanged.
That padded-image implementation spent bounded extra preparation/storage to avoid
small-pan work. Both mobile and desktop used the same algorithm and resolution;
these CPU and upload reductions are not measurements of device battery life.

Focused rendering checks on 2026-10-04 used the Playwright 1.63.0 Noble container:
all 19 Chromium landing/detail/package cases passed, including phone and desktop
track-up workloads. The new small-pan upload check also passed in WebKit. Two
additional WebKit cache-restoration cases failed identically with this change and
with the original Glide code from `07cdf45`: restoring a legacy route reread its
source, and reloading packaged shading with data requests blocked did not restore
the image. Those persistence findings remain unresolved; this run does not establish
Safari offline readiness or physical-device power consumption.

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

The range worker calculates one request at a time. `GlidePlanner` discovers new
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

Ownship demand uses a **25 m displacement deadband**, measured from the last
accepted planning origin, so timestamp-only updates and small GPS drift do not
request worker or geometry-upload work. Disabled coverage ignores GPS updates.
The aircraft marker still uses the exact GPS fix.
Origin changes coalesce at 250 ms without canceling airport preparation. During
nearby movement, keep the completed ring at its calculated geographic origin until
the new result replaces it, without an intervening empty source upload. Retention
is limited to **0.1 NM from the published origin** and requires the new origin to be
on screen; larger jumps and changed off-screen origins clear it immediately.
Nearby late results may replace the retained ring while the newest origin queues;
status remains loading until the result matches the accepted origin. The retained
fallback ends when a completed request for the current origin returns `null`,
including when zoom prevents discovery: both the ring and its landing-detail mask
are cleared. A late null reply for an older origin cannot clear a newer range.
Repeated null replies do not submit another empty collection. The retained
ring is a previous planning result, not a terrain-clearance guarantee from the
moving aircraft's new position. Settings, source changes and GPS loss still clear
obsolete ranges immediately. The displacement limits bound drift; this does not
reduce GPS acquisition frequency or establish measured battery savings.

Nearby complete ownship ranges transition over **600 ms**, using **128 fixed radial
bearings** sampled from the displayed and new outlines. Retargeting resamples that
fixed mesh instead of accumulating bearings from earlier clipped frames, so
geometry complexity depends on the mesh and newest terrain footprint, not flight
duration or GPS frequency. Each intermediate shape is
intersected with the **new** terrain footprint: contractions appear immediately,
while newly reachable portions move smoothly outward. The line and fill share
that boundary. This interpolates completed results; it never translates an old
terrain shape to an uncalculated GPS position or extrapolates motion between fixes.
Unknown/open ranges, empty results and antimeridian-split geometry update directly
so animation cannot bridge a terrain gap. First acquisition and reduced-motion
mode also publish directly. Manual camera movement or hiding finishes a pending
transition; GPS loss, invalidation, disable and teardown cancel it.

Animation uploads are capped at **30 frames/second**, wait for both MapLibre
source updates before admitting another frame, and coalesce newer results while
the renderer is busy. Intermediate geometry uses the fixed mesh and latest terrain
mask and does no terrain work. Transitions stop at the exact new result, including
all its original detail, and leave no idle animation loop.

A rejected fill or outline stops interpolation and hides both ownship sources.
Recovery retains the complete calculated target, invalidates the peer upload and
retries that target once; it cannot recover an obsolete intermediate frame.

Each airport union carries a planner-generation/revision key. The map acknowledges
it only after both airport sources accept it; the worker then omits that unchanged
plan from later replies while retaining counts and independent origin results.
Failure, clearing and worker replacement revoke the acknowledgment. A completed
but discarded response cannot suppress an unpublished union. Each published
selected-point result must match its current origin; late results cannot
restore a moved or cleared point. Ownship results follow the bounded retention
policy above. Old forward-origin profiles are replaced within
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
range from an uncalculated origin that needs zooming in. Manual camera movement and
hiding cancel pending work but keep completed ranges and the idle worker/cache.
Automatic GPS-follow movement preserves in-flight terrain calculations and
reconciles viewport discovery after the movement, avoiding cancel/restart cycles
on every GPS fix. Completed geographic ranges do not depend on camera bearing.
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

GeoJSON ranges, airport coverage and landing vectors track source acceptance
separately from prepared geometry. A processing failure hides the affected source,
reports an error and retries its retained collection once after 100 ms. Later
camera settles or new prepared data can retry again. This recovery needs no new
terrain calculation or download. Empty updates hide immediately; teardown cancels
timers and invalidates late completions. Landing queries acknowledge their detail
key only after vector submission succeeds, so a failed upload cannot suppress
the replacement geometry. The current prepared receipt survives a retry that
finishes before the failed upload settles; that late failure cannot overwrite
the recovered status or acknowledgment. Image/raster acquisition retains its
existing policy.

Both range and landing admission retain demand when movement outlasts their
timers. Camera settle or map idle resumes that demand without another pan/zoom; idle events
after completion do not start queries. Failed, replaced or torn-down GeoJSON
uploads release their adapter's wait immediately, even if the old MapLibre promise
has not settled. Camera cancellation also releases a pending landing upload.
Ownship animation retires the failed/reset upload's backpressure independently of
its eventual settlement; a late completion cannot release a newer upload early
or keep later fixes stuck after recovery or remount. Recovery remains driven by
events and the existing bounded retry, with no background polling.

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

`test/glide-landing-map.test.ts` covers a source error whose retry succeeds before
the original upload settles, acknowledgment of the newest render key and teardown
with an upload still pending, independently valid heat during range changes,
canceled refreshes, failure cooldown and camera-idle recovery.
`test/glide-map.test.ts` covers ownship source recovery with unresolved uploads,
adapter remount and deferred range admission without repeated idle work.
`test/glide-landing-display.test.ts` checks heat publication before slow detail
and non-overlapping cached overview selection; `test/glide-packages.test.ts`
compares overview pixels after warming one versus multiple published resolutions.

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

`test/glide-animation.test.ts` checks intermediate motion, containment within the
new terrain footprint, immediate ridge cutbacks, incomplete/world-split bypasses,
upload backpressure, exact completion and cancellation without idle frames. A
minute of overlapping 400 ms updates checks bounded vertices, containment and
absence of periodic snapping when new results precede animation completion.

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
- **Airport indexing.** A spatial index over the navigation collection could avoid scanning every
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


### Review limits

Patch count is a rendering count, not independent emergency alternatives. Airport
infields, overlapping chunks and several fragments of one opening can inflate it.
The downloader's `review:glide` command reports union area, spatial groups, gap
samples and the Key West airport-vicinity / Bay pond-edge review contexts for
repeatable inspection. Its geographic proximity statistics are not terrain-aware
glide coverage. Source misclassification remains a review issue; never promise an
acceptable landing area in every tile.

Focused checks cover national manifests above 64 MiB with unchanged per-file
limits, dense-view partial loading, per-record inspection after union, hole and
longitude-wrap handling, reverse arrival altitude/elevation changes, route
intersection lengths, and map-menu selection with real workers.
