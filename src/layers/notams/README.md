# Airport and procedure NOTAMs

[Documentation](../../../docs/README.md) / Plugins / notams

**Status: implemented; production feed enabled.** This is the long-term owning
guide for the NOTAM plugin, collector, supported interpretation, and remaining
qualification. Collection remains disabled by default for new deployments. The
[roadmap](../../../docs/product/roadmap.md#airport-and-procedure-notams) tracks
release work. Requirements below retain the intended scope; the implementation
coverage and dated evidence distinguish supported behavior from remaining work.

The plugin shows NOTAM (D) and Flight Data Center NOTAMs (FDC)
in a third airport-detail tab, with concise flairs and a **Show raw** disclosure
for every entry. Relevant notices also appear in an expandable red **NOTAM**
bar in the plate reader, especially amendments to IAPs, SIDs, and STARs.
One data client and entry renderer serve both views.

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
  The workspace's optional bridge composes the UI. The plate disclosure stays
  focused on the displayed plate; the full airport list lives in the NOTAM tab.
- Plates pins the catalog resource in new selections and resolves each book page
  by exact URL/hash/index. Legacy selections without that resource remain readable
  but report matching unavailable; reopening from the catalog supplies the pin.
- The shared info server owns OAuth, all-class full sync, global deltas,
  durable quota admission, checksummed generations, local reads and feed health.

Current interpretation limits: explicit IAP headings, named SID/STAR headings,
all-IAP scope, runway identity and explicit runway ILS/LOC/glideslope outages are
supported. Ambiguous procedure targets are review candidates; facility dependency
graphs, broader regional applicability,
multipart assembly and every publisher alias are not established. Simple daily
and weekday/range UTC schedules with one time window are evaluated, including
overnight windows. Other schedules remain **Check Schedule**. These limits cannot
establish complete operational applicability. Sustained deployment capacity
alongside weather, device checks and broader source comparison remain
release work.

## Contents

- [Scope and ownership](#scope-and-ownership)
- [Airport detail tab](#airport-detail-tab)
- [Persistent TFR chart](#persistent-tfr-chart)
- [Plate NOTAM bar](#plate-notam-bar)
- [NMS source contract](#nms-source-contract)
- [Staging evidence, October 4, 2026](#staging-evidence-october-4-2026)
- [Production verification, October 5, 2026](#production-verification-october-5-2026)
- [Collection and delivery](#collection-and-delivery)
- [Airport query contract](#airport-query-contract)
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

Airport association is not a complete route briefing. ARTCC-wide, regional GPS,
national, and nearby airspace notices require additional applicability rules;
an airport location query or airport-point geometry alone does not establish that
coverage. Document supported scope and qualify those rules before expanding
it. The persistent TFR chart uses the separate FAA graphical source described below.
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
filters plus text search using core controls. Include Other/Unclassified so
imperfect parsing never hides a notice. Show filtered and total counts, and reset
transient search/filter restrictions on a different airport. These filters do not
affect the plate bar's results or counts.

Group notices into **Active**, **Check timing**, and **Upcoming** sections, omitting
empty sections. Active contains notices within their effective interval and any
supported schedule; uncertain validity/schedules and notices outside their schedule
stay under Check timing with their existing qualifiers. Upcoming always appears last,
with a muted heading and subtle dashed leading border using existing theme tokens;
it is a section, not a flair. Keep notice text and semantic flair colors at full contrast.
Within each airport section, order newest issued first with a stable ID tie-breaker;
the plate list additionally prioritizes FDC notices as described below.
The clock reevaluates timing every 30 seconds while
demanded and immediately when demand resumes, moving notices between sections as
their effective times change. Expired/cancelled
notices leave the current list only on validated lifecycle/time evidence; retained
history is separate and bounded. Do not infer severity from FDC versus D.

| Entry element | Contract |
| --- | --- |
| Identity | Source number and location, with classification `D` or `FDC`; preserve unknown classifications explicitly |
| Subject flairs | Source-backed topics such as Runway, Taxiway, IAP, SID, STAR, Navaid, Obstruction, or Airspace |
| Effect flairs | Scoped effects such as Runway Closed, Lighting Unavailable, Procedure Amended, or Circling Unavailable, only when established |
| Body | Conservative formatting retaining every operational clause, condition, exception, value, and unit |
| Validity | Start/end in device-local time with Zulu in parentheses, schedule, estimated/permanent qualifiers, and timing uncertainty using core time formatting |
| Source state | Environment-specific source status and retry above the list, as described below |
| Raw disclosure | **Show raw** containing the complete original local-format text and any ICAO translation, separately labeled |

Production snapshots show **FAA NOTAMs · Checked …** above each airport list or
expanded plate list, using the actual source-check time. Offline, stale,
incomplete-coverage, request-failure and degraded-feed states remain explicit when
present; production access alone does not establish freshness or completeness.
The snapshot's environment controls the note, including for saved data.
Keep feed status in this source header. Counts describe retained notices and
matches without repeating generic completeness or coverage qualifiers. Empty
airport lists say **No retained notices.** Empty plate lists say **No matches in
the retained notices.** These describe the saved results without a separate claim
about current completeness.

Staging snapshots retain one testing notice in the same position:
**Testing with FAA staging data. Notices may be incomplete. Do not use for flight
planning.** This replaces source-age, stale, incomplete and degraded-feed messages.
Offline state, request failures, retry actions and procedure-specific
interpretation/review qualifiers remain visible.
Empty staging results describe retained notices without implying current completeness.

Raw text is selectable/copyable, retains line breaks, and wraps on narrow screens.
Validity labels use the shared local-first timestamp pair, for example
`From Oct 4 · 09:00 PDT (16:00Z)`. **From** and **Until** occupy separate aligned
rows; long dates wrap within their value column. Permanent, estimated and unknown
end qualifiers stay on the Until row. When local and UTC calendar days differ, include
the UTC date inside the parentheses. Display the local zone at each instant so
daylight-saving transitions remain explicit. Source schedule and raw NOTAM times
retain their supplied notation.
If a complete translation is missing, expose available source text and label that
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
native controls at core's text-entry and touch sizes. **Show raw** is a native,
keyboard-operable disclosure with a visible focus ring and at least a 32 px
pointer / 44 px touch target. Flairs use semantic theme tokens; their text conveys
meaning independently of color. Do not dim notice text in Upcoming sections.

### Temporary obstacle map context

An open airport NOTAM tab previews supported obstacle/crane points from its filtered
list, together with supported area boundaries. An expanded plate NOTAM panel
previews the geometry in its displayed matches.
Stowing/closing the host, switching tabs/airports/pages, collapsing the plate bar,
hiding the document or disabling NOTAMs releases that reader's preview. If two
readers are visible, each owns a lease; releasing one cannot erase the other's
context. Previews are session-only and do not create acquisition demand or a saved
map overlay. Reopening uses the current retained snapshot and current timing.

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

`obstacles.ts` accepts the explicit coordinate/altitude/height point format in
[FAA 7930.2 §5-2-2](https://www.faa.gov/air_traffic/publications/atpubs/notam_html/chap5_section_2.html).
The unlabeled altitude in feet in that format is MSL; parenthesized AGL is separate.
Compact DMS coordinates support fractional seconds and all hemispheres, with
strict degree/minute/second limits. A leading airport identifier is stripped only
when confirmed by the record's locations. Selected explicit FDC crane/tower clauses
with MSL and coordinates also qualify; without AGL they use a neutral position ring
and `(?)` for the unknown AGL height, never an inferred low/tall classification. Multiple
explicit FDC point clauses remain separate. Note edits/conditions stop extraction
of subsequent FDC coordinates rather than promoting quoted positions.

Farm descriptions without supported boundaries, multiple ambiguous coordinates, malformed coordinates, unknown
positions and runway-relative descriptions stay in the readable list without a
guessed point. Airport/Q-line centers and ASN/ASR references are not obstacle
coordinates. This preview does not promise complete obstacle coverage or change
plate applicability. Cancelled and definitely expired notices never generate points.

`areas.ts` supports explicit latitude/longitude circles and closed simple polygons
in AIRSPACE, NAV GPS and OBST notices, following the location forms in
[FAA 7930.2 §6-1](https://www.faa.gov/air_traffic/publications/atpubs/notam_html/chap6_section_1.html).
Circles require a published NM radius and coordinate center. Polygons require
at least three distinct vertices, at most 64 supplied coordinate pairs and an
explicit return to the first point; self crossings,
missing closure, arcs, corridors, exclusions, additional boundary qualifications
and navaid-relative positions retain full prose. Never use the Q-line radius or
an airport center as the operational area. Coordinates use the same strict DMS
decoder as obstacle points. Geodesic circles use 64–720 segments, with a radial
chord error below 0.01 NM; polygon edges use the shared great-circle sampler.
Longitudes unwrap locally across the dateline. Radii/edges over 600 NM and
geometry above 85° latitude remain text, bounding work and avoiding polar ambiguity.

Areas share the obstruction orange, with diagonal hatching over a 24%-opacity
fill, a fully opaque 2.5 px dashed boundary and a concise activity label with a dark halo
(for example **UAS** or **GPS unreliable**) with source altitude limits when
available. These are activity footprints, not an inferred entry prohibition.
One repeating pattern image supplies the hatch and tint without additional geometry
or camera listeners; it shares the preview's visibility and resource lifetime.
GPS footprints that explicitly decrease with altitude depict the published outer
circle as **Outer extent**. All smaller-radius altitude tiers stay in the entry;
the map does not imply that the outer footprint applies at every altitude.

`chart.ts` replaces only the validated location portion of a standalone OBST
description with **Location shown on chart**. The chart labels carry its type and
heights; outages, marking/lighting status, conditions and all remaining wording
stay visible. Only exact unconditional `U/S` lighting or `FLAGGED AND LGTD` status
may move entirely into its corresponding visible badge. Additional wording or
schedules prevent that omission. Never clear an obstacle's whole readable body
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

`map-state.ts` owns per-reader leases and chart acknowledgments; `map.ts` owns
images, fills, outlines, labels, source submissions and cleanup. Clears and
replacements hide old geometry immediately, before worker
acceptance; late submissions cannot reveal stowed geometry. Changed inputs coalesce
behind one pending submission. Unchanged geometry/timing does not resubmit. One
bounded retry follows a source failure, and subsequent input can retry; teardown
cancels retries/listeners and releases resources even after partial setup.

## Persistent TFR chart

Implemented locally; deployment and sustained live qualification are separate.
Enabling the NOTAM plugin starts a national TFR client independently of airport
selection, search, open readers or stowed panels. Disabling it aborts requests,
stops clocks and removes the map resources, context-menu action and details panel. Map reattachment
uses the current snapshot. Active areas use solid red outlines with translucent
red fill; upcoming areas use yellow. Neither uses hatching. Temporary reader
geometry excludes explicit TFR text so it cannot add a second, hatched TFR shape.
Areas have no map labels. A left click or tap inside a published area opens the
shared right-side detail panel with its identity, altitude limits, current/next
window, complete raw NOTAM and a link to the FAA detail page. Overlapping areas
are listed together. Right-click or long-press opens the shared map menu with
**Inspect TFRs** alongside applicable actions from other enabled plugins; releasing
the long press does not select an action. Direct TFR inspection takes precedence
over point selection inside an area; nearby navigation points remain available in
the context menu. Active tools and route drags retain the shared gesture policy.
The panel has no dedicated edge tab. Reopen it by clicking/tapping an area or choosing
**Inspect TFRs**; Close, Escape and Back use the shared panel lifecycle. Its compact
typography matches other map details: 12px content, 14px notice headings and 11px
freshness metadata, with the shared panel heading. Each explicit inspection reopens
it; source/clock updates refresh its contents without reopening a stowed panel.
Selection is session-only and resolves current source
identities, so expired/removed areas are not presented as current restrictions.
The Layers footer reports source age and missing geometry or schedules. The footer
and details panel retain stale-source qualifications.

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

The collector checks the index at least three minutes after the preceding round,
reuses details only with the same FAA ID/modification time and fetches changed
details sequentially, with at least one second after the preceding response body,
30-second deadlines and durable overload backoff. Index/XML
inputs are bounded to 1/2 MiB; XML rejects DTDs and has node/depth limits. A fully
validated replacement is bounded to 8 MiB/1,000 notices and atomically saved with
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
Failed acquisition retains the preceding snapshot and its original `checkedAt`,
with an explicit error. Only a successful index replacement removes absent IDs.
HTTP reads never contact FAA; a cold cache returns 503. `/api/weather/healthz`
includes independent `tfrs` readiness, check time, failure state and next attempt.
HTTP serialization and gzip are shared for the current check-time/error boundary;
the common NOTAM delivery limit bounds slow clients.

The PWA reads every three minutes while enabled, rejects future/regressing
snapshots, and marks source data stale after six minutes or a reported refresh
failure. Optional validated localStorage restoration is limited by the plugin's
2 MiB record ceiling; storage failure never prevents online display. This route
shares the existing `/api/notams/` service-worker exclusion and reverse proxy.
The matching info-server release must be deployed to make the new route available.

Local evidence, 2026-10-05: all 90 captured FAA detail documents normalized into
105 areas, 93 with published geometry and 105 with recognized schedules. This is
a dated source sample, not a promise about future FAA documents. Captured examples
in `test/fixtures/tfrs.json` and `test/notams-tfr.test.ts` cover identity, UTC,
recurrence, geometry bounds, cache retention and HTTP/client lifecycle.
`test/e2e/notams.spec.ts` exercises persistent solid red/yellow rendering,
details, panel independence, disable/re-enable and map reattachment.

## Plate NOTAM bar

Place a horizontal strip between the plate heading and PDF reading area, with
centered **NOTAM** text, a count, and an expand/collapse chevron. This is the middle
bar in the reader layout, not a mark drawn onto the source PDF.

When relevant notices exist, the strip is red. Clicking expands the shared entry
list inline. Use the same timing sections as the airport list, separating
**Applies to this plate** from **Review applicability** within each section. This
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
Detailed feed status belongs in the expanded source header; notice-specific
interpretation and applicability reasons remain with the entries.
Count each source notice once even if several clauses match. Multipart groups
retain their individual parts' identities and counts.

The expanded area has a maximum height based on available reader height and its
own scrolling, with a tighter cap in short readers. Keep the collapse control,
PDF controls, and some reading area reachable on short phones. The disclosure
participates in layout rather than covering chart content. Scrolling it must not
trigger PDF pan/zoom. The strip stays
reachable while its list or the PDF scrolls.
Keep the source status and refresh action spaced apart from the plate title and
the first timing-section heading so the controls and notice groups remain distinct.
The title uses the shared 14 px heading scale. Empty, recovery and unavailable
states use the same compact status typography as airport lists; catalog retry
keeps its shared button styling. The bar label wraps beside a separate chevron,
and procedure-row counts wrap within their existing metadata layout.

| Data state | Bar behavior |
| --- | --- |
| Current matches or review candidates | Red strip with counts, timing qualifiers, and expandable entries |
| Complete, fresh query with zero matches | Neutral `NOTAM · 0 matched`, limited to the supported scope |
| Loading without a snapshot | Loading state, never a zero count |
| Saved/stale snapshot | Retain match counts; identify age and offline state in the expanded source header |
| Partial feed with a snapshot | Retain match counts; show feed status and recovery in the expanded list |
| Unresolved page or failed query without data | Explicit unavailable matching state with recovery |

The expanded strip shows notices for the displayed plate. The airport's NOTAM tab
owns the full list; omit the **Show all airport NOTAMs** button and nested full-list
fallback. Apply the staging presentation above; production keeps source freshness
and actual incomplete states visible. Unresolved interpretation remains explicit in
both environments, without repeating general regional/route-scope explanations.
Counts beside IAP/SID/STAR rows in the Plates list use the same airport snapshot
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
target. Shared minimums documents require airport-specific context. Unresolved or
ambiguous pages show matching unavailable; never carry a previous airport's
confirmed notices onto another page.

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
   without comparing its presentation or other inactive metadata. These records
   are excluded from the active airport index; their text may shrink to a terse
   cancellation rendering without affecting active coverage. A cancellation
   message is distinct from an original-ID tombstone. Their references never
   remove another source ID. An equal-order active/inactive disagreement becomes
   an unresolved source record; neither lifecycle is chosen as authoritative. Newer source revisions follow the usual ordering. Envelope, source-ID,
   record-bound and lifecycle validation always precede reconciliation.

   Active records retain stricter content checks. At equal ordering, the
   demonstrated `NMS_ID_` alias and equivalent
   update-time fractional-zero spellings do not make a conflict. Decimal notice
   and referred numbers compare without leading zero padding; composite identifiers
   remain exact. Translations are optional representations grouped by type, not
   an ordered list of required fields. Shared types must have the same text after
   whitespace normalization and removal of the observed literal `<pre>` wrapper.
   For recognized ICAO NOTAMN layouts only, paired domestic/international header
   numbers may differ across those two formats; different numbers, series or years
   within one format are conflicts. Missing Q-line traffic/purpose/scope values may be
   supplemented. All supplied values must agree; FIR, code, altitude, coordinates
   and the complete A)-onward content remain exact. Unrecognized layouts and
   replacement/cancellation references receive no such relaxation. Arbitrary
   markup, case and punctuation are not discarded. Missing types do not withdraw
   previously supplied translations. Retain earlier raw spellings and append new
   types or compatible ICAO variants within the existing record limits. Every
   retained variant constrains later comparisons, so an empty qualifier cannot
   override a populated value. Alternate renderings can also differ in issue time;
   retain the earliest supplied issue time without changing update ordering,
   effective times or freshness. Hash the combined normalized record. Never carry
   old translations into a newer revision. An E)-only body and a full ICAO body
   reconcile only when both records retain the identical complete ICAO translation
   and its E)-onward content matches the short body. Retain the short body and the
   complete raw translation, including any F)/G) suffix. Missing structured referred
   metadata may be supplemented; two supplied references must agree. References
   never identify another source ID for deletion.

   FDC procedure bodies may include or omit the subject (`IAP`, `SID`, `STAR`,
   `ODP`) and trailing validity interval. Reconcile those forms only through an
   identical complete `LOCAL_FORMAT` translation retained by both records, after
   whitespace normalization. Its FDC number/year, airport, interval and end qualifier
   must match each record; both bodies must equal a supported form of that exact
   translation. Preserve the first raw body and all compatible translations. An
   optional ICAO rendering may carry older dates and cannot substitute for this
   local evidence. Changed restrictions, conditions, identities or dates still
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
   tombstones long enough to prevent resurrection from overlap. Absence in a delta
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

Unfamiliar same-order content, active/inactive disagreements, unknown lifecycle
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
cancellation messages/tombstones for two days. The lock owner removes unreferenced
dataset files at startup and after publication/candidate disposal, including failed
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

## Info server integration

Use `createInfoServer`, `info:serve`, `info:build` and `zlayer-info.service` for the
shared listener on port 8787. The [server guide](../../../tools/info-server/README.md)
owns common operations; this section defines the wiring for the collection
and query contracts above. No additional workspace or service framework is needed.

### Module and lifecycle boundaries

The explicitly composed `createNotamService` runs beside the existing weather
updaters. A small surface is sufficient: `restore`, `refresh`, `readAirport`,
`status`, and `close`. Use typed constructor options with injectable transport,
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
The systemd budget is shared: four CPUs' worth of time and 4 GiB across the process
and workers. Set the [storage/resource limits](#storage-and-query-indexes) within
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
Enabled collection requires Linux `flock` (util-linux); Docker installs it. A
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

Dispatch `/api/notams/` before weather's `routeFor`, enforcing the query contract
and rejecting unexpected parameters/ranges. Expose no arbitrary upstream proxy.
Include the feed-health summary as `notams` in existing `/api/weather/healthz`.

- Add `/api/notams/` to `tools/dev-proxy.ts` with the same
  `INFO_API_ORIGIN` target as weather. Both products use one local/remote service.
- Add a sibling location in `docs/development/info-api.nginx.conf` forwarding
  to the same backend as weather. The snippet's optional SSH tunnel uses loopback
  port 8788; a same-host backend uses port 8787. Reuse the same-origin TLS boundary;
  no additional public listener is needed.
- Give `zlayer-info.service` a second persistent state directory,
  `/var/lib/zlayer-notams`, and configure `NOTAMS_STATE_DIR` there. Keep it stable
  across release symlinks and weather cache swaps. Mount a separate persistent
  NOTAM volume for Docker and include any new worker in the existing build.
- Warm candidate weather releases with NMS disabled. Stop and drain the old
  collector before enabling its replacement against the same durable NOTAM state.
  Do not let candidate/staging processes use the production key concurrently.
  Validate state-schema compatibility before switching or rolling back code;
  never restore an older quota journal as part of rollback.

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

Recognize keywords in their subject position, not unrestricted substring searches.
Start with NMS's vocabulary: `RWY`, `TWY`, `APRON`, `AD`, `OBST`, `NAV`, `COM`, `SVC`,
`AIRSPACE`, `ODP`, `SID`, `STAR`, `CHART`, `DATA`, `DVA`, `IAP`, `VFP`, `ROUTE`,
`SPECIAL`, `SECURITY`. Preserve unknowns. A D pointer mentioning an FDC notice keeps
its original classification.

Attach effects to their subject and clause. Retain exceptions, conditions, aircraft
categories, transitions and time windows. Context-specific abbreviation expansion
must preserve values, units, direction and scope. Unknown clauses stay in the
default readable body; raw disclosure is not a reason to omit qualifications there.
Every derived flair retains supporting source-field or text-span evidence.

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

`minima.ts` recognizes complete approach-minimums clauses for LNAV, LNAV/VNAV,
LP/LPV, RNP, GLS, straight-in ILS/LOC, circling and sidestep entries. It displays
MDA/DA, HAT/HAA/HAS and visibility/RVR as compact inline label/value pairs.
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
explicitly labeled altitude/height/visibility values with value-before-RVR
ordering share a row only with their published category scope. Multiple
explicit approach scopes on one line become separate minimums sections only when
every member parses completely. `NA` in a minimums value displays **Not authorized**;
it is never zero, an absent field or a general-purpose expansion of `NA` elsewhere.

`takeoff.ts` accepts explicitly headed runway clauses, including published runway
shorthand such as `4L/R`, up to three complete alternatives and a trailing obstacle
reference. It does not borrow a preceding runway/heading, supply missing gradient
units, or carry a scope into an unheaded later clause. Explicit JETS/PROPS branches
retain separate aircraft/runway headings; every branch must name its runway.
Up to four explicitly unit-labeled climb stages retain their ordered gradients
and endpoints under **Minimum climb** and **Then minimum climb**. An explicit
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
remove **Interpretation Limited**. Complete translations and the source body stay
untouched under **Show raw**. A trailing compact validity range is omitted from the
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
and explicit surface-to-AGL limits. Procedure tags include the source procedure
title, amended DA/MDA and visibility minima, sidestep/circling minima, VDP changes,
takeoff minima and climb gradients, terminal-route/transition restrictions, and
conditional inoperative-lighting notes. Numeric minima, aircraft categories and
their qualifications remain together in the complete body; tags do not replace
them with a single airport-wide value. A `FOR INOP ALS` note does not establish an
actual lighting outage, and an obstacle or lighting notice does not close a runway.

Color expresses the kind of information, independently of D/FDC classification:

| Color | Meaning | Examples |
| --- | --- | --- |
| Blue | Facility or subject | Runway, RWY 12R, Navigation, Obstruction |
| Purple | Procedure identity | Approach, Departure, RNAV (RNP) Z RWY 30L |
| Amber | Restriction, amendment, outage, activity or uncertainty | Minima Amended, ILS Unavailable, UAS Activity, Check Schedule |
| Red | Explicit unqualified closure of the identified facility | Runway Closed, Taxilane Closed |
| Neutral | Supporting information or timing | Flagged and Lighted, Surface to 300 ft AGL, Outside Schedule |

Use the shared `surface-tag-*` / `text-tag-*` theme roles; the light palette is
generated from the dark seeds. Labels convey the meaning without color and wrap
within narrow cards. Authored flair labels use title case, preserving aviation
abbreviations, source procedure titles and unit symbols such as `ft`. Each tag's
title exposes its supporting source text. The same
entry component renders airport lists and expanded plate notices.

Illustrative fixtures, not live NOTAMs:

| Fragment | Result |
| --- | --- |
| `RWY 20 RWY END ID LGT U/S` | Runway / Lighting Unavailable; no runway-closure claim |
| `RWY 09/27 CLSD EXC …` | Runway closure with the exception retained |
| `IAP … CIRCLING NA` | Circling Unavailable for that procedure, not the entire approach |
| `SID … TRANSITION … NA` | Restriction scoped to that transition |
| `SEE FDC …` | Pointer with a reference when resolvable; unresolved pointers stay visible |

Parsing is bounded to 64 KiB of body text, 320-character heading prefixes, 16
procedure targets and 20 deduplicated flairs. Scan amendment delimiters before
applying the bounded heading grammar. If limits are reached, retain the entire
body/raw text and flag **Interpretation Limited**. Derived results are cached by
record identity for repeated airport-list and plate matching; replacement records
are parsed anew. Parser version 5 owns these derivations, not the wire schema.
An exact associated FAA/ICAO prefix may precede a subject; unrelated prefixes
remain unrecognized. Obstacle lighting includes plural objects and wind turbines,
with negations and conditions preventing an unconditional outage/lighting claim.
Closures qualified by aircraft type/size, exceptions or conditions receive a caution
**Closure Restriction** flair with the qualifier included in its evidence. Numeric
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

## Procedure matching

Matcher version 3 is a pure function of validated notices and exact plate context. Return
source ID, applicability outcome, affected clauses, and an explainable reason.
Avoid numerical confidence scores suggesting unmeasured accuracy.

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
   Unsupported heading prefixes remain unresolved rather than becoming a recognized
   ILS/LOC/RNAV suffix.
4. Handle multiple named procedures and explicit broad scopes such as all IAPs at
   an airport. A runway in an exception, missed approach, or obstacle narrative
   is not by itself a procedure target.
   Broad clauses with exclusions or conditions, such as `ALL IAPS EXCEPT`, require
   review for every candidate plate; an excluded title never becomes an applies match.
5. Compare amendment number/date with the displayed plate. A mismatch requires
   review when the target otherwise agrees; it alone does not prove incorporation.
6. Include D runway/facility notices when explicit runway identity or a qualified
   dependency proves relevance. Preserve their actual effects without inventing
   minima or declaring whole procedures unavailable. Incomplete dependencies must
   not imply complete facility coverage.
   Explicit `NAV ILS/LOC RWY … U/S` matches ILS or LOC approaches on that exact runway;
   `GP`/`GS` matches ILS approaches. These notices do not establish a dependency for
   RNAV approaches. Unknown or absent facility/runway dependencies remain unresolved,
   and unresolved interpretation also qualifies the collapsed bar's assurance.

| Outcome | Presentation |
| --- | --- |
| Applies to this plate | Unambiguous procedure/broad-scope match or proven runway/facility relationship; show reason and affected scope |
| Review applicability | Plausible association with missing context, ambiguous wording or amendment mismatch; uncertainty stays visible |
| No established match | Keep the notice in airport results; do not attach it to an unrelated plate |

Clearly incompatible runway sides or variants are not review candidates merely
because they share a substring. Conversely, unresolved airport procedure notices
cannot disappear into a false zero-match assurance: expose unresolved procedure
coverage and access to the full airport list. Matching is not a claim that every
operationally applicable notice has been found.

## Client lifecycle and offline behavior

One stable client per workspace combines demand from airport NOTAM bodies, visible
Plates lists, and open plate bars. Coalesce the same airport; allow different detail
and reader airports concurrently. A collapsed bar still needs count/freshness
updates while visible. Stowed/hidden consumers retain state but release demand.

Use core `requestJson`, `OnDemandRefresh`, connectivity observation and scoped
storage. Refresh demanded snapshots on the three-minute product cadence; qualify
immediate reopen/reconnect reads against existing freshness. Browser reads never
change upstream cadence. Reopening or adding another airport preserves each
airport's next due read; the shared scheduler wakes at the earliest deadline.
Only completed reads establish throttling, so unloading during acquisition cannot
delay the first read after reactivation. Dispose timers/listeners and reject obsolete airport,
edition, page or activation completions.

Persist bounded validated airport snapshots. The client keeps up to 24 airport
entries under a 64 MiB eviction target, protecting visible demand; the optional
scoped record is capped at 2 MiB and skips snapshots that do not fit.
Restoration shows saved results but
cannot replace newer live state. Preserve original check/validity times and usable
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

- `test/notams-corpus.test.ts` retains 24 complete captured records from 21 airports,
  with independent expectations for field/category assignments, alternatives,
  note actions, qualified closures and conservative fallbacks. It also checks
  source-span, numerical/lexical and rendered-content preservation; deliberate
  content corruption verifies that the audit detects lost clauses and changed facts.
- `test/notams.test.ts` covers conservative flairs, supported schedules and validity,
  procedure identity and ILS/LOC aliases, exact page context, saved/offline state,
  refresh deadlines and cancellation across activations.
- `test/notams-ui.test.ts` checks rendered Active/Check timing/Upcoming sections,
  effective-start transitions, removal of the Upcoming flair, and plate grouping
  that keeps upcoming matches after current review candidates and prioritizes FDC
  within each applicability group without changing airport order. These are markup
  and timing checks; browser layout remains part of the release matrix.
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
- `test/notams-obstacles.test.ts` covers exact coordinate/height parsing, rejected
  ambiguous positions, FDC points without AGL, timing qualifiers and independent
  reader leases. `test/notams-map.test.ts` covers immediate hiding on stow,
  delayed source acceptance, replacement coalescing, failures and teardown.
- `test/notams-areas.test.ts` covers source circle radii, polygon closure and
  dateline wrapping, malformed/ambiguous boundaries, GPS altitude qualifications,
  source preservation and renderer-acknowledged coordinate abbreviation. Browser
  coverage verifies overlays, filter/stow lifetime, restoration after map detachment
  and separate From/Until rows on a narrow screen.
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
- `test/notams-collection.test.ts` covers unfamiliar representations, lifecycle
  ambiguity, order/duplicate independence, bounded evidence overflow, scope unions,
  sparse-version constraints, daily reconciliation and wire completeness guards.
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

- `npm run verify` passed checks, 2,227 Node tests across root/contracts/domain,
  and the production PWA build; `npm run info:build` passed separately. The
  collector/admission/delivery/collection suites include 72 targeted cases.
- All 27 current NOTAM Chromium cases passed in the matching Playwright container
  with external networking disabled. These focused cases skipped native weather
  preparation; they do not replace the full browser/weather/graphics gate.
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

The replacement subsequently passed 149 targeted backend tests covering weather,
NMS and graphical TFR behavior, plus static checks and the server build. Its built
worker passed a bootstrap/delta check using fake transport. An isolated candidate
passed the API/artifact readiness checker with NMS disabled. Deployment acceptance
requires advancing complete checkpoints, complete airport content coverage, and
restart recovery that preserves source timestamps and the NMS admission journal
without extra source requests. The graphical TFR snapshot and its separate
admission state must also survive handoff and restart. Release identity, activation
timing and host-specific rollout results belong in private operations.

The full browser gate has failures in the broad panel/plate/plugin/glide suites;
that broad run was stopped after recorded failures, before the matrix completed.
The earlier full run also used the superseded NOTAM coverage-label expectations,
which pass in the current focused run. A clean full browser gate, sustained
combined native-weather/NMS capacity and a complete live daily reconciliation
remain unqualified. The validation environment used an 8 GiB memory limit; the
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

### Broad airport presentation audit

The [structural audit](validation/2026-10-05-structural-audit.md) and its
[semantic follow-up](validation/2026-10-05-semantic-audit.md) cover all of the
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
record versions separately. A new capture timestamp alone is not temporal coverage.
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

- Replaying the saved KSJC staging airport response derived specific tags for all
  30 D/FDC records. These observed source forms informed the grammar and synthetic
  fixtures; the replay did not establish operational completeness.
- Focused Chromium checks used invented notices and a synthetic three-page PDF.
  The host browser lacked its GLib dependency, so they used the matching Playwright
  container with networking disabled. Fixture runs did not spend FAA quota or change
  the live collector's state. Earlier browser passes predate the simplified staging
  notice and timing sections and do not validate those later presentation changes.
- Live staging full-load and delta evidence is recorded in the source qualification
  section above. Production was not enabled, and temporary plaintext credential
  copies used for this exercise were removed; durable admission state is retained.

The full browser verification gate was not completed. These historical results do
not complete the broader release matrix below or qualify shared deployment capacity.

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
