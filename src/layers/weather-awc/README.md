# AWC Weather

[Documentation](../../../docs/README.md) / Plugins / weather-awc

The independent `weather-awc` plugin supplies G-AIRMETs, domestic/convective SIGMETs,
CWAs and freezing contours, [PIREPs/AIREPs](pireps/README.md), CONUS cloud/freezing/icing/wind/temperature forecasts,
WPC pressure charts and NDFD weather coverage through [Progs](progs/README.md), and current/recent
[NEXRAD/TDWR radar](radar/README.md) with optional storm-motion tracks.
Map weather starts off. METAR/TAF and navigation remain independent plugins.
The parent map attachment uses core's `LayerScope` for independent child disposal,
advisory resources and controller detachment. It revokes parent updates before
cleanup; a child disposer that throws cannot skip the other products or controller.
The [grid guide](grids/README.md) describes numeric meanings, preparation and offline
budgets; the [winds guide](grids/winds.md) describes vertical interpolation and barbs.
The [info server](../../../tools/info-server/README.md) owns source acquisition
and shared prepared data.

The [October 6 preparation measurements](../../../docs/verification/render-preparation-2026-10-06.md)
separate prepared JSON decoding/validation from MapLibre source submission. The
worker-copy experiment remains benchmark-only: copying parsed coordinate graphs
added latency and transient ownership, and left the larger source-submission
pause unchanged. Production keeps checksum validation and cache publication in
their existing owner. These measurements identify the copying cost; they leave
large scans' compliance with the interaction budget unverified.

`controller.ts` owns shared preferences, selection and display receipts.
`product-refresh.ts` owns advisory/Progs restoration and product refresh demand;
`clock.ts` owns expiry and app-resume events. Periodic clock work stops when
weather is switched off, every product is off, or the document is hidden; enabling or resuming reconciles
the current time immediately and restores expiry scheduling. Grid interaction pauses live in
`grids/preparation-demand.ts`. A child grid publication reconfigures its peers
only when it changes the selected stop or advances Now into another hour.

Map updates compare each renderer's selection, data and retry inputs before invoking
it. Display receipts do not reselect unrelated overlays; radar acceptance still
explicitly updates storm-motion demand. Controller-local selectors reuse advisory
selections and timeline stops while their inputs remain unchanged. Preparation
counters are not selection inputs, but acquisition publications still reconcile
wall-clock time, so expiry remains correct after suspended mobile timers.
Time, filter, catalog and altitude changes invalidate the relevant result.
Only the selected product tab mounts its controls. Advisory shown counts use one
accepted-ID set, and a closed, empty inspection does not scan chart features.

GeoJSON renderers use core’s [`source-submission.ts`](../../core/map/source-submission.ts)
for source acceptance, error invalidation and stale completions. Each renderer still builds its own geometry,
layers and recovery resources. A failed source is recreated before retrying;
neither a late completion nor an error event may claim that old geometry is shown.

## Display and selection

The left-edge toolbox has seven core content tabs in two rows: **Advis.**,
**Progs**, **Radar**, **PIREP**, then **Cloud**, **Icing**, and **Winds**, sharing one master switch and timeline. Switching tabs or
stowing the toolbox preserves displayed weather, filters, time and altitudes.
An enabled-product dot is separate from the selected control tab. Progs and wind
barbs are independent overlays. Cloud and Icing choose one shaded field; temperature
replaces the shaded field. Icing and winds have separate altitude controls.

Use core controls, tabs, `ToolPanel`, `DetailPanel`, stowing, focus and keyboard
behavior. Product-specific layouts, discrete forecast/altitude sliders, legends and
map rendering stay in this plugin. The timeline and tabs remain above a scrolling
body. The bottom-anchored toolbox is 656px tall, capped by available map height,
so its upper edge rises by one 36px row. Product tabs and Prev/Now/Next use core's
explicit slim option (32px height, at least 44px width), including on touch screens.
The two product rows use separate core tab backgrounds with a 4px gap, matching NOTAM tabs.
Maps at most 536px tall scroll the whole toolbox. Map Display groups this plugin and
METAR/TAF under **AWC Weather** without coupling their loading or visibility.

