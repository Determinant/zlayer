# Surface analysis and Progs

[AWC Weather](../README.md) / Progs

Progs adds NOAA/WPC surface pressure charts to the existing weather map. It is an
independent overlay: changing a tab or shaded field does not turn it off. Progs
starts off and its switch is saved with plugin preferences. NOAA's analysis and
forecast coverage varies by chart; the numeric weather fields retain their CONUS
coverage. The six product tabs use two rows of shared 32px slim controls. The
bottom-anchored toolbox grows upward and scrolls inside short phone viewports.

Progs matches Radar's 12px control/status text and 11px supporting metadata.
The main switch, Isobars switch and retry action use core's 32px slim buttons,
including on touch screens. Source errors retain their warning color; the H/L
legend centers its symbols on a contrasting badge. Reference-cycle metadata in
Weather Details uses the shared 11px weather freshness style.

The separate **Isobars** switch starts on and saves its preference.
It hides contour lines and numeric pressure labels together, including
pressure numbers near H/L centers. H/L symbols, fronts and nonnumeric chart
annotations remain visible. NOAA's text records do not classify center versus
contour pressure, so the switch groups all pressure numbers without guessing a
geometric association. Hidden pressure numbers are not inspectable. Switching it neither fetches nor rebuilds a
chart, and its state survives forecast changes, stowing and style recovery.

## Source and weather meaning

