# PIREPs / AIREPs

[AWC Weather](../README.md) / Observations

PIREPs is an independently toggled weather product, initially off, with its own
core tab beside Radar and Progs. It includes the aircraft reports available in
AWC's feed, preserving routine/urgent PIREP, AIREP and other supplied report types.
AWC describes coverage as primarily the US and North Atlantic; this is not a
CONUS-only product and empty space does not establish an absence of weather.

## Source and delivery

The info server checks AWC's minute-updated
[`aircraftreports.cache.xml.gz`](https://aviationweather.gov/data/cache/aircraftreports.cache.xml.gz)
in the background, using the existing upstream queue and disk cache. It publishes
schema-2 `PirepSourceSnapshot` at `/api/weather/pireps.json`: source-check time,
source identity and an ordered `records` array containing every original
`AircraftReport` XML member. Entries with missing or invalid fields, source quality
flags, oversized report text and duplicate deliveries are all retained verbatim.
The server validates the transport and complete XML envelope; **per-entry
interpretation, deduplication, location recovery and display decisions belong to
the PWA**, following the NOTAM division of responsibilities. The shared
contract/guard is [`packages/contracts/src/pireps.ts`](../../../../packages/contracts/src/pireps.ts).

HTTP requests only read published data. Successful checks are spaced by at least
a minute; failed checks retry after at least 30 seconds and obey upstream backoff.
Last-Modified caps the source-check time. Missing/future/ten-minute-old publications
and regressing publication times cannot replace the retained snapshot. The last
snapshot remains available for at most ten minutes from its original source time,
including across restart. After a system-clock rollback, the warmer resets its
retry deadline and a now-future publication cannot prevent a valid replacement.
Ordinary source regressions remain errors. Health and the release probe describe
complete source delivery and freshness, independently of how many entries a PWA
can interpret or plot. A fresh, complete collection of unplottable entries still
has complete delivery; malformed envelopes and acquisition failures fail readiness.

The gzip/XML reader bounds compressed input to 4 MiB, decoded XML to 8 MiB,
10,000 records, 64 levels of nesting and 300,000 nodes. It rejects DTDs, malformed
or truncated envelopes, warnings and count mismatches. JSON delivery and each
saved browser file are bounded to 16 MiB, allowing for XML escaping without
clipping individual members. A complete empty collection withdraws preceding
reports. Document/transport limits reject the whole collection rather than
publishing a truncated feed. On migration, the server discards its old interpreted
publication and uses a new upstream cache identity to acquire the full source.

The PWA's `decode.ts` uses event-driven `SaxesParser` with explicit structural state
to read each XML member, then validates the interpreted fields from
[AWC's aircraft-report schema](https://aviationweather.gov/data/schema/aircraftreport2_0.xsd).
`PirepSnapshot` is the resulting view of reports and explicit issues. Member decoding
is bounded to 20,000 characters, 12 levels and 2,000 nodes; failures leave valid
neighbors available. Oversized evidence is marked as an excerpt in that view;
complete original entries remain in the source cache. Decoding runs on acquisition
or restoration, never on hover or map movement.

For rollout and offline compatibility, the PWA also accepts legacy schema-1
responses and saved files. It retains their validated point reports and redecodes
**every legacy issue from its retained XML**, whether or not the older server
supplied `issue.report`. Client location recovery therefore does not depend on
a coordinated server rollout. Previously truncated legacy evidence cannot be
reconstructed; new source deliveries replace it.

Interpreted reports retain original XML and raw text, observation/receipt times,
location, source altitude, aircraft reference, report type, sky/turbulence/icing
descriptions and quality flags. Conditions retain NEG and other source qualifiers;
absence of an icing/turbulence field does not mean negative conditions. The AWC
schema labels numeric altitude in feet MSL; we preserve that meaning rather than
substituting a forecast altitude. Missing, ranged or AGL-qualified altitudes remain
unknown for filtering. A complete raw `/FL DURC`, `/FL DURD` or `/FL UNKN` also
leaves altitude unknown, even if XML supplies a number: the AMA departure capture
supplies zero for a climb-only report without an altitude quality flag. The
original XML number remains in source evidence. Numeric flight levels and mentions
of climb/descent in remarks do not override the structured altitude; zero remains
valid when no explicit uncertainty applies. Raw uncertainty cannot suppress
validation of a malformed structured altitude. `bad_location` prevents plotting
source coordinates; valid observation fields remain available for PWA `/OV`
recovery. A finite source position
is retained as untrusted corroborating evidence for the narrow identifier-typo
recovery below, never as a replacement for a published reference. A missing observation
time or `no_time_stamp` flag permits bounded PWA `/TM` recovery as described below.
A location failure cannot hide unrecoverable time, malformed raw text, conditions
or other interpreted fields. Flag values must explicitly be true/false or 1/0,
with case and surrounding whitespace normalized. Empty or unsupported values
remain explicit PWA interpretation issues.

Only otherwise identical interpreted observations with identical raw text are
deduplicated in the PWA; receipt differences alone do not create another marker.
The earliest known receipt and its evidence win over a later or missing receipt.
Content identities cover displayed interpretation and raw text. XML attribute/
qualifier order and equivalent numeric representations do not change identity;
repeated condition layers keep source order. The source cache preserves every
original delivery regardless of the derived display identity.

The bounded raw-text reader interprets `/OV` for location, `/TM` for time
recovery, and complete `/FL` uncertainty markers. It does not synthesize numeric
altitudes or other observation fields from free text. Wind,
temperature, visibility, weather strings and vertical gusts remain in XML/raw evidence; the compact summary
covers sky, turbulence and icing. Nested scalar/condition content, duplicate
quality flags and unsupported condition attributes remain explicit issues.
Condition heights must be integer feet from −2,000 to 100,000 with base no higher
than top. Malformed nested reports retain their original member XML as evidence.

The [October 13–14 source captures](../../../../test/fixtures/pireps/README.md)
each contain roughly 90 minutes of observations, including AWC-flagged bad
locations. They provide regression evidence for this implementation; they do not
guarantee future source coverage or support for every raw location phrase.

## Raw location decoding

`location.ts` follows [FAA JO 7110.10, §8-1-5](https://www.faa.gov/air_traffic/publications/atpubs/fs_html/chap8_section_1.html)
and the [AWC PIREP format](https://aviationweather.gov/help/data/#pireps). The shared
bounded reader in `text.ts` advances through text-element indicators, consumes the whole `/OV` field,
and treats `/RM` as terminal free text. Duplicate locations, unconsumed suffixes,
invalid bearings/minutes/coordinates and oversized fields/routes stay unresolved.
Cloud-layer slashes and `/OV` quoted in remarks cannot supply a position.

Readers return explicit `parsed`, `unrecognized` or `rejected` outcomes. Only
unrecognized syntax can try another grammar; recognized syntax with invalid
values or missing context retains its rejection. Standard coordinates, routes
and reference/bearing forms take precedence over local descriptions. A complete
local description is recognized before looking for an explicit anchor, so compass
words cannot become airport identifiers when the reporting station is missing.
Compact identifier/recovery choices and ambiguous identifier splits are explicit
alternatives resolved against published references. Even when a compact token's
recovery is rejected, its published identifier can still resolve.

Parsed locations use distinct types for coordinates, references, offsets, routes
and recovery choices. Recovery metadata carries the anchor, its source and the
description kind (compass, distance, approach, departure or magnetic bearing). Reference
resolution uses those fields; human-readable labels are formatted afterward.
Extending a grammar requires defining its complete syntax and rejection rules,
then adding recovery/reference handling and overlap tests. Display wording never
controls which interpretation is accepted.

Supported forms are three/four-character alphanumeric airport/VHF station IDs, identifiers with
three-digit radial/bearing and three-digit nautical-mile distance (`GFK180005`,
`GFK 180005`, `GFK 180 005`), degrees/minutes coordinates (`3901N 08446W`, either
hemisphere), and hyphen-separated routes of up to 16 such points.
The reader also recovers published five-letter fixes, including direct `FORCK`,
`FORCK270010`, spaced bearing/distance forms and route endpoints. This extends
the three/four-character PIREP encoding above using a known navigation identity;
it does not accept arbitrary five-character alphanumeric strings. Fix offsets
use WMM at observation time, as magnetic bearings do for airports. They never
borrow a nearby VOR's station alignment. Explicit compass offsets such as
`2 N OF FORCK` use the same published point and true geographic direction.

Distance-padding recovery also accepts one/two digits or four digits with a
leading zero: `LWM23001` means LWM, 230°, 1 NM; `MQP2260020` can mean MQP, 226°,
20 NM. The radial stays three digits and the distance is bounded to 0–999 NM.
Supported identifier splits remain alternatives until reference lookup;
a standard three-digit distance with a known reference wins. Otherwise exactly
one nonstandard interpretation must have a known reference. This prevents greedily
turning `MQP2260020` into an unknown `MQP2`, while retaining real alphanumeric IDs.
Ambiguous identities or missing alignment cannot trigger a different interpretation.
Recovered padding shows the decoded reference, bearing and distance in details.
Explicit spacing respects the identifier boundary; partial fields remain invalid.

Bare identifiers are standard FAA location syntax: `/OV KJFK` or `/OV W55`
means over the named facility, with no radial or distance required. Seaplane bases
and other landing facilities use the same published airport lookup. These points
receive **Decoded /OV** in details, without an **Approx. location** label or an
assumed reporting-station reference.

An additional bounded recovery grammar handles understandable compass offsets:
`2 N`, `30NW`, `40SW`, `7 SOUTH`, `2NM NE`, `N 2`, and explicit-reference forms such as
`2 N OF KHYA` or `KHYA 2 N`. The 16 compass directions accept abbreviations and
spelled-out words. Distances may be fractional; `SM` is converted to nautical
miles, while omitted units or plain `MILES` assume NM. Compass words use geographic
directions rather than station radials. Compact number-first tokens such as
`10N` or `30NW` retain both possible readings until the reference data arrives:
a published identifier wins, while an absent identifier permits the compass-offset
reading. Ambiguous published identifiers stay unresolved. Both airport and NAVAID
collections must be available before making this choice; token length alone does
not distinguish an airport from an offset. Letter-first compact IDs such as `W55`
remain explicit references. Arbitrary prose/partial phrases remain unresolved.

When this offset supplies no reference, a unique airport matching the report's
header is used: `HYA UA /OV 2 N` becomes approximately 2 NM north of HYA airport.
The header identifies a weather reporting location, so this is an explicit recovery
assumption, not FAA-standard encoding. An explicit known `/OV` reference always wins;
an unknown named reference does not fall back to the header unless the separate,
corroborated typo rule below applies. These reports show
**Approx. location** in the compact row and the assumed reference/distance in
details, retaining raw text unchanged. Missing or ambiguous reporting airports
remain unplotted, and a same-ID VOR cannot replace the reporting airport.

Distance-only descriptions require explicit units (`SM`, `NM`, or `MILE(S)`)
and use a unique explicit or reporting airport as a representative marker. For
example, `RNT UA /OV 2SM` shows **Approx. location** and retains **2 SM from RNT
(reporting station); airport reference, direction unknown** in details. Fractional
distances are accepted only up to 5 NM, converting `SM` before applying the limit;
larger distance-only reports remain unplotted. This is a product recovery limit to
bound the marker's displacement, not a restriction on offsets with a known direction.
No bearing is inferred from altitude or remarks. A complete compass phrase without
a usable reporting station stays unresolved; `UA /OV 2 NM NNE` cannot reinterpret
the direction as an airport. An explicit `2 NM OF NNE` can still name an airport.
Compact tokens such as `2SM` still prefer a published identifier; offset recovery
requires complete, nontruncated airport and NAVAID collections, and known
unsupported or ambiguous identities stay unresolved.

A bare radial/distance such as `DEN UA /OV 260020` uses the same explicitly
labeled reporting-airport assumption, with a 260° magnetic bearing and 20 NM
distance. It requires WMM at observation time; a compass direction or same-ID
VOR cannot substitute for that magnetic airport bearing.

Approach descriptions such as `RNAV 15`, `RNAV (GPS) Z RWY 15`, `ILS RWY 15`
and `FINAL RWY 15` also use an explicit airport or the reporting airport. The
reader recognizes RNAV, ILS, LOC, GPS, VOR and NDB runway approach names, with
runway numbers 01–36 and optional L/C/R suffixes. It consumes the whole location
field and does not extract an approach from remarks. An approach name alone
does not identify a point along the procedure: these reports use the airport
reference coordinate as a representative marker, show **Approx. location**, and
state **airport reference, position along approach unknown** in details. No
distance, glidepath position or procedure geometry is invented from altitude.
The airport must resolve uniquely; an explicit unavailable airport never falls
back to the header. This does not assert that a named approach is currently published.

Runway departure descriptions such as `DEP 4`, `DEP RWY04L` and `DEPARTURE RUNWAY 4`
use the same unique explicit or reporting-airport reference. The number is treated
as a runway designation, with the same 01–36 and optional L/C/R limits, rather than
a distance. Details show **DEP RWY 04** and **airport reference, position along
departure unknown**, with **Approx. location** on the marker. No departure track,
distance, flight level or procedure geometry is inferred. Whole fields are required;
remarks and partial descriptions cannot supply the location. Missing or ambiguous
airports stay unresolved, and bare published identifiers such as `DEP` or `DEP4`
retain reference precedence.

`location-references.ts` indexes the workspace's edition-qualified airport/NAVAID
and five-letter fix data. PIREP enablement requests these even with navigation symbols
hidden, sharing the navigation caches without requesting unrelated airway topology.
The airport and NAVAID collections must arrive before resolving standard references, avoiding transient airport/VOR
alias confusion. A unique VOR takes precedence over a three-letter airport alias;
an exact ICAO airport ID stays an airport reference. The FAA's K-prefixed VHF form
(`KFMG233016`) can resolve the three-letter station only without an exact match.
Five-letter references additionally wait for the fix collection; a late or replaced
collection recomputes the derived location without rewriting the observation.
VOR radials use the shared domain solver and published station alignment, as in
NOTAM geometry. Airport and fix bearings use the existing WMM model at observation time.
Missing alignment, expired/unavailable models and ambiguous identities remain
explicitly unresolved. Unambiguous reporting-airport compass offsets, approach and
departure references need only the airport collection and no magnetic model; compact
offset/identifier alternatives first require both reference collections.

A bare, unknown three-letter `/OV` may recover a single-letter substitution of
the three-letter reporting station only when all three reference collections
are present, none is marked truncated, and the supplied source position is within 0.01 NM of that unique
published station. The tolerance covers AWC's four-decimal coordinate rounding;
it is not a nearby-station search. Known, unsupported or ambiguous identifiers,
missing coordinates, larger disagreements, route segments and bearing/distance
forms cannot use this recovery. The marker uses the published reference point,
shows **Approx. location**, and states the original/candidate identifiers and
corroborating evidence in details. This is a bounded interpretation, not an FAA
identifier correction or proof of the pilot's intent; raw `/OV` and AWC's quality
flag remain intact. The October 14 `SLN UA /OV SKN` capture meets this rule: its
source position rounds to SLN VORTAC, while SKN is absent from the current edition.

Exact international ICAO references missing from NASR can use the bundled
[AWC station lookup](station-references.md). Its use is labeled as approximate
with the station identifiers in details. It supplements US coverage without
per-report requests or an info-server parsing change. Known navigation identities
retain precedence, including ambiguities; station coordinates cannot supply an
assumed reporting airport or approach location.

All route points must resolve. Route reports use the geodesic halfway point along
the complete route, labeled **Route midpoint** in details; it is a representative
symbol, not an exact observation location. Antipodal legs remain ambiguous.
Standard single-point recoveries show **Decoded /OV** and the location field in the core
details table. Valid AWC coordinates retain precedence.

`locations.ts` derives one view per source/navigation/model identity. Recovered
reports share normal filters, viewport selection, hover and drawing, and leave
**Reports not plotted**. Raw source flags and evidence remain unchanged in the
cached snapshot. Derived positions are not persisted; replacing or withdrawing
references updates geometry even for unchanged report IDs. Repeated deliveries
deduplicate by observation identity, retaining the earliest receipt. Reference
indexing starts only for parseable locations and is released when PIREPs are
disabled. Hover, map movement and age ticks do not repeat parsing or indexing.
Remaining entries explain missing/unrecognized `/OV`, unavailable/ambiguous
references or invalid observation data. A valid `/OV` cannot repair an unrecoverable observation time or malformed
conditions. These are PWA interpretation issues; they do not change server delivery health.

## Raw time decoding

FAA `/TM` supplies four digits of UTC observation time. AWC sometimes flags
`no_time_stamp` even when the raw report contains this field, and its structured
observation/receipt times may conflict with it. When the observation time is
missing or explicitly flagged, the PWA reads one complete `/TM` using the same
field-state reader as `/OV`. Duplicate, malformed or missing times and `/TM`
quoted after `/RM` cannot recover an observation.

The raw field supplies no date. The PWA chooses the single occurrence within
the 90 minutes ending at the source publication time, allowing the preceding
UTC date across midnight. Times outside this window, including future times,
remain unresolved. This uses the original source clock, never the device's
current date, so offline restoration cannot make an old observation current.
This is a recovery assumption from the bounded feed; it does not establish which
conflicting upstream timestamp was entered correctly. Unflagged, valid source
observation times keep precedence. Nonempty malformed source times without the
missing-time flag remain issues.

Recovered observations carry `timeSource: 'raw'` in the derived view, show
**Time unverified** in the compact row, and **Decoded /TM** beside **Observed**
in the core details table. These distinguish recovered recency from a trusted
source timestamp when the upstream metadata conflicts. Original XML,
quality flags, receipt time and raw text remain unchanged; a conflicting receipt
is not silently repaired. The matching missing-time flag is omitted from the
mapped row's qualifier list because the observed-time label explains its recovery.
Time recovery composes with `/OV` recovery and preserves normal age, timeline,
altitude and condition filters. Remaining fields must still pass validation.

## Time, display and inspection

Age filters are 30, 60 and 90 minutes, initially 90. Now follows the weather clock.
Past timeline selections show only retained reports observed at or before that
instant, within the selected age window and the current 90-minute retention
window. Future selections hide reports. This is a lookback filter, not an asserted
weather-validity interval; source-check and observation ages remain separate.
PIREPs do not add a stop for every individual report to the shared timeline.

Altitude bands are All, below 10,000, 10,000–17,999, and at least 18,000 feet MSL;
All includes unknown altitudes. All / Turbulence / Icing filters use the reported
condition fields, including negative reports. No forecast altitude control changes
these filters.
The three native selects use core `ui-input ui-input--compact` alongside `ui-field`
labels, matching the other weather controls' typography, colors and touch sizing.
The full-row toggle uses core's slim button, matching Radar and Progs.

Fixed screen-size saturated cyan-blue rings mark routine reports; violet rings
emphasize urgent PIREPs, distinct from active TFR red and upcoming TFR yellow.
A light fill preserves the chart beneath and distinguishes the rings from
solid airport flight-category markers. Their size is a point symbol, not a
geographic hazard radius. They
sit above other weather and below route/navigation geometry. Core source submission
owns acceptance and late-completion invalidation; failed drawing hides the markers
and reopening the PIREP toolbox tab or report panel retries failed drawing. The status distinguishes drawing
from source acquisition. Style recovery preserves state.

Enabling PIREPs opens the temporary right-side **PIREP in View** panel. The
scrollable list contains every matching report in the viewport, including
individual reports whose circles overlap. It updates after map movement/resize,
projects the visible longitude-world copy and handles rotated views. Viewport
membership includes ring radius, stroke and map-picking tolerance, so a partially
visible ring can always reveal its row. Circles keep their screen size when the
map is pitched. Reports are
newest first. Selecting a circle reveals its row; selecting a row highlights its
circle and expands observation/receipt times, position, source qualifiers and raw text.
Each compact row leads with the supplied aircraft reference and observation age;
altitude and a quiet **Pilot report** / **Air report** label follow. These labels
describe report types from the same AWC feed, not different providers or an inferred
manual/automated distinction. Unknown types retain their source label, and missing
aircraft references remain explicit. Urgency has its own core status badge.
Recognized pilot-report aircraft type codes append a readable name in parentheses,
using the bundled [FAA designator lookup](aircraft-types.md). Unmapped codes and
AIREP flight references retain their source label without an invented name.
Reported conditions appear once beneath the summary; expanded metadata uses core's
data table with labeled rows. Core item titles, compact content, notes, metadata, badges and
buttons own typography and touch targets; list spacing uses the core related-content
token rather than section-sized gaps.
The selected row keeps the same core background highlight as hover, including
when selection comes from the map; its divider retains the ordinary neutral color.
The row owns this single background, using the same 6px rounded corners as core
buttons; its button stays transparent on hover while retaining core's keyboard
focus indicator.
Hovering a row or focusing its controls temporarily emphasizes its accepted map
point with the same bright outline and dark halo used by NOTAMs. Leaving restores
the selected report's highlight, if any. The emphasis uses core's focused drawing
band above ordinary navigation symbols and below ownship; normal rings retain
their weather position. Hover/focus changes only layer filters;
it does not rescan the report collection, expand reports, move the camera, fetch
or resubmit source geometry. The panel subscribes only to its display inputs, and
unchanged rows skip rendering when their displayed age and other inputs stay equal.
Touch scrolling does not activate hover. Row removal, panel stow/close and drawing
failure release the transient emphasis; each row releases only its own interaction.
Navigation point selection and route/ruler gestures retain their precedence.
Context gestures offer **Inspect PIREPs**. The panel uses core `DetailPanel`,
`TabList`, controls, content roles and typography tokens.
The raw-report disclosure uses core panel spacing without browser-default paragraph
or preformatted-text margins.
When the viewport list is empty but matching reports exist elsewhere, the empty
state shows that count and suggests moving or zooming the map. Source warnings
refer to the whole AWC feed and count reports still unplotted after location recovery.
**Reports not plotted** uses core headings and data tables to show each
exclusion reason and readable source fields. This includes missing or unreliable
locations, missing observation times, and invalid source fields. Known location/time exclusions appear
once in the heading; their matching quality flag and repeated explanation are omitted.
Other quality flags appear as short notes without a `Quality` prefix or affirmative
`Yes` value; conflicting, negative or unsupported values remain explicit. Original report
text appears verbatim under **Raw report**, including decoded XML entities and CDATA.
Each raw report uses the same initially collapsed core disclosure as mapped reports.
Transport XML remains in the
snapshot as evidence rather than being shown as report text. This display reader
only formats source evidence; recovery uses the separate `/OV` reader and validated
observation fields. Duplicate fields and invalid values remain visible. Truncated or
unsupported XML gets an explicit unavailable-details message. Parsing/rendering is
bounded and deferred until the disclosure opens; closed disclosures release it.

Closing/stowing the panel leaves the layer enabled. Selecting a map circle or
choosing **Inspect PIREPs** reopens it, following the TFR detail interaction. The
toolbox shows a quiet viewport count and map-selection hint instead of a separate
list-opening button. Refreshes, filters and viewport changes do not reopen it. The
explicit action focuses the list so it comes forward when phone panels overlap.
The list keeps its mounted scroll body and stable row identities. While stowed,
it pauses list rendering and catches up with current data on reopening; map
freshness and expiry continue normally. Disabling PIREPs or
AWC weather closes its temporary panel and clears the markers. The seven weather
tabs occupy two compact rows (four and three). The visible PIREP label stays
on one line at small phone widths without reducing core typography or tab height;
its accessible name is PIREPs.

The browser uses core's bounded JSON requests and refresh scheduler only while
enabled, the app is visible, and online. It checks once a minute after each completed
request, with a 30-second retry after acquisition failure. Stowing the toolbox or
report panel leaves refresh active for the enabled map overlay. Reopening the PIREP
tab or report panel checks for overdue data without duplicating an active or recent
request; this uses the local completion time, separately from the source timestamp.
There is no manual refresh button. The browser lazily restores an endpoint-qualified snapshot
from core's asynchronous plugin file cache, marking it cached/unverified until a
live response arrives. A separate PIREP pool retains at most two 16 MiB source snapshots
for up to 90 minutes of non-use; other weather products cannot evict that pool.
Only a small endpoint/time/digest reference is written to localStorage, after the
file is saved. Full snapshot byte limits match delivery limits. Saved bytes are
authenticated and validated before decoding. Derived reports and navigation-dependent
positions are not saved in place of source entries. Older inline snapshots remain readable
until a successful save replaces them. Live data is displayed before optional
persistence completes, and a delayed restore cannot replace live data or advance
its source clock. Restoration is cancelled on disable/detach. Future-dated saved snapshots are ignored using the same
30-second clock tolerance as live responses, preventing them from blocking newer
valid acquisition. The same recovery applies when the device clock moves backward
after a live response. Optional storage failure preserves live data. Reports age
out while offline and after app resume. Regional chart saves do not imply PIREP
coverage.

## Verification

`test/pireps.test.ts` covers complete verbatim delivery (including duplicate and
uninterpretable entries), raw browser persistence, legacy XML recovery and server
cache migration. It also covers malformed envelopes, isolated member failures
(including oversized text and invalid flags), validated unlocated observations,
duplicate delivery, equivalent times, qualifiers, repeated layers, negative
reports, filters, large browser cache snapshots, restoration races, storage failure
and server publication/restart/failure/empty replacement. Altitude regressions
distinguish complete raw uncertainty markers from numeric levels, partial tokens,
duplicate fields and remarks, while preserving cloud heights and source evidence.
`test/pirep-time.test.ts` covers the captured GFK missing-time report in both wire
formats, selection/expiry, combined time/location recovery, UTC midnight, duplicate
and malformed fields, terminal remarks, and source-time precedence.
`test/pirep-locations.test.ts` covers FAA `/OV` forms, direct alphanumeric airport
and seaplane-base references, field boundaries, invalid and
ambiguous locations, compact compass/identifier disambiguation, the supplied DEN
and BTV report examples, approach/departure context markers, reporting-airport assumptions,
station alignment, airport bearings, route midpoints, reference
replacement, receipt deduplication and source preservation. Grammar interaction
tests distinguish unsupported and rejected forms, keep coordinates independent of
reporting context, and preserve published compact IDs despite rejected fallbacks.
Distance-only tests cover units, the 5 NM limit and missing-direction disclosure;
compass tests cover all 16 directions with missing or invalid reporting stations.
`test/pirep-location-recovery.test.ts` retains the actual LWM/CYBL-KBFI XML and
published navigation features. It covers both wire formats through map selection,
short/extra-zero distance padding, identifier splits, international station
fallbacks, explicit reference precedence, missing WMM and the bare DEN radial.
It also covers the supplied RNT distance-only report in synthetic XML for both
wire formats, source-coordinate precedence and withdrawal of its airport reference.
The captured AMA `DEP 4` case covers both wire formats through map selection,
departure labeling, airport withdrawal and preservation of cloud layers while
`/FLDURC` keeps the aircraft altitude unknown despite the source XML's zero.
`test/pirep-corpus.test.ts` checks all 358 PIREPs in the two bulk captures through
map selection, including all 11 bad-location recoveries, preservation of every
observation and withdrawal of derived locations when references disappear. It
records raw phrases that still depend on valid AWC coordinates separately from
source decoding; successful display does not establish raw syntax coverage.
`test/weather-awc.test.ts` covers refresh cadence, overdue checks on reopening,
request sharing, drawing retries, and offline/hidden/disabled suspension. The browser
regressions in `test/e2e/weather-pireps.spec.ts` cover location recovery and withdrawal
with navigation updates, rendering, viewport-edge selection, viewport/world-copy
selection, style recovery, time expiry, hover/focus ownership and cleanup,
hover without report rescans, selected-row emphasis, stowed-list catch-up,
structured unavailable-source details, verbatim raw text and malformed-source fallbacks,
independent controls and the scrollable
panel at desktop and phone sizes. Existing weather layout checks cover the expanded
tab set. Device and operational validation remain separate.
