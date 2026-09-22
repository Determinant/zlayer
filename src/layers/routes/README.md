# Route parsing and editing

[Documentation](../../../docs/README.md) / Plugins / routes

This guide owns route editing, resolution, recommendations and persistence.
Supporting guides cover [terminal procedures](terminal-procedures.md),
[approach geometry](approach-geometry.md) and
[coverage, source evidence and remaining validation](approach-coverage.md).

The editable draft is an ordered array of `{ id, text, pinnedFeatureId?, approach?, departure? }` entries.
IDs survive insertion, replacement and reorder; pins travel with their entries.
Route text is an import/export format, and token indexes are display positions.

Resolution builds scoped atoms and expands them into shared points with source
references, point requirements and explicit incoming connections. Every source
reference retains the original entry ID and display index. A TEC owns a segment
with its own airports and published children; SID/STAR expansion reads that scope
without knowing whether it came from a TEC or the overall route. There is no
expanded string to reparse or final index-remapping pass.

```text
text/import → draft entries → scoped segments → constrained points → resolved plan
                                                                       ↓
                                                       editor / recommendations / map
```

## Contents

- [Ownership](#ownership)
- [Invariants](#invariants)
- [Route actions](#route-actions)
- [Recommendations](#recommendations)
- [Persistence and compatibility](#persistence-and-compatibility)
- [Deliberate limits](#deliberate-limits)

## Ownership

| Module | Responsibility |
| --- | --- |
| `packages/domain/src/route-text.ts` | Shared delimiters, normalization and feature identifiers |
| `packages/domain/src/route-coordinate.ts` | GPS waypoint formatting and coordinate token resolution |
| `packages/domain/src/route-model.ts` | Draft entries, explicit edit targets and resolved plan types; no runtime dependencies |
| `packages/domain/src/route-draft.ts` | Entry identity, text import/export and boundary adapters |
| `packages/domain/src/route-source.ts` | Shared scopes, source ownership, point requirements and incoming connections |
| `packages/domain/src/route.ts` | Index navigation, orchestrate expansion, match requirements and build connected legs/distances |
| `packages/domain/src/airways.ts` | Published V/T airway paths and inferred airway transitions |
| `packages/domain/src/terminal-procedures.ts` | Airport/transition matching and discontinuous SID/STAR waypoint previews |
| `packages/domain/src/departures.ts` | Airport-attached SID branches, exits and filing-text import |
| `packages/domain/src/tec-routes.ts` | Local airport-pair matching and scoped published children |
| `packages/domain/src/preferred-routes.ts` | Published route imports and typed point constraints |
| `src/layers/routes/draft.ts` | Atomic edits by entry ID |
| `src/layers/routes/use-draft.ts` | Versioned persistence and storage validation |
| `src/layers/routes/use-plan.ts` | Reference loading, resource identity, partial failures and superseded requests |
| `src/layers/routes/suggestions.ts` | Shared resolution for history and preferred/TEC recommendations |
| `src/layers/routes/history/` | Worker client and store, plus history query and draft conversion; offline callers use `client.ts` |
| `src/layers/routes/editor.tsx`, `use-editor-gestures.ts` | Entry, insertion, token menus, reorder and pointer lifecycle |
| `src/layers/routes/renderer.ts`, `geometry.ts`, `editing.ts` | GeoJSON presentation, dateline handling and edit target identity |
| `src/layers/routes/snapping.ts` | Stable snap selection and bounded retention through missing rendered hits |
| `src/workspace/feature-route-actions.tsx` | Shared detail-panel add/remove controls, derived from the selected feature and current route |
| `src/layers/routes/map-gestures.ts` | Shared map selection, route hit testing, dragging and snapping |
| `src/workspace/map/snap-bounds.ts` | One-time capture of rendered snap bounds through MapLibre's public query API |

Keep text helpers and shared types separate from the resolver: TEC interpretation
uses preferred-route import helpers, which must not import the resolver back.
Recommendations and the main editor share the domain resolver. Map rendering
consumes the resulting plan rather than interpreting route text again.

## Invariants

### Drafts and direct edits

- In the route input strip, swipe across any chip to scroll with native momentum
  on touch devices; drag across a chip or the strip gaps to scroll with a mouse.
  Click or tap a chip for actions; hold it for 450 ms until it lifts, then drag to reorder.
  A swipe stays a scroll until release. Dragging near either edge scrolls
  continuously, and cancellation or a second finger never commits a move.
  Mouse and touch share the same hold-to-reorder behavior; right-click and keyboard menus also work.
- Input is case-insensitive. Whitespace, dots, commas, slashes, hyphens and `>`
  separate tokens; `DCT` and `DIRECT` are connectors. Unknown tokens stay visible
  and interrupt resolved legs. Dotted planning connections bridge the known points
  on either side for map and terrain coverage.
- GPS labels in the route input, stash, map and fix headings show degrees and
  minutes, omitting seconds without rounding. Fix info includes a full coordinate
  with seconds. Stored identifiers, positions and
  exports retain their full precision. Map labels use an apostrophe for minutes
  from the bundled offline font; other displays use the prime symbol.
- A map-selected feature contributes one usable identifier. Display names and
  empty identifiers cannot create tokens or displace pins. Draft mutations move,
  replace or remove complete entries. Editing a missing ID is a no-op.
- Dragging a direct leg inserts the snapped navigation waypoint, or a GPS waypoint
  at an unsnapped drop. Coordinates use `DDMMSSNDDDMMSSW` tokens (with the appropriate
  hemisphere letters), rounded to the nearest second. These tokens resolve without
  navigation data or feature pins and survive route text export and saved drafts.
  Taps, cancelled drags and stale route revisions do not insert anything.
  A drag preview marks the new bend; the leg itself is the hit target, with no
  midpoint handle. The free preview follows precise pointer coordinates; rounding
  happens when saving the GPS waypoint. Leg movement updates only the bent line
  and marker in a separate source. The original leg stays available throughout
  the drag. Once preview tiles are ready, paint state swaps their visibility in
  one frame; cancellation restores the original without a source reload. Pointer
  moves during initial loading coalesce to the latest coordinate, keeping
  per-move geometry work independent of route length.
- Snapping preserves the map's rendered label/icon hits in a box extending 24 CSS
  pixels around the pointer, ranked by anchor distance. A captured entity remains
  eligible while hit, within 36 pixels of its anchor, or within its captured
  rendered bounds plus the 24-pixel acquisition box and a 12-pixel release margin
  when symbol placement or source updates temporarily hide it. Bounds are measured
  once on acquisition, within the acquired world copy and relative to its anchor,
  and never grow with pointer motion.
  Another rendered target must be more than 6 pixels closer to take over.
  Equal-distance initial candidates use
  stable feature identity, independent of map query ordering. Distances use the
  pointer's world copy.
- Dragging an existing GPS waypoint to empty space updates that entry's coordinate;
  dropping it on a navigation feature replaces it with that feature. Its moving
  marker and label cannot snap to themselves. GPS waypoints are removed through
  the token menu. Dragging a published waypoint onto another feature replaces it;
  dropping it clear of all snap targets removes it.
- Route waypoint markers and labels select their navigation feature, including
  airports whose background symbols are hidden at the current zoom. A tap or click
  opens details without editing the route, including in recommendation previews.
- Right-clicking empty map space (or holding on touch) opens a temporary GPS
  waypoint using the same coordinate details and actions. Its marker lasts while
  that point is selected; viewing or closing it does not change the route.
  Nearby navigation features and route points retain their existing selection menu.
- GPS waypoint details preserve existing feature elevations and otherwise include
  approximate terrain elevation in feet MSL, rounded to 10 ft. The lookup uses the finest supported DEM at the saved coordinate,
  independently of zoom and terrain-layer visibility. Saved terrain packages take
  precedence over browsing data; missing heights show **Unavailable** with **Retry**.

### Anchored approaches

Tap or right-click an airport chip and choose **Choose approach…**. Choose
a chart, then a published entry or **Vectors to final (VTF)**, preview it on the
main map and press **Add to route**. No entry is chosen implicitly. The green segment precedes the
airport in one box and shows a compact name plus the entry (for example,
`ILS Y 31 · VTF`). Click it to change the entry, switch approach or view its plate.
The box's × and **Remove approach** detach only the approach.
The airport stays in the route. Reordering moves both together, while replacing
the airport with a different entity clears the attachment. Replacing it with the
same text and feature pin is a no-op and retains its attachments. Duplicate airport
occurrences are independent.

The picker shares Advise's docked panel and map-preview path. It leaves the map
interactive and fits the selected approach into the area beside or above the
panel. Switching entries changes only the preview; **Add to route** or **Replace
approach** commits the selection. Closing the picker, returning to the approach
list, or opening a plate clears the preview and restores the saved route depiction.

The attachment stores the catalog airport ID, procedure ID, display name, cycle,
and coded route/entry identity and effective date on the existing route entry.
It survives reloads. A missing or older-edition selection stays visible
and removable; the picker does not silently substitute a different edition.
The picker loads the shared cached procedure catalog and national terminal routes,
excluding deleted procedures and non-approach charts. `terminal-procedures.json`
now optionally contains `approaches: ZLayerApproachRoutes`, normalized from FAA
CIFP primary records by the faa-regs navigation builder. This shares existing
download, cache, edition and offline verification machinery. Old exports still
load but cannot supply approach entries; they must be rebuilt and published.
Chart title matching is conservative and keeps runway and Y/Z variants distinct.
Combined VOR/VOR-DME/NDB or GPS and VOR or TACAN titles use their conventional
coded counterpart. This does not provide separate GPS/TACAN avionics behavior.
Supported continuation pages and SA CAT I charts retain their original titles
while using their corresponding coded routes. A small set of plate-reviewed
identifier exceptions is restricted to its reviewed data edition. Helicopter
and fixed-wing titles remain distinct. Shared parallel-runway charts can reuse
identical complete source routes; otherwise the picker requires a runway choice
and saves its exact route ID and runway label. Picker and saved-route expansion
use the same association logic. See the
[reviewed associations](approach-coverage.md#reviewed-associations) for evidence and limitations.
Charts with no unambiguous coded counterpart offer **View plate**, not an invented entry.
Entry choices use the published fix names, including coded IAFs within feeder
routes and outbound FC feeder starts even when an IAF role is absent. A procedure
with no other entry and no straight VTF final can expose its explicitly coded
initial IF, labeled `(IF)`, retaining the curved final and the plate's entry requirements.
When a fix starts multiple branches, the next fix distinguishes them
(for example, `SNS via AANNE` and `SNS via ARTYY`). Selecting an internal IAF
omits its incoming feeder leg and retains any coded hold or procedure turn.
Transitions join only to the inbound approach, never to a same-name missed fix.
Reference- and course-constrained reversal joins retain the FAF and intermediate
fixes within the coded turn extent. A feeder can follow one explicit onward
transition; ambiguous continuations remain gaps. Separate ILS DME positions need
the rebuilt navigation export. See the
[geometry validation guide](approach-coverage.md#geometry-lessons-retained-in-the-implementation).
Previously saved regions retain their pinned data; use **Verify / update** to
include approach routes added by a newer export of the same FAA cycle.

The selected entry decompresses on the map into magenta approach legs, named
fixes/roles and dashed missed-approach legs. The preceding route connects to the
chosen entry, and a subsequent waypoint connects from the last known missed
endpoint (usually its holding fix). VTF starts at the FAF and adds a light 30 NM
final-course extension. A dotted planning connection joins the preceding known
waypoint to the FAF for terrain coverage; loading VTF does not activate a
present-position direct-to. Its workflow follows the entry
selection and final-extension conventions in the [ForeFlight pilot guide](https://cloudfront.foreflight.com/docs/ff/14.10/ForeFlight%20Mobile%20Pilot%27s%20Guide%20v14.10.pdf).

Drag a connecting leg into or out of an approach to insert a waypoint before or
after its airport bundle. The approach stays attached and its published legs stay
intact. The same drag insertion works on ordinary connections beside SID, STAR,
airway and TEC route items. Published internal legs and dotted planning connections
(including the arrival into VTF) do not become editable connections.

This is a route preview. TF/CF/DF show waypoint connections, RF uses its coded
center, and AF follows the published radius around the DME antenna. Arcs with
missing or inconsistent geometry retain a diagnostic and use a dotted planning
connection between their known endpoints. Older exports need rebuilding to
include AF centers and radii. The export also retains airport magnetic variation,
explicit true courses and holding leg times separately from distances.
Approach geometry comes from one ordered interpreter shared by the preview and saved
route. It produces source-constrained fixed spans, declared schematic spans, and
explained gaps. The FAA export preserves scoped station/localizer references,
station declination, radial/range conditions, altitude constraints and leg IDs.
FC legs advance their own coded distance before the following leg is interpreted;
a surveyed CF endpoint within 0.05 NM can absorb distance-field rounding. Older
exports retain the bounded shared-track fallback when both distances agree.
Fixed spans count toward route distance and terrain eligibility; no synthetic
named waypoint is added for an intermediate termination.
Published holds appear as oriented racetracks: initial holds are solid and missed
holds are dashed, with one small outbound direction chevron per racetrack at local
zoom levels. Labels show the suggested direct, parallel or teardrop entry after
`HOLD R/L`, based on the planned arrival course and mirrored FAA entry sectors.
Fix labels show only their names below zoom 10; roles, hold entries and leg lengths
appear at zoom 10 and closer, in both previews and the saved route.
Preview labels retain the connected arrival when switching from VTF or an explicitly
filed entry fix; missing arrival/course information displays `ENTRY ?`. These are planning suggestions
without wind correction, and sector boundaries allow pilot discretion
([FAA AIM 5-3-8](https://www.faa.gov/air_traffic/publications/atpubs/aim_html/chap5_section_3.html)).
Holds, procedure turns, heading intercepts, DME plan-view approximations and
altitude-dependent paths are schematic. Radial/DME conditions use the referenced
station, and successive climbs carry their synthetic endpoint into the next
instruction, including a direct return to the same station. A bounded policy can
adjust climb length to reach the following forward intercept without changing
published courses. Procedure turns retain the coded side, orientation and extent.
The arbitrary missed-climb spline fallback has been removed.
These depictions contribute terrain coverage but are excluded from route distance
and ordinary waypoint decomposition. Dotted planning connections cover remaining
gaps between successive known waypoints without cutting across existing curves
or routing back through attached airport markers. No hold-entry maneuver is drawn. Unknown references,
open-ended legs and inconsistent constraints retain a specific diagnostic.
A trailing open-ended leg cannot become
an ordinary onward leg; a planning connection can still reach the next known
waypoint. Approach children remain owned by the airport bundle and
cannot be dragged or removed individually. Direct to a landing fix can decompose
the remaining approach as described below; otherwise remove/change the bundle
to edit it. Filing text remains unchanged while attached. Legacy chart-only attachments prompt
for an entry before supplying route connections.

Approach fixes reuse an existing navigation fix or navaid when its identifier
matches and its position is within 0.01 NM (allowing reference rounding). Ambiguous
matches keep the coded approach point. Previews follow the same rule, preserving
the existing entity's details and one map label/nearby-picker entry while keeping
each approach occurrence and its role. Older coded pins and saved selections
continue to resolve when a matching navigation entity becomes available.

The [coverage guide](approach-coverage.md) retains source examples, final inventories,
audit commands and remaining chart/entry gaps. Its latest FAA 2609 national scan
finds 9,079 of 10,980 U.S. chart records whose offered entries have no unresolved
diagnostics (82.69%); 1,854 chart records remain unmatched. The audit distinguishes
chart records from distinct coded routes and includes the recorded radar/source
review exceptions.
This is automated screening of available entries, not full chart coverage or
manual validation of every plate. An unresolved connection still retains subsequent
known fixes and
available hold depictions, with a route warning and unknown hold entry when the
arrival is missing. The [geometry design](approach-geometry.md)
describes the shared interpretation and its limits.

### Direct to

With a fresh GPS fix, tap or right-click a resolved route waypoint and choose
**Direct to**. The route starts at a snapshot of the current GPS position, removes
everything before that occurrence, and keeps the target and the remaining route.
Feature details offer the standard **D→** Direct to icon immediately before **ID**.
An on-route feature uses the selected occurrence; an off-route feature asks for
an in-app confirmation, styled like the AHRS stow dialog, before replacing the
route with GPS position → target. Cancelling or pressing Escape
keeps the route. Without a fresh fix these actions are hidden, and the fix is
checked again after confirmation. If the fix becomes stale while the dialog is
open, **Direct to** pauses until a fresh fix arrives. The origin remains fixed as
GPS updates arrive.
Cutting into an airway, procedure or TEC expands the affected remainder into pinned
waypoints; unrelated route items and unresolved suffix entries are retained.
If that expansion would remove a warning or connect across a missing waypoint or
route discontinuity, Direct to leaves the route unchanged and explains the problem.
This includes procedure previews with an open connection to the airport. An intact
published suffix can still be retained, or the target can be chosen after the gap.

Selecting a displayed approach fix and pressing **D→** starts at the current GPS
position, inserts that fix and the remaining landing fixes before the airport in
the route input, and removes the airport's green approach bundle. The missed
branch and VTF extension are removed; entries after the airport stay intact. The
new ordinary waypoints pin the exact coded fixes, including runway points, and
survive reloads with the same approach data available. A missed-approach fix is not a landing target;
remaining gaps, holds or curved legs prevent decomposition because ordinary
waypoints cannot preserve them. An unresolved final endpoint or trailing vector
also prevents decomposition, even when there is no later fix to expose the gap.
Gaps before the target or in the discarded missed branch do not prevent Direct to.
Saved map selections from older approach IDs rebind to their original airport
entry and child occurrence once the route loads, and persist the current fix ID.

### Nearby navaid identification

Every feature, including temporary GPS points, has a blue **ID** button after
the route actions. It opens up to six nearby VOR, VOR/DME or VORTAC references within
100 NM, using the feature's navigation edition even with navaids hidden or an empty
route. GPS coordinates have no published edition: their references follow the
current regional context, including catalog revalidation and saved region updates.
Saved regions still own their navigation edition.

Stations 5–60 NM away rank first, MON candidates first within that band; other
distances are fallbacks. The top three have thin blue dashed connections, station
labels and a common target marker on the map. Each connection shows MB (magnetic
bearing/radial) and distance in NM. Labels sit at the projected line midpoint so
short connections retain both values. Nearby directions use separate label offsets;
labels remain upright as the map rotates or tilts. Opaque white casing around the
dark-blue dashes and stronger white outlines around markers and labels keep them
legible over chart markings.

Rows show identifier, MON membership, frequency, station-relative radial and
horizontal distance. Radials subtract the published east-positive station declination
from the true bearing **from** the station. The list shows MB and TB (true bearing)
separately. Older exports without alignment mark MB as unavailable while retaining
distance and TB. Co-located stations are omitted. Distances do not include DME's
altitude component, and these geographic references do not verify radio reception.

Closing ID, opening Info/Plates, selecting another feature or closing details clears
the connections. The view is temporary and starts closed on reload.

### Selection and published route items

- Nearby features includes planned route points within the picking radius, even
  when their symbols or labels are hidden. Route points are marked with their
  position; repeated occurrences stay separate, while duplicate navigation symbols
  and labels are merged. Right-click or touch-and-hold opens the chooser, including
  when the hold begins on a draggable route waypoint.
- The same feature detail panel offers a red **Remove from route** action before
  **Add to end of route** whenever that feature is in the current route, including
  departure/destination airports and airway/procedure/TEC children. Selection through
  search, background symbols and route markers uses the same membership check.
  Repeated occurrences remain distinct; after removing the selected occurrence,
  the panel continues to offer removal if another occurrence remains.
- For a point supplied by or anchoring a published item, Remove offers both
  **Remove only this point** and **Remove entire route item**. Point-only removal
  replaces the affected published items with their other displayed points as direct,
  pinned waypoints; adjacent airway chains expand together. The menu explains this
  conversion. Unrelated input and entry identities stay intact. Whole-item removal
  uses the same edit as removing that token in the route editor.
- The token menu's **Replace route item** opens a selected inline text field.
  Enter, a delimiter, or leaving the field commits; Escape or blank input cancels.
  Changed text clears only that entry's old feature pin; unchanged text preserves
  it. Pasting several identifiers replaces the item with that segment. The edited
  entry retains its ID, and a removed or externally changed target cancels the edit.

### Resolution

- Ordinary waypoint pins choose a specific feature. Published airway/procedure
  constraints still apply: a pin cannot replace a required airway identifier, and
  a junction must satisfy both incoming and outgoing point types.
- Direct entries prefer a primary identifier over another feature's alias:
  `SFO` selects the navigation aid, while `KSFO` selects the airport. Unambiguous
  airport aliases still work. Proximity only breaks ties after that preference;
  a VOR test transmitter does not displace a navigation aid with the same identifier.
  Stable feature IDs break remaining ties.
  SID/STAR airport matching follows the same rule, and explicit feature pins win.
  Airport identifiers such as `T67` work at endpoints; an interior identifier shared
  with an airway defaults to the airway unless pinned to a feature.
- A TEC code matches its immediately adjacent airports and published direction.
  This restriction is local to that segment; ordinary entries can precede and
  follow it, and multiple TEC segments can share an airport. Ambiguous definitions
  are errors. Typed published waypoints must have unique stable identities.
- TEC children retain their originating entry throughout resolution; geometry,
  diagnostics and nested ownership need no remapping. Internal TEC/airway/procedure
  geometry cannot be dragged as independent tokens. Their detail panel can remove
  an individual displayed point by expanding the affected segment. Explicit airports
  and ordinary connecting legs remain draggable.
- Unknown or unavailable points, missing airway segments and procedure
  discontinuities retain their diagnostics. Dotted planning connections bridge known
  points for map and terrain coverage. A missing feature pin never falls back to a
  different feature. Reported distance is the sum of resolved legs.

Adjacent airway tokens form one bounded chain between entry and exit fixes. Traversal
can run in either direction but cannot cross a published gap or disconnected
geographic component. The shortest valid shared transition is inserted internally;
equivalent flown paths use the first crossover in the direction of travel. Equal-cost
candidates with different paths require an explicit transition fix.

TEC syntax is a client rule, not a universal filing rule: `KSNA CSTQ9 KSMO KVNY`
expands the published KSNA–KSMO segment and continues to KVNY. Conditions remain
visible without claiming eligibility or clearance. The source is the
[FAA Preferred Routes database](https://www.fly.faa.gov/rmt/nfdc_preferred_routes_database).

### Edit lifecycles

- Resolved editable waypoints and legs carry explicit edit targets. Map hit
  properties contain the target entry ID and plan revision; a stale worker result
  cannot edit the current plan even when coordinates are unchanged. New plan
  revisions cancel map drags, editor menus and reordering. Inline insertion follows
  its entry ID through data refreshes and resets if that entry is removed.
  Pointer cancellation/lost capture and teardown release timers, capture and listeners.
- Map drags also cancel on Escape, window blur, and release outside the canvas.
  Gesture cancellation clears pending long presses, restores only the map controls that
  were enabled before the drag, and cannot commit the last preview. Mouse and
  touch releases finish only their own gesture; releasing another mouse button
  does not finish a left-button drag. Map drops and chip reorders use the final
  release position, including when the last move event was coalesced. A release
  cannot start a map edit without an active drag preview. If the pointer stays
  at its last previewed position, release preserves that preview's drop target
  even when rendered query results change. A new physical press clears click
  suppression immediately; compatibility mouse events from the preceding touch
  release remain suppressed. Route-only refreshes leave independent empty-map
  long presses intact.
- Direct-to and point removal share `sameRouteDraft` to reject stale actions
  consistently, comparing entry identity, text, exact feature pins, and every
  approach/SID selection field. Re-resolution with an unchanged draft remains valid.
- Recommendation overlays carry no editing targets. Selecting a shared geometry
  still preserves the selected route's metadata. Details include every TEC segment.

Snapped edits pin the exact feature ID; coordinate insertions remain self-contained
tokens. Multi-touch cancels edits, and dateline geometry and route fitting share
the same longitude-unwrapping rule.

## Route actions

The Route icon and label open a menu for Show/Hide NavLog, Copy Route, native Share when supported,
Open in ForeFlight on iPhone/iPad, Save Route, Manage Routes, and Clear Route. On phones the menu trigger
starts the second row before Advise; wider layouts keep it before the input.
Clearing returns focus to the empty route editor. Clipboard failures offer selected
text for manual copying. Exports expand airport-attached SIDs to `SID exit` and
resolved TEC designators to their published route text, preserve unknown entries, and use ForeFlight's Maps URL scheme for the
app handoff. **Open in ForeFlight** automatically uses ForeFlight coordinate
syntax. The menu does not detect whether ForeFlight is installed.

**Show NavLog** reveals a compact drawer below the route input without resizing
the map. The lower bezel collapses the entire drawer, leaving no tab behind;
reopen it from the Route menu. Closing with the bezel or Escape returns focus
to the Route button. The drawer follows route edits,
uses the shared panel scrollbar, and keeps its column headings visible while scrolling.
Waypoint names share the route chips' type colors: ice blue airports, soft gray fixes,
lavender navaids, slate NDBs, and amber VFR waypoints. Procedure groups remain green.
Subtle alternating backgrounds across waypoint rows help track course and distance.
Rows describe the incoming leg at each expanded waypoint occurrence: initial
course, leg NM, and cumulative NM. Courses show magnetic / true (for example,
`113°M / 126°T`), retaining true course when the magnetic reference is unavailable; curved and
composite paths show **Varies**. Distances use resolved route geometry, with gaps,
VTF and missed-approach sections identified. Attached airport markers do not
become extra flown legs. Incomplete routes show known distance only; holds and
schematic paths are excluded. Speed, time and fuel are not modeled in this view.

**Copy Route** and **Share…** each expand a format submenu on desktop, iOS/iPadOS
(including the desktop-style iPad user agent), and Android. Share passes the
selected format to the native share sheet. Arrow Right opens either format menu;
Arrow Left or Escape returns to its parent action, and a second Escape closes the
route menu. Clipboard fallback text uses the chosen format. Cancelling native
sharing keeps the format menu available for retry; a failure offers Copy Route.

**Save Route** asks for an optional name and saves a snapshot of the current draft,
including pending input, exact coordinates, pinned waypoints, and attached
SIDs and approaches. Empty names stay hidden. **Manage Routes** opens the **Route Stash**,
where Load replaces the active draft. Edit changes
a saved route's name or filing text without changing the active draft; unchanged
entries retain their pins and procedure attachments. Remove deletes the saved route, and
Move up / Move down persist the list order with buttons usable by touch and keyboard.
The dialogs use the shared confirmation typography, native modal focus handling,
and a scrollable list that fits phone and tablet screens.

The [Web Share API deliberately hides the chosen destination app](https://www.w3.org/TR/web-share/#privacy-considerations),
so a PWA cannot switch formats after the user picks an app in the system sheet.
Choose the destination's format before sharing, or use **Open in ForeFlight** on
iPhone/iPad for a direct handoff with automatic conversion.

| Copy / share format | Example coordinate | Precision |
| --- | --- | --- |
| ForeFlight | `374529N/1223030W` | Seconds |
| SkyVector / ZLayer | `374529N1223030W` | Seconds |
| ICAO / 1800WX | `3745N12231W` | Rounded to whole minutes |

Formatting changes only exported coordinates; the draft retains seconds. All
formats retain route endpoints, airway/procedure identifiers and unresolved
entries, and expand resolved TEC shorthand. The ICAO choice is a coordinate
format for route text, not a complete ICAO flight-plan message or validation of
Item 15 filing grammar.

Format references: [ForeFlight coordinate entry and filing](https://support.foreflight.com/hc/en-us/articles/206074628-How-can-a-latitude-and-longitude-waypoint-be-filed),
[SkyVector format in Little Navmap's coordinate guide](https://www.littlenavmap.org/manuals/littlenavmap/release/latest/en/COORDINATES.html),
[Leidos web help, ICAO Route of Flight, p. 87](https://www.1800wxbrief.com/Website/resources/help.pdf),
and [FAA ICAO coordinate conventions](https://www.faa.gov/air_traffic/publications/atpubs/fss/AppendixA.htm).

## Recommendations

**Advise** uses the first and last draft entries as airports; intermediate entries
do not affect lookup. Rows appear in **Frequency**, **Preferred**, then **TEC**
sections. Frequency shows the historical snapshot's observation dates and filed-route
counts, with an aircraft engine-category filter. FAA/ICAO aliases and equivalent
text are combined; percentages use all matching counts, including undisplayed rows.
These are filings, not verified ATC clearances or a rolling 30-day window.

Published typed imports require a unique stable identity for every waypoint;
missing or ambiguous reference data disables import instead of dropping the
constraint. Published endpoint NAVAIDs are preserved even when an airport shares
their identifier. Text-only historical recommendations use ordinary parsing and
retain unknown procedure identifiers for the editor to flag.

Opening Advise previews up to five distinct paths in section order, initially
highlighting the first with normal route styling and fading alternatives to gray. Selecting a
row highlights its path without editing the draft; **Use** loads it and closes the
list. Closing without Use restores the editable route. Matching paths share an
overlay while preserving the selected result's labels and procedure details.
Procedure segments remain dashed; dotted planning connections bridge known points
across unknown segments, and partial previews are labeled. An exact, unique historical TEC code can use the current FAA definition,
labeled **current TEC** while retaining the original filed text and counts.

The camera leaves room for the list, which becomes a bottom sheet on phones.
Restoring an open list preserves the saved camera. Panel state, aircraft filter,
selection, expanded conditions and row limits persist locally; see
[workspace persistence](../../../docs/data/contracts.md#workspace-persistence). Recommendation sources
load independently and share national references with the planner and
[regional downloads](../../../docs/features/offline-storage.md).

## Persistence and compatibility

Version 2 persists the entry array through the routes storage scope as
`zlayer-plugin:routes:draft`. Core reads the former `zlayer-route-draft-v1` slot
only when the namespaced record is absent and copies validated intent on read. Version 1
text and index-based pins migrate once on read. Subsequent reloads preserve entry
IDs. Invalid duplicate IDs or malformed entries are rejected, and storage failures
do not disable in-memory editing.

The route stash is stored separately on this device under
`zlayer-plugin:routes:stash` as `{ version: 1, routes }` through a core storage slot.
The former `zlayer-route-stash-v1` slot is read only when the new record is absent;
the next successful locked mutation writes the new slot. Opening the stash is read-only. Each saved route contains a
stable ID, optional name, and a structured draft; entry validation is shared with
active-draft persistence. Mutations read the latest saved list, and only publish
success after storage accepts the write. Unreadable records are left untouched.
A Web Lock covers each complete read/change/write so simultaneous windows cannot
overwrite unrelated saves. If another window holds the lock or browser coordination
is unavailable, the operation reports an error without writing. Dialog actions are
disabled while a write is pending. Storage events refresh an open stash across tabs;
saving an edit rejects a route changed or removed in another tab. Site storage reset
also clears the stash.

The resolver still accepts filing text with optional legacy pins at the import
boundary. The application passes structured drafts directly. Published imports
resolve their typed entries once and attach pins before entering the draft or a
TEC segment. Recommendation airport-pair lookup has a derived pin adapter; there
is no separately maintained pin map in application state.

## Deliberate limits

This is a route planner and waypoint preview, not a complete flight-plan grammar
or clearance validator. Airway expansion currently supports V/T identifiers.
Coordinate input supports the compact degrees/minutes/seconds format above;
other coordinate formats, speed/level annotations and other filing constructs are not parsed.
After primary identifier matching, unpinned ordinary identifiers use the existing
layer-priority/nearest-previous selection heuristic; published ambiguity is handled
more conservatively.

Route actions have no application-level Undo/Redo history. Loading a saved Route
Stash snapshot restores that draft, including its attached approaches and pins.

SID selection attaches a runway/branch and exit to its airport, using the same
picker and bundle interaction as approaches; see [procedure previews](terminal-procedures.md).
SID/STAR rendering does not reconstruct vectors, arcs or full flight-guidance paths.
STAR runway branches remain unselected. Lines
join published waypoint coordinates; long direct legs are not densified into
great-circle polylines, although distance uses great-circle calculations.

Regression coverage lives in the domain route/airway/TEC/procedure tests and the
application draft, persistence, lifecycle, editor gesture, map gesture, geometry
and recommendation tests. `npm run verify` runs type checks, tests and production
builds. The local fixture `/test/browser/routes.html` supports browser checks of
paste, insertion, removal and reorder at desktop and touch-sized viewports.
