# Airport, navaid and procedure NOTAMs

[Documentation](../../../docs/README.md) / Plugins / notams

**Status: implemented; production feed enabled.** This is the long-term owning
guide for the NOTAM plugin, collector, supported interpretation, and remaining
qualification. Collection remains disabled by default for new deployments. The
[roadmap](../../../docs/product/roadmap.md#airport-and-procedure-notams) tracks
release work. Requirements below retain the intended scope; the implementation
coverage and dated evidence distinguish supported behavior from remaining work.

The plugin shows NOTAM (D) and Flight Data Center NOTAMs (FDC)
in an airport or navaid detail tab, with concise flairs and a **Show raw** disclosure
for every entry. Relevant notices also appear in an expandable red **NOTAM**
bar in the plate reader, especially amendments to IAPs, SIDs, and STARs.
One data client and entry renderer serve the detail and plate views.

Implemented in this tree:

- `plugin.ts`, `client.ts`, `storage.ts`: one optional workspace provider, coalesced
  visible demand, three-minute reads, bounded saved snapshots and explicit source
  freshness/offline state. `/api/notams/` is excluded from service-worker caching.
- `parser.ts`, `presentation.ts`, `minima.ts`, `takeoff.ts`, `distances.ts`,
  `validity.ts`, `matcher.ts`, `ui.tsx`: conservative
  D/FDC flairs, structured readable bodies/raw disclosures, airport filters,
  procedure/runway matches and review candidates.
  All defaults to D/FDC and unclassified records; Other also exposes retained
  international/military records. Those classes do not duplicate D/FDC plate counts.
- Navigation's third tab and Plates' row counts/red disclosure use core controls.
  The workspace's optional bridge composes the UI. The plate disclosure groups
  related notices and offers the full airport list as a fallback.
- Navaid details offer **Info | NOTAM**. Exact affected-location queries and
  bounded station/component references show direct facility notices first, with
  other records under the same location accessible separately. Airport-filed and
  dependent-procedure coverage remains incomplete.
- Airport NOTAMs offer **Airport | ARTCC / FIR** areas. Regional reads use only
  published navigation associations and retain source classifications; missing
  associations explicitly report unavailable.
- Plates pins the catalog resource in new selections and resolves each book page
  by exact URL/hash/index. Legacy selections without that resource remain readable
  but report matching unavailable; reopening from the catalog supplies the pin.
- The shared info server owns OAuth, all-class full sync, global deltas,
  durable quota admission, checksummed generations, local reads and feed health.

Current interpretation limits: explicit IAP headings, named SID/STAR/ODP headings,
takeoff/DVA/radar minimums, all-IAP scope, runway identity, explicit runway
ILS/LOC/glideslope outages and scoped ILS category prohibitions are supported.
Ambiguous procedure targets are review candidates; facility dependency
graphs, broader regional applicability,
multipart assembly and every publisher alias are not established. Simple daily
and weekday/range UTC schedules with one time window are evaluated, including
overnight windows. Other schedules remain **Check Schedule**. These limits cannot
establish complete operational applicability. Sustained deployment capacity
alongside weather, device checks and broader source comparison remain
release work.

## Contents

- [Scope and ownership](#scope-and-ownership)
- [Navaid detail tab](#navaid-detail-tab)
- [Airport detail tab](#airport-detail-tab)
- [Persistent TFR chart](#persistent-tfr-chart)
- [Plate NOTAM bar](#plate-notam-bar)
- [NMS source contract](#nms-source-contract)
- [Staging evidence, October 4, 2026](#staging-evidence-october-4-2026)
- [Production verification, October 5, 2026](#production-verification-october-5-2026)
- [Collection and delivery](#collection-and-delivery)
- [Airport query contract](#airport-query-contract)
- [Navaid query contract](#navaid-query-contract)
- [Regional query contract](#regional-query-contract)
- [Info server integration](#info-server-integration)
- [Normalized records](#normalized-records)
- [Parsing and flairs](#parsing-and-flairs)
- [Procedure matching](#procedure-matching)
- [Client lifecycle and offline behavior](#client-lifecycle-and-offline-behavior)
- [Implementation sequence](#implementation-sequence)
- [Verification](#verification)
- [Open source questions](#open-source-questions)
- [References](#references)

## Scope and ownership

The first release covers airport-associated D and FDC notices, procedure
amendments and restrictions, and runway/facility notices whose relevance can be
established. **D means distant dissemination**; NMS calls the API classification
`DOMESTIC`, and the normalizer maps its `DOM` payload code to that value. The UI
displays it as **D**. The NMS API also defines `INTERNATIONAL`, `MILITARY` and
`LOCAL_MILITARY`; retain source classifications even when interpretation is outside
the supported D/FDC scope. Airport/ARTCC association is separate from classification.

FDC is a classification, not a synonym for an approach amendment:
retain its other subjects when associated with that airport. Classification and
subject keyword remain separate throughout the UI. The ICAO series letter is not
the NOTAM classification and must not determine the D/FDC flair.

Airport association is not a complete route briefing. The ARTCC/FIR area offers
notices filed under the airport's published regional associations, including
regional GPS notices when filed there. It does not establish flight applicability,
geometric containment, adjacent-region or national coverage. Those require
additional applicability rules; an airport location query or airport-point geometry
alone does not establish that coverage. The persistent TFR chart uses the separate
FAA graphical source described below.
The temporary chart preview is limited to supported explicit point/area
locations in an open reader. A general graphical NOTAM map, route-wide briefing, automatic
route changes, and changes to printed PDF content remain outside this implementation.

Ownership follows the [plugin contract](../../../docs/architecture/layer-plugins.md):

| Owner | Responsibility |
| --- | --- |
| `src/layers/notams/` | Client snapshots, demand, parsing, matching, entries, flairs, filters, freshness presentation, temporary chart context and persistent TFR chart |
| Navigation | Airport detail frame, ordered content tabs, and saved tab selection |
| Plates | Document/edition identity, displayed page context, PDF lifecycle, and placement of the NOTAM bar |
| Workspace | Stable registration and composition of airport and plate NOTAM views |
| Shared server | NMS authentication, one collector, normalization, complete generations, and bounded airport queries |
| `packages/contracts` | Versioned delivery types and runtime guards shared by server and client |
| Core | Requests, refresh scheduling, scoped storage, optional plugin connections, controls, panels, and time formatting |

Use the stable plugin ID `notams`. Expose a small data-only `NotamsApi` through
`workspace/plugin-apis.ts` and register one instance in `workspace/products.ts`.
The public surface exposes scoped airport demand, observable snapshots, temporary
map-preview leases, acknowledged chart revisions and an explicit retry command. The shared UI derives typed match results locally from
those snapshots and exact plate context. Keep React components out of the public
contract. The workspace discovers the enabled provider through core's scoped
plugin bridge in `workspace/notams.tsx`, then composes the Navigation detail body
and Plates notice views through explicit props. Neither Navigation nor Plates
requires NOTAMs or imports its implementation. Disabling NOTAMs removes its tab,
counts and plate bar, releases demand and clears derived results without closing
the PDF or removing the selected airport. Re-enabling reconnects those optional views.

The [info server integration](#info-server-integration) uses the existing
`tools/info-server/` process and deployment. Collection and query contracts
below define its NMS responsibilities.

## Navaid detail tab

Navaid details use **Info | NOTAM** with the same optional-provider, saved-tab,
stowing, refresh, offline and raw-text behavior as airports. There is no Plates
tab for a navaid. Missing published identity leaves the NOTAM tab available with
an explicit unavailable message and makes no request.

`navaid.ts` requires a published US navaid, its station `ident`, and its type.
NASR `notamId` names the accountability office; it is not an affected-location
alias. For example, the retained NASR EHF record has `notamId: BFL`, but its
query is `navaidId=EHF`. The FAA's
[NOTAM format](https://www.faa.gov/air_traffic/publications/atpubs/notam_html/chap4_section_2.html)
distinguishes accountability from the affected location. Do not invent a `K`
prefix or use the nearest airport, feature ID or accountability office.

Within records filed under that exact location, bounded NAV facility headings
and COM facility VOICE headings associate with the selected type or a known
component: VORTAC includes VOR/TACAN/DME; VOR/DME and NDB/DME include their
components; TACAN includes DME. An explicit station identifier must agree.
Runway ILS notices, unfamiliar headings and other same-identifier records remain
under **Other notices filed under …**, retaining all classifications and raw text.
Direct notices appear as a simple list with all retained classifications. Navaid
readers omit classification, subject, search and manual refresh controls. The
source status uses the full list width. Timing sections, raw disclosures and the
other-location list remain available; airports retain their filters.
Location results use a compact 4 px gap before the other-location disclosure and
omit trailing notice-group padding so **Show raw** and **Other notices filed under …**
stay close, while preserving both disclosures' pointer and touch target sizes.

Coverage is measured within this station's affected-location scope. Airport
NOTAMs are a separate view; their absence from this list does not make station
coverage incomplete. The FAA's
[navaid filing rules](https://www.faa.gov/air_traffic/publications/atpubs/notam_html/chap5_section_3.html)
also allow airport-filed navaid notices. Neither this view nor its endpoint
discovers all airport-filed notices or dependent procedures. The `navaid-location`
scope expresses that boundary without a permanent **Incomplete coverage** status
or explanatory paragraph in the navaid reader. That reader's
status reflects source content/collection completeness, freshness, offline state
and refresh failures. Actual source issues remain visible. Airport and plate
coverage indicators continue to include their association limits. Empty results say
there are no directly associated facility notices in this snapshot, never that
the navaid is operational or unrestricted. This UI does not resolve the remaining
plate-title/category discrepancies documented in the matching validation.

## Airport detail tab

The tab order is **Info | Plates | NOTAM**. NOTAM is available for an identified
airport when the plugin is enabled, including airports without plates. It must
not depend on the existing `hasPlates` condition. Omit disabled providers' tabs
while preserving the remaining order. An unavailable saved tab falls back to Info
without deleting its saved preference.

Use core `TabList`, `tabPanelProps`, and `DetailPanel`. Extend Navigation's saved
tab validator to accept `notams`, preserving existing records and their bounded
retention. Inactive bodies unmount; stowing retains mounted content and UI state
while withdrawing visible refresh demand.
Temporary obstacle markers also disappear while stowed; retaining a cached query
or a plate-row count does not retain a map preview.

Default to **All**, showing D and FDC together. Offer classification and subject
filters plus text search using core controls behind a **Filters** disclosure,
collapsed by default. Include Other/Unclassified so imperfect parsing never hides
a notice. Keep the filtered/total count visible with the controls
collapsed. Applied filters show a count on Filters, a readable summary when
collapsed, and a **Clear** action; closing the disclosure must not clear them or
silently hide the restriction. Reset filters and collapse the controls on a
different airport or area. These filters do not affect the plate bar's results or counts.

Compact **Airport / ARTCC–FIR** content tabs default to **Airport**. Use the shared
keyboard-accessible tab control, since these switch between distinct lists.
The area row belongs in the fixed detail header below Info/Plates/NOTAM, outside
the single scroll body. It appears only with the NOTAM tab selected. Filters,
source status and notices scroll together below it. Changing area starts that
list at the top; stowing preserves its reading position. The plugin supplies
the header and body together through `useAirportNotamView`; Navigation only
hosts those slots and their content key.
Geographic scope is separate from the D/FDC classification filter. The regional
view uses the same entries, filters, freshness, offline storage, timing and chart
preview lifecycle, with the same compact source-status and filter layout. Its
**All** includes every retained classification, including
international notices filed only under a FIR; it does not feed airport plate
matching or counts. Only the visible area's query creates demand. Changing
airports resets Area to Airport; stowing preserves the selection and releases demand.

`region.ts` takes a US airport's `responsibleArtcc` from NASR
`APT_BASE.csv` `RESP_ARTCC_ID` ([FAA field mapping](https://nfdc.faa.gov/webContent/28DaySub/TXT_to_CSV_Mapping.pdf)),
and an explicit `firId` if the navigation source
publishes one. The responsible Center is an administrative association, not a
geometric boundary. Do not substitute Center frequency assignments, `lowArtcc`
from another feature, the NOTAM accountability office, the nearest facility, or an
invented ICAO prefix. The publisher must rebuild and publish the airport export
to supply the new optional field; older exports remain readable and report
ARTCC/FIR lookup unavailable. Missing or invalid identity makes no regional
request and never presents an empty list as established coverage.

Group notices into **Active**, **Check timing**, and **Upcoming** sections, omitting
empty sections. Active contains notices within their effective interval and any
supported schedule; uncertain validity/schedules and notices outside their schedule
stay under Check timing with their existing qualifiers. Upcoming always appears last,
with a muted heading and subtle dashed leading border using existing theme tokens;
it is a section, not a flair. Keep notice text and semantic flair colors at full contrast.
Within each airport section, use this priority order:

1. Airport, runway and taxiway closures, including partial or qualified closures.
2. Navaid outages.
3. Other closures, outages, monitoring limitations, restrictions and procedure notices.
4. Remaining notices, including activity, obstacles and informational updates.

Use supported parser facts and subjects, not raw keyword matches, classification
or flair colors. A runway lighting outage is not a runway closure; an unmonitored
navaid is not an outage. Preserve newest-issued order (updated time when issue
time is missing) and the stable ID tie-breaker within each priority. Apply the
same ordering under classification, subject and search filters, independently in
Active, Check timing and Upcoming. `priority.ts` owns this airport-only reading
order; the plate list prioritizes FDC notices as described below.
The clock reevaluates timing every 30 seconds while
demanded and immediately when demand resumes, moving notices between sections as
their effective times change. Expired/cancelled
notices leave the current list only on validated lifecycle/time evidence; retained
history is separate and bounded. Do not infer severity from FDC versus D.

| Entry element | Contract |
| --- | --- |
| Identity | Source number and location, with classification `D` or `FDC`; preserve unknown classifications explicitly |
| Subject flairs | Source-backed topics when a more specific facility/effect does not already identify the subject; long procedure lists stay in the body |
| Effect flairs | An at-a-glance body: scoped closures/outages, distinct minima/visibility/VDP/takeoff amendments, climb gradients and restrictions, only when established |
| Body | Conservative formatting retaining every operational clause, condition, exception, value, and unit |
| Validity | Start/end in device-local time with Zulu in parentheses, schedule, estimated/permanent qualifiers, and timing uncertainty using core time formatting |
| Source state | Environment-specific source status above the list, as described below |
| Raw disclosure | **Show raw** containing the complete local-format text labeled **Original NOTAM** and any separately labeled ICAO translation; **Source body** appears only when the original is unavailable or does not contain the complete body |

Production snapshots show **FAA NOTAMs · Checked …** above each airport list or
expanded plate list, using the actual source-check time. Offline, stale,
incomplete-coverage, request-failure and degraded-feed states remain explicit when
present; production access alone does not establish freshness or completeness.
The snapshot's environment controls the note, including for saved data.
Airport, ARTCC/FIR, navaid and plate lists have no manual refresh button. Visible
online readers refresh automatically every three minutes. Reopening resumes
demand and retries failed or due reads; a recent successful read retains its
original refresh deadline. Source status and errors remain visible across these
transitions.
Keep feed status in this source header. Counts describe retained notices and
matches without repeating generic completeness or coverage qualifiers. Empty
airport lists say **No retained notices.** An empty airport snapshot in the plate
reader says **No retained airport NOTAMs.** These describe the saved results without a separate claim
about current completeness.

Staging snapshots retain one testing notice in the same position:
**Testing with FAA staging data. Notices may be incomplete. Do not use for flight
planning.** This replaces source-age, stale, incomplete and degraded-feed messages.
Offline state, request failures, plate-catalog retry actions and procedure-specific
interpretation/review qualifiers remain visible.
Empty staging results describe retained notices without implying current completeness.

Raw text is selectable/copyable, retains line breaks, and wraps on narrow screens.
The raw disclosure footer shows the update timestamp without the internal NMS source ID.
Validity labels use the shared local-first timestamp pair, for example
`From Oct 4 · 09:00 PDT (16:00Z)`. **From** and **Until** occupy separate aligned
rows; long dates wrap within their value column. Permanent, estimated and unknown
end qualifiers stay on the Until row. When local and UTC calendar days differ, include
the UTC date inside the parentheses. Display the local zone at each instant so
daylight-saving transitions remain explicit. Source schedule and raw NOTAM times
retain their supplied notation.
Compare the entire source body against the supplied local-format originals using
whitespace folding and complete word boundaries only. Omit the redundant body when
an original contains it; retain different wording, values, punctuation and qualifiers.
Keep displayed text and stored source fields unchanged. Empty originals count as
unavailable. If the original is missing, expose available source text and label that
limitation; never present a reconstructed full NOTAM as original. Render strings
as text. Disclosure expansion is session state keyed by source ID/revision, not
an unbounded collection of persistent records. Material revisions must not inherit
an old read/dismissed state.

Reuse `ui-button`, `ui-input`, `LoadingPlaceholder`, typography, focus treatment,
and scrollbars. Both airport and plate lists use the same hierarchy: 14 px bold
timing headings, 13 px notice identity/body text, 12 px source state, applicability,
validity and list messages, and 11 px flairs. Use the bundled B612 regular/bold
weights; raw source text uses the shared monospace stack at full text contrast.
List counts, source status, errors and empty-list messages wrap without
extra paragraph margins. Source state and filters have their own spacing above
the list; timing-section spacing belongs to the shared list so both hosts agree.

Filters stack when the available panel width cannot fit both fields. Long source
numbers, translation labels, procedure titles, schedules and raw text must wrap
without widening either scroller, including with expanded text spacing. Keep
readable prose's line breaks while collapsing inter-word whitespace so preserved
spaces cannot hang beyond a wrapped line; raw source disclosures retain verbatim
spacing. Keep native controls at core's text-entry and touch sizes. **Show raw** is a native,
keyboard-operable disclosure with a visible focus ring and at least a 32 px
pointer / 44 px touch target. Flairs use semantic theme tokens; their text conveys
meaning independently of color. Do not dim notice text in Upcoming sections.

### Temporary obstacle map context

An open airport or ARTCC/FIR NOTAM tab previews supported obstacle/crane points from its filtered
list, together with supported area boundaries. An expanded plate NOTAM panel
previews the geometry in its displayed matches.
Stowing/closing the host, switching tabs/airports/pages, collapsing the plate bar,
hiding the document or disabling NOTAMs releases that reader's preview. If two
readers are visible, each owns a lease; releasing one cannot erase the other's
context. Previews are session-only and do not create acquisition demand or a saved
map overlay. Reopening uses the current retained snapshot and current timing.
The map receives one union of notices by source ID across visible readers. Two
airports showing the same ARTCC/FIR share its records and depict each notice once;
adding or releasing a duplicate reader does not republish unchanged map input.

The NOTAM plugin owns a separate lazy map contribution and GeoJSON source. It shares
the obstruction glyph drawing primitive with DOF, using saturated orange, full-opacity
symbols and dark halos for contrast over chart content. Compact labels
give the structure name (such as **Crane** or **Tower**) above `MSL (AGL)` values
in feet, matching the obstruction height convention without repeated NOTAM/unit
suffixes. DOF remains magenta and has an independent lifecycle. Low/tall/wind and
grouped shapes use explicit AGL evidence; 1,000 ft AGL is the tall-symbol boundary.
Ordinary lighting words never imply a high-intensity strobe. Labels distinguish MSL
from AGL and retain upcoming, outside-schedule and uncertain-timing qualifications.
There is no DOF zoom/height cutoff on these deliberately opened notices; short
cranes stay visible. Labels may declutter while position symbols remain visible.
No camera movement or new interaction mode is imposed.

Hovering a depicted notice or focusing its entry/contents emphasizes that notice's
map geometry: area boundaries gain a bright outline with a dark halo, obstacle
points gain a ring, and their labels remain readable above neighboring symbols.
The entry receives a subtle hover treatment and the shared keyboard focus ring.
All points or areas belonging to that notice respond together. Unsupported or
not-yet-accepted geometry offers no highlight interaction. Touch scrolling does
not establish hover. The camera stays where the user left it.

Compact national TFR references participate in the same reader interaction:
hover/focus highlights all accepted areas of that exact notice, including
multiple boundaries. The national source stays installed when the reader closes;
only its emphasis is released. National and temporary source acknowledgments stay
independent, so failure of one cannot erase the other's valid interaction.

`radials.ts` recognizes explicitly unusable/restricted VOR radials such as
`HTO VOR R-236 UNUSABLE`, multiple bearings (`R-274 AND R-057`), and separate
stations in one notice. These are station radials, not `R-xxxx` restricted areas.
Hover/focus shows fixed screen-size direction arrows at uniquely resolved VOR
positions using published station alignment. Arrows and a **Direction only** label
provide reference context; they have no geographic range, width or outage boundary.
The full notice stays readable, including beyond-distance, altitude and RNAV
exceptions. Multiple bearings at one station share a label. Ordinary healthy
route references, radial sectors, malformed bearings, ambiguous/missing stations
and missing alignment do not become guessed directions. These cues are prepared
with the temporary source and remain hidden until highlighted; interaction changes
filters without resubmitting geometry or moving the camera.
Radials use the shared document control scopes: an instruction or unassembled
part cannot supply a cue. Conditional route text can supply a direction reference
because the complete qualification remains visible and the arrow asserts no
outage extent or applicability. Every bearing in a recognized list must be valid.

Each interaction belongs to its reader's preview lease and exact source revision.
Pointer exit or focus leaving the entry releases that interaction; filtering,
revision replacement, stow, area/tab changes and map failure also clear it.
An old reader's cleanup cannot clear another reader's newer highlight. Emphasis
changes only filters on layers sharing the accepted source; it does not parse,
resubmit geometry, fetch data or animate the map.

`obstacles.ts` accepts the explicit coordinate/altitude/height point format in
[FAA 7930.2 §5-2-2](https://www.faa.gov/air_traffic/publications/atpubs/notam_html/chap5_section_2.html).
The unlabeled altitude in feet in that format is MSL; parenthesized AGL is separate.
Compact DMS coordinates support fractional seconds and all hemispheres, with
validated degree/minute/second limits and the bounded recovery rules below. A leading airport identifier is stripped only
when confirmed by the record's locations. Selected explicit FDC crane/tower clauses
with MSL and coordinates also qualify; without AGL they use a neutral position ring
and `(?)` for the unknown AGL height, never an inferred low/tall classification. Multiple
explicit FDC point clauses remain separate. Note edits/conditions stop extraction
of subsequent FDC coordinates rather than promoting quoted positions.
Each accepted obstacle carries its exact coordinate occurrence in the selected
source body. The charted reader removes only that occurrence, never all tokens
with the same numeric position. Quoted/repeated coordinates remain readable.
The independent mapped-reader audit checks those spans and detects removal of
coordinates outside the mapped occurrence, alongside status/qualification loss.

Farm descriptions without supported boundaries, multiple ambiguous coordinates, unrecoverable coordinates, unknown
positions and runway-relative descriptions stay in the readable list without a
guessed point. Airport/Q-line centers and ASN/ASR references are not obstacle
coordinates. This preview does not promise complete obstacle coverage or change
plate applicability. Cancelled and definitely expired notices never generate points.

`areas.ts` uses a bounded cursor parser for circles and closed simple polygons
in AIRSPACE, NAV GPS, OBST, service-outage and supported FDC area notices, following the location forms in
[FAA 7930.2 §6-1](https://www.faa.gov/air_traffic/publications/atpubs/notam_html/chap6_section_1.html).
It consumes a location, an optional reference annotation, then a connector or
closure; it never collects unrelated coordinates scattered through prose.
Document scopes are checked before splitting multiple area introductions. A later
`DELETE NOTE`, `CHANGE`, or conditional introduction cannot restart operative
geometry parsing. Circle, polygon, corridor and multiple-area definitions have
distinct types; unsupported combinations such as an arc inside a corridor fail.
Case-insensitive tokens retain exact offsets into the original source. Circles
require an explicit NM (or nautical mile) distance and a coordinate or named center.
The observed `NMR RADIUS`, `NM OF RADIUS OF` and `NM OF` variants are accepted.
Polygons require at least three distinct vertices, at most 64 supplied locations
and an explicit return to the first point. A repeated first vertex and “point of
origin” close once; the observed “ORGIN” spelling is accepted. Coordinates support
degrees/minutes, degrees/minutes/seconds, fractional seconds and mixed precision,
with the same range checks and recovery rules as obstacle points. Self crossings,
missing closure, exclusions and unresolved additional boundary qualifications stay
as prose. Never infer operational boundaries from the Q-line or airport association.

`area-tail.ts` consumes complete supported limits, GPS tiers, service airport
lists, schedules, contacts and operational statements after the boundary. It must
consume the whole suffix; punctuation and a recognized altitude do not authorize
ignoring unknown words. Qualifications such as `ONLY THAT PORTION EAST OF HIGHWAY
101` keep the complete notice textual. Known malformed height wording remains
visible without an inferred datum, while an unrecognized radius token such as
`M179NM` cannot supply a partial numeric tier.

`area-geometry.ts` handles multi-leg corridors using the published lateral NM
distance on each side of every great-circle leg, round interior joins and flat
caps at the first/last stations. Polygon union removes shared seams and preserves
interior holes; a sub-millimeter coordinate grid avoids numerical slivers. Width
is limited to 100 NM per side, each leg to 600 NM, and input to 64 locations.
Clockwise/counterclockwise station arcs retain the published direction and radius;
endpoints must agree with the stated radius within 0.6 NM. The entire expanded
polygon must still be simple. NALU's captured clockwise arc crosses a previous
segment and remains unplotted; the parser never silently reverses it.

Multiple explicit area definitions produce one Polygon/MultiPolygon feature and
one notice label, with all source qualifications retained. Every component must
resolve before acknowledgment. Complete multipart transport markers can be masked
without changing source offsets. `multipart.ts` is shared by geometry and national
TFR source matching: it requires ordered, nonempty parts, matching totals and a
closing marker for every part (at most 99). Opening markers may be absent in NMS
renderings; duplicates, gaps, reversed order, contradictory openings and trailing
content fail. Part markers are masked only after that proof. National matching
additionally validates each envelope's identity and validity. Malformed redundant distance
annotations after valid vertices may be ignored for geometry while keeping the
full source prose. They never override the explicit coordinate. A structured
flight-check `INCLUDING … RWY … FINAL AND … DEG EITHER SIDE` qualification
after a complete polygon is retained in full and called out in the map label;
only the supplied polygon is drawn, without constructing another sector.

`coordinate-recovery.ts` recognizes exact 60-second carries and a displaced
longitude hemisphere such as `07240W00`, retaining all numeric fields. A missing
hemisphere or observed `M` in the latitude hemisphere needs a unique published
airport reference from the adjacent distance/direction annotation. The resulting
point must agree within 25 degrees and max(2 NM, 5%) of that plain-language
distance. Missing-decimal candidates use the stricter max(0.25 NM, 2%) distance
check; they are not accepted without corroboration. No digit is deleted or
inserted to force an otherwise ambiguous coordinate to fit. Two-digit longitude
is accepted without a reference only when interpreting its first three digits
as degrees would exceed 180; an ambiguous shortened `113242W` is rejected.
Recovered positions are marked **Recovered coordinate — check source** on the
map, and the reader retains the source coordinate. Navigation replacement
invalidates recovered geometry just like VOR/reference geometry.

`activity-points.ts` depicts explicitly located laser sources, free-balloon
launches and volcano advisories as source points with their complete prose.
These markers do not imply a hazard radius or a predicted balloon track.
Explicit route-amendment controlling windmills and tower-light position notices
also retain their operational text; unknown height datums remain unknown.

`area-references.ts` resolves named centers and compact, spaced or slash-separated
VOR radial/distance references against the selected navigation edition. Radials
use the station's published alignment, including fractional NM distances. Missing
alignment, ambiguous identities and unsupported station types remain unresolved;
airport variation and current magnetic models are not substitutes. Bare airport
identifiers need an unambiguous published match or an explicit airport ICAO
association. The workspace supplies airport/navaid data even when their map
symbols are hidden; replacement or late arrival recomputes geometry and follows
the same renderer acknowledgment lifecycle. Reference-dependent notices retain
their full location prose with an **Area shown on chart** receipt.

ADS-B/ADS-R/TIS-B/FIS-B service footprints retain their affected-airport lists and
altitudes, including limits after that list. Airport identifiers such as `ARC`
inside that structured list are not boundary instructions. Wind-farm and balloon
heights retain their MSL/AGL meaning and lighting status.
Point obstructions also recognize water/power/transmission towers, tower
abbreviations, antennas, silos, ship masts, rigs, parked aircraft, dirt piles and
individually positioned power lines. `obstacle-fields.ts` owns the bounded object,
identifier, relative-annotation and height fields; a cursor consumes them in order
after the shared document state admits the report. Relative annotations and
ASN/ASR identifiers never supply a position. ICAO object headings, truncated ASN
suffixes and incomplete heights retain the full source. Explicit unknown
heights use `?` in the MSL (AGL) label; missing units or datums remain in the
readable text, with no inferred elevation. A position can still be depicted when
its height is unknown. Malformed coordinates never receive guessed digits or
hemispheres.
Explicit final-approach obstacle and ramp-light reports can publish their exact
positions while retaining all prose and leaving unspecified heights unknown.
An unlabeled FAS number is never interpreted as an elevation or height.
Geodesic circles use 64–720 segments, with a radial
chord error below 0.01 NM; polygon edges use the shared great-circle sampler.
Longitudes unwrap locally across the dateline. Radii/edges over 600 NM and
geometry above 85° latitude remain text, bounding work and avoiding polar ambiguity.

Areas share the obstruction orange, with diagonal hatching over a 24%-opacity
fill, a fully opaque 2.5 px dashed boundary and a concise activity label with a dark halo
(for example **UAS** or **GPS unreliable**) with source altitude limits when
available. These are activity footprints, not an inferred entry prohibition.
One repeating pattern image supplies the hatch and tint without additional geometry
or camera listeners; it shares the preview's visibility and resource lifetime.
GPS footprints with explicit altitude/radius tiers depict the largest published
circle as **Outer extent**. All altitude tiers stay in the entry. If a later tier
is larger than the first circle, the full location sentence also stays visible
and the map omits the first circle's altitude label;
the map does not imply that the outer footprint applies at every altitude.

`chart.ts` replaces only the validated location portion of a standalone OBST
description with **Location shown on chart**. The chart labels carry its type and
heights; outages, marking/lighting status, conditions and all remaining wording
stay visible in the body even when a summary badge repeats them. Never clear an obstacle's whole readable body
merely because its coordinates are plotted. The full description remains under
**Show raw**; identity, validity and schedule stay in the entry.
Procedure amendments and area notices omit only mapped location prose,
adding **Location shown on chart** or **Area shown on chart**; their operating
limits, restrictions, exceptions and applicability remain readable.
Raw source and search always retain the complete text. Unsupported
geometry keeps its original readable text. The `charted` API store acknowledges
source ID/revision pairs only after the current map submission succeeds; loading,
failure, detachment, stow or disabling the plugin restores the full readable body.
An altitude-dependent GPS footprint instead says **Outer area shown on chart ·
Extent varies with altitude**. “Shown” describes geometry installed on the chart;
it does not promise that the location is inside the current viewport.

Identical map features share one depiction and label even when FAA delivers
separate FDC/international filings or neighboring-center notices. Each source
ID/revision retains its own list entry, raw text, timing, chart receipt and hover/
focus interaction. Geometry, label, altitude or current timing differences remain
distinct. This is presentation deduplication, not source-record reconciliation.

When the national TFR renderer has accepted every area of a matching notice,
the regional/airport entry replaces its long body with **TFR … shown on chart**,
published altitude limits and a reference to map inspection. Raw text, search,
identity, validity and schedule remain intact. Matching requires the FDC number,
start time and complete normalized body, not a `SEE FDC` pointer or `R-…` name.
Complete multipart notices compare each ordered part after validating its optional
FDC envelope, part number and repeated validity. Every body word and repeated title
remains in the comparison; basic source HTML entities compare as their characters.
Missing/reordered parts, mismatched identities or altered validity cannot compact
the notice. This includes the captured three-part New York TFR `5/2811` in KEWR's
ZNY region, as well as Baltimore `6/7096` with two boundaries.
Metadata end differences require identical complete FAA local text including its
validity range (the captured Bull Fire has an NMS end one minute after that raw
range). Missing geometry, conflicting/newer text, detail issues, pending source
replacement or map detachment restore the full body. A restricted-area name
alone never proves that its particular restriction is already drawn.

`map-state.ts` owns per-reader leases and chart acknowledgments; `map.ts` owns
images, fills, outlines, labels, source submissions and cleanup. Clears and
replacements hide old geometry immediately, before worker
acceptance; late submissions cannot reveal stowed geometry. Changed inputs coalesce
behind one pending submission. Unchanged geometry/timing does not resubmit. One
bounded retry follows a source failure, and subsequent input can retry; teardown
cancels retries/listeners and releases resources even after partial setup.

## Persistent TFR chart

Implemented with a deployed backend; frontend rollout and sustained live
qualification remain separate, as tracked in the
[roadmap](../../../docs/product/roadmap.md#airport-and-procedure-notams).
Enabling the NOTAM plugin starts a national TFR client independently of airport
selection, search, open readers or stowed panels. Disabling it aborts requests,
stops clocks and removes the map resources, context-menu action and details panel. Map reattachment
uses the current snapshot. A hidden page retains that snapshot but suspends
requests and the schedule clock. Foreground return immediately reconciles time
(including offline use and clock rollback), then resumes online refresh. Colors follow the saved schedule: active areas and
areas with an unknown schedule use solid red outlines with translucent red fill;
upcoming areas use yellow. Detail age, refresh failures and server restarts do not
change those colors. The key reads **Red: active or unknown schedule · Yellow:
upcoming**, with a reminder that colors follow the saved schedule. Neither uses
hatching. Temporary reader
geometry excludes explicit TFR text so it cannot add a second, hatched TFR shape.
TFR and temporary NOTAM fills/outlines share the map's area band: above imagery and
weather shading, below route/reference lines and entity symbols. They cannot tint
an airport's category dot or cover a point label. Temporary obstacle symbols and
area labels retain their foreground band.
Areas have no map labels. A left click or tap inside a published area opens the
shared right-side detail panel with its identity, altitude limits, current/next
window, complete raw NOTAM and a link to the FAA detail page. Overlapping areas
are listed together. From/Until times show device-local time first with Zulu in
parentheses, following the shared [date/time convention](../../../docs/features/date-time-display.md).
Right-click or long-press opens the shared map menu with
**Inspect TFRs** alongside applicable actions from other enabled plugins; releasing
the long press does not select an action. Clicking or tapping an airport or another
navigation/route point's marker or label opens that point's details, including
inside active or upcoming TFRs. Direct TFR inspection applies where no point is hit;
**Inspect TFRs** remains available in the context menu at overlapping points.
Active tools and route drags retain the shared gesture policy.
The panel has no dedicated edge tab. Reopen it by clicking/tapping an area or choosing
**Inspect TFRs**; Close, Escape and Back use the shared panel lifecycle. Its compact
typography matches other map details: 12px content, 14px notice headings and 11px
freshness metadata, with the shared panel heading. Each explicit inspection reopens
it; source/clock updates refresh its contents without reopening a stowed panel.
Selection is session-only and resolves current source
identities, so expired/removed areas are not presented as current restrictions.
The Layers footer uses a compact TFR heading and FAA index link, followed by the
index-check age and a short source-review count when geometry, schedules,
altitudes or detail freshness are unconfirmed. It uses the shared 12px heading
and 11px metadata scale with sentence case and natural spacing. The count expands
into individual notices with reasons, FAA detail links and any retained raw text.
This includes successfully downloaded notices with no usable boundary or no
published areas, independently of map selection or activation. The red/yellow
color key lives in the TFR details panel,
not the Layers footer. Both surfaces retain stale-source qualifications.

The info server prepares `GET`/`HEAD /api/notams/tfrs`, a schema-1 `TfrSnapshot`
from `packages/contracts/src/tfrs.ts`. It uses the FAA public
[`getTfrList`](https://tfr.faa.gov/tfrapi/getTfrList) index and
`https://tfr.faa.gov/download/detail_<number>.xml` documents. This is a separate
background source adapter, independent of NMS credentials and its quota journal;
airport query membership cannot establish national TFR coverage. The FAA
[site guide](https://tfr.faa.gov/tfr3/AboutTFRWebsite.pdf) describes graphical
data and notices without shapes. A published list is not a complete route
briefing or a guarantee of all restrictions, including stadium/event applicability.

`tfr-normalize.ts` verifies FDC identity and UTC validity against the raw NOTAM,
retains source text and altitude datums, and prepares each published merged area
separately. Single WGS84/GRC boundaries are supported; long great-circle edges
are densified at at most 20 NM spacing. Longitudes unwrap within one interval
less than 180 degrees wide, including date-line crossings. Polar geometry above
85 degrees, unsupported shape operations or absent boundaries remain null rather
than fabricated. Source `codeTimeZone` controls local display, not the UTC XML
dates. Missing dates may come only from an exact raw validity footer or the
explicit legacy effective-immediately/until-further-notice form.

Each area carries UTC windows, including daily/named-weekday recurrence and
overnight windows, clipped to overall notice validity. `tfr-time.ts` evaluates
the next occurrence: yellow before it, red during it, absent after its final end.
An unsupported schedule remains explicit as **Check source schedule**; its area
uses conservative red inside overall validity. It is never described as known
active. The client clock updates at boundaries and at least every 30 seconds.

Clock and loading/error notifications reuse the prepared map input until its
next schedule or detail-freshness boundary (or a clock rollback). Color changes
use MapLibre feature state; detail becoming stale or fresh does not recolor areas.
Geometry crosses the GeoJSON worker boundary only when drawable area membership
or coordinates change, including expiry. Newly downloaded but
identical coordinates reuse the accepted source even when check times change.
Actual geometry replacements retain the source-acceptance/failure guard before
inspection becomes available; remounts restore current colors on the new source.
This prevents the independently acquired detail timestamps (often about a second
apart) from hiding and re-tiling the entire national layer as each detail ages.

The collector checks the index at least three minutes after the preceding round.
It reuses details only with the same FAA ID/modification time and a known
`detailCheckedAt` less than 15 minutes old. Changed, overdue or legacy details
are acquired again with `Cache-Control: no-cache`; the independent 15-minute
interval bounds reuse when index/XML updates propagate separately without
redownloading every unchanged document on each index check. `detailCheckedAt`
records successful detail acquisition start, not index-check time; failed
acquisitions never renew it. Details are fetched sequentially, with at least one
second after the preceding response body,
30-second deadlines and durable overload backoff. Index/XML
inputs are bounded to 1/2 MiB; XML rejects DTDs and has node/depth limits. A fully
validated replacement is bounded to 8 MiB/1,000 distinct notice/issue IDs and atomically saved with
a checksum at `<NOTAMS_STATE_DIR>/tfrs/snapshot.json`, outside weather eviction.
One kernel lock owns that directory. A separate checksummed `admission.json`
reserves the restart cooldown before every request, including a bounded dispatch
margin; completed attempts establish the next index deadline. Numeric and HTTP-date
`Retry-After`, failures and quota-write failures survive process handoff or stop
further admission. Never remove the journal/provisioning marker to repair data.
This adapter does not consume NMS credentials or reset the NMS journal.

Completed details are saved to a bounded private `details.json` progress cache,
so a different failing detail does not cause successful downloads to be repeated
after a retry or restart. The progress cache never becomes a national HTTP result.
Snapshot and progress writes are atomic and synchronized. Invalid UTF-8, truncated
responses and cache corruption cannot silently change source text. Closing the
collector aborts its own transport and drains writes before releasing ownership.
An invalid, regressed or unavailable index retains the preceding snapshot and its
original `checkedAt`, with an explicit error. A revision older than published,
unresolved or privately saved detail rejects the whole index before it can
establish withdrawals; this protection survives restart. Once the complete index
validates, a failing detail becomes an explicit `issues` entry, including the
current index identity and a `detail-unavailable` or `detail-invalid` reason. Other updates and index
withdrawals can publish in the same round. Failed details may retain only their
previously published notice, with `retainedCheckedAt` equal to its original
`detailCheckedAt`; repeated failures and restarts never renew that time. Rechecks
can fail with unchanged index metadata too. Legacy snapshots without a detail
timestamp retain unknown age (null in an issue), never inferred from `checkedAt`.
A new notice without usable detail has an issue and FAA link, but no invented
boundary. All affected notices remain
available for source review in the Layers footer; retained areas show their older
detail age and unconfirmed status in the details panel. Their old validity still
limits rendering and does not establish the changed notice's timing or geometry.

`checkedAt` identifies the successful national index check. Any nonempty issue
list also carries `error: incomplete-details`, so schema-1 clients without issue
support still qualify the snapshot. Reads and health status expose
`detail-recheck-due` when any detail age is unknown or overdue and there is no
other source error, even between collector rounds. The PWA independently
qualifies old/unknown detail on its live clock while retaining its schedule colors,
and avoids an unqualified active/upcoming claim in the details panel. Detail age
appears separately from index age in the details panel and source-review disclosure. Source overload stops
further requests under
the durable backoff; remaining uncached members are accounted for as issues.
Cancellation, lost ownership, admission-write uncertainty and snapshot/progress
storage failures still abort publication. Only a validated index removes absent IDs.
HTTP reads never contact FAA; a cold cache returns 503. `/api/weather/healthz`
includes independent `tfrs` readiness, check time, failure state and next attempt.
HTTP serialization and gzip are shared for the current check-time/error boundary;
the common NOTAM delivery limit bounds slow clients.

The PWA reads every three minutes while enabled, rejects future/regressing
snapshots, and marks source data stale after six minutes or a reported refresh
failure. After clock rollback, a valid snapshot may replace retained data with
implausibly future index/detail check times, during refresh or reactivation.
Optional validated localStorage restoration is limited by the plugin's
2 MiB record ceiling. Saves use core's coordinated record update so an older
window cannot overwrite a newer usable check; equal-check error/recovery changes
remain publishable. Restoration does not rewrite the shared snapshot. Missing
locks or failed/cancelled storage never prevent online display. This route
shares the existing `/api/notams/` service-worker exclusion and reverse proxy.
The matching info-server release must be deployed to make the new route available.

Local evidence, 2026-10-05: all 90 captured FAA detail documents normalized into
105 areas, 93 with published geometry and 105 with recognized schedules. This is
a dated source sample, not a promise about future FAA documents. Captured examples
in `test/fixtures/tfrs.json` and `test/notams-tfr.test.ts` cover identity, UTC,
recurrence, geometry bounds, cache retention and HTTP/client lifecycle.
`test/e2e/notams.spec.ts` exercises persistent solid red/yellow rendering,
details, panel independence, disable/re-enable and map reattachment. Its staggered
detail-expiry check verifies no source submissions or hide/show changes, and reads
the resulting color from the real drawing buffer. `test/notams-tfr-map.test.ts`
covers idle and refreshed-source reuse, schedule/freshness transitions, geometry
replacement, clock rollback, pending acceptance, bounded retry and cleanup.

## Plate NOTAM bar

Place a horizontal strip between the plate heading and PDF reading area, with
centered **NOTAM** text, a count, and an expand/collapse chevron. This is the middle
bar in the reader layout, not a mark drawn onto the source PDF.

When relevant notices exist, the strip is red. Clicking expands the shared entry
list inline. Use the same timing sections as the airport list, separating
**Related to this plate** from **Review applicability** within each section. This
keeps every upcoming notice after active and timing-review notices, regardless of
its matching outcome. Within each applicability group, put **FDC** notices first
so procedure amendments precede other notices; preserve newest-issued order and
the stable ID tie-breaker within FDC and other notices. Use source classification,
not mentions of FDC in a D notice's text. This plate-specific ordering leaves the
airport list and semantic flair colors unchanged.

The collapsed count includes displayed non-expired
matches and review candidates; label the review count separately when present.
Omit generic **Unconfirmed** and **Coverage limited** suffixes from the bar and
procedure-row counts. An actual unresolved source record adds **Source data needs
review**; otherwise detected incomplete content or association coverage adds
**Coverage incomplete**, so a zero match count cannot imply complete coverage.
Interpretation gaps and unmatched procedure references belong in the expanded
view. Omit **Matching incomplete** from compact summaries and do not highlight a
zero count solely because interpretation is unresolved. Both collapsed bar and procedure
rows share the same qualifiers: **Offline**, **Refresh failed**, and, for
production, **Stale** or **Feed degraded** when applicable. Unrelated source-record
issues do not degrade an otherwise complete airport query. Detailed feed status
belongs in the expanded source header; notice-specific interpretation and
applicability reasons remain with the entries. When airport notices remain outside
the displayed suggestions, the expanded bar offers **Show remaining airport NOTAMs**
with their count, using the same current airport snapshot and timing rules. Exclude
notice IDs already displayed in either applicability group; keep each displayed
notice's full content and raw text accessible. The remainder describes which notices
have not been shown, without asserting that they are irrelevant to this plate.
With zero suggestions it contains every retained airport notice; omit the disclosure
when none remain. An empty snapshot says **No retained airport NOTAMs.** Unmatched
procedure references remain listed separately, including references from notices
already shown above. The remaining list renders only when opened.
Count each source notice once even if several clauses match. Multipart groups
retain their individual parts' identities and counts.

The expanded area has a maximum height based on available reader height and its
own scrolling, with a tighter cap in short readers. Keep the collapse control,
PDF controls, and some reading area reachable on short phones. The disclosure
participates in layout rather than covering chart content. Scrolling it must not
trigger PDF pan/zoom. The strip stays
reachable while its list or the PDF scrolls.
Keep the source status spaced apart from the plate title and the first
timing-section heading so the source information and notice groups remain distinct.
Within plate results, use a compact 4 px gap before disclosures and omit trailing
notice-group padding so **Show raw** and **Show remaining airport NOTAMs** stay close.
Both disclosures retain their shared pointer and touch target sizes.
The title uses the shared 14 px heading scale. Empty, recovery and unavailable
states use the same compact status typography as airport lists; catalog retry
keeps its shared button styling. The bar label wraps beside a separate chevron,
and procedure-row counts wrap within their existing metadata layout.

| Data state | Bar behavior |
| --- | --- |
| Current matches or review candidates | Red strip with counts, timing qualifiers, and expandable entries |
| Complete, fresh query with zero matches | Neutral `NOTAM · 0 matched`, limited to the supported scope |
| Loading without a snapshot | Loading state, never a zero count |
| Saved/stale snapshot | Retain match counts with collapsed freshness, offline and failure qualifiers; show source age in the expanded header |
| Partial feed with a snapshot | Qualify counts with detected coverage/source issues; show feed status and recovery in the expanded list |
| Unresolved interpretation | Keep compact counts unchanged; show matching limits, unmatched references and all airport notices in the expanded view, including with zero matches |
| Unresolved page or failed query without data | Explicit unavailable matching state with recovery |

The expanded strip keeps every airport notice accessible either in its suggested
groups or under **Show remaining airport NOTAMs**. A notice with an unresolved
heading stays complete wherever it is shown, without appearing in both places.
Opening the remainder does not create plate matches or chart overlays. Apply the staging presentation
above; production keeps source freshness
and actual incomplete states visible. Unresolved interpretation remains explicit in
both environments, without repeating general regional/route-scope explanations.
Counts beside supported procedure rows in the Plates list use the same airport snapshot
and matcher, without a request per row.

Support both side-reader and fullscreen `PanelSurface`. Use core focus/touch
sizing, `aria-expanded`/`aria-controls`, and a labeled scroll region. Red denotes an
alert; core's danger-button variant denotes deletion and should not be repurposed.
Keep focus valid when collapsing and announce status changes without stealing
focus or repeatedly announcing each refresh.

Opening, updating, or collapsing NOTAMs must not remount/refetch the PDF, recreate
its worker, or reset scroll/zoom/rotation. Reuse existing reader height-change
handling. NOTAM loading and failure remain independent of PDF loading and failure.

### Displayed page identity

Users can navigate an entire combined TPP volume, so the original
`ProcedureSelection` cannot identify every displayed page. Plates must expose
context for the actual rendered page, tied to exact catalog identity, document
hash/URL, page index or named destination, airport, and edition.

Resolve indexed book pages through the owning catalog. Continuations share a
procedure only when publisher identity and consecutive targets establish it, as
current Plates grouping requires. Individual PDFs retain their explicit procedure
target. Shared minimums documents require airport/section context from the exact
indexed page; offer the indexed choices when more than one section shares it.
Other unresolved or ambiguous pages show matching unavailable; never carry a
previous airport's confirmed notices onto another page.

New selections pin the catalog resource alongside their document and procedure
identity. The page resolver reads that exact catalog to obtain airport FAA/ICAO IDs,
the full procedure record and amendment metadata, checking the displayed edition
and published page target. Legacy selections without the catalog pin remain
readable but cannot establish matching context; reopen the procedure from its
catalog. A failed pinned-catalog read can recover through Retry or reconnect
without replacing the PDF. No fallback silently adopts another edition.

## NMS source contract

The original staging onboarding package was reviewed on 2026-10-04. The subsequent
production package contains the same OpenAPI specification and FAQ content, with
production credentials and connection examples. Use the dated specification and
FAQ as the source contract, resolving the discrepancies below during qualification.

| Supplied material in local `nms/` | Evidence and limitations |
| --- | --- |
| `Gmail - Onboarding onto NMS-API - INC0033186.pdf` | September 25, 2026 staging onboarding; validate before requesting production next steps |
| `Gmail - Follow-up Email.pdf` | Separate workbook password delivery; no product/data contract |
| `ZLayer.xlsx` | Read in memory with the supplied password; contains Key and Secret; values excluded from documentation/fixtures |
| `FAQ NMS-API.pdf` | Authentication, token expiry, content authorization, environment caveats, and request limits, especially page 5 |
| `nms-api.yaml` | OpenAPI 1.0.18, revised February 12, 2026; endpoint/schema baseline |
| `nms-api_curl_examples.txt` | Connection examples; direct signed-URL wording predates the content-proxy contract |
| `NMS-API-Pre-Prod-soapui-project_sample.xml` | REST configuration despite the SoapUI name; older parameter descriptions and embedded authentication material |
| `nms_api_initial_load_example.json` | Historical signed GCS URL response; not a reusable URL or NOTAM payload |
| `nms-api_sample_initial_load.xml` | SOAP/AIXM domestic lighting and ARTCC UAS examples; two members despite a collection count of 21,468, so not a complete-load fixture |
| `nms-api_checklist_example.json` | Active inventory IDs, classifications, locations, accountability and update times; no bodies |

Keep private onboarding artifacts separate from tracked documentation, public
assets, and sanitized fixtures. Their continued presence is not needed to understand
this guide. Do not copy credentials, tokens, passwords, or signed URLs into logs,
builds, source examples, or browsers. No authenticated requests were made during
the initial documentation review; the subsequent implementation exercise is
recorded below. Vite denies `nms/` and `.cache/` as development assets.

### Staging evidence, October 4, 2026

One all-class initial load and budgeted global deltas were exercised against the
supplied staging host, using the collector's durable journal. No production
requests or deployment were performed. Private source captures and credentials
were excluded from tracked files; regression fixtures use invented content.

- OAuth returns decimal-string `expires_in` and `BearerToken`; the adapter also
  accepts numeric expiry and `Bearer`. Renewals use the actual expiry.
- The gzip bulk declared and delivered **74,831** members: 20,854 DOM, 4,676 FDC,
  43,907 INTL and 5,394 MIL. Its timestamp was `2026-10-04T22:48:04.879Z`.
  The compressed file was 44,814,701 bytes. Complete normalization took about
  nine seconds on this development host; normalized records occupied about 93 MB.
- Some `lastUpdated` timestamps have nine fractional digits. Ordering retains
  their original precision. Some messages contain an additional annotation-only
  EventTimeSlice; exactly one NOTAM-bearing slice is required. ICAO translations
  use `formattedText` with XHTML, preserved as inert text with line breaks.
  A year-0001 placeholder becomes unknown time. Some source bodies exceed 64 KiB;
  the bounded text limit is 256 KiB per body/translation.
- Global deltas include original source IDs with `FNSE:canceled` timestamps.
  These become tombstones. Type C is a separate cancellation notice and never
  identifies the cancelled source ID by itself. Type R remains an active
  replacement; the old notice's cancellation arrives on its own source ID.
  Structured referred series/number/year and raw translations are retained.
  Some legacy bulk records omit type; absent `canceled` retains their source state.
  Unknown change types or invalid cancellation timestamps fail the update.
- A 29-member delta included 15 original-ID cancellations, seven active records
  and seven cancellation messages. A later collector round restored the candidate,
  bridged from its source timestamp, and published 72,306 retained records after
  old cancellation-message/tombstone pruning. Local MIA, SAC and SNA reads worked.
  The complete exercise reached about 507 MiB RSS with qualification buffers
  still retained. This is evidence of a working path, not a shared-weather
  capacity or production-completeness qualification.
- FDC SID headings often list several `… DEPARTURE...` lines without amendments.
  Some FDC records carry EST only in the original text's validity suffix; the
  adapter requires it to identify the same structured end time before applying
  the estimated qualifier.

### Production verification, October 5, 2026

Production credentials and environment selection enabled the existing collector
without server-code changes. Authentication, an all-class initial load and its
subsequent budgeted delta succeeded, publishing a production generation with
`ready` state and complete continuity. The public API checker passed production
airport reads and the existing weather products after restart. Staging state and
its request-budget journal were preserved separately.

This records the initial production rollout, not ongoing freshness, broader
applicability or sustained capacity qualification. Host configuration, release
identity and rollout results remain in private operations. UI status always follows
the returned snapshot rather than assuming this rollout makes later data current.

### Authentication and environments

Staging data uses `https://api-staging.cgifederal-aim.com/nmsapi`; production is
listed as `https://api-nms.aim.faa.gov/nmsapi`. Authenticate at the chosen host's
`/v1/auth/token`, without `/nmsapi`, using OAuth2 client credentials and
`grant_type=client_credentials`. Provision credentials in server configuration.
The example lifetime is 1,799 seconds; honor actual `expires_in`, coalesce renewal,
and bound retries after 401. Invalid credentials differ from an expired token.

Staging can contain test-generated notices. Include environment in dataset/cache/
checkpoint identity; staging data must never appear as production. Retain normal
TLS verification; examples weakening certificate checks are not adapter policy.

### Endpoints and request budgets

| Endpoint under `/nmsapi` | Planning contract |
| --- | --- |
| `GET /v1/notams/il` | All active classifications in compressed SOAP-wrapped AIXM; one complete bootstrap/rebase |
| `GET /v1/notams/il/{classification}` | Same AIXM format for one classification; does not select GeoJSON |
| `GET /v1/notams` | Required `nmsResponseFormat: AIXM` or `GEOJSON`; filters combine with AND; no-parameter request is invalid |
| `GET /v1/notams?classification=…` | A sole classification filter returns full-classification content through a temporary URL; other filters return data directly |
| `GET /v1/notams?lastUpdatedDate=…` | Created, updated and cancelled notices, including inactive records; YAML limits lookback to 24 hours |
| `GET /v1/notams?nmsId=…` | One active/inactive notice for diagnosis or repair within budget |
| `GET /v1/notams/checklist` | Active inventory, optionally filtered by location/accountability/classification; reconciliation cadence needs qualification |
| `GET /v1/locationseries` | YAML specifies active mappings without a date; dated deltas include N/U/D statuses, with five-day lookback |
| `GET /v1/content/{token}` | Authenticated binary proxy; temporary references expire after five minutes |

The FAQ specifies pre-production limits of one request per second, approximately
two per second for content, and at most one delta pull every three minutes.
Production allows one data pull every three minutes and at most one bulk pull per
24 hours using initial-load or full-classification retrieval. More frequent use
needs FAA approval. These are shared credential limits across replicas, restarts,
retries, and administrative tools, not per-browser allowances.

Do not assume separate DOMESTIC/FDC bulk calls have separate daily quotas. Use one
all-classification AIXM initial load and AIXM deltas initially, with one normalization
path and JSON delivery to browsers. Retain every current record delivered by that
authorized feed, across classifications; apply the first release's D/FDC display
scope locally. GeoJSON remains an option once its benefits and bulk budget are
established. `DOMESTIC,FDC` is not a documented classification value.

Location accepts domestic/ICAO IDs. Accountability identifies the issuing office,
not the airport. Effective start/end filters must be paired; geospatial requests
require latitude/longitude/radius together, with radius limited to 100 NM. Do not
add active-location filters to the global delta until their interaction with
cancelled records is proven.

### Conflicting and incomplete examples

- SoapUI describes a 72-hour NOTAM delta window; YAML specifies 24 hours. Plan for
  24 until confirmed otherwise. SoapUI's location-series default is a one-hour
  window, whereas YAML specifies active initial load without a date.
- Older JSON/cURL/SoapUI use direct signed GCS URLs. Newer YAML/FAQ use an
  authenticated content proxy. Examples vary between `/v1/content/…` and
  `/nmsapi/v1/content/…`; resolve documented forms against the configured host
  without duplicating or dropping `/nmsapi`.
- Records may use `DOM` while request/checklist classification is `DOMESTIC`.
  Payload IDs may start `NMS_ID_` while query IDs are 16 digits. Preserve originals
  and normalize only demonstrated equivalents.
- The schematic GeoJSON example pairs `type: N` with a NOTAMR translation, has
  string-valued fields, and includes an incomplete polygon. It does not establish
  replacement semantics or valid geometry.
- A `feature` query filter does not guarantee a structured keyword or a d-TPP
  procedure identifier in each returned record. Text parsing/catalog matching
  are still needed.
- The examples do not qualify FDC amendments, lifecycle chains, multipart
  completeness, all schedules, or airport-association coverage.

## Collection and delivery

Maintain a complete local copy of the current NOTAM dataset available through our
NMS credentials. Retain normalized records and complete raw translations for all
locations and classifications delivered by the feed, including published upcoming
notices. The first PWA query for an airport is served locally just like a repeated
query. Collection runs independently of which airports users view or how many
queries they make.

All supported PWA queries use this dataset. Collection continuity means every
identifiable record in each accepted response is accounted for at the published
source boundary, either as resolved data or an explicit source issue. It does not
mean all source versions agree. Airport content coverage additionally requires
no relevant unresolved source records. Operational applicability follows the
narrower [product scope](#scope-and-ownership).

### Sync policy

| Work | Implemented cadence and behavior |
| --- | --- |
| Initial full sync | One all-classification initial load when no usable baseline exists and the durable bulk budget permits |
| Incremental sync | Target one global delta every three minutes; include created, updated and cancelled records, with overlap |
| Scheduled full reconciliation | Target one all-classification full sync per rolling 24 hours, never sooner than 24 hours after the preceding bulk attempt; rebuild and reconcile even when deltas appear healthy |
| Recovery replay | Replay from a verified complete previous checkpoint within the delta window, using the ordinary delta allowance; publish only after complete validation |
| Recovery full sync | Use the same bulk allowance after lost continuity or invalid state; no separate emergency quota or restart allowance |
| Browser query | Local indexed read only, including new airports and query-result cache misses |

Full syncs and deltas use the same collector and shared data-pull admission.
A scheduled full pull takes an allowed request slot; it does not run beside a
delta in violation of the three-minute limit. Fetch referenced content within its
lifetime using the qualified content-endpoint allowance. Backoff and failed
attempts can postpone either schedule. Do not run catch-up bursts after downtime
or interpret a new calendar day as a reset of the rolling bulk limit. Checklists
remain an optional additional check after their request accounting is qualified.

Request admission is independent of HTTP demand and the weather queue. All NMS
requests, including OAuth and referenced content, start at least one second after
the preceding response headers or transport failure. Data pulls share a
three-minute cooldown; bulk pulls additionally require 24 hours. Token attempts
have their own three-minute cooldown, including failed authentication and process
restarts; successful tokens are reused until 30 seconds before expiry. There are
no immediate authentication retries, per-airport FAA queries or parallel class
pulls. Thus normal collection permits at most 480 data starts in a rolling day,
one of which may be a bulk request, plus its one content fetch and token renewals.
Actual cadence is slightly slower because the 30-second scheduler and response
time can postpone the next eligible request.
The short spacing wait rechecks its wall-clock deadline after waking. An early
timer wake must wait the remaining interval, not abandon the content fetch after
the daily bulk request has already consumed its allowance.

Before dispatch, the journal reserves through a bounded 120-second dispatch
window plus the applicable cooldown. The client refuses to send after that
window or without the writer lock. On response headers or transport failure, a
serialized durable completion replaces that provisional margin with the normal
cooldown from completion; 429/503 `Retry-After` (seconds or HTTP date) is persisted
in the same write. An interrupted attempt retains the full conservative margin.
An uncertain journal write disables further admission from memory. Wall-clock
rollback cannot bypass a recorded deadline; production hosts must maintain a
correct synchronized clock. Excess scheduler ticks never accumulate work.

1. Restore a verified generation containing environment/source identity,
   schema/adapter version, records, watermark and source check, plus the independent
   quota journal. Restart or generation rollback must not reset the bulk allowance.
2. Bootstrap when no usable baseline exists and budget permits. Download content
   within its lifetime; stream decompression and namespace-aware XML parsing.
   Enforce compressed/expanded-byte, record, depth and per-record limits, and
   disable external XML entities.
3. Establish the baseline's actual timestamp and bridge its changes through the
   present. Retrieval time is not snapshot time. Do not declare completeness if
   the gap cannot be closed within the supported lookback.
4. Pull deltas at most every three minutes, with a conservative overlapping lower
   bound for timestamp precision/repeated delivery. Merge idempotently by source
   ID and qualified revision/update metadata.
   Compare the source timestamp through nanoseconds, then sequence and correction.
   The raw record digest includes original spellings; it is not a semantic revision
   number. Equal source ordering does not establish byte-identical FAA renderings.

   Reconciliation first distinguishes active records from inactive lifecycle state.
   At equal ordering, the same source ID and the same `cancelled` or `cancellation`
   lifecycle are an idempotent inactive observation: retain the earlier raw record
   unless a later cancellation timestamp extends retention, in which case retain
   that original record. Presentation differences do not break continuity, and
   neither choice advances source revision ordering or collection freshness.
   These records are excluded from the active airport index; their text may shrink to a terse
   cancellation rendering without affecting active coverage. A cancellation
   message is distinct from an original-ID tombstone. Their references never
   remove another source ID. An original-ID `canceled` timestamp at or after the
   source update instant, including fractional precision, establishes cancellation
   over a rendering that omits that field. Cancellation is an independent event
   and need not advance `lastUpdated`; requiring timestamp equality would leave
   confirmed cancellations unresolved. Source ID, classification, notice
   number/series/year and change type must agree. Absence of the optional field
   cannot resurrect this tombstone. Missing, invalid or older cancellation
   evidence and active/NOTAMC disagreements remain unresolved. Newer source
   revisions follow the usual ordering. Envelope, source-ID,
   record-bound and lifecycle validation always precede reconciliation.

   Active records retain stricter content checks. At equal ordering, the
   demonstrated `NMS_ID_` alias and equivalent
   update-time fractional-zero spellings do not make a conflict. Decimal notice
   and referred numbers compare without leading zero padding; composite identifiers
   remain exact. Translations are optional representations grouped by type, not
   an ordered list of required fields. Shared types compare after whitespace
   normalization and removal of the observed literal `<pre>` wrapper. A complete
   shared native notice can establish the record independently of its auxiliary
   ICAO renderings: each DOMESTIC/FDC record must retain exactly one distinct
   `LOCAL_FORMAT` text, both texts must agree, and its identity, complete body,
   interval and end qualifier must account for both records. Domestic evidence
   additionally checks the issuing office, location and local notice number;
   its body may include the separately supplied matching schedule. FDC evidence
   uses the qualified forms below. Other core fields still have to agree.
   Captured source pairs demonstrate different ICAO Q codes/radii, omitted
   subject words, headers and conversion artifacts for that same native notice.
   Retain those original ICAO renderings without treating them as distinct native
   revisions or claiming that their individual fields are equivalent.

   Without that complete native witness, recognized ICAO NOTAMN layouts retain
   the stricter comparison: paired domestic/international header
   numbers may differ across those two formats; different numbers, series or years
   within one format are conflicts. Missing Q-line traffic/purpose/scope values may be
   supplemented. All supplied values must agree; FIR, code, altitude, coordinates
   and the complete A)-onward content remain exact. Unrecognized layouts and
   replacement/cancellation references receive no such relaxation. Arbitrary
   markup, case and punctuation are not discarded. Missing types do not withdraw
   previously supplied translations. Retain earlier raw spellings and append new
   types or qualified auxiliary ICAO variants within the existing record limits.
   Every retained core/native variant constrains later comparisons; without a
   native witness an empty ICAO qualifier cannot override a populated value.
   Alternate renderings can also differ in issue time;
   retain the earliest supplied issue time without changing update ordering,
   effective times or freshness. Hash the combined normalized record. Never carry
   old translations into a newer revision. An E)-only body and a full ICAO body
   reconcile only when both records retain the identical complete ICAO translation
   and its E)-onward content matches the short body. Retain the short body and the
   complete raw translation, including any F)/G) suffix. Missing structured referred
   metadata may be supplemented; two supplied references must agree. References
   never identify another source ID for deletion.

   FNSE ICAO associations are also optional evidence: a missing list can be
   supplemented from the same revision, while two populated lists must name the
   same set. No domestic-to-ICAO alias is invented. The demonstrated
   `Daily:HHMM-HHMM~DLY HHMM-HHMM` schedule equals its readable `DLY` form only
   when both supplied windows agree, using the same rule as validity display.
   The raw schedule stays intact. Domestic schedule metadata may also omit the
   schedule or its hours while both records retain the same complete native
   notice and body. Reconcile those omissions only against one terminal schedule
   in that shared body: every supplied weekday and hour must agree. Supported
   evidence is a weekday list/range or `DLY`/`DAILY` with one valid UTC window;
   overnight windows and an end of `2400` are allowed. Weekday ranges and their
   expanded lists identify the same days. Multiple windows, exceptions, unknown
   expressions, different days/hours and missing or mismatched native evidence
   remain unresolved. Keep the fuller original schedule field, including its raw
   spelling, so sparse replays cannot erase known hours. Never synthesize a field
   from prose or let a partial field overrule a complete one.

   Whitespace-only body differences also reconcile through an identical complete
   native notice. Retain the first original body; do not discard changed words,
   punctuation, case, units or digits. These representation repairs change neither
   source revision ordering nor collection freshness. Verified saved issues are
   reconsidered on restore using all retained variants, preserving incomplete
   collection checkpoints, genuine conflicts, overflow evidence and quota history.

   Derived end kinds are compared after combining
   compatible optional evidence: a matching retained `EST` suffix can qualify
   a representation whose missing local translation caused a fixed-end default.
   Different end instants, conflicting suffixes and unknown/permanent ends are
   not converted into estimated ends by this reconciliation.

   FDC bodies may include or omit the subject (`IAP`, `SID`, `STAR`, `ODP`,
   `ROUTE`, `VFP`, `SPECIAL`) and trailing validity interval. Reconcile those forms
   only through an
   identical complete `LOCAL_FORMAT` translation retained by both records, after
   whitespace normalization. Its FDC number/year, airport, interval and end qualifier
   must match each record; both bodies must equal a supported form of that exact
   translation. Preserve the first raw body and all compatible translations. An
   optional ICAO rendering may carry older dates and cannot substitute for this
   local evidence. A `PERM` wrapper additionally requires a permanent structured
   end, literal `PERM` effective end and no normalized expiry. Changed restrictions,
   conditions, identities or dates still
   conflict. An optional `EST` suffix on the compact structured end is equivalent
   only when both records have the same known estimated end instant; fixed,
   permanent and unknown ends do not receive that tolerance. Original end spellings
   remain retained, and reconciliation never advances source time by itself.

   All other notice fields, including lifecycle and effective-time qualifiers,
   remain exact. An unrecognized difference becomes an explicit source issue for
   that ID; it does not reject independent IDs or stop collection. Equivalence
   rules improve the usable interpretation, but are not a prerequisite for
   collecting the next valid response. See [unresolved records](#unresolved-source-records).
   The current overlap is ten minutes, accommodating timestamp precision and
   delivery lag while remaining inside the 24-hour query window. It is not proof
   of an upper bound on FAA delivery latency.
5. Advance the collection watermark only after the entire response is structurally
   validated and every ID is durably accounted for as resolved data or an issue.
   Use a qualified source boundary or conservative request-start boundary, not
   response completion or the newest record. An empty delta follows the same rule.
6. Apply replacement/cancellation events using verified source semantics. Retain
   tombstones long enough to prevent resurrection from overlap, including the
   bridge after a full snapshot omits the cancelled ID. Absence in a delta
   or a shared display number is not cancellation evidence.
7. Commit resolved records, source issues, indexes, watermark and source-check time
   as one atomic generation.
   Continue serving the preceding generation while preparing. HTTP 200 alone is
   insufficient: check envelope `status`, `errors`, format and full consumption.
8. Perform scheduled full reconciliation even when continuity appears healthy.
   Build a candidate from the complete bulk load, bridge its deltas through at
   least the published generation's watermark, and then atomically replace the
   live generation. Retain the preceding generation while downloading/validating;
   an older bulk timestamp must not regress already published updates.
9. Compare source IDs/revisions across the complete generations. A notice absent
   from a verified, equivalently scoped full snapshot can leave the current set
   only after the snapshot boundary and intervening changes are reconciled. A
   partial bulk load, filtered result or missing delta entry never proves removal.
   Preserve bounded tombstones/history separately from the current set. A still-present
   equal-revision conflict survives a full load containing only one of its versions.
   Absence can resolve an issue only when the actual full snapshot is at least as
   recent as the preceding collection watermark, and its bridge succeeds. Conflicts
   never cause per-ID request bursts or reset the ordinary collection schedule.

If the required delta lower bound, including overlap, exceeds the 24-hour lookback,
or the live baseline/continuity cannot be verified, retain the last usable generation
as stale/incomplete and rebase when permitted. A failed replacement alone leaves
the verified live generation usable; continue its deltas when budget permits.
When a replacement bridge fails and the live generation remains eligible for deltas,
discard that candidate and resume the live feed at the next allowed attempt. A
bootstrap candidate without a usable live baseline remains available for bridge
retry within the lookback window. Only a continuity failure in the live delta path
marks its current checkpoint incomplete; replacement failures do not change that checkpoint.
Before that invalidation, retain the exact verified prefix as the previous
generation. A rejected delta has not changed its records or watermark. Recovery
can replay every delta from that authenticated prefix when its boundary plus
overlap is still inside the source window. It can also recover an older invalidated
checkpoint from a separately verified complete previous generation. Publish and
clear the failure only after the entire replay validates; never set an incomplete
checkpoint complete merely because code changed or the server restarted. Missing,
corrupt, incomplete or expired recovery prefixes require the next permitted bulk
load. Replays consume the normal global delta allowance.

A due full reconciliation takes priority over replay or an old candidate bridge.
A failing replay must not hold the feed incomplete until its lookback expires
when a fresh baseline is already permitted. Keep a usable candidate until the
replacement bulk validates and is durably saved. If the bulk attempt fails, its
daily allowance remains consumed and the next budgeted round can retry the retained
candidate; neither retry nor restart resets quotas. A successful bulk remains a
candidate until its complete delta bridge validates.

Persist the original collection-gap reason in the checkpoint through recovery waits
and restarts. Legacy checkpoints invalidated by `revision-conflict` or
`unsupported-lifecycle` still require a verified replay before advancing. Their
records are not made complete merely by upgrading the implementation. During that
replay, unresolved IDs enter the new issue collection and independent updates can
commit normally. Missing or expired prefixes still require a budgeted full load.
Honor 429/503 backoff and `Retry-After`; retries consume budget.

### Unresolved source records

`collection.ts` separates per-record interpretation from collection continuity.
Within a batch, group records by source ID and retain the newest qualified source
ordering; equal-order variants must all constrain reconciliation. A sparse
representation cannot erase a disagreement between richer representations.

Unfamiliar same-order content, unqualified active/inactive disagreements, unknown lifecycle
values, and representations that cannot fit the bounded merged record become
`NotamSourceIssue` entries. They are excluded from resolved records, matching and
map symbols. Preserve their raw bodies/translations and reason. Their presence
does not prevent cancellations, new notices or updates for other IDs from being
committed at the same source boundary. Empty and repeated deltas still advance
collection time; they do not resolve an issue. A newer source revision can replace
it, subject to the same interpretation checks. Daily reconciliation preserves
still-present equal-order disagreements and overflow evidence.

A full snapshot can remove an absent record or issue only when its source time
covers the current collection watermark and is strictly later than that record's
update time. Otherwise retain it through the bridge. This also protects
observations newer than a conservative watermark from an older full snapshot.

Each issue retains up to eight distinct source variants and the union of their
known domestic/ICAO associations. More variants set a durable
`variantsTruncated` flag; the UI identifies the retained versions as non-exhaustive,
and replaying those samples cannot restore confidence. This bounds evidence for
one ID without discarding the ID or treating one sample as authoritative. Only a
newer revision or qualified full-snapshot absence clears overflow. Association
unions retain up to 32 IDs per namespace; missing associations or overflow set
`unscoped`, qualifying every airport query. Known scopes qualify the union of all
versions' airports. Issues never disappear through display filters, expiry of a
single variant, or optional diagnostic failure.

Collection-level failures remain strict: malformed/truncated envelopes, missing
source identity or ordering, invalid boundaries, download/parse limits, and failed
durable publication cannot advance the collection watermark. The former
`conflict.json` diagnostic is superseded by checksummed issue records. Logs contain
safe failure codes and changes in unresolved-record counts, not source bodies,
credentials or content references.

Follow same-origin allowlisted content routes; never forward credentials to an
arbitrary redirect host. Preserve safe request IDs for diagnosis. An expired
content reference enters budget-aware recovery, not an unbounded download loop.

The server permits at most three content-download attempts against the same
validated reference within the original 120-second download deadline and the
reference's five-minute lifetime. Transport failures, truncated/empty bodies and
transient source responses can retry after durable spacing/backoff. Partial files
are removed before retry. Long `Retry-After`, authentication failures, redirects,
size limits, local storage failures and shutdown stop recovery. Retrying content
never obtains another `/il` reference or renews authentication; the consumed daily
allowance and original snapshot request boundary remain unchanged.

### Storage and query indexes

Index source IDs, qualified location associations and classifications per
generation. The airport tab and plate views share one airport result. PWA clients
download relevant subsets; retaining other records does not enable unqualified
geographic or route applicability queries.

Indexed reads feed a 128-entry, 32 MiB LRU response cache, counting JSON and gzip
bytes together. Canonical queries share serialization and in-flight compression.
The complete feed status is the cache boundary, so generation, check time,
freshness, continuity, errors and retry changes invalidate even cached empty
results. Oversized responses cache an explicit unavailable result, never an empty
success. Dropping a derived response never drops source records or triggers FAA
acquisition. Response construction checks the 16 MiB limit incrementally, including
individual issue variants, before allocating the whole response.

The listener admits at most 16 simultaneous NOTAM deliveries, holding capacity
through compression and socket completion. Excess readers receive a local 503
with a one-second retry hint; NOTAM health bypasses this limit. The existing socket
timeout bounds stalled clients. These bounds protect local delivery resources;
they cannot increase NMS demand. HTTP receives only the collector's read/status
capability, with no refresh or source-request entry point.

Keep durable state outside the disposable weather cache. Partition it by source
environment and schema/adapter identity. One credential-level collector owns
ingestion; a local writer lock prevents duplicate writers on one host, and
deployment must enforce that ownership across hosts. A database is not required.

- **Budget journal:** durably reserve request class, attempt time and next allowed
  time before sending. Failed or interrupted attempts consume their slot. Persist
  this independently of dataset publication, with file/directory synchronization;
  restart, credential rotation and generation rollback cannot reset allowance.
  Version 2 journals authenticate their fields with a SHA-256 checksum; metadata
  reads are bounded to 16 KiB. Legacy version 1 remains readable and retains all
  existing deadlines, conservatively deriving the first token deadline from the
  last attempt. The next mutation writes version 2. All reservation, completion
  and backoff writes serialize and recheck admission after the preceding write.
- **Dataset generations:** commit resolved records, source issues, indexes,
  watermark and source-check time with a checksummed manifest atomically. Pin readers to a generation and retain the
  previous complete generation during construction. Bound retired generations,
  tombstones and spool files without evicting current notices.

Current hard limits are 64 MiB per bulk download, 32 MiB per delta, 512 MiB expanded
XML, 150,000 records, 2 MiB per XML member, depth 80 and 256 MiB per normalized
generation. Airport responses stop at 5,000 records or 16 MiB, returning unavailable
instead of truncating. UTF-8 decoding is strict for envelopes and XML; invalid
bytes cannot silently rewrite source text. Downloads have a 120-second deadline.
One 60-second parsing worker handles each round. Measured
staging parsing fits that deadline; deployment headroom still needs qualification.
Keep current, the previous distinct dataset and one candidate generation, and retain
cancellation messages/tombstones for two days after the later of their source
update and valid cancellation timestamps. Missing cancellation timestamps use the
source update time; active notices do not expire under this rule. A bulk snapshot's
absence cannot shorten this retention, and the bridge applies the same expiry as
ordinary deltas. Retention does not change source revision ordering or quota.
The lock owner removes unreferenced dataset files at startup and after
publication/candidate disposal, including failed
replacement attempts. Cleanup never removes the admission journal. Empty, duplicate
or older-only deltas reuse the immutable record array, dataset file and airport
indexes; only the small manifest advances source time and watermark. Changed datasets
are written in bounded buffers.

Version 2 manifests authenticate both ordinary record lines and tagged issue lines
in the same NDJSON dataset, with separate counts and a shared byte/digest identity.
The manifest itself has a separate checksum covering its source times, continuity
and dataset reference; plausible numeric corruption cannot silently advance a
watermark or make an incomplete checkpoint complete.
Version 1 datasets remain readable; the next publication writes version 2 without
resetting source times or the independent quota journal. Rollback requires a
backend that can read version 2 datasets and journals: never roll back dataset or budget files to make
an older binary start. Current, previous and candidate retain the same bounded
lifecycle. Issue evidence is not silently resolved while restoring or upgrading
saved derivations.

On restore, validate the saved dataset's checksum before upgrading derived end kinds
and revisions from its retained source text/translations. Atomically republish its
manifest when an upgrade changes the content; retain source times, continuity and
quota history. The same validity interpretation applies to saved browser snapshots.
This avoids revision conflicts with unchanged source records after a normalizer fix.
Restoration also reconsiders each complete retained issue through the same
collection rules. Only an issue whose entire saved evidence now reconciles becomes
a resolved record. Truncated evidence, unknown lifecycle and genuine disagreements
remain issues. Save the resulting authenticated generation without changing its
collection timestamps or completeness flag; an incomplete collection still needs
its ordinary replay/rebase. The separate request-admission journal is unchanged.
This makes corrected interpretation available for old issues even when their IDs
no longer occur in the delta overlap, without another FAA request or a quota reset.
Capacity accounting includes current, preceding and
replacement generations, raw text, indexes and temporary work. Insufficient
capacity rejects publication; it never justifies a truncated dataset. If admission
cannot be persisted, stop source requests. Corrupt/missing state needs conservative
recovery, not deletion and a new daily allowance. Provisioning, migration and backup
restoration must account for requests already made with the same credentials.

## Airport query contract

Use `GET`/`HEAD /api/notams/airports?faaId=…&icaoId=…`. Require at least one named
identifier and accept at most one of each. Both fields describe the same published
airport; trim and uppercase values, preserving their namespaces. Reject malformed,
oversized or duplicate parameters. Catalog `id`, map feature ID, generic `ident`
and NOTAM source ID are not airport-query identifiers.

The client owns the airport-to-alias relationship:

- Navigation supplies `faaId` and `icaoId` from one published airport feature.
  `airportNotamQuery` trims and uppercases them while retaining the originating
  field's namespace; it is not an alias lookup service.
- Plates supplies those fields from the actual page's `ProcedureAirport`, together
  with pinned catalog identity, as described under
  [displayed page identity](#displayed-page-identity).
- Send both published IDs when available, including non-`K` ICAO codes. Never
  invent an alias, use a display ID as fallback, or combine IDs from different
  airport records. Missing/conflicting context produces matching unavailable.

The server unions exact matches against its qualified domestic-location and
ICAO-location indexes, deduplicating by source identity. Echo the normalized
selectors and each record's association evidence. A caller-supplied pair is not
proof of an alias relationship and never updates a global alias registry. Additional
associations require independently qualified source evidence. This keeps alias
ownership with the published airport data without adding a second navigation-feed
loader to the weather service.

Return versioned records, supported scope, environment, generation, source-check
time and continuity. Zero means no records for the supplied selectors in a verified
complete generation; absence from the NOTAM index does not prove that an airport
is unknown or invalid. The client must have resolved airport identity before
presenting that zero. This is location coverage, not complete route applicability.
If source fields cannot establish coverage for a supplied namespace, label that
query's association coverage incomplete; an unmatched ICAO-only query must not
imply zero airport notices when relevant records may carry only domestic IDs.
If pagination is needed, pin every page to one generation and expose incomplete
counts until all pages arrive.

Disabled collection or no usable baseline returns 503 with a stable reason code
and appropriate retry hint. Verified saved data can return 200 with explicit stale/
incomplete state. Reads, cache misses and user retries never start NMS acquisition.
Response metadata stays in the body, independently of weather-specific headers.

Airport schema 1 adds `issues` and `contentCoverage` together. Resolved `records`
and `issues` have disjoint source IDs. `contentCoverage` is complete only with
complete collection continuity and no relevant issues; association coverage remains
a separate limit. An issue matches either selector across the union of its source
variants, or every query when unscoped. Source issues are shown separately with
raw versions, including on plates, and qualify collapsed counts even when there
are zero matches. They are never interpreted as an active restriction or charted.

Feed status adds `collectionContinuity`, `unresolvedRecords`, and
`unscopedRecords`. The existing global `continuity` stays incomplete and `state`
stays degraded while any issues exist, so older clients remain conservative.
New clients use airport `contentCoverage` together with association coverage and
original source-check age. An unrelated airport can have fresh, complete content
while global feed health reports unresolved records. Offline persistence validates
and retains the same issues. A recent collection timestamp cannot make an affected
airport's content complete.

Expose feed status at `/api/notams/healthz`: enabled/environment, generation,
continuity, source check, last completed full reconciliation, latest delta boundary,
record counts, safe failure code and next allowed attempt. Keep process health,
freshness and completeness separate; a successful full sync cannot conceal later
failed deltas. Health output excludes credentials and temporary content references.

The shared server health additionally exposes `notamReconciliation`: completed
full-sync age, pending state, durable last attempt/failure and the next allowed
bulk attempt. Fresh deltas do not erase this history. An overdue full sync is an
operational warning separate from the existing feed/airport continuity contract;
it does not make otherwise continuous local reads unavailable. The server's
[maintenance guide](../../../tools/info-server/maintenance.md) defines the warning
threshold and diagnostic-file recovery behavior.

## Navaid query contract

Use `GET`/`HEAD /api/notams/navaids?navaidId=…` with exactly one 2–5 character
alphanumeric station identifier, trimmed and uppercased. Reject duplicate,
malformed and foreign query parameters. `NotamNavaidSnapshot` is schema 1 with
`scope: navaid-location`, the echoed `navaidId`, and the compatibility value
`associationCoverage: incomplete`. Airport and navaid namespaces
remain distinct in guards and cache keys, even when their identifier strings coincide.

The exact station-location lookup is complete within that scope, not a combined
station, airport and procedure search. Relevant/unscoped source issues and
collection gaps still make `contentCoverage` incomplete. The navaid reader uses
content/collection coverage for its status. Current guards accept either
association value, but the server retains `incomplete` because already deployed
schema-1 clients accept only that value.

This endpoint reads the existing global generation's domestic affected-location
index. It does not query accountability, invent ICAO aliases, filter source records
by interpreted facility type, search dependent procedures or contact FAA. It
retains all matching resolved records and relevant/unscoped source issues, with
the same source-check times, continuity, content coverage, bounded response cache,
compression, delivery limits and failure behavior as airport reads. Introducing
the route changes neither source acquisition nor durable server generations.

## Regional query contract

Use `GET`/`HEAD /api/notams/regions?artccId=…&firId=…` with at least one published
selector. `artccId` is a three-letter US Center identifier beginning with `Z`;
`firId` is an explicit four-letter ICAO identifier. Trim and uppercase them;
reject duplicate, malformed and foreign parameters. `NotamRegionSnapshot` is
schema 1 with `scope: region-location`. Association coverage is complete for an
explicit domestic ARTCC filing location; FIR-only reads remain incomplete because
domestic notices may lack ICAO aliases. Content issues and collection gaps still
qualify the returned content. Neither status establishes flight applicability.
Its cache namespace remains distinct from airport and navaid queries.

Read the existing domestic affected-location index for `artccId` and ICAO index
for `firId`. Union by source identity; retain all classifications, source text,
regional and unscoped source issues. Do not infer FIR aliases or match
accountability. Regional reads use the same response limits, freshness, continuity,
compression and bounded caches as airport reads, and never contact FAA. This
establishes filing-location membership only, not geographic or route applicability,
national notice coverage, or coverage of adjacent regions. The airport's regional
association does not establish which other centers a flight will traverse.

## Info server integration

Use `createInfoServer`, `info:serve`, `info:build` and `zlayer-info.service` for the
shared listener on port 8787. The [server guide](../../../tools/info-server/README.md)
owns common operations; this section defines the wiring for the collection
and query contracts above. No additional workspace or service framework is needed.

### Module and lifecycle boundaries

The explicitly composed `createNotamService` runs beside the existing weather
updaters. A small surface is sufficient: `restore`, `refresh`, `readAirport`,
`readNavaid`, `readRegion`, `status`, and `close`. Use typed constructor options with injectable transport,
clock and cancellation for tests. Environment and credential-file loading belong
in `main.ts`, not in parsers or request handlers.

| Module | Responsibility |
| --- | --- |
| `tools/info-server/notams/service.ts` | Single ingestion owner, admission, bootstrap/delta/recovery state, query indexes and lifecycle |
| `tools/info-server/notams/collection.ts` | Per-ID resolution, bounded source issues, and full-reconciliation evidence |
| `tools/info-server/notams/revision.ts` | Qualified revision ordering and representation equivalence; no collection scheduling |
| `tools/info-server/notams/client.ts` | OAuth renewal, allowlisted NMS requests, bounded downloads and source error classification |
| `tools/info-server/notams/store.ts` | Durable quota journal, checksummed dataset generations and atomic publication |
| `tools/info-server/notams/lock.ts` | Kernel-backed single-writer lifetime lock |
| `tools/info-server/notams/normalize.ts` | Namespace-aware AIXM/source normalization, identity and lifecycle validation |
| `tools/info-server/notams/routes.ts` | Strict local route parsing and snapshot responses |
| `packages/contracts/src/` | Versioned NOTAM delivery types and guards, following the package's existing layout |

The server normalizes source facts; flairs and plate matching remain plugin
derivations. Keep React/workspace state out of the backend, and secrets/filesystem
paths out of shared delivery types. Split further modules only for distinct work.

Wire lifecycle into `server.ts` as follows:

1. Construct with the shutdown signal and restore local state independently.
   Report NOTAM loading until ready; weather startup never waits for FAA access
   or NMS recovery.
2. Let the existing 30-second update tick call a cheap, nonblocking
   `notams.refresh()`, enforcing the [sync policy](#sync-policy) with one in-flight
   round and no queued catch-up. Preserve `startUpdates: false` for tests.
3. Serve published generations through the [query contract](#airport-query-contract).
   A browser abort cancels its response, not shared ingestion.
4. In idempotent `close()`, stop admission, abort transport/parsing and drain
   bounded durable writes before releasing the lock, within the shutdown deadline.

NMS failures affect only NOTAM readiness. Sanitize errors before the server's
generic logger: safe codes and permitted request IDs only, excluding tokens,
credentials, content URLs and upstream bodies. Recovery stays within the service
rather than restarting the weather process.

### Reuse and resource isolation

Reuse HTTP methods, exact-origin CORS, `no-store`, security headers, compression,
cancellation and bounded worker patterns through small helpers as needed. Keep
weather's `Resource`, `PreparedFamily`, route classification and `WeatherCache`
unchanged in ownership; NOTAM reads never enter `cache.get()`. `UpstreamQueue` is
in-memory admission and cannot replace the durable budget journal. NMS owns its
queue and does not inherit weather's test `spacing` override.

Bulk decompression/XML normalization runs in one cancellable parsing worker;
credentials remain in the parent, which passes private spool paths. The build
emits that worker beside the server bundle. The parent streams normalized records,
merges revisions, builds indexes and publishes generations with asynchronous file
writes. Merge, sorting, hashing and serialization still consume parent event-loop
time. Combined weather/NMS load measurements must qualify that work before
deployment; move generation construction into the worker if latency requires it.
The 60-second worker deadline handled the measured staging load, but needs
deployment headroom qualification.

Measure weather latency and preparation during bootstrap, deltas and NMS failure.
The checked-in systemd unit defaults to a shared budget of four CPUs' worth of
time and 4 GiB across the process and workers; deployments may override it.
Set the [storage/resource limits](#storage-and-query-indexes) within
measured headroom; adding a worker does not add memory capacity.

### Configuration and credentials

`main.ts` loads these server-only settings:

| Setting | Meaning |
| --- | --- |
| `NOTAMS_ENABLED` | Defaults to false; explicit collection enablement |
| `NOTAMS_ENVIRONMENT` | Required when enabled: `staging` or `production`, selecting fixed data/auth hosts |
| `NOTAMS_STATE_DIR` | Dedicated durable directory; local default `.cache/notams`, deployed outside the weather cache |
| `NOTAMS_CLIENT_ID_FILE` | Private file containing the FAA workbook's Key, used as OAuth client ID |
| `NOTAMS_CLIENT_SECRET_FILE` | Private file containing the FAA workbook's Secret |

Use an optional systemd `LoadCredential` drop-in or Docker read-only secret mounts.
Disabled deployments need neither file. Never put secrets in `VITE_*`, checked-in
configuration, command arguments or image layers; access tokens stay in memory.
Invalid enabled configuration reports NOTAM unavailable while weather continues.
Deployment acceptance checks product readiness, not only process health.
The collectors require Linux `flock` (util-linux), including the graphical TFR
collector when NMS is disabled; Docker installs it. A
kernel-owned helper lock is held until collector shutdown, so a process crash
does not leave a stale PID lease. The credential-level single-owner rule also
applies across hosts. Never delete `budget.json` or the provisioning marker to
recover data: missing/corrupt budget state blocks source requests. Corrupt dataset
generations can rebase under the existing budget; a previous readable generation
is retained as incomplete. Source conflicts persist as explicit issues; a legacy
checkpoint invalidated by a conflict still requires a verified recovery bridge.
The local lock protects a state directory, not a credential copied into a second
directory or host. Never start another collector with production credentials and
fresh state. Preserve admission state across migration, failover and rollback.

### HTTP, proxy and deployment changes

The server dispatches `/api/notams/` before weather's `routeFor`, enforces the query
contract and rejects unexpected parameters/ranges. It exposes no arbitrary upstream
proxy and includes the feed-health summary as `notams` in `/api/weather/healthz`.

- `tools/dev-proxy.ts` forwards `/api/notams/` to the same
  `INFO_API_ORIGIN` target as weather. Both products use one local/remote service.
- The Caddy hosting configuration and optional `docs/development/info-api.nginx.conf`
  forward both API prefixes to the same backend. The nginx snippet's optional SSH
  tunnel uses loopback port 8788; a same-host backend uses port 8787. Reuse the same-origin TLS boundary;
  no additional public listener is needed.
- `zlayer-info.service` includes the persistent state directory
  `/var/lib/zlayer-notams` and configures `NOTAMS_STATE_DIR` there. Keep it stable
  across release symlinks and weather cache swaps. Mount a separate persistent
  NOTAM volume for Docker; the bundle includes the collector's worker.
- Follow the [single-owner staging and handoff procedure](../../../tools/info-server/README.md#service-installation).
  Disabling NMS does not stop the separate graphical TFR collector. Offline
  candidate restoration uses independent state copies, disabled background updates
  and blocked source requests. Drain the old service before transferring live
  collection ownership; preserve both collectors' durable admission history.

Multi-host expansion needs a shared admission mechanism or continued single-owner
ingestion before adding collectors.

## Normalized records

Define and validate a versioned delivery contract before integrating UI. Source
facts cross that boundary; the derivation row describes client-owned results built
from those facts, not precomputed server UI or plate matches:

| Area | Retained meaning |
| --- | --- |
| Identity | Opaque source ID, original ID, classification, number/year/series, environment, and record revision/digest |
| Association | Location, ICAO ID, accountability, affected FIR, airport/facility references and evidence for derived associations |
| Lifecycle | Issued/updated times, replacement/cancellation information and references, preserving unknown values |
| Validity | Original and normalized start/end, estimated/permanent/unknown end kind, raw schedule and supported evaluation |
| Content | Local/ICAO translations, body, structured event/subject fields, and source-part relationships |
| Derivation | Parser version, subjects/effects, clauses, targets, unresolved interpretation, and field/text-span evidence |
| Coverage | Generation, source-check time, continuity, supported scope and processing limitations |

Keep IDs as strings: 16 digits can exceed JavaScript's safe integer range. Display
numbers alone are not durable keys. Preserve unknown enum values and source fields
needed to explain results. Validate records before application state or storage.

A safely preserved record with unsupported interpretation stays readable/raw and
unresolved. A structurally valid record with an unsupported lifecycle becomes a
source issue; preserve its evidence and qualify its airport coverage while other
IDs advance. A broken envelope, truncated load or unidentifiable record cannot be
silently discarded while claiming complete collection. Retain the prior snapshot
and expose that collection failure. Optional invalid geometry must not hide
otherwise valid text.

Separate source-check, issue/update, effective and browser retrieval times. Missing
fields cannot manufacture freshness. Matching cache identity includes generation,
parser/matcher version, airport, and exact plate/catalog context.

## Parsing and flairs

Use deterministic bounded parsing backed by fixtures: source normalization,
lexical/header parsing, scoped clauses/targets, then presentation. Keep comparison
text alongside untouched raw text. Prefer qualified structured fields; use supported
grammar where absent. Surface conflicts instead of silently choosing one reading.

The parser is organized by responsibility:

| Module | Responsibility |
| --- | --- |
| `parser.ts`, `interpretation.ts` | Source selection, bounded orchestration, shared evidence/types and interpretation coverage |
| `source-text.ts` | Identity/interval/whole-body proof for alternate FDC renderings, shared with collection |
| `procedure-targets.ts`, `procedure-title.ts` | Complete headings/amendments and a state machine for facility, variant, designation and qualifications; stopped before narrative references |
| `effects.ts` | Typed, subject-bound facts and complete supporting source spans, independently of badge selection |
| `flairs.ts` | At-a-glance summaries, proven facility/effect combinations, and specific interpretation explanations |
| `clauses.ts` | Shared control lexer/transitions, sentence clauses and exact document scopes: operative, instruction, conditional, multipart |
| `multipart.ts` | Bounded ordered transport proof and offset-preserving marker masking, shared by spatial consumers and national TFR matching |
| `areas.ts`, `area-tail.ts` | Typed spatial definitions, boundary cursor and whole-suffix grammar; no geometric approximation of unknown qualifications |
| `area-geometry.ts`, `area-references.ts`, `coordinate-recovery.ts` | Geometry construction, unique navigation resolution and corroborated coordinate recovery |
| `obstacles.ts`, `radials.ts`, `activity-points.ts` | Scoped point/direction interpretation; obstacle coordinate evidence retains exact source occurrences |
| `minima.ts`, `minima-row.ts` | Procedure/category scope and token-driven field/value state machine |
| `takeoff.ts`, `distances.ts` | Bounded whole-clause grammars for takeoff alternatives and declared distances |
| `presentation.ts`, `readable-text.ts` | Reading model and display wording; no source or applicability mutation |

Small lexical patterns recognize tokens and supported headings. State machines
control interpretation: the document machine cannot leave an instruction,
condition or multipart state merely at punctuation. Instruction state takes
precedence over an earlier condition; unassembled multipart state takes precedence
over both. Numeric effect badges and geometry share these control boundaries,
as do named-procedure amendment fallbacks; an `(IF)`
fix qualifier is not a conditional `IF`.
The minima row machine moves
through field, value, separator and final-category states. Ordered `DA/HAT` or
`DA/RVR/HAT` labels establish their paired values; a slash inside a visibility
value can instead form a fraction. Only the current field determines that meaning.
Failed transitions preserve the entire clause as prose; no partial numeric result
escapes. A row accepts at most eight fields. A category on a later field cannot
retroactively scope earlier fields. Categories never carry to a later row;
the one supported shorthand is a category-only visibility row immediately after
a single explicit, non-RVR visibility row. Its units remain exactly as written.
The approach-title machine consumes the prefix, facility/combined branch, runway
or bearing, then complete category qualifications. Unknown branches and unbalanced
qualifications reject the whole title. It returns recognition only; source titles
and offsets remain untouched for matching and evidence.

Recognize keywords in their subject position, not unrestricted substring searches.
Start with NMS's vocabulary: `RWY`, `TWY`, `APRON`, `AD`, `OBST`, `NAV`, `COM`, `SVC`,
`AIRSPACE`, `ODP`, `SID`, `STAR`, `CHART`, `DATA`, `DVA`, `IAP`, `VFP`, `ROUTE`,
`SPECIAL`, `SECURITY`. Preserve unknowns. A D pointer mentioning an FDC notice keeps
its original classification.

Attach effects to their subject and clause. Retain exceptions, conditions, aircraft
categories, transitions and time windows. Context-specific abbreviation expansion
must preserve values, units, direction and scope. Unknown clauses stay in the
default readable body; raw disclosure is not a reason to omit qualifications there.
Every derived fact retains supporting source-field or text-span evidence. Badge
selection is a separate pure presentation step, driven by fact kinds rather than
display-label comparisons. It cannot change procedure matching, geometry or source
content. Each displayed badge retains all of its supporting spans.

`presentation.ts` prepares a clock-independent reading model used by both airport
and plate entries. It separates procedure/airport context, titles and amendments,
sentence paragraphs, and supported takeoff-minimums clauses. Each runway gets its
own block with an ordered list of alternatives separated by **or**. Each alternative
owns its minimums, climb gradient/altitude and any explicit visual-condition
requirement. Either alternative may contain a climb. Coded minima such as `3100-3` retain
their notation; presentation does not infer units, convert values or remove the
visual-condition requirement. Search covers the displayed labels as well as original
source text.

Both hosts use the same B612 reading hierarchy: 14px body text with 1.6 line height,
13px bold block labels, and 12px supporting context. Keep the airport, procedure
title and amendment together. Structured blocks share one left edge and quiet
horizontal separators; do not nest a border or badge around every fact. Minimums
use aligned label/value columns and tabular numerals, with categories attached to
their own row. Qualifiers sit below values in narrow cards and alongside them when
the entry has enough width. Responsive decisions use the entry's width, not the
device width: desktop airport side panels can be as narrow as phone cards.
Limit prose to 68ch in wider readers. Climb gradients/units and destination altitude
groups wrap together, and all blocks must reflow under increased text spacing.

`readable-text.ts` applies sentence casing after structural parsing, including
unstructured paragraphs, notes, missed approaches and minima conditions. Its explicit
prose vocabulary changes case only: no spelling corrections, abbreviation guesses,
new punctuation or dropped conditions. Unknown tokens and aviation contractions stay
as supplied. Navigation contexts protect English-word fixes such as WHITE and CROSS;
record location identifiers, taxiway codes and numeric/reference components also keep
their spelling. Recognized airport headings title-case the name and city separately
from the state code. Procedure titles keep their source identity. Raw text, matching
and numeric parsing never consume the cased display text.
Known apostrophe, quotation-mark and ampersand character escapes are decoded once
for plain-text display. Raw text and evidence retain the source escapes; unknown
escapes and markup are not interpreted as HTML.

`minima.ts` recognizes complete approach-minimums clauses for LNAV, LNAV/VNAV,
LP/LPV, RNP, GLS, straight-in ILS/LOC, circling and sidestep entries. It displays
MDA/DA/RA, HAT/HAA/HAS and visibility/RVR as compact inline label/value pairs.
Visibility uses **Vis**, with the full label supplied by its abbreviation element.
Category groups sit beside each other when space permits and wrap as groups on
narrow or enlarged layouts. Use 12 px labels and categories, 13 px bold tabular
values, aligned baselines and natural spacing; category captions stay immediately
above their own values. Category scope belongs to each source row: an all-category altitude must not make a
CAT C/D visibility change apply to every category. Retain fix-minimums headings
and equipment requirements, RNP decimals, runway suffixes, fractional notation,
footnote markers and explicit trailing conditions. Do not infer omitted altitude
types, RVR labels, units or categories. Standalone minima/visibility clauses keep
their source position without borrowing scope from preceding minima. At most 16 rows
are accepted per clause; any unmatched remainder preserves the entire source clause.
Explicitly labeled `DA/RVR/HAT` triplets retain the published field order. Adjacent
explicitly labeled altitude/height/visibility values, including colon labels,
compact `FT`/`SM` units and value-before-RVR ordering, share a row only with their
published category scope. `CAT C AND D` remains that written category group.
`MINIMUMS NA` retains its explicit prohibition. Multiple
explicit approach scopes separated by commas, semicolons or publisher newlines
become separate minimums sections only when
every member parses completely. `NA` in a minimums value displays **Not authorized**;
it is never zero, an absent field or a general-purpose expansion of `NA` elsewhere.

`takeoff.ts` accepts explicitly headed runway clauses, including published runway
shorthand such as `4L/R`, up to three complete alternatives and a trailing obstacle
reference. It does not borrow a preceding runway/heading, supply missing gradient
units, or carry a scope into an unheaded later clause. Explicit JETS/PROPS branches
retain separate aircraft/runway headings; every branch must name its runway.
Up to four explicitly unit-labeled climb stages retain their ordered gradients
and endpoints under **Minimum climb** and **Then minimum climb**. An explicit
`THEN 280 FT/NM TO 6300` can omit the repeated climb introduction but must still
supply the gradient unit and destination altitude. An explicit
`OR DEPARTURE NA` remains a prohibition alternative, never standard minima.
Unknown aircraft types, missing units or extra qualifications retain the whole
clause as prose. `distances.ts`
displays explicitly labeled TORA/TODA/ASDA/LDA values in feet, in source order;
missing labels are not synthesized and conflicting duplicate labels remain prose.

Note blocks distinguish **Add note**, **Replace note**, **Change note**,
**Disregard note** and **Delete note**, along with equipment conditions, exceptions
and missed-approach instructions. Preserve the full instruction body and both old
and new wording in `CHANGE NOTE: … TO READ …` forms. Never promote numeric values
inside a disregarded/replaced note into current-minimum rows. After an instruction
or embedded editorial directive, later numeric clauses in that notice stay as
source prose: sentence punctuation alone cannot establish the end of quoted or
conditional wording. Unknown instructions and unsupported notation remain visible.

Structured runway grammar must consume the entire clause. Extra exceptions,
conditions, unfamiliar units or unsupported runway forms leave that whole clause
as source text in the main view. Paragraph splitting does not split commas,
semicolons or decimal numbers. This formatting does not resolve applicability or
remove **Interpretation Limited**. Raw text stays untouched under **Show raw**, with
redundant source bodies omitted under the [entry contract](#airport-detail-tab).
A trailing compact validity range is omitted from the
readable body only when both endpoints and its estimated/fixed qualifier agree
with the visible validity row; conflicting/unknown ranges remain visible.

Presentation is bounded to 64 KiB, 128 blocks and 2,048 characters per structured
clause, with whole-body/whole-clause fallback when those limits are reached. The
reading model retains a source-body span for every block, including fallback prose.
These spans support independent content-preservation audits and never change raw
source strings or become operational applicability evidence. The
linear casing pass also handles unstructured fallback within the 64 KiB limit;
larger bodies remain untouched. Results are cached by record identity independently
of the current clock. This is
currently a client derivation from the version 1 API, not a server-prepared delivery
contract; it changes neither collection/reconciliation nor record identity.

The current grammar includes the D/FDC clause forms observed in the KSJC staging
snapshot: runway/taxiway/apron closures, runway and approach lighting outages,
ILS and other named navaid outages, obstacle light outages, cranes, UAS Activity
and explicit surface-to-AGL limits. Procedure summaries retain distinct
amended DA/MDA and visibility minima, sidestep/circling minima, VDP changes,
takeoff minima and climb gradients, terminal-route/transition restrictions, and
crane context. Procedure titles and conditional inoperative-lighting instructions
remain in the body. Numeric minima, aircraft categories and
their qualifications remain together in the complete body; tags do not replace
them with a single airport-wide value. A `FOR INOP ALS` note does not establish an
actual lighting outage, and an obstacle or lighting notice does not close a runway.

Flairs form an at-a-glance body, not a fixed-size selection of keywords. Preserve
separate **Minima Amended**, **Visibility Amended**, **VDP Amended**,
**Takeoff Minima Amended** and **Climb Gradient** summaries when supported; these
describe different changes even when structured values also appear below.
Do not drop operational effects to meet an arbitrary visual cap. Remove repeated
subject/identity labels instead. A proven whole-runway closure becomes
**RWY 09 · Closed**; qualified and partial closures retain **Closure Restriction**
or **Segment Closed**. Scope must be supplied by the recognizer. The first taxiway
in a compound or segment closure cannot label the entire effect; use **Taxiway
Closure** and retain the complete boundaries in the body. Source procedure names
remain in their headings/prose. Multiple names receive one **Multiple Approaches**,
**Multiple Departures** or **Multiple Arrivals** summary, without implying that an
unresolved heading set is complete. References name their target as **See NOTAM …**.

Obstacle marking and conditional lighting details remain ordinary body content.
Mapped obstacle readers always retain lighting status, marking and qualifications;
badge visibility never licenses deleting that text. Parser issues distinguish an
unclear subject, affected-procedure scope, procedure exceptions, unconfirmed
facility dependencies and bounded interpretation. Entry interpretation badges are
reserved for operational exceptions and bounded reading limits (`procedure-exceptions`,
`fact-limit`, `body-limit`). Subject, heading, target, multipart and facility-dependency
issues remain internal and qualify plate coverage; they do not add generic “unclear”
badges to correctly rendered notices. Source wording remains readable verbatim.
The expanded plate bar explains these matching limits; compact counts omit the
interpretation qualifier. These issues are separate from source-feed failures.

Color expresses the kind of information, independently of D/FDC classification:

| Color | Meaning | Examples |
| --- | --- | --- |
| Blue | Facility or subject | RWY 12R, Navigation, Obstruction |
| Purple | Procedure context | Approach, Departure, Multiple Approaches |
| Amber | Restriction, amendment, outage, activity or uncertainty | Minima Amended, ILS Unavailable, UAS Activity, Check Schedule |
| Red | Explicit unqualified closure of the identified facility | RWY 09 · Closed, Taxilane Closed |
| Neutral | Supporting information or timing | See NOTAM FDC 6/1001, Surface to 300 ft AGL, Outside Schedule |

Use the shared `surface-tag-*` / `text-tag-*` theme roles; the light palette is
generated from the dark seeds. Labels convey the meaning without color and wrap
within narrow cards. Authored flair labels use title case, preserving aviation
abbreviations, source procedure titles and unit symbols such as `ft`. Each tag's
title exposes its supporting source text. The same
entry component renders airport lists and expanded plate notices.

Illustrative fixtures, not live NOTAMs:

| Fragment | Result |
| --- | --- |
| `RWY 20 RWY END ID LGT U/S` | RWY 20 · Lighting Unavailable; no runway-closure claim |
| `RWY 09/27 CLSD EXC …` | Runway closure with the exception retained |
| `IAP … CIRCLING NA` | Circling Unavailable for that procedure, not the entire approach |
| `SID … TRANSITION … NA` | Restriction scoped to that transition |
| `SEE FDC …` | See NOTAM FDC …; the reference stays visible without following or merging it |

Parsing is bounded to 64 KiB of body text, 320-character heading prefixes, 16
procedure targets and 20 deduplicated facts. Scan delimiters before applying
the bounded heading grammar. Each IAP heading is checked independently, with or
without an amendment; one supported heading cannot suppress another heading or
an unsupported heading's matching uncertainty. Familiar suffixes inside
unsupported prefixes/compound headings do not establish a target. Scanning
stops before narrative notes, exceptions and conditional procedure references.
If limits are reached, retain the entire body/raw text and flag
the relevant interpretation issue. Derived results are cached by
record identity for repeated airport-list and plate matching; replacement records
are parsed anew. Parser version 11 owns these derivations, not the wire schema.
Recognized headings include RNAV departures/arrivals, `DEP`/`ARR` spellings,
explicit arrival prohibitions, PRM and converging approaches, lettered variants,
parenthesized or flat CAT qualifications and copter bearing titles. These
qualifiers remain part of the procedure identity. The documented
[category spelling aliases](#procedure-title-spelling-aliases) produce comparison
keys while preserving original headings and evidence. Complete comma-separated
headings can share an amendment; per-heading amendments remain distinct. Bounded
forms include `AMT 6`, `AMDT2`, `AMDT ORIG-B`, a contiguous `. ORIG...` clause,
and omitted `RWY` only in an ILS category heading. A complete SID/STAR airport,
city and state preamble can precede a title, including periods within airport names.
Unknown prefixes and conditional/narrative references never become suffix matches.
An exact associated FAA/ICAO prefix may precede a subject; unrelated prefixes
remain unrecognized. Obstacle lighting includes plural objects and wind turbines,
with negations and conditions preventing an unconditional outage/lighting claim.
Closures qualified by aircraft type/size, exceptions or conditions receive a caution
**Closure Restriction** flair with the qualifier included in its evidence. Explicit
exceptions in a later sentence still qualify a closure. Taxiway segments can name
runways, taxilanes, ramps, gates and deice pads as endpoints. A partial runway
closure receives **Runway Segment Closed**, not an airport-wide closure claim.
Recognized COM/SVC outages retain frequencies and qualifications; a tower closure
does not mean the airport is closed. Facility-qualified `SEE` references retain
their pointer identity without following or merging another notice. Numeric
procedure flairs stop before note edits and conditional wording, so quoted values
inside a disregarded or conditional note do not look like operative amendments.

Parse supported UTC validity forms and preserve `EST`/`PERM`/unknown-end meaning.
Check the source body and every retained translation for compact validity ranges,
including ranges before multipart footers. An `EST` range must agree with the
structured end to the published minute; conflicting evidence stays unknown. Estimated
and unknown ends remain visible for review after the stated end. Only a fixed end
can remove a notice from the current/upcoming display.
Permanent notices do not get an invented expiry. Distinguish the effective interval
from recurring schedules, including overnight/day-boundary cases. Unsupported
schedules get **Check Schedule**, not a guessed Active/Inactive result. Retain
schedule text even after successful evaluation. Qualify estimated-end behavior
and cancellation precedence before enabling time-based removal rules.
The NMS form `Daily:1500-0500~DLY 1500-0500` is evaluated only when the two windows
agree. Conflicting windows and sunrise/sunset schedules remain **Check Schedule**.

Only verified part identifiers establish multipart groups; retain each part's raw
source and expose missing parts. Cross-format translations are representations of
one record, not additional independent notices.
An initial `PART 1 OF N` envelope may precede an explicit IAP/ODP/SID/STAR subject.
Recognize that part's headings only before `END PART`; retain a multipart coverage
issue and suppress numeric minima/climb extraction. Do not infer a second part's
subject or assemble numeric clauses across parts.

## Procedure matching

The parser can recover a missing FDC subject from a retained `LOCAL_FORMAT`
only when its identity, validity and complete body satisfy the same equivalence
proof used by the server's revision reconciliation (`source-text.ts`). Conflicting
translations or substantive differences prevent recovery. Both source strings
remain unchanged, and evidence offsets address the chosen original string.
SID/STAR procedure headings may follow airport context on the same line; bounded
sentence recognition stops before note, exception and incidental narrative.

Matcher version 8 is a pure function of validated notices and exact plate context. Return
source ID, applicability outcome, affected clauses, and an explainable reason.
Avoid numerical confidence scores suggesting unmeasured accuracy.

Airport-wide reference coverage is cached once per immutable catalog procedure list
and notice object, shared by plate rows and the reader across clock updates. Contexts
retain the original catalog list; the matcher excludes deleted entries. Replacing
the catalog or a notice object recomputes its coverage, including same-cycle source
replacements. Weak keys release obsolete catalogs and notices with their owners.
Time filtering and each displayed plate's match/amendment checks remain live.

1. Resolve airports through published FAA/ICAO aliases and qualified associations.
   Never manufacture IDs by adding/removing `K`, equate accountability with the
   airport, or assign a nearby coordinate to it.
2. Resolve class and procedure identity from the displayed edition's catalog.
   Use publisher IDs/computer codes and established name aliases. IDs from
   different systems need a proven mapping.
3. Normalize punctuation, whitespace, runway zero-padding and supported SID/STAR
   number-word/code aliases. Preserve subtype, Y/Z, L/R/C, revision numbers,
   `HI-`, helicopter/special qualifiers and transitions. GPS and RNP remain distinct.
   Combined ILS/LOC titles match either named branch, retaining its own variant and
   subtype: `ILS Z OR LOC Z` matches ILS Z and LOC Z, while `ILS OR LOC Z` matches
   unlettered ILS and LOC Z. Qualifiers and runway sides apply to both branches.
   Category spelling aliases use the same title grammar as target recognition;
   category lists retain explicit boundaries so `CAT I/II` cannot become `CAT III`.
   Unsupported heading prefixes remain unresolved rather than becoming a recognized
   ILS/LOC/RNAV suffix.
4. Handle multiple named procedures and explicit broad scopes such as all IAPs at
   an airport. A runway in an exception, missed approach, or obstacle narrative
   is not by itself a procedure target.
   Broad clauses with exclusions or conditions, such as `ALL IAPS EXCEPT`, require
   review for every candidate plate; an excluded title never becomes an applies match.
5. Compare amendment number/date with the displayed plate. A mismatch requires
   review when the target otherwise agrees; it alone does not prove incorporation.
   `ORIG`, `ORIG-A`, etc. compare with catalog `0`, `0A`, etc.; preserve different
   letters and unknown metadata. Check every matching heading, so a later conflicting
   amendment cannot be hidden by the first one.
6. Include D runway/facility notices when explicit runway identity or a qualified
   dependency proves relevance. Preserve their actual effects without inventing
   minima or declaring whole procedures unavailable. Incomplete dependencies must
   not imply complete facility coverage.
   Explicit `NAV ILS/LOC RWY … U/S` matches ILS or LOC approaches on that exact runway;
   `GP`/`GS` matches ILS approaches. `ILS RWY … LOC`, `GP`/`GS` and
   `LOC/GP`/`LOC/GS` identify explicit
   components. `ILS … DME/OM/IM/MM` retains its component and requires dependency
   review; it never becomes an outage of the complete ILS. `NOT MNT` is a monitoring
   restriction, distinct from `U/S`. These notices do not establish a dependency for
   RNAV approaches. Unknown or absent facility/runway dependencies remain unresolved,
   and unresolved interpretation is explained in the expanded plate bar.
   Explicit `NAV ILS RWY … [SPECIAL AUTH|SA] CAT … NA` associates only with the
   stated runway and overlapping authorization/category on a published ILS plate.
   It is not a whole-ILS outage. Coverage checks every requested category and
   authorization across related, nondeleted plates. A CAT II match cannot hide an
   absent CAT III reference: retain the valid match and list the missing category
   in the expanded bar. The same rule applies to category-qualified IAP headings;
   separate plates may together cover the requested categories.

ODP is not synonymous with SID: complete generic takeoff headings map to
`takeoff-minimums`, diverse-vector headings (including `(RADAR VECTORS)`) to
`diverse-vector-area`, and named graphical ODPs to `departure`. A named ODP may
omit the catalog's `(OBSTACLE)` suffix; its revision number stays significant.
IAP `RADAR-1`/`RADAR 1` maps to `radar-minimums`; other radar numbers are not inferred.
Unavailable amendment metadata on these minimums pages always requires review.

These kinds use the same exact edition/page checks as approach, departure and
arrival charts. On a shared minimums page, the reader offers only airport/section
choices explicitly indexed to that page. Opening a catalog entry selects that
section; paging to another shared page requires a new choice. Unindexed pages,
unresolved named destinations and ambiguous ordinary approach pages cannot inherit
the previous airport. See [Plates](../plates/README.md) for context ownership.

| Outcome | Presentation |
| --- | --- |
| Related to this plate | Unambiguous procedure/broad-scope match or proven runway/facility relationship; show reason and affected scope |
| Review applicability | Plausible association with missing context, ambiguous wording or amendment mismatch; uncertainty stays visible |
| No established match | Keep the notice in airport results; do not attach it to an unrelated plate |

Clearly incompatible runway sides or variants are not review candidates merely
because they share a substring. Conversely, unresolved airport procedure notices
cannot disappear into a false zero-match assurance: expose unresolved procedure
coverage and access to the full airport list. Matching is not a claim that every
operationally applicable notice has been found.

### Procedure-title spelling aliases

`procedure-title.ts` owns complete-title recognition and canonical comparison keys.
Only category tokens in a recognized qualification receive these equivalents:

- `SAT CAT I` matches `SA CAT I` in an ILS heading. This is an observed FAA source
  spelling, not a general `SAT` abbreviation or a fuzzy correction rule. The
  [January 2018 FAA NOTAM publication](https://www.faa.gov/air_traffic/publications/atpubs/ntap_jan_18/part1_Section2.html),
  EWR FDC 7/7214, uses both spellings for the same runway 22L procedure. KOAK
  FDC 6/6268 supplies `ILS RWY 12 (SAT CAT I), AMDT 8B`; its
  [cycle 2610 FAA plate](https://aeronav.faa.gov/d-tpp/2610/00294I12SAC1.PDF)
  is titled `ILS RWY 12 (SA CAT I)` and carries amendment 8B. The alias does not
  extend to `SAT CAT II`, arbitrary `SAT` tokens, or non-ILS headings.
- Arabic category numbers `1`, `2`, `3` match Roman `I`, `II`, `III` only after
  `CAT`. The same FAA publication includes OAK FDC 7/1264 with `SA CAT 1`.
- Category lists separated by `/`, `AND` or `&` compare as the same set;
  ascending hyphen ranges include every intervening category. Thus `CAT II-III`,
  `CAT II AND III` and `CAT II/III` agree, as do `SA CAT I-II` and
  `SA CAT I AND II`, both present in FAA source notices. A combined category
  set has a distinct identity from a single category or a different set.

Relevance is separate from identity equality: a notice for SA CAT I can address
the SA CAT I portion of a combined SA CAT I/II plate. The reason states only the
common category; authorization, PRM, facility, variant and runway must still agree.
Multiple authorization groups on one plate remain distinct. `(CLOSE PARALLEL)`
is an optional catalog spelling only within a complete PRM title, corroborated by
the [ATL PRM chart](https://aeronav.faa.gov/d-tpp/2610/00026IPRM10.PDF).

The [FAA AIM 5-4-5](https://www.faa.gov/air_traffic/publications/atpubs/aim_html/chap5_section_4.html)
documents removal of `/DME` from titles in favor of chart equipment notes. A complete
VOR/DME notice title can therefore produce a **review candidate** for a VOR catalog
title differing only in that notation. This forward transition preserves HI/COPTER,
variants, runway/circling letter and an OR TACAN branch; it does not merge identity
keys or infer that DME is optional. The reverse transition and other facility
subtypes are not generalized. The
[HUM](https://aeronav.faa.gov/d-tpp/2610/05037COPTERV12.PDF) and
[BIL](https://aeronav.faa.gov/d-tpp/2610/00048HVT28R.PDF) captured cases both show DME
requirements on the printed charts. Missing catalog amendments remain unknown.

SA remains part of the identity: [FAA category guidance](https://www.faa.gov/about/office_org/headquarters_offices/avs/offices/afx/afs/afs400/afs410/cat_ils_info)
defines it as Special Authorization. Matching retains runway side, facility,
variant, special qualifications and amendment checks. Unknown qualifiers and
malformed titles receive no inferred alias. Canonical keys never replace source
text, presentation headings, evidence offsets or server record identity; the
captured KOAK regression checks both plate matches and unchanged source wording.

## Client lifecycle and offline behavior

One stable client per workspace combines demand from airport/navaid/regional NOTAM
bodies, visible Plates lists, and open plate bars. Coalesce the same query; keep
airport, navaid and regional namespaces separate and allow different detail and reader queries
concurrently. A collapsed bar still needs count/freshness
updates while visible. Stowed/hidden consumers retain state but release demand.

Regional identity consists only of the normalized explicit ARTCC/FIR selectors,
never the airport used to open the view. For example, KOAK, KSFO and KSJC with
`artccId: ZOA` share one request/refresh schedule, one in-memory snapshot and one
saved snapshot. The server response cache uses that same regional identity.
Reopening the region through another airport reuses its snapshot and original
refresh deadline. A refresh replaces that entry rather than appending another
airport-specific copy. Different explicit selector sets remain distinct queries.

Follow the same demand-driven lifecycle as [METAR/TAF](../metar-taf/README.md#demand-refresh-and-recovery):
show saved data immediately, acquire while visible and online, release obsolete
work on hiding/stowing, and resume demand on reopening or reconnecting. Retain
usable data with its original source times and explicit errors after failed reads.
Use core `requestJson`, `OnDemandRefresh`, connectivity observation and scoped
storage. Detail demand uses zero debounce, like weather cards. Refresh demanded
snapshots on the three-minute product cadence; qualify
immediate reopen/reconnect reads against existing freshness. Browser reads never
change upstream cadence. Reopening or adding another airport preserves each
airport's next due read; the shared scheduler wakes at the earliest deadline.
Only completed reads establish throttling, so unloading during acquisition cannot
delay the first read after reactivation. Dispose timers/listeners and reject obsolete airport,
edition, page or activation completions.

Persist bounded validated airport, navaid and regional snapshots. The client targets 24 query
entries and 64 MiB in memory, protecting visible demand even above those targets.
Persistence independently limits the saved list to 24 complete snapshots and
1,900,000 UTF-16 bytes within the scoped record's 2 MiB ceiling, preferring recent
retrievals and skipping snapshots that do not fit.
The mixed-scope `query-snapshots` record uses schema-1 snapshots. Restore the legacy
`airport-snapshots` record as well, preferring the newer usable source check for
each airport. Leave that legacy record intact for older clients; new responses
write only `query-snapshots`. The count/byte caps apply to the new combined list.
Every successful response merges only that query into the latest saved
list under core's record lock. Other windows' queries survive, and an older
response cannot replace a newer usable check from the same source environment.
The recently retrieved query moves first in the saved retention order; equal
checks may update feed health. The same count/byte caps apply after the merge.
Live results publish before the optional save, and waiting for a save lock does
not delay requests for other demanded queries. Missing/denied locks skip saving;
teardown cancels queued writes and storage deadlines cannot block recovery.
Restoration and live responses require a source-check time no more than 30 seconds
ahead of the current clock. Restoration cannot replace newer usable live state;
after clock rollback, a valid snapshot may replace an implausibly future-dated
one even if its check time is earlier. Preserve original check/validity times and usable
data after refresh failure. Optional storage failure does not invalidate online
results. Re-evaluate validity/schedules over time even offline; handle clock rollback
and implausibly future timestamps.

Keep transport, source continuity and freshness separate. **Freshness policy:**
two missed three-minute checks mark data stale (six minutes since the last
successful source check). This implemented product threshold still needs
operational qualification. Offline remains explicit even within that interval.
Freshness does not establish
completeness, and neither is a regulatory guarantee.

PDF and NOTAM offline availability are separate facts. Saving a plate/region does
not promise current NOTAMs. Keep the existing PDF save indicator specific to the
document, and NOTAM status in its bar/list. Verified regional NOTAM packages and
route packing remain future work.

## Implementation sequence

The collector, parser/matcher and UI stages are implemented. Staging source behavior
and the initial production collection were exercised as recorded above. The table
retains acceptance targets: it does not imply every source variant, device or later
production deployment is qualified.

| Stage | Deliverable and acceptance |
| --- | --- |
| 1. Qualify NMS | Staging auth and required endpoints within budget; sanitized D/FDC, lifecycle, schedule, multipart and complete-load fixtures; resolve continuity/identity questions and set measured limits |
| 2. Collector and contract | Integrate the NMS module into the existing weather process; full local dataset, daily reconciliation, three-minute deltas, shared guards/types, durable quota/generations, local airport reads, health, secrets and proxy wiring; prove restart, gap recovery and weather isolation |
| 3. Parser and matcher | Pure derivation with evidence and exact edition/page context; representative positive and negative catalog matches |
| 4. Airport tab | Registration, Info/Plates/NOTAM composition and persistence compatibility, core UI, both classifications/raw text, and offline/failure behavior |
| 5. Plate integration | Actual-page context, row counts and scrolling red disclosure; preserve PDF lifecycle and optional-provider cleanup |
| 6. Release qualification | Full local checks, reference/device review, comparisons with matching source times/scope, and production deployment readiness |

Stages 1 and 6 remain open for the source/operational questions below and the
broader release matrix. Production onboarding and initial collection are complete;
new collector instances still require explicit enablement and credentials.

Implementation homes are `plugin.ts`, `public.ts`, client/storage, pure parser/matcher,
and entry/airport/plate UI under this directory. Create modules only for distinct
responsibilities. The [server module map](#module-and-lifecycle-boundaries) defines
backend ownership; wire types/guards belong in `packages/contracts`.

Update Navigation/Plates guides as integrations land and shared data/persistence,
source, architecture, gateway and deployment guides for their owned contracts.
Link here for parsing/matching rather than duplicating rules. Keep future status
in the roadmap and dated validation evidence beside this plugin with source/build/
time limitations. This README remains the canonical guide after implementation.

## Verification

### Regression coverage

- `test/notams-navaid.test.ts` covers retained NASR station/accountability
  identities, component associations, unmatched-record preservation, navaid
  snapshots from restored server generations, raw source issues, separate query
  namespaces and the real client request paths. `test/notams-delivery.test.ts`
  covers navaid GET/HEAD through the listener without FAA acquisition;
  `test/notams-ui.test.ts` checks the two-tab composition and absent-provider
  behavior. These focused Node checks do not establish browser layout correctness.
- `test/notams-storage.test.ts` exercises actual scoped storage through save,
  client recreation, offline restoration and refresh, including count/byte bounds,
  future source times, clock rollback, rejected updates, denied writes and multiple
  windows merging under a held lock. Legacy airport saves coexist with mixed
  airport/navaid saves; current-cache entries take priority at equal check times
  and the restoration capacity limit. `test/notams-tfr-storage.test.ts` covers TFR
  rollback, reactivation, cross-window regression, read-only restoration and
  cancelled saves. Core record tests cover unavailable locks/reads, queue timeout,
  cancellation and output validation.
- `test/notams-us1000.test.ts` replays every delivered record in the frozen
  1,000-airport commercial/GA capture through the current parser and both React
  reader paths. It checks source integrity, value bindings, evidence and mapped
  content preservation. A separate obstruction inventory checks point coordinates,
  map publication and every reviewed omission. It runs in `npm test`; see the
  [frozen corpus contract](#frozen-1000-airport-regression) for provenance and limits.
- `test/notams-corpus.test.ts` retains 24 complete captured records from 21 airports,
  with independent expectations for field/category assignments, alternatives,
  note actions, qualified closures and conservative fallbacks. It also checks
  source-span, numerical/lexical and rendered-content preservation; deliberate
  content corruption verifies that the audit detects lost clauses and changed facts.
- `test/notams.test.ts` covers conservative flairs, supported schedules and validity,
  procedure identity and ILS/LOC aliases, exact page context, saved/offline state,
  refresh deadlines and cancellation across activations. Captured FDC rendering
  pairs cover collection-to-parser-to-plate matching in both arrival orders,
  unchanged raw text/evidence spans and rejection of conflicting translations.
  Mixed IAP headings cover independent targets and unsupported target review candidates.
- `test/notams-matching.test.ts` pins the cycle 2610 catalog and captured record
  identities, checks complete expected plate sets and rejects wrong scopes/editions.
  It covers hidden sibling misses, partial category coverage, shared catalog
  coverage and source replacements, shared-page section choices, first-part
  boundaries and the airport-list fallback. The offline inventory is
  diagnostic evidence rather than a generated semantic oracle.
- `test/notams-tfr-server.test.ts` covers isolated detail failures, independent
  publication and withdrawals, original retained-detail ages through restart,
  unchanged-index revalidation, legacy unknown ages, complete recovery and durable
  backoff without a request per failed member.
  `test/notams-tfr.test.ts` validates partial snapshots and unconfirmed map/detail
  state, including the live detail-age deadline. Browser regressions cover
  stale/offline/failed collapsed plate counts, unmatched-source review, recovery,
  unknown schedules and individual source access for unavailable/unmappable TFRs.
- `test/notams-ui.test.ts` checks rendered Active/Check timing/Upcoming sections,
  effective-start transitions, removal of the Upcoming flair, and plate grouping
  that keeps upcoming matches after current review candidates and prioritizes FDC
  within each applicability group without changing airport order. These are markup
  and timing checks; browser layout remains part of the release matrix.
- `test/notams-priority.test.ts` checks airport priority against supported closures,
  navaid outages, other effects and misleading mentions. The browser priority
  regression covers independent timing sections, newest-issued and stable-ID ties,
  missing issue times, and classification/subject/search filtering.
- `test/notams-presentation.test.ts` covers runway-specific minimums and alternatives,
  flat/wrapped local-format text, exact values and source retention, unsupported
  qualifications, contradictory validity and bounded fallback. UI tests also check
  shared airport/plate rendering and complete raw source disclosure.
- `test/notams-minima.test.ts` covers category-specific altitude/height and visibility,
  circling/sidestep and fix scope, source notation and footnotes, attached exceptions,
  unknown/contradictory syntax, and note edits that must not expose old values as
  operative minima.
- `test/notams-readable-text.test.ts` covers prose casing, English-word navigation
  identifiers, airport names, exact coordinates/reference codes, punctuation and
  unknown tokens. The shared browser case also checks missed-approach prose and
  unchanged raw disclosure in both airport and plate views.
- `test/notams-formats.test.ts` and its 55 captured examples cover the expanded
  commercial/GA corpus formats, document state boundaries, field/value/category
  binding, exact source evidence, permanent FDC equivalence and rejected source
  ambiguities. Deliberately swapped fields, units and scopes must fail the
  independent audit. The browser suite checks compact units, newline scopes,
  conditional RVR, shortened climb stages and raw character escapes at 320/1280 px.
- `test/notams-flairs.test.ts` covers distinct amendment summaries, complete-scope
  facility combinations, retained procedure names, specific interpretation causes
  and mapped status preservation independent of badge selection. The mapped audit
  must reject lost status even if an outage badge still exists.
- `test/notams-obstacles.test.ts` covers exact coordinate/height parsing, rejected
  ambiguous positions, FDC points without AGL, timing qualifiers and independent
  reader leases. `test/notams-map.test.ts` covers immediate hiding on stow,
  delayed source acceptance, replacement coalescing, failures and teardown.
- `test/notams-areas.test.ts` covers source circle radii, polygon closure and
  dateline wrapping, station alignment, late reference data, service footprints,
  malformed/ambiguous boundaries, GPS altitude qualifications,
  source preservation and renderer-acknowledged coordinate abbreviation. Browser
  coverage verifies overlays, filter/stow lifetime, restoration after map detachment
  and separate From/Until rows on a narrow screen.
- `test/notams-artcc.test.ts` replays 27 U.S. ARTCC and 27 published FIR scopes, including
  oceanic and island scopes, with pinned navigation references and reviewed
  omissions. It checks geometry, source/readers and the supplied ZOA 6/7169 and
  Bull Fire cases. `test/notams-coordinate-recovery.test.ts` checks corroborated
  hemisphere repair, numeric carries, ambiguous tokens and source-point handling.
  The [fixture contract](../../../test/fixtures/notams-us-artcc/README.md) owns
  capture provenance, geometry counts, reviewed omissions and replay instructions.
- `test/notams-server.test.ts` covers AIXM variants, durable admission, generation
  restoration, bulk-to-delta publication, cancellations, failed replacement recovery,
  equivalent raw representations, checksummed source issues, legacy incomplete-checkpoint
  replay, candidate cleanup, unchanged-delta reuse and weather HTTP isolation. A
  26-hour simulated collection exercises persistent ambiguity, independent airport
  updates, restarts, transport/truncated-response failures and daily reconciliation;
  this is deterministic regression coverage, not a live FAA reliability measurement. The historical
  `test/fixtures/notams-fdc-renderings.json` retains the three October 5 production
  FDC conflict pairs, with no credentials or deployment metadata. Regressions cover
  both arrival orders, supported subject/interval wrappers, real-content rejection,
  saved-failure recovery, restart and subsequent deltas without resetting bulk quota.
  Cancellation-retention cases include an old source revision cancelled recently,
  sparse replay, restart with a pending bulk bridge, and expiry of old inactive records.
- `test/notams-reconciliation.test.ts` also replays the retained corpus conflicts
  and the October 6 source pairs in
  [`notams-source-renderings-2026-10-06.json`](../../../test/fixtures/notams-source-renderings-2026-10-06.json).
  Those pairs retain omitted/partial schedules and body line wrapping, including
  SJC 10/027. Regressions check both arrival orders, sparse replays, shared native
  evidence, genuine schedule/content disagreements and recovery across XML deltas
  and restarts without changing source boundaries or request admission.
  [`notams-cancellation-2026-10-06.json`](../../../test/fixtures/notams-cancellation-2026-10-06.json)
  retains CZYZ G3595/26 with a cancellation later than its unchanged source revision.
  The same replay checks cover its restoration and exclusion from active notices;
  cancellation cases also cover fractional timestamp ordering and newer revisions.
- `test/notams-collection.test.ts` covers unfamiliar representations, lifecycle
  ambiguity, order/duplicate independence, bounded evidence overflow, scope unions,
  sparse-version constraints, daily reconciliation and wire completeness guards.
  They also cover two-day cancellation retention through bulk absence, later
  cancellation evidence in either arrival order and the exact expiry boundary.
- `test/notams-admission.test.ts` covers concurrent reservations/backoff, rapid
  failed-auth restarts, interrupted dispatch, slow writes, stale completion receipts,
  normal request spacing/token reuse, legacy admission migration, numeric and
  HTTP-date backoff, checksummed budget/checkpoint corruption, failed writes,
  content-route restrictions, strict UTF-8 and standalone collector shutdown.
- `test/notams-delivery.test.ts` covers 10,000 canonical-query reads sharing one
  serialization, 1,000 concurrent gzip consumers sharing one encoding, status-aware
  invalidation, count/byte eviction, oversized evidence, lossless JSON, strict
  queries, real slow HTTP readers and health availability under local overload.
  Cold airport reads and 1,000 repeated scheduler ticks cannot add FAA calls.
- `test/e2e/notams.spec.ts` covers source conflicts in airport/plate views, raw
  versions, offline retention and unaffected-airport coverage, plus airport
  filters/raw disclosure, optional providers,
  shared requests, actual-page changes and catalog recovery without PDF reacquisition,
  the single staging notice, offline/stowed demand, narrow scrolling/collapse,
  semantic flair colors and contrast in both themes. Departure cases check separate
  runway alternatives, readable-label search and unchanged raw text at 320/393 px;
  shared airport/plate cases cover structured blocks with expanded text spacing.
  Approach cases also verify distinct note actions, exact raw text, and identical
  minima typography in the airport card and plate reader.
  A real MapLibre case checks temporary obstacle symbols, filter changes, stow,
  plate collapse/page changes, map remount and plugin disable/re-enable while
  ordinary DOF symbols remain independent.

### Server reliability audit — 2026-10-05

This records the implementation audit and its subsequent focused validation;
it does not qualify long-term source availability or a complete daily live cycle.
The older collector repeatedly rejected the captured equal-revision FDC
renderings. The 79,090-record checkpoint
still had `incompleteReason: revision-conflict` and an unchanged source watermark;
the status label reflected a real collection stall. The central background/local
read architecture remains appropriate, but making one source disagreement reject
every independent update was an incorrect failure boundary.

The redesign accounts for unresolved IDs explicitly and continues independent
updates. The wider audit also corrected concurrent admission writes, token attempts
across restart, loss of backoff on response-cancellation failure, dispatch delays
around durable writes, unauthenticated checkpoint metadata, older-full-snapshot
erosion of newer observations, UTF-8/member byte limits, standalone shutdown and
unbounded repeated response construction/compression. The contracts above specify
the resulting behavior and fail-closed limits.

Evidence from the audited tree:

- An offline replay of all 79,090 captured production records reconciled all three
  captured FDC pairs, retained an unfamiliar issue alongside an independent update,
  and verified version-2 publication, restart and unchanged admission history.
- The deterministic 26-hour simulation covered 520 scheduled rounds, restarts,
  persistent per-record uncertainty, transport/truncated-response failures and a
  daily full reconciliation. It checked monotonic watermarks and request spacing.
- At captured production record volume, 2,000 real local HTTP requests with 32
  concurrent readers made zero source calls. Measured query/health p95 was 31/14 ms;
  event-loop p99 was 15 ms. Restoration took 644 ms. Peak process RSS was 613 MiB,
  including the replay harness's retained source copy. One scheduled empty-delta
  round then made exactly one token and one data request through fake transport.
  Separate stalled-reader tests verified local 503 admission and reachable health.

The built worker was checked with fake bootstrap/delta transport; API/artifact
readiness was checked separately with NMS disabled. Deployment acceptance
requires advancing complete checkpoints, complete airport content coverage, and
restart recovery that preserves source timestamps and the NMS admission journal
without extra source requests. The graphical TFR snapshot and its separate
admission state must also survive handoff and restart. Release identity, activation
timing and host-specific rollout results belong in private operations.

The October 5 browser run predates later fixture repairs and does not establish
current pass/fail status; use the [verification commands](../../../docs/development/local-development.md#verification).
Sustained combined native-weather/NMS capacity and a complete live daily
reconciliation remain unqualified by this audit. The validation environment used
an 8 GiB memory limit; the
checked-in systemd unit defaults to 4 GiB, so that observation does not qualify
the default capacity. The separate graphical
TFR adapter has independent durable admission and validation. Its additional
targeted server tests cover exclusive ownership, backoff through rapid restarts,
partial-detail recovery, admission corruption and shutdown; those results are
separate from the NMS-specific evidence above.

Continue inspecting advancing `checkedAt`/`watermark` through daily reconciliation
and subsequent restarts. Monitor source age beyond six
minutes, incomplete collection continuity, unresolved/unscoped counts, failure
codes and `nextAttemptAt`; process liveness alone is not NOTAM readiness. Do not
try to repair stale status by resetting source time, deleting quotas, or adding a
second collector.

### Frozen 1,000-airport regression

`test/fixtures/notams-us1000/` retains the October 5, 2026 commercial/GA capture
(October 6, 01:30:54–01:34:52 UTC): 1,000 airport snapshots and all 19,469 delivered
records, including DOMESTIC, FDC, INTL and MIL classifications. The JSON manifest
records the original capture endpoint/time, airport identities and counts, and a
SHA-256 digest of the uncompressed payload. `snapshots.jsonl.gz` stores one complete
snapshot per line in manifest order, compressed to about 3 MB. It preserves every
source field and translation, empty-airport snapshots, feed/coverage status, and
the 12 source conflicts with their 24 variants. Conflicts remain separate from
the delivered records; they are not promoted to resolved notices for the audit.

The sample combines operational public-use land airports in the 50 states and DC
using FAA FY2025 Terminal Area Forecast activity and October 1, 2026 NASR identities.
Selection uses the best rank across total operations, GA operations, and itinerant
GA plus air taxi, with deterministic activity/identifier tie breaks; display order
uses total operations. This retains the earlier 500 GA airports and includes major
commercial airports such as SFO, LAX and DEN. Activity is a coverage proxy, not an
official FAA popularity ranking. Published FAA/ICAO pairs are retained, including
airports without an ICAO identifier. The original ranking CSV and capture reports
remain local audit artifacts; the test only needs the frozen snapshots and manifest.

Run just this corpus with:

```sh
npm run test:notams:corpus
```

The ordinary `npm test` glob also includes it, so `npm run verify` and the automatic
CI verification job run it without a separate opt-in. It performs no downloads,
FAA calls or browser launches and does not read `tmp/`. Records are audited one
airport at a time with the capture's fixed review clock. Assertions cover fixture
integrity and exact cohort/counts, schema validity, unchanged source snapshots,
source spans and flair evidence, numeric/word preservation, independent structured
value bindings, and both ordinary and mapped React readers. Failures identify the
airport, record ID, revision and failing audit.

The obstruction replay independently inventories all 4,976 `OBST` notices:
4,957 publish point markers, four publish areas and 15 remain text-only. Thirteen
of those have ambiguous or uncorroborated coordinates; two only point to another
notice. It also inventories 47 other explicit obstruction-coordinate reports:
45 depict, while two crane descriptions remain inside an open missed-approach
instruction scope. The test independently decodes every accepted point's exact
source span and checks map output, including 37 notices with exact 60-second
carries. `obstructions.json` pins counts and every omitted ID/revision with its
reviewed reason. `obstruction-references.json` pins the necessary navigation
subset, retaining all alias candidates and the full published source hashes.
No fixture source records were rewritten to repair coordinates. The pinned
[omission inventory](../../../test/fixtures/notams-us1000/obstructions.json) owns
individual IDs and reasons; punctuation alone cannot close instruction scope.

This is broad preservation coverage, not an assertion that every notice has a
complete structured interpretation. Unsupported wording may correctly remain
prose, and the reader replay preserves its captured source conflicts. The separate
`test/notams-reconciliation.test.ts` exercises the exact retained conflict pairs
through collection in both arrival orders, duplicate replay and authenticated
restart, checking raw evidence, source times, valid cancellations and unchanged
admission. It follows those repaired records through XML delta replay, empty
updates, backoff, airport response caching and another restart. It also verifies
that changed core content and truncated evidence stay unresolved and an incomplete
collection cannot become complete merely by repairing records. The focused corpus/formats/semantic
tests retain independent expected meanings and deliberately corrupted examples;
keep those tests when extending this replay. Do not replace them with generated
parser-output snapshots or weaken an audit to make unfamiliar wording pass.

The cycle 2610 [baseline inventory](validation/2026-10-05-matching-audit.json) and
[follow-up inventory](validation/2026-10-05-matching-fixes.json) retain source hashes,
per-heading outcomes and remaining catalog discrepancies. A content-preservation
pass does not establish complete plate associations.
The fixture also retains the complete byte-identical published cycle 2610 catalog
in `plate-catalog-2610.json.gz` (about 1.4 MB), with its uncompressed hash/size and
source URL in the manifest. Keeping airports outside the cohort preserves exact
shared-page section context. `test/notams-matching.test.ts` checks independent
captured match sets, scope/identity negatives, amendment conflicts and shared pages.
`tools/audit-notam-matching.ts` replays catalog-entry matching offline and inventories
every recognized heading, including misses hidden by a matching sibling. Its
successful exit means the inventory completed, not that every match is correct.
Reproduce the inventory without network access:

```sh
node --import=tsx tools/audit-notam-matching.ts test/fixtures/notams-us1000 test/fixtures/notams-us1000/plate-catalog-2610.json.gz /tmp/notam-matching.json
```

The follow-up inventory retains 19 unassociated headings in 16 notices, including
three notices with a matching sibling. Missing titles, SA authorization differences,
unknown amendments and dependency gaps remain explicit; no catalog metadata is
inferred from a PDF inspected during a review.

`tools/pack-notam-corpus.ts` packages an existing sequential capture offline:

```sh
node --import=tsx tools/pack-notam-corpus.ts CAPTURE_DIRECTORY NEW_FIXTURE_DIRECTORY
```

The input contains `manifest.json`, `capture.json` (capture times, review clock,
endpoint, and each airport's FAA/ICAO identity, record/issue counts and original
`snapshotSha256`) and `snapshots/<faaId>.json`. The packer validates every original
hash, schema, identity and count, copies all source content without parsing or
filtering, and refuses to overwrite an existing destination. For an intentional
refresh, review a new capture and its source issues, package a separate candidate,
then review the manifest/cohort and focused semantic cases before replacing the
fixture and its explicit test counts. Tests never recapture or update expectations.
To inspect the retained data, use `gzip -dc test/fixtures/notams-us1000/snapshots.jsonl.gz`.

### Broad airport presentation audit

The [structural inventory](validation/2026-10-05-structural-audit.json) and
[semantic inventory](validation/2026-10-05-semantic-audit.json) cover all of the
FAA's top 100 airports by CY2025 passenger boardings, plus eight GA airports.
The dated [airport manifest](../../../test/fixtures/notams-airports-2026-10-05.json)
retains ranking provenance and explicit FAA/ICAO pairs. Recheck rankings and airport
identities when changing the sample; do not infer every ICAO identifier with `K`.

Run from the repository root, choosing a new capture directory:

```sh
node --import=tsx tools/capture-notams.ts test/fixtures/notams-airports-2026-10-05.json /tmp/notam-capture
node --import=tsx --import=./test/helpers/assets.ts tools/audit-notams.ts /tmp/notam-capture /tmp/notam-audit.json
node --import=tsx --import=./test/helpers/assets.ts tools/audit-notam-generations.ts /tmp/notam-generations.json /tmp/notam-capture /tmp/notam-next-capture
node --import=tsx --import=./test/helpers/assets.ts --test --test-isolation=none test/notams-corpus.test.ts
```

Capture reads the prepared info-server API with at most three concurrent requests;
it neither acquires FAA data nor forces refreshes. It refuses to replace an earlier
capture. Audit validates the snapshots, counts every retained classification,
checks source spans/values/words and shared React rendering, and emits per-airport
coverage, feed health, failures and a frequency-ranked fallback inventory. Recognized
display aliases are explicit in the audit. `notam-value-audit.ts` independently
checks structured label/value/category bindings, approach and runway scope,
aircraft branches, ordered climb stages and declared distances. Mapped-entry audits
check retained operational text as well as the actual React rendering with raw
disclosures excluded. Mutation tests prove that swapped associations and deleted
qualifiers fail even when the numerical multiset is unchanged. Captured golden
cases separately cover obstacle outages, source prefixes, facility effects,
conditional instructions and ambiguous fallback families.

These checks still do not prove route applicability or completeness of FAA
collection. The generation command rejects stale/degraded/mixed captures,
different airport cohorts, content failures and repeated source generations. It
requires at least two fresh, complete, distinct generations and reports newly seen
record versions separately. A new capture timestamp alone is not temporal coverage. The October 5 semantic
captures contained the same degraded generation and added no record versions;
that retained evidence does not complete this temporal qualification.
Keep unsupported clauses visible; never supply missing altitude types, gradient
units, RNP labels or ambiguous radio-altitude/multipart meaning to improve counts.

### Presentation coverage sample — 2026-10-05

At 18:25 UTC, cached production airport queries using both FAA and ICAO selectors
returned 4,331 retained records: 1,880 domestic, 575 FDC, 1,851 international and
25 military. The 40 airports were KATL, KDFW, KDEN, KORD, KLAX, KJFK, KSFO, KSEA,
KLAS, KMCO, KMIA, KCLT, KPHX, KIAH, KBOS, KEWR, KMSP, KDTW, KPHL, KLGA, KBWI,
KDCA, KIAD, KSLC, KSAN, KTPA, KPDX, KSTL, KBNA, KAUS, PANC, PHNL, KSJC, KOAK,
KSMF, KSCK, KTEB, KHPN, KAPA and KCVH. Reads used the shared cache and did not
initiate FAA acquisition. International notices can represent the same underlying
notice as domestic/FDC records; these counts are not independent operational events.

The FDC set included 365 IAP, 134 SID, 44 ODP and 15 STAR notices. Reviewing
recurring numeric-normalized clause patterns exposed missing MDA/DA-height pairs,
category-specific visibility, note actions, whitespace before amendment ellipses,
and conditional/footnoted minima. These forms informed invented regression fixtures
and were compared with [FAA's published NOTAM examples](https://www.faa.gov/air_traffic/publications/atpubs/notam_html/appendix_a.html).

After the changes, replay produced 420 structured minima/visibility blocks across
235 FDC IAP notices and 160 labeled instruction blocks across the FDC set. All
4,331 records replayed without source-object mutations; all 835 emitted minima
blocks across classifications preserved the source numeric sequence. This checks
values and formatting, not operational applicability or universal grammar coverage.
Remaining fallback examples include omitted altitude labels, `DA/RVR/HAT` triplets,
radio-altitude shorthand, reversed height notation, misspelled visibility labels,
joined clauses without delimiters and ambiguous continuations after note edits.
Those retain the complete source wording in the main view. General domestic notices
still rely on scoped flairs and source paragraphs; the new numeric model is for
procedure amendments, not an arbitrary NOTAM decoder.

A subsequent casing replay against the same sample changed ordinary prose in 3,558
records. Case-insensitive whole-string comparisons retained every word, number,
punctuation mark and space in all 4,331 bodies; records remained unmodified and the
835 structured-minima numeric checks still passed. This casing evidence is separate
from structural coverage: unrecognized abbreviations and tokens remain uppercase.

Focused Node and Chromium checks cover these derivations and both themes/hosts;
this sample does not complete full verification or installed-device qualification.

### Local implementation evidence — 2026-10-04

Replaying the saved KSJC staging airport response derived specific tags for all
30 D/FDC records. These observed source forms informed the grammar and synthetic
fixtures; the replay did not establish operational completeness. Browser checks
used invented notices and a synthetic three-page PDF, without FAA acquisition.
Live staging full-load and delta evidence is recorded in the source qualification
section above. These samples do not qualify shared deployment capacity or complete
the broader release matrix below.

### Release qualification matrix

Parser/matcher fixtures must cover D/FDC, unknown fields/keywords, whitespace, multiple
procedures, runway suffixes, RNAV Y/Z and GPS/RNP, ILS/LOC combined titles,
SID/STAR revisions/transitions/continuations, amendment mismatches, broad scopes,
pointers, multipart gaps, scoped `NA`/`U/S`/`CLSD`, exceptions, and failed parsing
that retains readable/raw text. Include incidental runway/procedure mentions as
negative cases, plus supported/unsupported schedules and UTC boundaries.

Collector tests must cover token expiry/renewal failure, 200-with-errors, redirect/path
forms, expired content, malformed/truncated/oversized compressed/XML responses,
empty/overlapping deltas, out-of-order revisions, duplicate IDs, cancellations/
replacements, clock skew, persisted quota, corrupt checkpoints, partial writes,
concurrent readers, and outages beyond lookback. Rebase/checklist comparisons
require established completeness and permitted request cadence.

Full-dataset tests must cover previously unqueried airports, every delivered
classification, upcoming notices, cancellations missing from an earlier faulty
generation, older bulk snapshots, changes during reconciliation and incomplete
bulk loads. Prove that a reconciled full sync repairs drift without regressing
newer records; that partial loads/capacity failures retain the preceding dataset;
and that full pulls, deltas, failures and restart share the same durable budget.
Query-cache eviction and generation changes must preserve local coverage and
invalidate obsolete empty results without source calls.

Server integration tests use fake NMS transport, clocks and temporary state. Prove
that many airport/health reads and disconnected clients cause no FAA requests;
that disabled/misconfigured NMS, failed OAuth, corrupt state and parsing failure
leave weather routes available; and that restart, overlapping refresh calls,
shutdown, credential rotation and release handoff preserve request admission.
Exercise `GET`/`HEAD`, strict routing, safe errors, no-baseline versus complete
empty results, generation-pinned reads, and cold/warm state with the weather
cache independently replaced. Validate proxy paths and the built worker layout.
Cover FAA-only, ICAO-only and paired selectors, non-`K` aliases, catalog-ID rejection,
duplicate records across selectors, conflicting airport context and complete zero
results for valid airports without notices. Query input never creates alias mappings.
Run a combined bootstrap/forecast workload within the deployed CPU/memory limits
to qualify sustained production capacity; normal unit passes do not establish it.

Browser regressions must cover timing-section order and counts, effective-time
transitions, filtering across sections, theme contrast and wrapping, third-tab
keyboard order, airports without plates, saved-tab compatibility, disabled providers,
simultaneous airport contexts, raw
disclosures, filters, stale/empty/error states, denied storage, reconnect and late
results. Plate regressions cover paging across airports, continuations, ambiguous
context, saved old editions, fullscreen, rotation, short/narrow viewports, enlarged
text, touch scroll, focus, and unchanged PDF acquisition/worker/view state.
The NOTAM browser fixture loads both bundled B612 weights. Its reading-layout
cases exercise long identifiers and raw translations, loading/error/empty states,
both themes, keyboard disclosure focus and touch sizing, and narrow/short layouts
with expanded text spacing in the airport, plate-row, side-reader and fullscreen
views. These exercise the real shared controls and list renderer.

Use the [shared UI viewport matrix](../../../docs/features/shared-ui.md) and
[local verification commands](../../../docs/development/local-development.md#verification).
Run `npm run verify:full` before committing. Installed-device and
production-feed checks remain separate. A fixture pass or ForeFlight comparison
does not prove operational completeness. Comparisons record airport, exact plate
edition/page, environment, effective time, source-check time and supported scope.

## Open source questions

These are qualification work, not assumptions to hide in the UI:

1. Confirm redistribution conditions and how auth,
   content, checklist, location-series, diagnostics and failed calls consume the
   credential budget, including whether classification bulk limits aggregate.
2. Confirm 24-hour lookback, location-series defaults, delta inclusivity, source
   clocks/baseline timestamps and a gap-free bootstrap sequence.
3. Establish cancellation/replacement IDs and revision ordering, estimated/permanent
   end behavior, and same-time conflicts with authoritative fixtures.
4. Confirm completeness indicators, record limits/pagination, bulk counts, and
   malformed-record behavior in response envelopes.
5. Validate FDC airport association, multi-airport/multipart records, dependency
   coverage, and location/geometry limits for ARTCC/regional notices.
6. Qualify procedure/amendment name variation, schedules, translation availability,
   safe record sizes and supported content URL forms.

## References

- The onboarding inventory and discrepancies above preserve source context without
  requiring credential-bearing files to be published with this guide.
- [FAA AIM, NOTAM classifications and keywords](https://www.faa.gov/air_traffic/publications/ATpubs/AIM_html/chap5_section_1.html)
  supplies terminology/examples; interpretation still needs qualified NMS fixtures.
- [FAA NOTAM definitions](https://www.faa.gov/about/initiatives/notam/what_is_a_notam)
  distinguishes distant dissemination in NOTAM (D) from the domestic classification name.
- [ForeFlight FDC NOTAM display](https://support.foreflight.com/hc/en-us/articles/203329009-Where-can-FDC-NOTAMs-be-viewed-in-ForeFlight-Mobile)
  describes airport lists, the red plate alert, and access to all airport notices.
- [ForeFlight 17.8](https://www.foreflight.com/releases/17-8) describes relevant
  procedure counts and Show All. These are interaction references, not documentation
  of ForeFlight's matching algorithm.
- [ForeFlight NOTAM interface improvements](https://www.foreflight.com/enhancements/notam-interface-improvements)
  provides the list/filter reference. The flair grammar and theme colors above are
  this plugin's own deterministic presentation rules.
- [Navigation](../navigation/README.md), [Plates](../plates/README.md),
  [shared UI](../../../docs/features/shared-ui.md#shared-controls),
  [time formats](../../../docs/features/date-time-display.md), and
  [workspace persistence](../../../docs/architecture/workspace-persistence.md)
  own existing host contracts.

## Reader working set

Notice lists mount at most 50 complete entries per page in the existing timing
and applicability order. Previous/Next notices expose the full retained list;
section counts, filtering, search, matching and chart preview still cover all
records. Changing filters resets the page. Raw translations/source text mount
only while **Show raw** is open and are released on close or page change.
Unmounting an entry also releases its hover/focus chart highlight.

Temporary chart rendering retains one prepared collection per adapter. Clock
updates compare record identities, reference identity and per-notice validity
states before geometry preparation/serialization. Schedule transitions, expiry,
clock rollback and changed source/reference data invalidate that result; unchanged
validity keeps the same collection. No second national geometry cache is added.
