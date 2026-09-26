# Radar

The **Radar** tab follows **Progs** in the first slim toolbox row. Its independent
switch overlays current or historical reflectivity alongside other enabled weather.
The panel uses the same 12px status rows, 11px supporting text and bordered frame
summary as Progs, with a 32px slim switch and refresh action. National
coverage uses NOAA MRMS `MergedReflectivityQCComposite` (quality controlled,
0.01°/approximately 1 km, normally every two minutes). Regional views at MapLibre
zoom 7 or higher add intersecting FAA TDWR lowest-tilt scans (product 180/TZ0,
150 m range gates, approximately 1° azimuth, about 89 km range).

These are different observations: composite reflectivity includes returns aloft;
TDWR provides terminal detail near the ground. Neither supplies Doppler velocity,
wind-shear alerts, precipitation type or a forecast. Terminal range gates are not
150 m Cartesian pixels everywhere; beam width grows with distance. Coverage has
real gaps, and some terminal sources can be down or old. This implementation has
not been qualified against ForeFlight or for operational use. Automatic playback
and physical-device performance qualification remain future work.

## Preparation and display

`tools/weather-server/radar.ts` checks the NOAA MRMS public S3 bucket and 45 TDWR
`tgftp.nws.noaa.gov` latest-product files in the background. Two isolated Node
worker slots decode and contour changed scans; a 60-second deadline bounds each job.
National checks have one slot; terminal checks use the other and publish partial
results every five stations. A slow terminal cannot delay a fresh national scan.
History borrows the national slot only between live checks and is cancelled when
live work becomes due. S3 listings start at the rounded two-hour lookback boundary,
so the response stays bounded instead of growing with the whole UTC day.
Observation timestamps are checked before PNG/bzip2 decoding or contour generation.
Rejected byte hashes are remembered until the source changes; future timestamps
are reconsidered after a minute, and clock rollback clears these rejections.
Repeated identical station errors are logged only when their status changes.
The numerical MRMS GRIB2 reader supports the qualified regular latitude/longitude
grid, local discipline/category/parameter 209/10/0, observation time and PNG
packing 5.41. It verifies the dated object name against the GRIB timestamp. TDWR
validates WMO station/product identity, product description, bzip2 framing,
threshold table and packet 16 radial data. Missing/range-folded codes and missing
azimuth sectors stay missing. Unsupported formats fail visibly.

A qualified marching-squares implementation retains D3's interpolation at 5, 15,
25, 35, 45, 55, 65 and 75 dBZ. It indexes exterior bounds for hole assignment and
omits zero-area rings. National contours then remove straight-line redundancy and
simplify within **0.1 native cell** (0.001°, at most about 112 m). Each replacement
is checked against all thresholds, islands and holes: it cannot cross another
edge or sweep over another contour vertex. Rings are never dropped or merged.
The tolerance changes interpolated edges slightly; it does not resample the
mosaic, discard small echoes or infer new reflectivity. This reduction happens
once on the server. Publication marker `noaa-radar-contours-v2` prevents reuse of
older prepared geometry after an upgrade.

National positions use the source cell centers. Terminal contours use
source radial bearings and 150 m range gates, projected onto a sphere of mean
Earth radius 6,371.0088 km. No intensity is inferred from a colored image. Coordinates
round to five decimal places. Native detail remains bounded by the source grid
or beam; smooth outlines add no new observations. The map draws all source
contours in increasing reflectivity order, so terminal echoes cannot cover a
stronger national contour. Contours are translucent and overlap; legend colors
represent thresholds, not an exact pixel-color readout. Values below 5 dBZ are not
shown. Empty space does not establish radar coverage or absence of weather.

The national overlay appears at all zooms. Only intersecting terminal files load
at regional zoom, through core's whole-file cache. Intersection uses the visible
world copy, so panning through ±180° does not drop terminal detail or reload
unchanged scans. The controller owns demand;
map movement changes the selected prepared files without upstream requests.
National and terminal geometry use separate sources. Eight interleaved threshold
layers per source preserve stronger-echo priority across both sources; changing
terminal coverage does not re-index the national composite. The renderer submits
each polygon as a separate feature, retaining its complete rings/holes, threshold
and prepared vertices. This lets MapLibre's tile index reject off-tile polygons
early instead of repeatedly clipping a national-size MultiPolygon. Fill sources
use an 8px tile buffer for edge antialiasing instead of the general 128px default;
their existing 0.2px simplification tolerance is unchanged. Neither change reduces
the prepared contour detail or changes the stored file format.

