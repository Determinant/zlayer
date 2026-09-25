# Cloud, freezing, icing and wind forecasts

[AWC Weather](../README.md) / Numeric forecast grids

The plugin displays one shaded field plus independently enabled wind barbs and
advisories. Cloud bundles contain coverage, base, top and both freezing diagnostics;
icing bundles contain probability, severity and SLD at one native altitude.
The icing slider selects actual manifest levels, including gaps, and never invents
intermediate heights. Unavailable saved heights remain explicit until changed.
Positive SLD can add a red hatch to probability/severity. Opacity defaults to 70%.
The [plugin guide](../README.md#display-and-selection) owns toolbox and inspection
behavior; the [winds guide](winds.md) owns vertical interpolation and barbs.

Inspect values from the numeric bundle, never from colors. Every covered point is
inspectable, including unshaded cells; wrapped longitudes use the canonical domain.
Cloud inspection shows all five diagnostics, icing all three at its selected
altitude, and enabled winds their components/temperature/height. Base/top do not
imply a full vertical cloud profile.

## Source meaning and limits

The source is NOAA model guidance used by aviation weather products. It is not a
pixel-for-pixel copy of AWC GFA. Initial coverage is CONUS.

| Field | Qualified encoding / displayed meaning |
| --- | --- |
| HRRR TCDC, entire atmosphere | Percent total-column cloud coverage, including clouds above FL180 |
| HRRR HGT, cloud base / top | Lowest/highest diagnosed cloud heights, geopotential metres converted to feet MSL; cloud base is not a ceiling |
| HRRR HGT, 0°C isotherm | Lowest freezing diagnostic; the bottom-up diagnostic may return the model surface when the lowest levels are below freezing |
| HRRR HGT, highest tropospheric freezing level | Highest freezing diagnostic, identified separately by surface 204; do not infer a complete set of intermediate crossings |
| IFI 0/19/233, local table 1 | Icing probability, source fraction ×100 to percent |
| IFI 0/19/37 | Severity 0/1/2/3/4 = none/trace/light/moderate/severe |
| IFI 0/19/217, local table 1 | SLD potential index 0–1, not a probability; negative values remain **unknown**, never zero |

The [NOAA diagnostic guide](https://rapidrefresh.noaa.gov/RAP_var_diagnosis.html)
describes the cloud and freezing diagnostics. The [HRRR inventory](https://www.nco.ncep.noaa.gov/pmb/products/hrrr/hrrr.t00z.wrfsfcf00.grib2.shtml)
identifies their surfaces. The [FIP2 product description](https://nsdesk.servicenowservices.com/api/g_noa/nwspc/res2/dc3cf44f47f8f290f6550c03e16d43d0)
describes SLD potential, and [NCEP severity table 4.228](https://www.nco.ncep.noaa.gov/pmb/docs/grib2/grib2_doc/grib2_table4-228.shtml)
defines categories. The server's GRIB decoder validates IFI's NCEP/AWC center, subcenter and
local-table identity, including numeric fields, rather than relying on decoder mnemonics.

IFI levels are derived from validated records, currently 500–30,000 ft MSL in
500-ft steps. This differs from some written product notices; the UI uses actual
published levels. Heights are MSL model levels, not pressure flight levels.
Same-cycle HRRR surface height provides an explicit below-terrain mask, only when
its geometry exactly matches IFI. Source bitmaps are preserved independently.
Severity is unavailable wherever the probability bitmap is unavailable: an
unmasked severity zero alone cannot establish no icing. Reserved categories and
negative SLD retain unknown state. A masked cloud-height diagnostic is shown as
**No cloud base diagnosed** or **No cloud top diagnosed**, rather than a data
availability error: NOAA documents absent cloud layers as undefined heights.
These labels describe each diagnostic independently, including when cloud coverage
has its own valid value; they do not replace total-column coverage with a clear-sky
claim. A numeric zero SLD value is **No SLD forecast (0.00)**; negative/unmapped
SLD is **SLD undetermined**. Both remain unshaded. Failed acquisition, missing icing
samples, outside coverage and below-terrain levels keep their separate statuses.

Unresolved source questions are the meaning of negative SLD, operational
freezing-diagnostic mapping and late-hour IFI input lineage. Sampled raw F017/F018
fields differed from F016; that does not prove independent driving-model guidance
at every lead. Decode each supplied lead with its actual time. Probability/SLD
masks can change over time, so they are not substitutes for terrain masks.
Retained [source samples](../validation/2026-09-22-grib.json) and
[vertical/horizon samples](../validation/2026-09-22-ifi-horizon.json) are dated evidence,
not full-cycle qualification. Independent operational depiction comparisons and
physical-device/flight qualification remain outstanding.

## Browser source and cache contract

The default endpoints are `/api/weather/grids/{clouds,icing,winds}.json`. The
[weather server](../../../../tools/weather-server/README.md#source-and-cache-contract)
owns complete-cycle discovery, pinned acquisition, projection and native-field
preparation. Catalogs describe complete prepared generations. Background updates retain the
previous catalog until every replacement artifact is saved; HTTP reads never start
preparation. The PWA has no server-readiness protocol or partial-catalog state.

Native artifacts use
`<product>/<run>-<lead>-<level>-<identity>.zwp.gz`; pressure levels use `p<hPa>`.
Identity is SHA-256 of `gridKey`: converter, model, run, valid time, native level,
source paths/index digests/ranges and output geometry. Check timestamps are excluded.
The server rejects changed source identities with 409 rather than substituting a
new cycle. The PWA checks artifact identity, compressed-byte SHA-256, format and
numeric bounds. The 4096 m projected geometry is canonical across JS engines;
saved catalogs with last-bit coordinate rounding remain readable.

The browser receives prepared bands, not raw GRIB. Its worker inflates and validates
them, transferring buffers for rendering and point inspection. Wind altitude
interpolation runs in the PWA. It uses same-run model terrain at
`winds/<run>-terrain-<identity>.zwt.gz`, whose identity includes converter, run,
geometry and terrain record. Terrain gzip contains a 168-byte v1 header with the
162-character source-grid signature and padding, followed by Float32 metres.
Validate exact size, signature and bounds; NaN preserves missing/outside terrain.

`packed.ts` owns `ZAWCPACK` v1: a 16-byte header (version, width, height, band count)
and 12-byte descriptors (field ID, encoding, offset, length), with four-byte-aligned
little-endian bands. Percent/severity use uint8, SLD hundredths, heights int16 tens
of feet, and wind/temperature int16 tenths. Four codes distinguish missing,
below-ground, unknown and outside coverage. Packing requires exact Float32
round-trips; other bands remain Float32, including unrounded interpolated winds.
Reading checks descriptors, bounds, exact length and every value. Main-thread
sampling reads compact bands without reconstructing a float bundle. Each frame's
bands inflate together; independent field reads are not implemented.

Core `files().deriveResult()` owns request sharing, cross-window locks, integrity
receipts, corruption repair and optional saving. Existing source-addressed URLs
and `packed-v1/` keys remain cache identities, not live proxy routes. Older Float32
artifacts migrate after bounded authenticated reads and numeric validation; remove
old bytes only after successful replacement. Pre-Google native catalogs require an
online refresh because index/range mirror identity must agree. Local checksums
establish saved-byte integrity, not an upstream GRIB checksum absent from indexes.

Validated data becomes display-ready before optional encoding/storage completes.
The scalar worker is reused, terminating on cancellation/error or after 30 seconds
idle. A separately admitted wind job owns its worker until completion/cancellation;
its input waits leave scalar acquisition available. Worker numeric calls share one
CPU slot. Completed inflation releases its reader without awaiting cancellation of
an already closed stream, avoiding a WebKit stall.

## Published contract

This earlier preconverted-feed format remains supported for archived data and
fixtures when `VITE_ZLAYERS_AWC_GRID_URL` is explicitly set. It is not the default
production path and does not impose a server-publisher requirement.

`packages/contracts/src/awc-grids.ts` owns version 1 runtime validation.
`clouds.json`, `icing.json` and `winds.json` each describe one independently published generation:
model, reference time, upstream check time, publication time, exact fields,
Web Mercator grid, and immutable frame descriptors. All instants are UTC epoch
milliseconds. Each descriptor carries valid time, optional native altitude,
compressed/decoded byte lengths, SHA-256 and original source URLs.

Files live at `runs/<generation>/<frame>.zwg.gz`. Gzip is **file encoding**, not
HTTP `Content-Encoding`. After decompression the header is 16 bytes: ASCII
`ZAWCGRID`, then little-endian uint16 version (1), width, height, and band count.
Band-major little-endian float32 cells follow, north-to-south rows. Grid bounds are
pixel edges in WGS84; positions are evenly spaced in EPSG:3857. Cloud bundles
contain all five cloud/freezing fields; an icing bundle contains three compatible
fields at one time and altitude. Wind bundles contain height, true east/north wind
components and temperature at a native pressure level (`pressureHpa`, with
`altitudeFtMsl: null`); the [winds guide](winds.md) specifies units, rotation and
browser-derived selected slices. This source format does not change when the
display uses MSL/flight-level interpolation.
The immutable generation also retains its manifest
and decoder/source provenance.

Conversion computes a shared nearest-cell index map with zero
transformation-approximation tolerance, then samples every field through it. Heights round to
10 ft, percentages to 1%, and SLD to 0.01. The default 4096-metre **projected**
spacing gives 1658×1004 cells over the initial bounds; projected spacing is not
a claim of constant ground resolution or increased model resolution.

Explicit float32 sentinels are `-9999` missing, `-9998` below model terrain,
`-9997` unknown source value and `-9996` outside coverage. All four remain
transparent so absent diagnostics and unavailable values do not add apparent weather shading. Point
inspection retains their distinct meanings; an unshaded area does not establish
the absence of weather. Finite zero is valid data: zero cloud coverage, icing
probability, icing severity and SLD potential are transparent, while zero-height
diagnostics remain colored. Red hatching still indicates positive SLD potential
over an available icing field. Color bins are defined once in
`presentation.ts` for map and legend. Height thresholds are lower inclusive at
1k, 3k, 6k, 10k and 18k ft; percentage thresholds are 10, 25, 50 and 75%.

## Time, recovery and budgets

Each product uses its latest native frame at or before the selected time, less than
one cadence old and within the horizon. There is no temporal interpolation, future
frame substitution or invented IFI F000. Icing uses exact native heights; winds use
[vertical interpolation](winds.md#source-and-levels). An advisory-only timeline stop
can reuse an applicable hourly grid without loading or uploading it again. Keep
all published stops even when palette colors or a local view look unchanged.

A changed time, level, field or generation clears obsolete imagery and inspected
values until matching numbers and pixels are ready. Field and level changes retain
the inspected location and panel state. Details show unavailable values while
loading. Cancelled results cannot regain the display. Warm replacements commit
synchronously. Pan/zoom keeps the full-domain
image while any viewport SLD detail is redrawn, with matching pixels/bounds committed
together. Point inspection always uses the committed full-domain numeric bundle.

Only demanded, mounted, visible, online products refresh catalogs, every five
minutes after completion; failures retry after thirty seconds. Clouds/icing and
winds refresh independently. Within one family, changing fields or altitude does
not restart polling. A replacement catalog becomes live after its selected frame
validates, or a current frame if the pinned time disappeared. Its offline pointer
advances only after a matching file saves; until then preserve the old offline
catalog and restrict new acquisition to nearby frames.

Load the selected frame first; speculative acquisitions start only after its
validated data is usable, so an adjacent file's optional save cannot take the
decoder slot ahead of the selection. Shaded fields then save Now through their horizon
plus an older pinned frame, at the chosen altitude. Barbs alone warm adjacent hours;
temperature extends that same wind stream to the selected-altitude horizon. No
all-altitude PWA download is implied. Existing source inputs and saved conversions
are reused. Field changes within a bundle reuse its numbers.

`planning.ts` derives the selected/nearby horizon, then computes speculative
starts, preparation status and retry deadlines from explicit inputs and receipt
state. These decisions perform no acquisition or storage. `controller.ts` applies
the plan and owns cancellation, catalog adoption and optional persistence; its
reconciliation guard handles synchronous store and decoded-memory callbacks.
`receipts.ts` owns per-frame save/error bookkeeping, pruning and retry eligibility.
Inventory checks retain receipt identities, so late results cannot overwrite a
newer save or repair even if its saved flag has the same value. New selections
join matching in-flight work before releasing speculative consumers.
The client's decoded-frame receipts use the same identity check before applying
inventory results, so stale checks cannot overwrite newer persistence evidence
before the controller receives them. Metadata-only frame copies share that identity.
Map gestures pause new speculative starts; selection changes debounce them for
150 ms. Relevant work already running finishes even if enabling another stream
reduces concurrency. Selected loads continue while preparation is paused.

Progress counts successful file saves or receipts together with a saved catalog,
not downloads or decoded frames. Completion bookkeeping survives tab/visibility
changes for each product's current-level horizon; wind discovery adds its work
without resetting scalar completion. Source/level changes invalidate incompatible
receipts. Optional save failure leaves live/nearby data usable, stops distant work
and reports **Offline save incomplete**. **Retry forecasts** retries file/catalog
saves and failed renderers. Rendering failures clear the layer and report errors;
ordinary status updates cannot trigger endless redraw retries.

Saved counts are reconciled against core file inventory after publication/eviction
hints (including other windows), on resume or demand changes, and roughly once a
minute during active clock updates. These batched checks read keys, not grid bodies, and
do not touch LRU order. Evicted receipts become incomplete while decoded nearby data
remains usable. They stop distant preparation until **Retry forecasts** or a verified
file repair, avoiding repeated downloads that immediately evict one another.

A saved timeline removes repeated downloads for retained files, not decoding or
rendering. Distant saved files use receipt inventory during preparation and validate
bytes on selection. Distant new downloads release decoded buffers after saving.
The decoded neighborhood prioritizes selected, next and previous bundles across
both streams. Evictions notify controllers to release obsolete references.

| Resource | Bound |
| --- | --- |
| All AWC files, including dormant/compatibility namespaces | 96 files / 256 MiB; 48-hour unused expiry |
| Converted frames and archived frames | Each namespace at most 64 files; shared aggregate above |
| Native pressure inputs | 64 files; same aggregate |
| Model terrain | 4 files / 32 MiB, at most 8 MiB each; same aggregate |
| Full-domain images | 24 files / 32 MiB, at most 8 MiB each; same aggregate |
| Other compressed forecasts | 16 MiB per file |
| Numeric bundle | 48 MiB decoded; at most 4096 pixels per dimension |
| Shared decoded neighborhood | 96 MiB per page, additional to displayed/replacement references and worker scratch |
| Full-domain rasters | Three / 48 MiB; each canvas/raster at most 2048×2048 / 16 MiB |
| Acquisition | Two scalar jobs and one independent wind job; at most three 16 MiB inputs |
| Numeric worker calls | One at a time through core's task limiter |

Core owns transfers, storage, LRU/age cleanup and publication locks. Quota may evict
older times and altitudes; opportunistic saves do not pin complete timelines.
Without Web Locks, reads work but optional saves are skipped. Corrupt saved files
repair online; offline reads use only retained files. All weather storage participates
in full local reset, independently of regional chart completeness. See
[core file caches](../../../../docs/architecture/layer-plugins.md#plugin-file-caches).

Frame work has a one-minute overall deadline; failures retry after one minute or
explicit retry. Optional storage waits stop after ten seconds, but an uncancellable
mutation holds its publication lock until it settles. Hidden/disabled/detached
layers stop preparation and release neighborhoods. Offline selection can warm
saved adjacent frames without network or full-horizon preparation.

Source check, browser check, model run and forecast valid time remain separate.
Runs older than three hours, source checks older than 90 minutes, browser checks
older than ten minutes, failed checks and restored-only data are visibly outdated.
Future metadata is rejected; reading a saved artifact never advances freshness.

### Raster ownership

`presentation.ts` owns map/legend colors and transparent sentinel behavior. Full-domain
images serve ordinary fields through camera changes; only screen-space SLD hatching
needs a viewport redraw. Sampling reuses repeated rows/columns, yields about every
six milliseconds and checks cancellation. Opacity/status changes do not resample.
`ImageSource.updateImage` submits each committed image once; there is no animated
canvas source. Disabling/detaching releases rasters, canvas, map source and references.

Core caches gzip RGBA images under endpoint, complete forecast identity, field,
SLD setting and `rgba-v1` render version. Bump that version for changed palettes,
sampling, transparency or hatching. Exact expected pixel length and integrity are
validated; corrupt images rebuild from numeric data. Image hits avoid recoloring
but never establish numeric readiness, saved forecast counts or freshness. One
image operation runs at a time, exposing usable pixels before optional saving.

These are allocation limits, not measured tablet peaks. Worker scratch, candidate
buffers, retained images, canvas and GPU copies can overlap. See
[wind working memory](winds.md#time-preparation-and-cache). Local DevTools timings
in `performance.ts` retain at most 64 samples and one entry per stage; nothing is
sent remotely. Image submission timing does not measure GPU completion.

## Delivery and verification

Leave both AWC feed overrides blank for the shared server in development and
production. Forecasts are not bundled into `public/` or the offline shell.
The [server guide](../../../../tools/weather-server/README.md) owns GCP service deployment and the DO HTTPS proxy.

`test/weather-grib.test.ts` and [captured GRIB fixtures](../../../../test/fixtures/awc-grib/README.md)
compare numeric decoding/projection with independent GDAL hashes. Processing and
discovery cases cover complete source horizons, pinned identity and cache reuse;
grid/cache cases cover sentinels, cancellation, quota and repair. Browser cases in
`test/e2e/weather-{awc-grids,native,winds}.spec.ts` cover display, stepping and offline
recovery. Their existence and historical reference outputs are not a current pass.
Independent operational comparisons and physical-device readability/memory checks
remain separate release requirements.