The server uses the same public catalog and WPC GeoJSON files as AWC's web Progs
view: [`/api/data/progchart`](https://aviationweather.gov/api/data/progchart) lists
`/data/products/wpc/YYYYMMDD/YYYYMMDD_HH_Fhhh_wpc.geojson` files. Each catalog entry
supplies an absolute `vsecs`, a forecast lead `fhr`, and a dated filename. The
GeoJSON metadata supplies the reference cycle `datim` and `fhr`. All must agree.
This is an **AWC web-product interface**, not one of the products listed in AWC's
[documented API](https://aviationweather.gov/data/api/); schema changes must fail
visibly and leave the last validated snapshot available. The gateway shares its
AWC request queue, custom user agent and backoff with other weather acquisition.

The complete chart contains:

- Isobar lines and independent pressure labels in hPa (equivalent to millibars).
- H/L centers, hurricane and tropical-storm symbols.
- Cold, warm, stationary and occluded fronts, including forming/weakening qualifiers.
- Distinct trough, dry-line and squall-line geometry when supplied.
- Original chart annotations, including outflow/tropical/ridge labels when supplied.

Pressure-ridge shapes are visible in NOAA's isobars. There is no locally computed
ridge axis; a label is shown only where NOAA supplies it. AWC renders codes 920
and 940 as squall lines; original codes and annotations remain inspectable. Source
numeric labels have their own positions. We do not guess which center or contour
a label belongs to, assign an unsupported value to an isobar, or turn a source
annotation into a computed line. `$` in source text becomes a line break, with
trailing empty lines trimmed; the original text remains in source properties.

The initial coded-bulletin adapter was replaced because it omitted isobars and
collapsed several boundaries into TROF. WPC's transparent KML was also considered,
but the sampled KML had bounds/relative leads without absolute valid dates. The
AWC GeoJSON supplies both full vector records and explicit chart identity. The
[WPC chart](https://www.wpc.ncep.noaa.gov/html/sfc2.shtml) remains a visual reference;
broader archived-source and operational comparison remains outstanding.

## Identity, time and rendering

`source.ts` preserves every feature's source properties and the original catalog
and GeoJSON documents, URLs and raw-file SHA-256 hashes. Reference cycles belong
to individual charts: publication can legitimately mix cycles. They are not
labelled as issue times. The catalog's native stops are authoritative, up to 168
hours; missing leads are not invented. A same-cycle correction has a new byte
hash and replaces the displayed geometry.

**Now** uses the latest analysis at or before the clock for at most six hours
after validity. That currently recent analysis also stays visible at other
products' stops before the first published prog, retaining its analysis label and
original valid time. Without a forecast catalog there is no assumed interval.
Pinned forecast times use the last chart at or before selection until the next
native chart, including stops contributed by other products. The next chart's
time appears beside the displayed chart's original valid time; selecting an
intermediate stop never retimestamps the geometry. The final chart is selectable
only at its own valid time. There is no interpolation between forecast times
or extension past the published horizon. The displayed chart's
valid time remains explicit at intermediate timeline stops. Only enabled Progs
forecasts contribute stops; toggling Progs preserves a retained absolute selection.
The shared [timeline](../README.md#display-and-selection) scrolls horizontally with
hourly spacing and date headers across the full forecast horizon. Prev/Next reveal
the selected native stop; the heading and accessible slider value retain its full
valid time. Product markers remain below the native slider handle.

AWC's [surface renderer](https://aviationweather.gov/assets/map-BY_ek-uh.js), inspected
September 24, 2026, smooths the source control points with a cardinal spline:
tension 0.5, 16 subdivisions per segment, and duplicated endpoint controls.
`curves.ts` applies that same spatial treatment to isobars, fronts and trough/boundary
lines on the server. Closed contours retain their closing source point and use
AWC's duplicated endpoint controls, rather than a separate cyclic spline.
Every original control point remains on the curve; added
coordinates round to five decimal degrees (under a meter of rounding error).
This avoids the angular segments produced by connecting sparse controls directly.
The full 16 subdivisions are retained for isobars as well as fronts; there is no
additional contour simplification, and MapLibre's GeoJSON simplification is disabled
for the prepared chart source. Prepared families and offline files have an
8 MiB ceiling; no smoothing runs in the browser or HTTP
request path. Native MapLibre pattern spacing and fonts are not a pixel-identical
copy of AWC's Leaflet markers.

AWC coordinates can be unwrapped degrees west (−290° means 70° E). The server
unwraps each line before smoothing, honors boundary `fpipdr` by reversing the finished
curve when required, then normalizes/splits date-line crossings at ±180° for both
contours and fronts.
Native MapLibre line patterns preserve
symbol sides and alternate stationary-front colors. Forming fronts have dashed
strokes; weakening fronts also have wider symbol spacing. Isobars are thin gray
lines beneath fronts and source-positioned labels. H/L and tropical symbols are
separate from pressure labels. A frame change hides the old resources until new
GeoJSON is accepted. A freshness check or change to another chart leaves the
selected chart source intact. Renderer failure is visible and retryable; style recovery
remounts against the retained controller. **Inspect weather** includes visible
surface features and their original properties.

## Acquisition and recovery

`/api/weather/progs/{analysis,forecast}.json` serves only prepared
`SurfaceCatalog` version 3 documents. Each contains freshness and immutable references
to `/api/weather/progs/{analysis,forecast}/<sha256>.json` chart artifacts;
`SurfaceSnapshot` version 2 remains the assembled client representation.
Independent background family updates share one cached catalog acquisition, then prepare every listed chart in their
family before atomic publication. Forecast acquisition is sequential through the
existing AWC queue (two requests in flight across products, one-second spacing).
Successful updates check sources every five minutes; unchanged chart URL/hash and
reference/valid times reuse the already normalized geometry. Changed bytes are
parsed, smoothed, validated and serialized in bounded Node worker jobs, including
corrections within the same cycle. Unchanged checks only rewrite the small catalog.
Restart restores prepared references and waits out any remaining source-check interval. Failures retry
after 30 seconds subject to source backoff. HTTP reads never acquire sources or
perform conversion, regardless of the viewer's selected time.

Upstream catalogs are bounded to 16 KiB, published catalogs to 64 KiB, source charts
to 512 KiB each, and the sum of prepared chart files in a family to 8 MiB. Runtime
validation also limits 32 frames, 2,500 features per frame, 5,000 positions per prepared line, 400,000 total positions, and 3 MiB of original chart text.
Unknown feature codes, invalid coordinates, missing metadata/isobars, mismatched
catalog/filename/metadata times, duplicate valid times and partial acquisitions
reject the replacement. HTTP checks declared response lengths. As with other
source products, a syntactically complete file missing whole records cannot be
detected without an authoritative upstream record count.

A rollback in a family's first/last valid time or an overlapping chart's reference
cycle cannot replace newer data. Equal-cycle corrected files are accepted. One
failed family does not block the other. Current/building files and ten minutes of
preceding catalog references are protected from grid eviction inside the existing
cache budget. Files remain eligible for retention up to 24 hours.
`healthz.progs` exposes readiness, valid times, source checks and errors per family.
Former monolithic server snapshots are replaced during migration. The current
publication marker is `wpc-surface-v3-wpc-cardinal-v2`; chart artifacts carry the
`wpc-cardinal-v2` processing revision. Family identity includes prepared chart
hashes, and the renderer uses the selected chart hash. Updating another forecast
chart or a source-check timestamp therefore does not rebuild the current map.
Original chart hashes and source documents remain unchanged.

The browser validates before using or saving a snapshot. It polls only while
Progs/weather are enabled, mounted, online and visible; detaching cancels demand.
Successful reads poll every five minutes. A failed family retries after 30 seconds,
so opening during initial server preparation does not leave forecasts missing for
a whole polling interval; another family's success remains usable.
The optional core chart cache holds at most 64 files / 32 MiB, 8 MiB per file,
with a 48-hour unused lifetime, inside AWC's shared 96-file / 256 MiB budget.
Complete isobar curves exceed the former localStorage payload limit (a captured
seven-day family is about 6 MB). LocalStorage holds only the endpoint and a small
catalog referencing successfully saved chart files. Validated current geometry
is reused in memory; unchanged polls transfer only freshness catalogs while the
chart files remain saved. Each poll rechecks retention rather than keeping a
permanent in-memory saved flag. Evicted files are repaired through core's loader;
a failed optional repair leaves authenticated live geometry usable. Failed saves
remain eligible for retry. Optional catalog-storage errors cannot reject live charts.
Original source documents remain in those files. Cache reads authenticate bytes
and validate the complete identity; a save failure preserves the preceding pointer.
Browser eviction or private-session storage loss can leave a pointer without its
file; restoration treats that as unavailable, never as a verified offline chart.
Existing inline and whole-family file snapshots remain readable offline until a successful refresh
replaces them. File restoration is asynchronous and cancelled on detach; it cannot
overwrite live data, and a failed concurrent refresh retains restored charts.
Validated network charts display before optional file publication finishes.
Offline restoration is cached/unverified. Failed responses do not replace saved
data; optional storage failure leaves network data usable. Checks older than ten
minutes, clock rollback, failed checks and restored-only records are unverified.
Reference cycles older than six hours for analysis or 36 hours for any forecast
chart also mark a source unverified. Regional downloads do not establish surface
weather completeness.

## Development and validation

Plain `npm run dev` runs Vite and proxies weather to the deployed server. For local
backend changes, run `npm run weather:serve` in one terminal and
`WEATHER_API_ORIGIN=http://127.0.0.1:8787 npm run dev` in another. See the
[weather-server guide](../../../../tools/weather-server/README.md).

`test/weather-progs.test.ts` checks every chart in a captured AWC catalog, including
mixed cycles and seven-day pressure fields, metadata identity, source labels,
front direction and contour/front date-line splits, closed contours, captured AWC
spline output, prepared-cache migration, complete-horizon file restoration,
malformed replacements, interval frame selection,
independent acquisition failures, read-only HTTP, restart, rollback/corrections,
cache retention and optional browser storage. [Fixture provenance](../../../../test/fixtures/wpc/README.md)
records original source bytes and hashes.

`test/e2e/weather-progs.spec.ts` exercises actual MapLibre features and pixels,
forecast/style recovery, isobar visibility and saved preferences, other-product
stops, startup retry, thumb/tick overlap,
offline reopening, stowing and touch layouts at 393×852,
320×568 and 852×393 CSS pixels. These are browser-emulation checks, not physical
iPhone or operational-weather qualification. Rerun checks after source changes.
