# Route parsing and editing

The editable draft is an ordered array of `{ id, text, pinnedFeatureId? }` entries.
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
| `packages/domain/src/tec-routes.ts` | Local airport-pair matching and scoped published children |
| `packages/domain/src/preferred-routes.ts` | Published route imports and typed point constraints |
| `src/layers/routes/draft.ts` | Atomic edits by entry ID |
| `src/layers/routes/use-draft.ts` | Versioned persistence and storage validation |
| `src/layers/routes/use-plan.ts` | Reference loading, resource identity, partial failures and superseded requests |
| `src/layers/routes/suggestions.ts` | Shared resolution for history and preferred/TEC recommendations |
| `src/layers/routes/history/` | Worker client and store, plus history query and draft conversion; offline callers use `client.ts` |
| `src/layers/routes/editor.tsx`, `use-editor-gestures.ts` | Entry, insertion, token menus, reorder and pointer lifecycle |
| `src/layers/routes/renderer.ts`, `geometry.ts`, `editing.ts` | GeoJSON presentation, dateline handling and edit target identity |
| `src/workspace/feature-route-actions.tsx` | Shared detail-panel add/remove controls, derived from the selected feature and current route |
| `src/workspace/map/gestures.ts` | Shared map selection, route hit testing, dragging and snapping |

Keep text helpers and shared types separate from the resolver: TEC interpretation
uses preferred-route import helpers, which must not import the resolver back.
Recommendations and the main editor share the domain resolver. Map rendering
consumes the resulting plan rather than interpreting route text again.

## Invariants

### Drafts and direct edits

- Input is case-insensitive. Whitespace, dots, commas, slashes, hyphens and `>`
  separate tokens; `DCT` and `DIRECT` are connectors. Unknown tokens stay visible
  and break connectivity rather than silently disappearing.
- A map-selected feature contributes one usable identifier. Display names and
  empty identifiers cannot create tokens or displace pins. Draft mutations move,
  replace or remove complete entries. Editing a missing ID is a no-op.
- Dragging a direct leg inserts the snapped navigation waypoint, or a GPS waypoint
  at an unsnapped drop. Coordinates use `DDMMSSNDDDMMSSW` tokens (with the appropriate
  hemisphere letters), rounded to the nearest second. These tokens resolve without
  navigation data or feature pins and survive route text export and saved drafts.
  Taps, cancelled drags and stale route revisions do not insert anything.
  A drag preview marks the new bend; the leg itself is the hit target, with no
  midpoint handle.
- Dragging an existing GPS waypoint to empty space updates that entry's coordinate;
  dropping it on a navigation feature replaces it with that feature. Its moving
  marker and label cannot snap to themselves. GPS waypoints are removed through
  the token menu. Dragging a published waypoint onto another feature replaces it;
  dropping it clear of all snap targets removes it.
- Route waypoint markers and labels select their navigation feature, including
  airports whose background symbols are hidden at the current zoom. A tap or click
  opens details without editing the route, including in recommendation previews.

### Nearby navaid identification

Every feature, including temporary GPS points, has a blue **ID** button after
append-to-route. It opens up to six nearby VOR, VOR/DME or VORTAC references within
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
  discontinuities leave gaps. A missing feature pin never falls back to a different
  feature. Reported distance is the sum of resolved legs.

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
- Recommendation overlays carry no editing targets. Selecting a shared geometry
  still preserves the selected route's metadata. Details include every TEC segment.

Snapped edits pin the exact feature ID; coordinate insertions remain self-contained
tokens. Multi-touch cancels edits, and dateline geometry and route fitting share
the same longitude-unwrapping rule.

## Route actions

The Route icon and label open a menu for Copy route, native Share when supported,
Open in ForeFlight on iPhone/iPad, and Clear route. On phones the menu trigger
starts the second row before Advise; wider layouts keep it before the input.
Clearing returns focus to the empty route editor. Clipboard failures offer selected
text for manual copying. Exports expand resolved TEC designators to their published
route text, preserve unknown entries, and use ForeFlight's Maps URL scheme for the
app handoff. **Open in ForeFlight** automatically uses ForeFlight coordinate
syntax. The menu does not detect whether ForeFlight is installed.

**Copy route** and **Share…** each expand a format submenu on desktop, iOS/iPadOS
(including the desktop-style iPad user agent), and Android. Share passes the
selected format to the native share sheet. Arrow Right opens either format menu;
Arrow Left or Escape returns to its parent action, and a second Escape closes the
route menu. Clipboard fallback text uses the chosen format. Cancelling native
sharing keeps the format menu available for retry; a failure offers Copy route.

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
Procedure segments remain dashed; unknown segments leave gaps and partial previews
are labeled. An exact, unique historical TEC code can use the current FAA definition,
labeled **current TEC** while retaining the original filed text and counts.

The camera leaves room for the list, which becomes a bottom sheet on phones.
Restoring an open list preserves the saved camera. Panel state, aircraft filter,
selection, expanded conditions and row limits persist locally; see
[workspace persistence](contracts.md#workspace-persistence). Recommendation sources
load independently and share national references with the planner and
[regional downloads](offline-storage.md).

## Persistence and compatibility

Version 2 persists the entry array in the existing local-storage slot. Version 1
text and index-based pins migrate once on read. Subsequent reloads preserve entry
IDs. Invalid duplicate IDs or malformed entries are rejected, and storage failures
do not disable in-memory editing.

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

SID/STAR rendering does not reconstruct runway branches, vectors, arcs or full
flight-guidance paths. See [procedure previews](terminal-procedures.md). Lines
join published waypoint coordinates; long direct legs are not densified into
great-circle polylines, although distance uses great-circle calculations.

Regression coverage lives in the domain route/airway/TEC/procedure tests and the
application draft, persistence, lifecycle, editor gesture, map gesture, geometry
and recommendation tests. `npm run verify` runs type checks, tests and production
builds. The local fixture `/test/browser/routes.html` supports browser checks of
paste, insertion, removal and reorder at desktop and touch-sized viewports.
