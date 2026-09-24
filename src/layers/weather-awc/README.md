# AWC Weather

[Documentation](../../../docs/README.md) / Plugins / weather-awc

The independent `weather-awc` plugin supplies G-AIRMETs, domestic/convective SIGMETs,
CWAs and freezing contours, CONUS cloud/freezing/icing/wind/temperature forecasts,
WPC pressure charts through [Progs](progs/README.md), and current/recent
[NEXRAD/TDWR radar](radar/README.md) with optional storm-motion tracks.
Map weather starts off. METAR/TAF and navigation remain independent plugins.
The [grid guide](grids/README.md) owns numeric meanings, preparation and offline
budgets; the [winds guide](grids/winds.md) owns vertical interpolation and barbs.
The [weather server](../../../tools/weather-server/README.md) owns source acquisition
and shared prepared data.

## Display and selection

The left-edge toolbox has six core content tabs in two rows: **Advis.**,
**Progs**, **Radar**, then **Cloud**, **Icing**, and **Winds**, sharing one master switch and timeline. Switching tabs or
stowing the toolbox preserves displayed weather, filters, time and altitudes.
An enabled-product dot is separate from the selected control tab. Progs and wind
barbs are independent overlays. Cloud and Icing choose one shaded field; temperature
replaces the shaded field. Icing and winds have separate altitude controls.

Use core controls, tabs, `ToolPanel`, `DetailPanel`, stowing, focus and keyboard
behavior. Product-specific layouts, discrete forecast/altitude sliders, legends and
map rendering stay in this plugin. The timeline and tabs remain above a scrolling
body. The bottom-anchored toolbox is 656px tall, capped by available map height,
so its upper edge rises by one 36px row. Product tabs and Prev/Now/Next use core's
explicit slim option (32px height, at least 44px width), including on touch screens;
maps at most 536px tall scroll the whole toolbox. Map Display groups this plugin and
METAR/TAF under **AWC Weather** without coupling their loading or visibility.

Advisory switches distinguish G-AIRMET, non-convective SIGMET, convective SIGMET,
CWA and freezing contours. G-AIRMET also filters icing, turbulence, IFR, mountain
obscuration and wind. Unknown hazards keep their supplied names. CWA records with
a null or absent hazard use `UNK` and display **Unspecified hazard**, retaining the
original bulletin and source properties without inferring a hazard from the text.
They remain visible with the generic hazard color and inspectable until expiry.
Boundaries share opaque 2px strokes and a subtle white halo; fills use 10% opacity.
The map and legend share the hazard palette. Weather lies above terrain and below
routes and navigation at `WEATHER_LAYER_ANCHOR`, including after style recovery or remounting.
Within weather, the top-to-bottom priority is **Progs → Radar → other weather**.
Radar sits above advisory fills/outlines, wind barbs and forecast shading, directly
below all Progs strokes and labels. Lazy loading, toggles and style recovery retain
this order regardless of which overlay becomes available first.

The timeline contains the union of enabled G-AIRMET snapshots, SIGMET/CWA validity
boundaries, the shaded field's native times at its selected level, enabled wind
times, enabled Progs forecast snapshots, and retained national radar observation times.
Radar history extends the scale before Now using five-minute spacing; its
[guide](radar/README.md#history-and-timeline) owns history selection and retention.
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
`packages/contracts/src/awc-weather.ts` validates complete snapshots. G-AIRMET uses
one pinned lookup instant for all five frames and rejects mixed cycles or partial
packages. Unsupported geometry, bad validity, transfer-limit flags and results at
the conservative 400-record ceiling reject a replacement. Empty GeoJSON collections
are successful; a missing advisory document is not an empty snapshot.

The September 24, 2026 [CWA regression fixture](../../../test/fixtures/awc-cwa-null-hazard.json)
preserves the [17:54 UTC AWC response](https://aviationweather.gov/api/data/cwa?format=geojson&date=2026-09-24T17%3A54%3A00Z):
Houston CWA 103 has `hazard: null` alongside a classified Kansas City advisory.
It verifies complete-family delivery, source preservation and exclusive expiry.
Malformed hazard types, blank hazard strings and invalid validity still reject
the replacement; the missing-hazard fallback applies only to CWA.

The browser reads normalized advisory snapshots, serially refreshing enabled families every
five minutes after completion while mounted, visible and online. Each request has
a 30-second timeout and 4 MiB decoded JSON bound. One failed family leaves others
usable. Whole successful snapshots replace their family, including withdrawals
and empty results; there is no bulletin-history archive or synthesized cancellation
feed. Detaching stops acquisition; style recovery preserves controller state.

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
three forecast catalogs, two small Progs file pointers, and radar/motion catalogs. Each record is capped at
4 MiB of UTF-16 text, subject to browser quota; these ten slots therefore have a
40 MiB aggregate ceiling. The [Progs guide](progs/README.md) owns
its larger, server-smoothed chart files and compatibility with former inline snapshots.
All carry endpoint identity;
explicit archived feeds restore only their own snapshots. Recognized former
same-origin snapshot identities can restore offline without claiming a fresh check.
Oversized/corrupt records are ignored, and optional save failure preserves live data.
Core also owns forecast file storage; the [grid guide](grids/README.md#time-recovery-and-budgets)
specifies the shared limits. Full local reset includes all weather storage. Regional
chart downloads do not imply weather coverage.

## Development and production delivery

Both use same-origin `/api/weather/`. `npm run dev` proxies to
`https://zlayer.tedyin.com`; it starts no private weather backend. DO nginx forwards
that public API through a managed SSH connection to the weather service on gcp0. Direct AWC/NOAA proxy routes are removed,
and older apps must update for the native-pressure wind API.

The server normalizes advisories and prepares native HRRR/IFI fields once through
its shared cache. The PWA validates, interpolates wind altitude, renders, inspects
and saves offline using core APIs. Catalogs are published only after every listed artifact is saved. HTTP forecast
reads never acquire sources or run conversion. Feed overrides remain
for archived data and fixtures. See [local development](../../../docs/development/local-development.md#data-and-proxies)
and the [server deployment guide](../../../tools/weather-server/README.md#deployment).

[Historical validation records](validation/README.md) retain source investigations
and measurements from earlier implementations. Current behavior belongs in these
guides; current verification follows the repository's precommit checks.
