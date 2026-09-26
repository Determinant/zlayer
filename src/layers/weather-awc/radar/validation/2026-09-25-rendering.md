# Radar rendering measurement, September 25, 2026

[Radar guide](../README.md) / Historical validation

These measurements compare the renderer immediately before and after splitting
contour MultiPolygons into individual Polygon features and reducing the GeoJSON
source buffer from 128px to 8px. They are local desktop evidence, not mobile
performance budgets or proof that a later tree passes.

## Sample

The shared weather endpoint supplied the CONUS MRMS observation at
2026-09-25 16:34:40Z:

- Prepared SHA-256: `fb18f1b0140fdecd2ec1c22d1e93a027b68034dd1ecfd2744e1d6600178bc9c9`.
- Source SHA-256: `269d29aa469c9933065d3010f7f7252d2d0b76ed166142b499e33c34bbefae9c`.
- Decoded JSON: 10,578,811 bytes (10.09 MiB).
- Eight threshold features containing 16,379 polygons, 28,604 rings and
  564,770 coordinate positions, including ring closures.

The smooth contour appearance does not imply a small vertex count. Empty higher
thresholds also do not make the lower thresholds inexpensive.

## Browser result

Headless Chromium from `mcr.microsoft.com/playwright:v1.63.0-noble`, Node 24.20,
MapLibre 6.9.0, Vite development fixture, 1280×900 viewport, device scale 1,
center [-96, 38]. Three submissions per variant/zoom, alternating original then
changed. Both variants used the same in-memory scan, eight threshold fill layers,
0.75 opacity, antialiasing and 0.2px simplification tolerance.

| Zoom | Original source accepted, ms | Changed source accepted, ms | Original map idle, ms | Changed map idle, ms |
| --- | --- | --- | --- | --- |
| 4 | 943, 919, 905 | 406, 432, 437 | 1166, 1078, 1051 | 525, 531, 533 |
| 7 | 940, 932, 890 | 402, 426, 413 | 1067, 1051, 1017 | 450, 467, 467 |

Median submission-to-idle improved from 1078 to 531ms at zoom 4 and 1051 to
467ms at zoom 7. These intervals include worker serialization, transfer, indexing
and visible-tile preparation/rendering. They exclude acquisition, Cache Storage
reads, checksum/schema validation and JSON parsing. They are not end-to-end
timeline-switch measurements, nor isolated GPU timings.

A separate image comparison at the same cameras changed 784 of 1,152,000 pixels
at zoom 4 (0.068%) and 133 at zoom 7 (0.012%). Differences included isolated
rasterization pixels and a horizontal line present only in the original zoom-4
image. Visual inspection found no new tile-edge seams. Input geometry is exactly
preserved; the captured TDWR regression checks every threshold, ring and hole.

## Reproduction and remaining work

Serve `/test/browser/weather-progs.html` through Vite, disable its weather
controller, and load a prepared national scan into memory. For each camera above,
add a temporary GeoJSON source and eight filtered fill layers, wait for map idle,
then time `await source.setData(data)` and the next map idle. Remove the layers
and source between submissions. Compare the original scan's MultiPolygon
features/default buffer against `radarFeatures([scan])` and `buffer: 8`.
Capture the canvas on a render event after idle for the pixel comparison. The
captured MRMS input under `test/fixtures/radar/` can produce another reproducible
scan through `prepareRadar`; its geometry and timings will differ from this live
sample. Retained live history is temporary, so the sample above is identified by
hash rather than assumed to remain downloadable.

The current decoded-memory policy retains selected scans only. Returning to a
saved time repeats parsing, validation and worker transfer/indexing; file caching
only removes the download. More history in decoded/indexed memory would cost
substantial RAM, especially on phones. Further work should measure these remaining
stages and consider preparing spatial render data once on the server. This change
introduces neither additional history memory nor server-format migration.
