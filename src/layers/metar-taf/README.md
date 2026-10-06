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

The independent [AWC Weather plugin](../weather-awc/README.md) owns advisory
polygons and the forecast timeline. Map Display groups the METAR and advisory
switches under one **AWC Weather** heading, while each plugin retains its own
visibility, loading and cache ownership. The advisory toolbox lives in the left
tab above Terrain; enabling advisories does not enable airport reports or change
their clocks. Unimplemented catalog weather products are not shown as controls.

The plugin is named **METAR/TAF** in the plugin list and startup status. Visible map
report state and active airport report cards publish their own loading, cached,
ready or unavailable status; card stowing/unmounting releases that demand. Startup
shows this work as background activity, so slow observations or forecasts do not
hold an otherwise usable workspace.

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
Selections and refresh timers remain independent. Display-age timers pause while
the document is hidden and reconcile immediately on resume. A current local report
with no manually selected alternative avoids scanning the nearby-report cache. The METAR map identity and saved
visibility setting remain `metar`; the directory name describes the module's scope.

An airport with unstowed details draws its weather circle in the shared selected-symbol
band, retaining the current category color. The focus layers share the METAR source
and its visibility/suppression lifetime, so refreshes, expiry, failures and disabling
cannot leave a stale foreground weather circle. A selected nearby navaid rises above
ordinary weather circles. See the [map stack](../../../docs/architecture/overview.md#map-rendering-stack).

Map METAR demand comes from rendered airport circles. Loading national airport references
for search does **not** fetch METAR for every airport. Manual camera movement pauses
requests until movement settles, while retaining the last settled station scope,
weather count and observation time for presentation. This keeps the flight-category
legend visible through GPS follow/track-up animations and manual pans. Once settled,
the rendered circles determine the new scope, including clearing it for an empty
view; requests resume even if the stations are unchanged. Automatic GPS follow
keeps the last settled scope active so repeated animations cannot abort slow
requests indefinitely; the next settled view still replaces obsolete station demand.
Airport visibility, the METAR toggle, document visibility, and
network availability control whether map requests run. Map METARs use gateway AWC
queries containing up to 100 station IDs, with two batches in flight, a 20-second
timeout and one retry for transient failures. For example, 250 demanded airports
need three requests, not 250 station lookups. Nearby METAR discovery uses a bounded
geographic query, split at the dateline. Cached station checks avoid repeat requests
when revisiting a view. Overlapping map/card station demand joins pending batches;
one consumer cancelling does not abort another, and the last consumer cancels
its work. The client admits at most two station batches across all consumers.
Freshness publishes per batch, but changed observations persist together when a
refresh settles. Unchanged observations retain their content identity and do not
rewrite storage. A change in display freshness can rebuild the map source without
changing the saved report; same-time corrections still replace report content.
TAF also preserves identical report objects and writes its bounded saved cache only
when report content or retained membership changes. Successful check times still
advance independently and are not persisted as fresh source checks.
The map legend shows the absolute UTC observation timestamp, so unchanged or
offline reports cannot leave a frozen relative-age label.

While the weather plugin is loaded, an open airport Info card adds independent
METAR and TAF demand through
`metar-taf/station-weather.tsx`, even when map weather or Airports is hidden.
Each report checks the airport's station on opening and at its own interval while
online and visible. If the local report is absent or no longer current, a nearby
search covers 50 NM; a manually selected alternative keeps nearby refreshes active.
The airport's own station is checked directly; alternatives are refreshed through
the nearby-area response. Selecting an alternative keeps that area demand active.
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
the same preference. TAF also prefers a non-future issue timestamp over a future-dated saved or batched
report, while preserving issue/amendment ordering among usable reports. Forecast
validity may legitimately begin in the future. Card labels and activity status
share each report type’s freshness calculation: checks older than 90 seconds for
METAR or five minutes for TAF, and future check timestamps, are cached/unverified.
Both weather clients treat negative cache age after a clock
rollback as eligible for refresh. Requests use `cache: 'no-store'` so the
service worker cannot turn a failed refresh into a successful cached response. The
product owns that fallback and its labeling.
Details show UTC observation time, age and the last successful check. These are
latest-known observations, not a weather-history archive.

METAR owns a separate `metar-airports` GeoJSON source above static navigation.
Refreshing weather does not resubmit the national navigation source. Category
colors require a usable observation no more than two hours old. Older, future-dated,
undated or NIL reports render gray. Display freshness preserves the saved report
and its original category; stale local observations remain available in details.
A failed source check alone does not remove the color
of a still-current observation. A 30-second display clock checks age even when
stationary or offline and rebuilds the source only when freshness changes. It pauses
when categories, Airports or the document are hidden and reconciles on return.
Circles also remain gray when categories are disabled; hiding Airports hides both sets of
circles. While Airports is hidden, card updates refresh the shared cache without
rebuilding the hidden map source; showing Airports submits the latest data once.
Shared airport identity ties circles, search, routes, and details together.

Weather station queries respond to camera, style, resize and airport-source
changes, including late tiles. Status-only updates and visibility changes avoid
redundant GeoJSON writes. Cached input identities do not retain another joined
collection.

Map-source processing errors hide the weather source and invalidate visual reuse,
including errors emitted before `setData` resolves. One retry follows after
100 ms; later display/input/environment demand can retry again. Recovery rejoins
the retained airport/report inputs without downloading reports or keeping a
second joined collection. Clears and category-disabled replacements stay hidden
through repeat callbacks until acceptance. Accepted empty sources remain hidden;
accepted gray replacements follow current Airports visibility. Teardown cancels
pending retries and completions.

Airport runway metadata belongs to navigation. The METAR product contributes wind
components to the runway panel, using the selected airport's own observation from
the shared METAR cache. Renderer-independent component calculations live in the
domain package; the runway component adds no request loop beyond map/card demand.

## Source access and report presentation

Blank `VITE_ZLAYERS_METAR_URL` and `VITE_ZLAYERS_TAF_URL` use the same-origin
`/api/weather/metars.geojson` and `/api/weather/tafs.json` routes. The
[TypeScript info server](../../../tools/info-server/README.md) reads AWC, shares
queries across viewers and keeps requested reports warm. Map, card and nearby
requests use the same AWC source. The gateway preserves full coded reports and
source fields; clients still validate and normalize the reports before display.

Gateway responses carry `X-Weather-Checked-At`. A cache hit retains this upstream
check time; the browser's attempt time remains separate. Nearby results use the
oldest contributing check. A failed update preserves saved reports with visible
cached/error state. The gateway never labels an expired response fresh.

METAR batches up to 100 stations with
two requests in flight, a two-hour lookback and one-minute demand cadence; TAF
refreshes the selected station every five minutes. Both use complete AWC area
queries for nearby reports and share station caches between map/card/nearby demand.
Explicit report URLs must implement the same AWC contracts.

AWC supplies complete coded reports and nearby queries. The retired NWS/GIS
adapters had different publication delays and incomplete nearby TAF discovery;
raw-less sensor updates cannot replace a coded METAR. Such legacy sensor caches
are ignored on restore. Coded saved reports retain original labels until refreshed.

### Report presentation and nearby weather

Raw METAR text uses the selected report's flight-category color, sharing TAF's
palette: green VFR, blue MVFR, red IFR and magenta LIFR. Unknown categories retain
neutral text; cached and nearby reports use their own observation's category.
Derived METAR and TAF categories share visibility-bound handling: `M1` remains
below 1 SM, and `P5`/`5+` remain above 5 SM at category boundaries. Reported
distances keep their original bound for presentation; supplied METAR categories
remain authoritative. METAR category derivation uses the same parsed distance as
the visibility display, including numeric strings such as `.5`, `1.` and `1e0`.
TAF retains its stricter decoded-visibility validation before applying shared bounds.
Visibility must consume the complete supplied field; negative values, contradictory
bounds, extra tokens and improper fractions remain unavailable. For example,
`11/2` may have lost a space and is not interpreted as 5.5 SM. Both visibility and
ceiling must be known to derive VFR; a known restrictive element still establishes
a restriction when the other is missing. Supplied METAR categories keep precedence.
The two rows above the raw text show Wind / Visibility, then Ceiling / Altimeter;
there is no separate flight-category field. Missing values retain their grid slots.
Altimeter settings come from the coded observation body before trends, `RMK` or
the report terminator, preserving the
reported unit: `A2992` displays as `29.92 inHg`, and `Q1013` as `1013 hPa`.
Missing or malformed pressure groups display “Unavailable”; sea-level pressure in
remarks is not substituted. See the [AWC METAR guide](https://aviationweather.gov/help/data/#metars)
and [Met Office decoding guide](https://docs.mavis.metoffice.gov.uk/guidance/metar-decode/).

Decoded METAR wind shows magnetic/true FROM bearings separated by a slash, followed
by speed and gusts, for example `327°M/340°T 6 kt`. The shared WMM2025 model uses
the selected report station's coordinates, observation time and zero ellipsoid
height, including for nearby and cached reports. Missing or out-of-validity model
data, or weak/polar fields, leave the magnetic value as `—` while retaining true
direction. Calm, variable and unavailable directions retain their existing labels;
the raw report stays unchanged. Runway components prefer published magnetic runway
headings paired with wind converted by this same model. True runway/true wind pairs
remain a fallback for older feeds or unavailable models. With neither published
heading, numbered runway ends use an approximate magnetic heading (number × 10),
including older summaries with no `ends[]`. Estimates are labeled `≈` in the runway
row and approximate in wind tooltips/accessibility labels, and participate in
Best Wind ranking. Magnetic headings and estimates without a usable model show
an explicit unavailable state. Named ends and helipads are not estimated. Both displays share the
observation-date declination hook, and runway model demand follows airport Info visibility.
Model loading follows the open report card and selected feed revision, using the
shared reference cache and retrying on reopening or reconnection.

While an airport's Info card is open, an absent, older-than-two-hours, future-dated,
undated or NIL METAR triggers an AWC search within 50 NM. TAF makes an AWC area query when the local
forecast is missing, NIL, cancelled or expired. Complete successful searches
publish together; failure or cancellation cannot publish partial nearby reports.
Clients share their own station/nearby caches and refresh clocks. METAR defaults to
the airport's own saved observation, including reports older than two hours, with
observation time, age and cached status visible. A stale local METAR stays first
in the dropdown; nearby reports remain selectable and are ranked by currentness,
then distance. Without a usable local observation, METAR defaults to the best-ranked
nearby report. TAF continues to prefer current forecasts over expired ones, then
distance. Manual station selections survive refreshes. Nearby reports do
not supply the selected airport's map category or runway wind. The nearest
station is a geographic default; it is not a claim of equivalent local weather.
TAF's nearby default follows [ForeFlight's nearby-forecast convention](https://support.foreflight.com/hc/en-us/articles/203723849-How-are-TAF-and-MOS-forecasts-selected-to-display-for-an-airport).

METARs and TAFs both keep product-owned, per-station caches in memory and localStorage
through core-managed slots (`zlayer-plugin:metar:metars` and
`zlayer-plugin:metar:tafs`). The former `zlayers.metars.v1` and `zlayers.tafs.v1`
slots are read when the new slot is absent; new cache writes stay in the plugin scope. Both retain the latest saved report after
empty or failed requests, restore reports without claiming freshness, revalidate
online, and bypass service-worker weather fallback with `cache: 'no-store'`.
Legacy same-origin report endpoints also explicitly bypass that fallback regardless
of request cache mode. TAFs refresh every five minutes while the Info card is visible, versus one
minute for demanded METARs, and retain up to 200 stations versus 5,000 METAR stations.
Nearby METARs and TAFs share their respective caches with direct station lookups,
including station coordinates for offline discovery; switching among fetched alternatives needs no
extra station request. Cached observations and forecasts remain available
offline with their timestamps and stale state visible. Only fetched weather is
saved; regional chart downloads do not prefetch weather. Acquisition uses the shared AWC gateway by default; report normalization and offline
caching remain in the app. There is no scheduled weather publisher.

TAF text stays coded below METAR, with one colored line per forecast period and no
separate decoded TAF panel. Cached, expired, cancelled, missing and failed-refresh
states are explicit; an empty nearby search has a distinct status from a failed refresh.
The normalized `fcsts` entries retain the AWC-compatible contract: visibility in statute miles
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
The timestamps come from the report's validity bounds or matched FM period,
so month/year rollover and daylight saving are handled as dated instants rather
than guessed from the current date.
See the [AWC API schema](https://aviationweather.gov/data/schema/openapi.yaml) and
[ForeFlight flight categories](https://support.foreflight.com/hc/en-us/articles/204019615-What-do-the-colors-of-the-Flight-Category-dots-mean).

## Report parsing

Raw interpretation lives in `packages/domain/src/`; the plugin formats those
results and owns report selection, freshness and display. AWC's decoded fields
remain the primary input. Raw METAR interpretation supplies the existing cloud
fallback and pressure setting; TAF parsing identifies source groups to match
against AWC's decoded periods. It does not decode every weather element from text.

| Module | Responsibility |
| --- | --- |
| `weather-tokens.ts` | Bounded, case-normalized lexical tokens with offsets into untouched source; complete cloud/clear-sky token recognition |
| `metar.ts` | Observation, trend, remarks and end states; observation-only pressure extraction with source evidence |
| `weather.ts` | METAR decoded/raw precedence, ceiling uncertainty, visibility bounds and category derivation |
| `taf-parser.ts` | Initial text and change groups, atomic probability/time headers, remarks and end states |
| `taf-conditions.ts` | Prevailing intervals, BECMG inheritance, temporary overlaps and category evaluation |
| `taf.ts` | Source/decoded period alignment, raw reading lines and matched FM timestamps |

Small lexical patterns recognize complete tokens; explicit states control their
context. METAR ceiling and altimeter extraction share the same observation section.
Once a trend (`TEMPO`, `BECMG`, `NOSIG`), remarks (`RMK`) or end marker (`=`) is
entered, later cloud/pressure groups cannot become current observations. Casing and
wrapped whitespace do not change these boundaries. A measured decoded ceiling and
an AWC-supplied category retain their existing precedence; unknown bases remain
unknown even when another measured layer establishes a restrictive bound.
Documented `RMKAO1`/`RMKAO2` and `RMK/…` separator variants also start remarks;
the attached text is preserved rather than repaired. In raw cloud fallback,
damaged ceiling groups such as `BKN09` or `0VC003` establish uncertainty rather
than a guessed height. They cannot be silently ignored to derive VFR from the
remaining clouds. TAF uses the same uncertainty recognition.

TAF change-header states require a complete FM time or change interval before
accepting weather for that group. `PROB30 TEMPO` and `PROB 30 INTER`, including
wrapped forms, consume their probability, optional qualifier and period as one
header. Unsupported probabilities, malformed headers and empty change bodies
preserve the source with neutral colors. Remarks cannot open another forecast
group. After `=`, remarks may remain as metadata; additional forecast text stays
uninterpreted. No partial header borrows a following group's time or category.
Every source group retains its original character span.
The documented damaged markers `BEC`, `BEMG`, `TEMP0`, `TEMP`, `TEMO`, `BE CMG`
and `T EMPO` are recognized as invalid headers. They do not become weather on an
otherwise colored prevailing line, even if the provider drops their periods.
This bounded list detects uncertainty; it does not correct arbitrary spelling.

The separate evaluator operates only after every source group matches the decoded
period's kind, probability and published time bounds. FM begins with unknown
conditions rather than inheriting omitted fields. BECMG carries unchanged elements
forward; its transition can overlap both old and new prevailing conditions.
Temporary changes evaluate against every overlapping prevailing period without
modifying the baseline. Missing information and mismatched periods retain neutral
colors; the original report and AWC fields are never rewritten.

Interpretation is bounded to 64 KiB and 4,096 tokens per report, and 128 TAF source
groups. Exceeding a bound keeps the complete raw report available: TAF remains
neutral, and METAR's raw-derived fields stay unavailable while usable decoded
fields remain intact. These are interpretation limits, not source truncation.

## Contracts and verification

- [Historical NOAA/NWS source comparison](validation/2026-09-23-source-comparison/README.md)
  retains the unused direct-source observation and TAF captures with their original
  provenance. The [NOAA bulk METAR fixture](../../../test/fixtures/nws/README.md)
  remains active regression input for the shared report parser and display.
- [Source access policies](../../../docs/data/sources.md#awc-constraints-that-shape-the-system)
  describe upstream limits, gateway routing and source comparisons.
- [METAR](../../../docs/data/contracts.md#metar),
  [TAF](../../../docs/data/contracts.md#taf) and
  [runway wind](../../../docs/data/contracts.md#airport-runway-details-and-wind-components)
  define the shared data formats and units.
- [Local verification](../../../docs/development/local-development.md#verification)
  covers the repository checks. Weather changes need demand/cancellation,
  stale-cache recovery and real map/card behavior checks as described above.
- [Report grammar tests](../../../packages/domain/test/weather-reports.test.ts)
  cover irreversible section boundaries, complete probability/time headers,
  malformed groups, source-span preservation, missing fields and bounded fallback.
  [TAF tests](../../../packages/domain/test/taf.test.ts) retain captured AWC reports
  and explicit expected categories for inheritance, overlapping transitions,
  international change groups and month/year rollover. [METAR view tests](../../../test/metar-view.test.ts)
  retain captured US/international pressure and sky expectations alongside invalid
  pressure and rendered-field cases. These fixed fixtures run offline through
  `npm test`; source preservation complements independently specified meanings.
- [Curated decoder corpus](../../../packages/domain/test/fixtures/weather-decoder/README.md)
  adds pinned NASA, pyIEM, AVWX and python-metar evidence, with separately reviewed
  adapter inputs and expected results. It distinguishes original report bodies,
  upstream test strings and adapted excerpts, including intentional unknowns.
  [The corpus test](../../../packages/domain/test/weather-decoder-corpus.test.ts)
  runs in normal Node verification or alone with `npm run test:weather:corpus`.
  Passing these cases does not establish complete decoding of all weather remarks
  or validate upstream AWC decoding; the scope and remaining limits stay explicit.
- [Map freshness tests](../../../test/metar-layer.test.ts) cover offline aging,
  future/undated/NIL reports, hidden-state reconciliation and timer cleanup without
  changing saved observations. [Station browser tests](../../../test/e2e/metar.spec.ts)
  cover stale local defaults, manual nearby selection and offline restoration.
- [Plugin browser regressions](../../../test/e2e/weather-plugins.spec.ts) cover
  independent weather/navigation activation, persisted disabled state, report and
  runway-wind removal, stopped refresh requests, and cached reports when re-enabled.
