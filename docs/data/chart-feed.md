# FAA chart-feed contract

[Documentation](../README.md) / Data

`faa-regs` builds the chart artifacts published at `charts.tedyin.com`. ZLayer reads
the publisher-owned manifests for the selected FAA effective date. It discovers dates
from `cycles.json` beside the dated folders; chart bounds and file identities
come from each edition's validated manifests.

## Contents

- [Date discovery and selection](#date-discovery-and-selection)
- [Spatial/zoom package manifest](#spatialzoom-package-manifest)
- [Legacy sheet manifest](#legacy-sheet-manifest)
- [Identity and caching](#identity-and-caching)
- [Publication and transport rules](#publication-and-transport-rules)

## Date discovery and selection

The default **Latest** mode fetches `https://charts.tedyin.com/charts/cycles.json`
(or `<configured-root>/cycles.json`) without caching on launch and chooses the newest supported date
with usable chart metadata. Partial new uploads without a valid chart manifest are
skipped. Dates at or before `2026-07-09` are excluded: that release predates the
ZLayer feeds and the faa-regs reorganization.

The index has `schemaVersion: 1`, a `generatedAt` timestamp, and a `cycles` array
of ISO calendar dates. Invalid dates or an unsupported schema reject the index;
supported dates are deduplicated and sorted newest first. FAA-regs generates it
after `npm run build:charts`, or separately with `npm run build:chart-cycles`.
Publish dated artifacts before this index and serve it with revalidation.

The cycle menu includes published dates and locally saved catalogs. Older published
editions load their manifests on selection; discovery does not fetch every edition's
archives or reference data. A date selection persists until changed; selecting
**Latest** restores automatic discovery on subsequent launches. Existing persisted
date choices remain pinned. A blank or `latest` `VITE_ZLAYERS_CHART_REVISION` uses
Latest; an explicit supported date sets the initial preference only.

The validated cycle list and catalogs are stored separately per feed root.
Cached catalogs appear before network revalidation and remain usable offline.
A failed selection keeps the active catalog; a late response from an abandoned
selection cannot change it. Every manifest is validated against the requested date
before entering the reference cache. Failed refreshes, including invalid new
manifests, retain the last valid cached manifest or the saved catalog's same-date
products, never navigation/procedures from another edition. When the saved catalog
supplies charts after a refresh failure, the notice identifies the saved edition.
Committed regional snapshots can also open the workspace independently when the
browsing catalog and discovery metadata are unavailable; see
[offline startup](../features/offline-storage.md#browsing-and-saved-editions).

Date discovery requires a readable `cycles.json`, including CORS when using a
cross-origin root. The existing production `/chart-data/` alias serves this file
without enabling directory listing. Copying frontend assets alone does not publish
the FAA-regs index.

## Spatial/zoom package manifest

The preferred feed is:

```text
https://charts.tedyin.com/charts/<effective-date>/mbtiles/manifest.json
```

Schema version 2, packaging version 1, keeps the source `charts` records below for
coverage and provenance, and adds `maximumArchiveBytes`, `archives`, and `regions`.
Delivery archive filenames are relative to `mbtiles/`. Source chart records describe
build inputs kept locally in faa-regs' `dist/mbtiles/<effective-date>/`; they are not
published or downloaded in package mode. Older nested package feeds remain supported.

Each archive has:

| Field | Meaning |
| --- | --- |
| `id` | `<kind>-z<zoom>-r<depth>-<x>-<y>` |
| `kind`, `zoom` | One chart family and one stored zoom |
| `root` | `{z, x, y}` geographic quadtree cell; depth is between `max(0, zoom-3)` and `zoom` |
| `bounds` | Exact Web Mercator root-cell bounds as longitude/latitude |
| `tileMask` | Hexadecimal bit mask of indexed tiles within that root, row-major XYZ order |
| `file` | `<id>-<sha256>.mbtiles` |
| `byteLength`, `sha256` | Complete-file identity, including SQLite overhead |

The builder stitches overlapping sheets in stable sheet-ID order before splitting
the output. Initial blocks contain at most 8×8 tiles; blocks over the 4 MiB budget
subdivide spatially. The root depth records that adaptive split. Sparse tile masks
let the client reject absent cells without downloading files. Transparent cells inside
source bounds are indexed explicitly to prevent incorrect coarser-level fallbacks.
Lower overviews extend to zoom 0. A sheet's native maximum is retained; the client
selects a coarser package where no finer source coverage exists, then resamples locally.

Regions contain `id`, `title`, `bounds` (an array of rectangles), and `archiveIds`.
Every archive intersecting those bounds at every zoom and for every family must be
listed. Dateline regions use separate rectangles on either side. Default regions
are FAA chart footprints; custom publisher definitions can represent states, trip
areas, or other named regions. Physical packages are shared across regions, not
duplicated. Settings uses `chartRegionPlans` with client-defined state/territory
envelopes against these archives, always adding navigation and applicable
plate/supplement books. Completeness requires every exact verified file identity
and validated reference document, not just tiles already viewed.
See [offline storage](../features/offline-storage.md); an index alone does not make a region
available offline.

Readable invalid indexes, overlapping quadtree roots, incorrect bounds, oversized
files, and incomplete region dependency lists are rejected. Missing flat package manifests
fall back to `mbtiles/packages/manifest.json`, then the sheet feeds below. Package mode
uses one MapLibre layer per family.

## Legacy sheet manifest

The sheet manifest URL is:

```text
https://charts.tedyin.com/charts/<effective-date>/mbtiles/chart-manifest.json
```

Archive filenames are relative to the manifest's directory. For older published
cycles, the client falls back to `<effective-date>/chart-manifest.json` when the nested
manifest returns 404/410 or cannot be fetched (legacy hosts omit CORS headers on 404s;
offline clients may also have only the old manifest cached). The fallback must pass the
same schema and cycle checks. Invalid manifests, readable server errors, and cancellation
do not trigger fallback. Navigation and procedures keep their existing paths.

Schema version 1 has this shape (hashes abbreviated here only):

```json
{
  "schemaVersion": 1,
  "effectiveDate": "2026-09-03",
  "generatedAt": "2026-09-15T04:00:15.719Z",
  "charts": [
    {
      "id": "vfr-sectional-san_francisco",
      "title": "Sectional · San Francisco",
      "kind": "vfr-sectional",
      "file": "vfr-sectional-san_francisco.mbtiles",
      "bounds": [-124.9799519, 36.0134553, -117.6799031, 40.2498947],
      "minZoom": 5,
      "maxZoom": 12,
      "byteLength": 132173824,
      "sha256": "00817bd5...",
      "sourceByteLength": 79738153,
      "sourceSha256": "958a0fe1...",
      "tilerVersion": 1,
      "buildConfigurationSha256": "e1f2b892...",
      "cutlineProvenance": "N129BZ/chartmaker@1d71db4"
    }
  ]
}
```

ZLayer requires each chart's ID, title, kind, file, bounds, zoom limits, byte length,
SHA-256, and cutline provenance. Source and builder fields are publisher audit data and
may grow without changing this schema. Current chart kinds are `vfr-sectional`,
`vfr-terminal`, `vfr-flyway`, and `ifr-low`. Partial regional coverage is valid. All
published sheets are available without a client allowlist; loading a dated catalog fetches
only manifests, not archives. The chart/navigation/procedure paths require three
requests for flat packages, four for nested packages, five for nested sheets, or six
for flat legacy sheets. Discovery also probes the optional feed-wide
`terrain/manifest.json`; its versioned packages are independent of the FAA cycle.
The obstruction layer separately loads `obstacles/manifest.json` on demand. Reloading revalidates the chart manifest,
including HTTP caches, so manual same-cycle uploads become discoverable immediately.

Zoom limits describe the archive, not when a selected chart should disappear.
Publishers must read bounds and zoom limits from the generated MBTiles: corner-only
bounds exclude curved IFR edges, and chart-family defaults misstate native zooms.
ZLayer reads both ends of the archive's tile index once. It composes lower overviews
and crops/rescales the highest stored tile when an older manifest requests a zoom
above the actual maximum. Missing tiles within the native range remain transparent.
All resampling uses the existing whole-file cache. Publishers should still prebuild
low-zoom overviews to minimize client work.

## Identity and caching

The consumer derives an archive URL containing the published identity:

```text
.../mbtiles/vfr-sectional-san_francisco.mbtiles?sha256=<hash>&bytes=132173824
```

The service worker uses that complete URL as the persistent cache key. It downloads the
whole MBTiles file once, verifies its byte length and SHA-256, and only then publishes
the entry. Small files use complete Cache Storage responses; large files live in
origin-private file storage with small Cache Storage receipts. See the
[storage contract](../features/offline-storage.md#stored-files) for write bounds and receipt lifetimes.
Small packages use a full-file GET through this cache, then one reusable
SQLite worker extracts all their compressed tile bytes in one pass and closes the
database. Native tile reads subsequently require no SQLite query or worker round trip.
Legacy SQLite HEAD and Range requests are served by slicing the verified local `Blob`;
they must never become one origin request per tile or database page.
Only visible chart bases/overlays initiate spatial/zoom package reads; legacy sheets
are gated by viewport bounds. Four small files can download concurrently; files larger
than 4 MiB consume two slots each, limiting large legacy downloads to two. Cached-file
reads bypass this queue. The fast reader retains at most 16 complete packages of at
most 4 MiB each (64 MiB compressed contents, excluding transient decoding/WASM buffers).
It copies returned tile bytes so MapLibre transfers cannot detach the cached originals.
Larger custom packages and legacy sheets retain the six-reader paged SQLite pool;
idle workers are terminated on eviction. Neither reader eviction nor package-memory
eviction deletes the corresponding verified file from persistent storage. Disk persistence
remains subject to browser storage quota/eviction; on-demand caching is not an
explicitly verified offline-region download.

Legacy sheet filenames may be overwritten during manual testing because the client
rejects bytes that do not match the manifest identity. Package filenames are immutable
and content-addressed. Upload all referenced archives before replacing either manifest,
so clients never observe an index whose bytes are not yet available. Keep old package
files for open clients and saved regions; do not mirror with blanket deletion.

## Publication and transport rules

1. Build sheet MBTiles and verified receipts in the local `dist/mbtiles/<date>/` cache.
2. Generate that cache directory's `chart-manifest.json` from the receipts.
3. Run `npm run build:chart-packages` to produce `dist/charts/<date>/mbtiles/` (already included
   in `npm run build:charts`). This verifies inputs but does not rerender source TIFFs.
4. Upload package archives before `mbtiles/manifest.json`. The entire `charts/` tree
   excludes intermediate MBTiles; do not upload the sibling `dist/mbtiles/` build cache.
5. Keep at least one prior effective-date directory and old hashed packages for rollback.
6. Serve deployed cross-origin GET requests with CORS enabled. HEAD and Range requests
   are handled locally after the initial whole-file download.

For an already completed older build, `npm run build:chart-manifests` in faa-regs
migrates sheets out of the publish tree and flattens existing delivery packages without
changing their bytes. Do this locally after builders finish. New URLs use the flat
path; existing hosted old paths can remain for older clients. Moving files locally is
not permission to delete previously published files with an upload sync's delete option.

Source chart bounds describe the rectangular extent of the applied cutline; package
bounds describe a storage-grid cell. Neither replaces the actual transparent cutline
mask. Within supported schema/packaging versions, additional chart kinds are
additive. The client excludes explicitly unsupported families (currently including
`ifr-high`) from chart records, archives and references to those archives in regions.
It still validates all supported records, unique archive identities, region dependency
completeness and unknown/dangling references. Records without an identifiable family
are invalid; a feed with no supported charts cannot become the browsing edition.
The original response remains cached, and the supported subset is derived and
validated on both network and offline reads. Incompatible schemas or packaging
still require coordinated publisher and consumer changes. Previously deployed
clients with stricter family guards require a compatible feed until updated.

### Navigation rebuilds within a cycle

Navigation and airway URLs include the navigation manifest's `generatedAt` value as
`?v=...`. Rebuilding a cycle gives its data a new cache key, so newly added runway
fields cannot be hidden by an earlier cached airport file. The application checks
manifests against the network on reload. The page's validated loader owns navigation
manifest revalidation and offline fallback; the service worker passes those requests
through even when browser settings override their cache mode. Versioned navigation
exports remain in the shared durable cache for ordinary map movement and offline use.

Publish the rebuilt navigation data files before `nav/manifest.json`. A page reload
then discovers the new export. Publishing only the frontend cannot add fields that
are absent from the data feed.

### Optional magnetic model

The AHRS HSI looks for a `magnetic-model` product in the browsing cycle's
`nav/manifest.json`. Its `file` is relative to `nav/`; the request uses the same
`?v=<generatedAt>` versioning as other navigation exports. The loader checks the
document's `effectiveDate` against the requested cycle and its coefficient count
against the manifest. A missing or invalid model leaves the HSI in true-north mode.

The current `ZLayerMagneticModel` schema version 1 requires WMM2025's 90 coefficient
rows through degree 12, WGS84 ellipsoid heights, Schmidt semi-normalization, and
east-positive declination. Coefficients use nT and annual changes use nT/year; model
validity runs from 2025-01-01 up to, but excluding, 2030-01-01. This interval is
independent of the FAA export cycle. The validated JSON is cached on access, but
regional downloads do not include it. See [AHRS magnetic references](../../src/layers/ahrs/README.md#compact-hsi)
for evaluation, heading gates and fallback behavior.