Switching to another scan still reads and validates its saved JSON, transfers its
geometry to the map worker and prepares visible tiles. Persistent file caching
avoids a download, not those render costs. Decoded memory retains only the selected
scans; there is no retained history of indexed map sources or GPU buffers.
File reads/validation use two core admission slots, and validated files reach the renderer before
optional cache publication finishes.
Within weather, radar draws above all advisory and grid layers, directly below
Progs, preserving fronts, pressure centers, isobars and chart labels above echoes.
The insertion point is resolved when radar first appears, so loading order and
style recovery cannot reverse that priority.
Selecting a past timeline stop shows the most recent national and terminal scans
at or before that instant. A scan must be less than 15 minutes before the selected
time, and inside the rolling two-hour window relative to the actual clock. Missing
history remains unavailable; current terminal scans never fill older coverage.
Changing to a different scan hides the old-time geometry until the new source
update completes, without first submitting an empty source. The national scan
can appear while terminal detail is still loading. Selecting another timeline stop
that resolves to the same scans leaves them visible. A first uncached history
selection can still show a loading gap. Source errors clear the affected rendering
status and retry recreates failed resources; “Shown” follows source acceptance.
Future selections clear radar; **Now** follows current observations, expiring each
scan at 15 minutes old. “Now” also updates on
source publication and app resume, so a suspended phone cannot retain an expired
image under a current heading. Source failures, old catalogs, rendering/file errors
and individual observation times remain visible. Refresh retries both acquisition
and drawing; a successful catalog refresh retries failed files automatically.

## History and timeline

The server retains one stable observation per station per five-minute bucket,
plus the latest scan. National history backfills from dated MRMS S3 objects in the
current and, across UTC midnight, previous day's folders. Between live checks, an
idle-slot batch prepares at most eight missing historical national buckets. A due
live check preempts that batch. Initial history grows over the first few checks; no
viewer query starts backfill. Terminal history accumulates from incoming live scans.
The panel reports the actual available history range and each selected source time.

Only national scan times add historical stops. Prev/Next and the slider traverse
history, **Now**, then enabled forecast products. The past section uses 11px per
five minutes, with five-minute ticks and half-hour labels; the forecast section
retains 11px per hour and its existing hourly ticks. Both sections share one
scrollable scale and one absolute selection. Historical selections are labeled
**History**. Refresh and tab changes preserve their absolute time while retained
coverage remains; unsupported gaps show no radar. Rewind loads only the selected
national file and intersecting terminal files, not the full archive.

## Storm motion

The optional **Storm motion** slim switch defaults off. NOAA NEXRAD Level III
Storm Tracking Information (STI, product 58) supplies the projected cell tracks.
White arrows and dots appear above reflectivity and below Progs; at regional zoom,
labels identify the radar/cell and forecast lead minutes. These are NOAA's supplied
positions, not motion estimated from our contours. The interval is read from each
product's adaptation data (normally 15 minutes), rather than hard-coded. New or
stationary cells without a forecast track produce no movement arrow. Nearby radars
can identify the same storm independently; their station/cell IDs remain distinct.
Tracks are guidance, not predicted reflectivity or Doppler wind velocity. Tracking
can miss cells and is less reliable for merging or nonlinearly moving storms.

`radar-motion.ts` independently collects CONUS `Kxxx` products from NOAA's bounded
`DS.58sti` directory listing, cached for a day. One sequential collector shares the
radar upstream admission queue. It publishes partial results every 25 stations and
waits two minutes between rounds; a motion station cannot occupy either reflectivity
worker. Raw products are capped at 512 KiB. The decoder validates WMO station/product,
message length, block boundaries, observation time and geographic coverage. It reads
packet 15 IDs and packet 24/6 forecast vectors in native quarter-km coordinates,
projects them from the radar location, and reads the forecast interval from the
tabular block. Empty-cell products and stationary circles are supported; incompatible
formats fail visibly through unavailable-source status. Invalid unchanged hashes
skip parsing, while valid unchanged scans reuse their decoded geometry.

National motion snapshots retain individual station times and source URL/hash.
History accumulates as observations arrive; there is no startup backfill. One stable
snapshot per five-minute bucket plus the latest is retained for two hours (at most
26 files). Snapshot `availableAt` is collection time, not observation time. Rewind
selects a collection available at or before the requested time. Every displayed
scan must also be at or before the displayed national composite and less than 15
minutes older, within the rolling two-hour window. Current motion never fills a
historical gap. Motion hides while national radar is unavailable or still drawing.
The panel distinguishes unavailable motion from valid reports with zero tracks and
reports source coverage, scan times and acquisition/render errors.

Motion HTTP requests only stream prepared files; they cannot initiate acquisition.
The small catalog is `/api/weather/radar/motion/latest.json` (≤32 KiB); immutable
snapshots are `/api/weather/radar/motion/<sha256>.json` (≤4 MiB). The shared disk
budget includes both encodings. History gets at most 1/64 of the server budget,
capped at 64 MiB, with the latest snapshot retained even if it exceeds that allowance.
Current/building files and six minutes of preceding catalogs are protected. Restart
restores the latest decoded scans without upstream reads. The browser uses core's
whole-file cache (24 files/16 MiB, one hour unused, in its own retention category),
authenticates each digest, and loads one selected national snapshot. One native
GeoJSON source and five layers draw all tracks without per-cell DOM markers.

