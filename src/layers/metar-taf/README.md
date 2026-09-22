# METAR and TAF weather

[Documentation](../../../docs/README.md) / Plugins / metar-taf

Airport data and visibility arrive through Navigation’s optional public API using the
[core plugin bridge](../../../docs/architecture/layer-plugins.md#inter-plugin-communication).
Provider removal clears airport demand; re-enabling reconnects to current airport data.

This plugin owns report clients and caches, station selection, airport weather
panels, runway wind components and METAR map rendering. Its registered plugin ID
is `metar`; it can be enabled or disabled independently of navigation. Forecasts and
observations keep separate meanings, freshness and demand even when shown in the
same airport card.

Navigation contributes airport data and visibility to map weather when available.
Without navigation enabled, weather stays enabled but has no airport map demand or
Info panel to enrich. Enabling either plugin does not enable the other. Disabling
weather removes METAR, TAF, and runway wind from airport Info, stops their requests
and refresh timers, and leaves airport/runway metadata available. Cached reports
remain available when weather is re-enabled, but are not shown while disabled.

## Demand, refresh and recovery

The shared [observation scheduler](../../../docs/architecture/layer-plugins.md#demand-and-freshness)
debounces changed demand, serializes refreshes and cancels obsolete work. METAR
refreshes one minute after the previous refresh completes; TAF uses five minutes.
Airport cards use zero demand debounce; map demand uses the default 250 ms.

`metar-taf/airport-weather.tsx` composes two instances of `station-weather.tsx`,
which owns selection, the station dropdown, refresh and cleanup. `nearby-stations.ts`
handles both report formats' station identity, freshness and nearby ranking.
Station selectors use core's [compact fields](../../../docs/features/shared-ui.md#shared-controls),
including shared focus styling and touch text sizing. Compact report formatting
remains plugin-owned. The METAR and TAF report views remain separate, as do their clients' validation,
request formats, retry policies and cache keys through core-managed slots (`zlayer-plugin:metar:metars` and
`zlayer-plugin:metar:tafs`). The former `zlayers.metars.v1` and `zlayers.tafs.v1`
slots are read when the new slot is absent; new cache writes stay in the plugin scope.
Selections and refresh timers remain independent. The METAR map identity and saved
visibility setting remain `metar`; the directory name describes the module's scope.

Map METAR demand comes from rendered airport circles. Loading national airport references
for search does **not** fetch METAR for every airport. Panning clears demand until
movement settles. Airport visibility, the METAR toggle, document visibility, and
network availability control whether map requests run. The client batches up to 100
eligible visible station IDs per request, limits concurrency to two, uses a 20-second
timeout, and retries transient failures once. Cached station checks avoid repeat
requests when revisiting a view.

While the weather plugin is loaded, an open airport Info card adds independent
METAR and TAF demand through
`metar-taf/station-weather.tsx`, even when map weather or Airports is hidden.
Each report checks the airport's station on opening and at its own interval while
online and visible. If the local report is absent or no longer current, a nearby
search covers 50 NM; a manually selected alternative keeps nearby refreshes active.
Changing airport, closing or stowing the card, or opening Plates cancels these requests without
stopping map demand. Stowing preserves the selected stations and resumes demand
when the card reopens. The card and map share the METAR client and cache. Nearby
reports are labeled with their source and never substitute for the selected
airport's map category or runway wind.

Latest-known observations survive viewport changes and map remounts; browser storage
restores up to 5,000 stations across page loads. Observation time and successful-check
time remain separate. Empty or failed refreshes retain the previous observation and
expose its cached status in airport details. A valid observation replaces a
future-dated cached report even if its timestamp is earlier; response batches use
the same preference. Both weather clients treat negative cache age after a clock
rollback as eligible for refresh. Requests use `cache: 'no-store'` so the
service worker cannot turn a failed refresh into a successful cached response. The
product owns that fallback and its labeling.
Details show UTC observation time, age and the last successful check. These are
latest-known observations, not a weather-history archive.

METAR owns a separate `metar-airports` GeoJSON source above static navigation.
Refreshing weather does not resubmit the national navigation source. Cached circles
can remain gray when categories are disabled; hiding Airports hides both sets of
circles. Shared airport identity ties circles, search, routes, and details together.

Airport runway metadata belongs to navigation. The METAR product contributes wind
components to the runway panel, using the selected airport's own observation from
the shared METAR cache. Renderer-independent component calculations live in the
domain package; the runway component adds no request loop beyond map/card demand.

## Source access and report presentation

The client reads same-origin `/weather/metars.geojson`. Vite and the production
nginx configuration proxy it to bounded AWC GeoJSON queries. While an airport's
Info card is open, an absent or older-than-two-hours METAR triggers a `bbox`
search within 50 NM. As with TAFs, the nearest current observation is selected
by default, and a matching dropdown lists station IDs, distances, and directions.
Older saved reports remain selectable with a Stale label. Nearby observations
stay in the labeled METAR section; they do not supply the selected airport's map
category or runway wind components. TAFs use
`/weather/tafs.json?ids=<ICAO>&format=json`, proxied to `/api/data/taf`, only while
an airport's Info card is open. If its own forecast is unavailable, cancelled, NIL,
or expired, a bounded `bbox` query finds TAF stations within 50 NM. The card defaults
to the nearest current forecast, shows the source station's distance and direction,
and offers the other stations in a dropdown. Expired saved forecasts remain
selectable and explicitly labeled when current data is unavailable. The nearest
station is a geographic default; it is not a claim of equivalent local weather.
This follows [ForeFlight's nearby-forecast convention](https://support.foreflight.com/hc/en-us/articles/203723849-How-are-TAF-and-MOS-forecasts-selected-to-display-for-an-airport).

METARs and TAFs both keep product-owned, per-station caches in memory and localStorage
through core-managed slots (`zlayer-plugin:metar:metars` and
`zlayer-plugin:metar:tafs`). The former `zlayers.metars.v1` and `zlayers.tafs.v1`
slots are read when the new slot is absent; new cache writes stay in the plugin scope. Both retain the latest saved report after
empty or failed requests, restore reports without claiming freshness, revalidate
online, and bypass service-worker weather fallback with `cache: 'no-store'`.
Both endpoints also explicitly bypass that fallback regardless of request cache
mode. TAFs refresh every five minutes while the Info card is visible, versus one
minute for demanded METARs, and retain up to 200 stations versus 5,000 METAR stations.
Nearby METARs and TAFs share their respective caches with direct station lookups,
including station coordinates for offline discovery; switching among fetched alternatives needs no
extra station request. Cached observations and forecasts remain available
offline with their timestamps and stale state visible. Only fetched weather is
saved; regional chart downloads do not prefetch weather. A shared scheduled snapshot
publisher remains a future alternative to per-viewer API queries.

TAF text stays coded below METAR, with one colored line per forecast period and no
separate decoded TAF panel. Cached, expired, cancelled, missing and failed-refresh
states are explicit; an empty nearby search has a distinct status from a failed refresh.
The AWC JSON `fcsts` entries supply visibility in statute miles
and cloud bases/vertical visibility in **feet**, unlike METAR GeoJSON cloud bases
in hundreds of feet. Raw change groups are matched to the decoded periods by type
and start/end time and probability, tolerating wrapped whitespace and case variants.
Australian `INTER` groups match AWC's decoded `TEMPO` representation. Coloring uses the more restrictive ceiling/visibility category;
TEMPO/PROB and BECMG inherit unchanged elements from prevailing conditions, while
FM starts a new forecast. Unknown or mismatched data stays neutral. Temporary groups
spanning multiple prevailing periods use the most restrictive applicable category.
The match is deliberately conservative: if raw and decoded periods disagree, raw
text remains visible without category colors. This is not a general raw-TAF decoder.
The opening line shows the full validity range in the device's time zone; FM
lines show their local start time. These muted, right-aligned labels include the
abbreviated month, day, 24-hour time, and zone, plus the year when it differs from
the current year. Same-day ranges share their date and zone unless the zone
changes; see [date and currency labels](../../../docs/features/date-time-display.md).
The timestamps come from the AWC report's validity bounds or matched FM period,
so month/year rollover and daylight saving are handled as dated instants rather
than guessed from the current date.
See the [AWC API schema](https://aviationweather.gov/data/schema/openapi.yaml) and
[ForeFlight flight categories](https://support.foreflight.com/hc/en-us/articles/204019615-What-do-the-colors-of-the-Flight-Category-dots-mean).

## Contracts and verification

- [Source access policies](../../../docs/data/sources.md#awc-constraints-that-shape-the-system)
  describe the upstream limits and planned shared publisher.
- [METAR](../../../docs/data/contracts.md#metar),
  [TAF](../../../docs/data/contracts.md#taf) and
  [runway wind](../../../docs/data/contracts.md#airport-runway-details-and-wind-components)
  define the shared data formats and units.
- [Local verification](../../../docs/development/local-development.md#verification)
  covers the repository checks. Weather changes need demand/cancellation,
  stale-cache recovery and real map/card behavior checks as described above.
- [Plugin browser regressions](../../../test/e2e/weather-plugins.spec.ts) cover
  independent weather/navigation activation, persisted disabled state, report and
  runway-wind removal, stopped refresh requests, and cached reports when re-enabled.