Advisory switches distinguish G-AIRMET, non-convective SIGMET, convective SIGMET,
CWA and freezing contours. The convective switch displays **Conv. SIGMET** to fit
the compact control while retaining **Convective SIGMET** as its accessible name.
G-AIRMET also filters icing, turbulence, IFR, mountain
obscuration and wind. Unknown hazards keep their supplied names. CWA records with
a null or absent hazard use `UNK` and display **Unspecified hazard**, retaining the
original bulletin and source properties without inferring a hazard from the text.
They remain visible with the generic hazard color and inspectable until expiry.
Boundaries share opaque 2px strokes and a subtle white halo; fills use 10% opacity.
The map and legend share the hazard palette. Weather lies above terrain and below
routes and navigation at `WEATHER_LAYER_ANCHOR`, including after style recovery or remounting.
Within weather, PIREP circles sit above Progs strokes/labels, which sit above radar, which sits above other weather.
Radar sits above advisory fills/outlines, wind barbs and forecast shading, directly
below all Progs strokes and labels. Lazy loading, toggles and style recovery retain
this order regardless of which overlay becomes available first.
Progs weather shading sits below advisory outlines and wind barbs, above numeric
field shading. Its separate switch allows either or both kinds of shading.

The timeline contains the union of enabled G-AIRMET snapshots, SIGMET/CWA validity
boundaries, the shaded field's native times at its selected level, enabled wind
times, enabled Progs pressure/coverage forecast stops, and retained national radar observation times.
Advisory applicability must fall within 48 hours of its original source check.
This generous ingestion limit catches damaged dates; it does not change the
product's actual validity or age saved publications against today's clock.
Invalid SIGMET/CWA members retain their source evidence as validity issues;
an invalid G-AIRMET horizon rejects the package. Timeline decoration independently
caps each tick series at 512 entries, using sparser ticks only for exceptional
spans; normal hourly forecasts and five-minute radar history keep their spacing.
Radar history extends the scale before Now using five-minute spacing; its
[guide](radar/README.md#history-and-timeline) describes history selection and retention.
The horizontally scrollable forecast scale
keeps at least 11px per hour, with hourly ticks and date headers, including across
the seven-day Progs horizon. UTC labels appear every four hours and at the selected
hour, with nearby labels omitted to leave the selection readable. The heading and
accessible slider value retain the full selected time. Marks occupy actual time positions, stacking product colors when they
coincide. Inactive products contribute no stops; hourly ruler ticks do not invent
forecasts. Dragging the scale pans without changing the weather selection; dragging
the native handle, tapping its track, Prev/Next and arrow keys use the native stops.
Selection and resize reveal the handle by scrolling only the scale. Refreshes and
clock ticks preserve manual browsing. The 16px handle stays above the product marks,
with its 44px touch target and 32px Prev/Now/Next buttons.

Now follows the wall clock, including source/grid publications, explicit Now actions,
and visibility, page restoration or window-focus events after mobile suspension.
Refreshing the clock does not change source-check or chart-validity timestamps.
Selection retains absolute time across tab/field changes, even if a new field has
no coverage there. An unavailable pinned
time gets no invented tick. Next skips elapsed forecast stops; enabled radar adds
retained observation stops before Now. Now remains a separate action and, with
radar history, a stop between observations and forecasts.

G-AIRMET uses the last 0/3/6/9/12-hour snapshot at or before selection, within its
package and less than one three-hour cadence old. It never shows a future snapshot
or carries polygons past the last one. The actual snapshot time remains explicit;
this depiction does not assert validity between snapshots. SIGMET/CWA use
`validFrom <= selection < validTo`, including expiry while offline. Source issue
times never stand in for validity. Successful empty frames remain selectable.
Grid selection, loading, progress and recovery follow the [grid contract](grids/README.md#time-recovery-and-budgets).

Right-click/long-press offers **Inspect weather** for available data. It opens core's
Weather Details panel with numeric values and all overlapping advisories; ordinary
clicks retain navigation/route/ruler behavior. Stowing the toolbox preserves both
inspection and weather. Explicit inspection reopens details, while source updates
preserve their stowed state. Preference changes, including Cloud/Icing forecast
dropdowns, preserve the inspected location and the details panel's open or stowed
state. Open details update for the chosen field once matching data is displayed;
closed details stay closed. Turning off AWC weather clears the inspection.
The point forecast groups matching provider/run/time metadata and keeps different
sources and altitudes explicit. **Change** beside a
wind/icing altitude opens its control without changing the inspected point or time.

Advisory cards lead with hazard, product/identifier, office, altitude and validity;
issue time appears only when supplied. Full source text remains expandable. Numeric
G-AIRMET heights are hundreds of feet, SIGMET/CWA heights are feet. Preserve bulletin
TOPS TO/ABV/BLW qualifiers rather than inventing exact numeric upper bounds. G-AIRMET
severity text and numeric SIGMET severity have different source meanings. Expired
selected bulletins remain readable and labeled until selection or the feed changes.

## Acquisition, freshness and persistence

`source.ts` normalizes advisories on the server. The shared guard in
`packages/contracts/src/awc-weather.ts` validates snapshots and explicit coverage. G-AIRMET uses
one complete [AWC bulk cache](https://aviationweather.gov/data/cache/gairmets.cache.xml.gz)
for all five frames, avoiding five independently queried database responses.
The bounded gzip/XML adapter rejects DTDs, incomplete envelopes, count mismatches,
mixed cycles and invalid forecast times. Source-check time is capped by the
file's HTTP Last-Modified time; a missing, future or ten-minute-old publication
cannot become fresh merely because an intermediary returned HTTP 200. Each
member retains its original XML fields in `sourceProperties.sourceXml`.
FZLVL isolines remain lines even when the XML calls a closed contour an area;
M_FZLVL remains an area. Foot-based XML heights become the existing hundreds-foot
source fields, retaining the original surface/missing encodings as evidence.
The [captured bulk/GeoJSON comparison](../../../test/fixtures/gairmet-bulk-2026-10-09/README.md)
covers every record and forecast hour, including those representation differences.
Unknown member geometry remains an explicit issue. Transfer-limit flags, malformed
collection envelopes and results at the conservative 400-record ceiling reject
a replacement. Empty GeoJSON collections
are successful; a missing advisory document is not an empty snapshot.

The server checks G-AIRMET's minute-updated bulk file at most once per minute after
success, independently of readers. Failed checks retry after at least 30 seconds
and obey upstream backoff. The last complete normalized package remains readable
for the existing ten-minute freshness window, including across restart, with its
original timestamp. Failed refreshes remain errors in health and fail the strict
release probe; retention does not mark them successful. At the age limit the
package stops being available. Older publication times or forecast cycles cannot
replace a newer retained package. SIGMET/CWA retain their existing refresh cadence
and 60-second server delivery lifetime.

Member interpretation is separate from envelope completeness. Unsupported geometry,
bad interval validity or malformed fields become source issues while valid neighbors
publish. Complete snapshots use schema 1; partial snapshots use schema 2 with
nonempty issues, so old clients cannot treat them as complete. Enabled partial
families show **Coverage incomplete** outside the collapsed status disclosure;
the disclosure lists unavailable entries and their raw evidence. Oversized evidence
is explicitly labeled as an excerpt. All-invalid is partial, never a successful
empty result. Recovery replaces the complete family and clears its issues.

`source-geometry.ts` prepares fill and outline together from validated source paths,
preserving polygon holes and disconnected pieces when splitting at the date line.
The [geometry guide](geometry.md) owns shared longitude conventions, accuracy
boundaries and generated regression obligations across weather products.
Declared polygon rings may omit the repeated first coordinate: preparation appends
that supplied coordinate before topology validation, with the same edge and aggregate
10,000-coordinate limits. It does not close line geometry, snap nearby endpoints,
reorder vertices, or invent locations. Fewer than three distinct corners, zero area,
ambiguous closing edges and invalid topology still become source issues. Each ring unwraps independently;
each hole must have exactly one longitude-world placement contained by its exterior.
Full-area containment rejects holes crossing a concave exterior, and intersecting
or nested holes are unsupported. Empty, crossing or retraced rings are rejected
when canonicalization would change their cyclic sequence of boundary turns instead
of silently repairing them. A short reversed edge cannot hide inside a perimeter
comparison tolerance; duplicate and forward-collinear vertices remain equivalent.
Starting vertex, winding and equivalent longitude
worlds cannot change the covered area. Uncontained or empty holes become explicit
source issues instead of being silently discarded by clipping. It bounds source longitudes to
±540°, latitudes to ±90° and geometry to 10,000 points; ambiguous 180° edges remain
unsupported. Canonical wire geometry stays within ±180°, and changed records retain
their original geometry JSON. The [October 8 capture](../../../test/fixtures/cwa-dateline-2026-10-08.json)
contains seven CWAs including Anchorage 103 with longitudes below −180°.
`weather-advisory-source.test.ts` verifies all seven publish, the Alaska boundary
does not span the world, wide and date-line polygon holes survive changes of ring
representation, and malformed neighbors remain
accounted for. `advisory-text.ts` owns display labels independently of source preparation.
The [October 9 Anchorage 202 capture](../../../test/fixtures/cwa-open-ring-2026-10-09.json)
records a four-corner polygon without a repeated closing point. Its raw geometry,
properties and bulletin remain unchanged as evidence; the canonical fill and outline
both include the completed closing edge. Source and HTTP regressions cover recovery,
holes, disconnected polygons, date-line closing edges and unchanged strict wire guards.
Transformed polygons publish their original boundary as separate canonical lines;
the map draws that `outlineGeometry` while using clipped polygons for fill and
picking. Closing edges introduced by clipping must not appear as source boundaries.
Both outputs derive from the same closed source rings before clipping, so a normalized
outline cannot omit an edge that is present in the filled advisory.

The September 24, 2026 [CWA regression fixture](../../../test/fixtures/awc-cwa-null-hazard.json)
preserves the [17:54 UTC AWC response](https://aviationweather.gov/api/data/cwa?format=geojson&date=2026-09-24T17%3A54%3A00Z):
Houston CWA 103 has `hazard: null` alongside a classified Kansas City advisory.
It verifies complete-family delivery, source preservation and exclusive expiry.
Malformed hazard types, blank hazard strings and invalid interval validity become
explicit source issues.

`source-hazard.ts` separates optional classification metadata from required
identity, validity and geometry. CWA's absent/null hazard remains `UNK`; G-AIRMET
still requires its structured hazard because that selects hazard groups and
freezing contours. Domestic SIGMET can resolve absent/null metadata from its
ordered native header, following [NWSI 10-811](https://www.weather.gov/media/directives/010_pdfs/pd01008011curr.pdf)
(sections 6.1/6.2 and appendices A/B). The bounded line parser reads the WMO header,
optional AWIPS/office lines, numbered bulletin heading and validity before the
body. It never searches body or outlook prose for a category. It requires one
active bulletin, agreement with the source issuer/series, and an effective interval
contained within the printed bulletin interval. AWC may shorten that interval
when replacing a notice; it may not extend it or borrow a same-number notice from
another day. UTC midnight, month and year rollover are resolved against the
supplied interval. Parsing is bounded to 100,000 characters, 2,048 lines and 4,096
characters per line.

A proven convective header yields `CONVECTIVE`, preserving the existing map toggle
and old-client contract. A proven non-convective header yields `UNK` when its hazard
is missing: it remains inspectable under SIGMET with **Unspecified hazard**. Present
metadata must agree with a recognized header's category; conflicts remain issues.
Unsupported grammar cannot recover a missing category, but usable supplied
metadata does not depend on complete parser support. Recognized header prefixes
still constrain issuer and category even when a later line is unsupported;
cancellation/control messages and multiple active bulletins remain blocking.
Malformed metadata cannot be overridden with text. Validity and geometry guards
still run independently; calendar overflow is rejected rather than silently shifted
by `Date.parse`.
Source properties and bulletin content remain available unchanged in the raw
properties; display text only trims surrounding whitespace. Derived hazard joins
prepared geometry in content identity so changed interpretation cannot reuse a
stale rendering receipt.

The [October 10 capture](../../../test/fixtures/sigmet-classification-2026-10-10.json)
retains both the missing-hazard KKCI 6C bulletin and a prior cycle containing a
non-convective SIGMET whose effective expiry precedes its printed expiry.
`weather-advisory-hazard.test.ts` checks every captured record, missing/invalid/
conflicting classification, header identity, bounded parsing and calendar rollover.
HTTP regressions verify publication, restart, real conflicts and recovery without
freshening source time; the advisory browser test verifies the convective toggle,
label, and inspectable bulletin.

### Advisory ingestion policy

Acquisition completeness, usable record coverage and interpretation support are
separate decisions. The adapter normalizes equivalent source representations before
the strict shared wire guard runs; parser support is not itself source validity.

| Input condition | Publication policy |
| --- | --- |
| Complete collection with no active records | Publish an explicit empty replacement; withdraw the old records. |
| Unknown fields, equivalent UTC offsets, whitespace, optional descriptive metadata | Preserve source evidence and existing applicability; do not require a release for harmless variation. |
| Missing hazard metadata | Apply the product rule: CWA may be unspecified, domestic SIGMET needs header proof, G-AIRMET needs structured classification. |
| Unsupported SIGMET header grammar with usable metadata | Retain the metadata classification and record the unsupported interpretation; known contradictions still block. |
| Invalid geometry, malformed required fields or contradictory evidence | Retain an issue with evidence; publish independent valid neighbors as partial coverage. |
| Truncated envelope, missing forecast frame or inconsistent G-AIRMET clock | Reject the replacement and retain the previous publication with the failed refresh visible. |

Each newly normalized advisory records `classification.basis` as `metadata`,
`bulletin`, or `unspecified`. SIGMET also records `classification.bulletin` as
`matched` or `unsupported`. Classification issues carry a typed `detail`, so
operator diagnostics distinguish unsupported syntax from actual identity, validity
or category conflicts. Older saved records without these additive fields are
counted as legacy rather than retrospectively claiming proof. Readiness continues
to depend on freshness and actual unresolved coverage, not on whether optional
metadata needed recovery.

Run `npm run test:info:advisories` for ingestion/recovery checks without browser or
PWA lifecycle/rendering verification. The same
tests run through `npm test` in CI. `weather-advisory-policy.test.ts` exhausts
combinations of equivalent timestamps, whitespace/line endings, field/record order,
unknown fields and missing descriptive metadata across CWA, G-AIRMET and both
SIGMET categories. Its policy matrix also injects missing/novel/malformed hazards,
unsupported syntax, contradictions and independent bad records. These invariants
complement the captured corpus and geometry invariance tests; a new incident
should extend the relevant rule and these matrices, not add an identifier-specific
exception. HTTP tests verify that provenance and diagnostic causes follow the
committed snapshot through restoration, failure and recovery without freshening it.

The browser reads normalized advisory snapshots, serially refreshing enabled families every
five minutes after completion while mounted, visible and online. Each request has
a 30-second timeout and 4 MiB decoded JSON bound. One failed family leaves others
usable. Whole successful snapshots replace their family, including withdrawals
and empty results; there is no bulletin-history archive or synthesized cancellation
feed. Detaching stops acquisition; style recovery preserves controller state.
Controller dependencies are named by product. `selection.ts` owns pure advisory
filtering and timeline reconciliation; renderer status updates do not change the
weather clock or selection. Source updates and clock events explicitly call
`reconcileAndPublish` with the current wall clock. `catalog-refresh.ts` shares catalog polling/cancellation for radar, storm
motion and Progs coverage. Detaching clears loading flags before destroying the
schedulers. Product retry counters isolate Progs from numeric fields, and grid
catalog retries use the shared scheduler's failure interval.

Advisory counts include only IDs accepted by the map source. Pending submissions
hide the preceding geometry. Source errors hide all advisory geometry and expose
**Retry advisories**; retry or a successful source refresh recreates the failed
source even when bulletin IDs are unchanged. Recovery preserves the wind, radar,
Progs and navigation layer order, and late completions cannot revive old output.

Source-check, issue and valid times remain distinct. Cache hits cannot advance the
source check. Errors, restored-only snapshots, clock rollback and checks older than
ten minutes show cached/unverified state. Offline data keeps its original times.
The service worker bypasses `/api/weather/` and `cache: no-store` requests so a
failed live check cannot silently become a successful cached response.

Core storage slots retain the last validated snapshot for each advisory family,
three forecast catalogs, Progs chart/coverage pointers, and radar/motion catalogs.
Each record is capped at 4 MiB of UTF-16 text, subject to browser quota; individual
catalog contracts impose smaller bounds. The [Progs guide](progs/README.md) describes
its larger, server-smoothed chart files and compatibility with former inline snapshots.
All carry endpoint identity;
explicit archived feeds restore only their own snapshots. Recognized former
same-origin snapshot identities can restore offline without claiming a fresh check.
Oversized/corrupt records are ignored, and optional save failure preserves live data.
Core also owns forecast file storage; the [grid guide](grids/README.md#time-recovery-and-budgets)
specifies the shared limits. Full local reset includes all weather storage. Regional
chart downloads do not imply weather coverage.

Saved advisory/radar metadata is restored when Weather is first enabled, rather
than while the workspace constructs disabled plugins. Grid catalogs restore once
per requested forecast family; Progs restoration starts when Progs is enabled.
This keeps disabled products out of startup storage/parsing work while preserving
cached-first offline activation and each product's independent freshness clock.
See [forecast download scope](grids/README.md#forecast-download-scope) for the
optional selected-and-adjacent-hours setting.

## Development and production delivery

Both use same-origin `/api/weather/`. `npm run dev` proxies to
`https://zlayer.tedyin.com`; it starts no local info backend. Production forwards
that API to the info service behind an HTTPS reverse proxy. Direct AWC/NOAA proxy routes are removed,
and older apps must update for the native-pressure wind API.

The server normalizes advisories and prepares native HRRR/IFI fields once through
its shared cache. The PWA validates, interpolates wind altitude, renders, inspects
and saves offline using core APIs. Catalogs are published only after every listed artifact is saved. HTTP forecast
reads never acquire sources or run conversion. Feed overrides remain
for archived data and fixtures. See [local development](../../../docs/development/local-development.md#data-and-proxies)
and the [server deployment guide](../../../tools/info-server/README.md#deployment).

The dated JSON artifacts under [`validation/`](validation/) retain source-access
research, independent GRIB values, horizon samples and earlier encoding/timeline/
rendering measurements. Their source identities and scope describe those earlier
implementations; the guides above own current delivery and rendering contracts.