## API, identity and caching

- `/api/weather/radar/latest.json`: schema version 1, last preparation check,
  latest immutable scan references, unavailable station IDs, and an optional
  backward-compatible `history` array (at most 1,200 references, catalog ≤1 MiB).
- `/api/weather/radar/<CONUS|Txxx>/<observedAt>-<sha256>.json`: bounded prepared
  GeoJSON with source URL/hash, scan time, coverage bounds and dBZ contours.
- [Shared guards](../../../../packages/contracts/src/radar-weather.ts) reject
  mismatched paths/stations, invalid geometry and oversized artifacts. The client
  also authenticates the complete file digest and scan identity.

HTTP only reads prepared data; queries, zoom and additional viewers cannot launch
source acquisition or contour conversion. An unchanged raw digest reuses its
existing prepared file, including after restart. The current catalog publishes
atomically after processing, requires a national scan, and tolerates independent
terminal failures. It identifies failed source checks even when a still-valid
saved scan remains usable. National checks are due every 60 seconds independently of terminal rounds; failed
national preparation retries after 30 seconds. Terminal rounds wait 60 seconds
after completion before repeating. Source checks share a two-request,
250 ms spacing queue with overload backoff.

The shared weather-server disk ceiling includes radar. History uses at most one
quarter of the configured disk ceiling, capped at 1 GiB, counting both saved HTTP
encodings. National history receives
priority; newer terminal samples use the remaining allowance. Small budgets and
source gaps can shorten coverage. Current/building files, published history and six
minutes of preceding catalogs are protected against eviction. Pruning removes
expired references atomically; restart restores retained history without converting
unchanged scans again. Disposable files may remain for up to 24 hours server-side;
the two-hour history window and 15-minute observation age are independent limits.
Browser browsing storage caps radar at 24 files/64 MiB, 16 MiB per file and one
hour unused, in its own retention category. Forecast altitude changes and
disposable grid inputs cannot evict radar files. Browser quota can still prevent
saves; radar's own older scans remain subject to LRU/age cleanup. The
[AWC budget table](../grids/README.md#time-recovery-and-budgets) owns the combined
ceilings. A small endpoint-scoped
catalog lives in the plugin storage slot. Optional saves never delay publication of usable live
data to the map. Denied radar or storm-motion catalog writes do not turn a valid
live refresh into an acquisition error. Regional chart downloads do not guarantee radar availability offline.

## Source references and verification

- [NOAA MRMS product table](https://www.nssl.noaa.gov/projects/mrms/operational/tables.php)
- [NOAA SPG product specification](https://www.roc.noaa.gov/public-documents/icds/2620070C_ICD_for_the_TDWR_SPG_Product_Specification_Bld_11.pdf), section 1
- [NOAA SPG Class 1 interface](https://www.roc.noaa.gov/public-documents/icds/2620063E_SPG_to_AWIPS_Class_1_User_ICD_Bld_12.pdf), packet 16 and compression
- [NOAA radar collection service](https://www.weather.gov/tg/rpccds)
- [NOAA RPG/Class 1 ICD, product 58 and packets 15/24/6](https://www.roc.noaa.gov/public-documents/icds/2620001AD.pdf)
- [NOAA product specification, section 18 and Appendix A](https://www.roc.noaa.gov/public-documents/icds/2620003AE.pdf)
- [D3 contours](https://d3js.org/d3-contour/contour)

`test/weather-radar.test.ts` uses captured MRMS and TDWR bytes, independently
checked GDAL values/geometry and Python bzip2/struct radial samples. It covers
partial sweeps, source identity, expiration/clock rollback, prepared-only HTTP,
unchanged scan reuse, history backfill, byte/window retention, mixed timeline
coordinates, failure isolation and disk restoration. Browser regressions
exercise combined and historical rendering, wrapped terminal coverage without
new file requests, source-free browser requests, style recovery, saved catalog/file
restoration after a full app reload with the origin disconnected, forecast
hiding/expiration and six slim tabs at phone sizes.
[Fixture provenance](../../../../test/fixtures/radar/README.md) records the captures.
The [September 25 rendering measurement](validation/2026-09-25-rendering.md)
records the native geometry size, before/after timings and remaining costs; it is
desktop evidence, not a physical-device qualification.
The [server contour reduction measurement](validation/2026-09-25-contours.md)
records the subsequent bounded simplification and its processing/rendering costs.

`test/weather-radar-motion.test.ts` adds captured STI decoding, empty/new-cell
handling, identity rejection, historical alignment, unchanged publication and
restoration cases. These cases belong to the regular Node suite; their presence
does not establish a current pass. The browser suite covers reflectivity, history
and layer ordering; storm-motion browser rendering and physical-device qualification
remain separate coverage gaps.
