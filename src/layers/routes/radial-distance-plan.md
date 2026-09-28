# Route point identification

Status: **implemented locally**. The [route guide](README.md) owns user-facing
behavior; this note retains the design rationale, boundaries and qualification
work from the original proposal. External application/device qualification remains
separate from local automated checks.

## One position, several descriptions

A route chip's **Identify point…** action opens the existing feature **ID** panel.
Selecting the feature and pressing **ID** reaches the same controls, which offer the original published
name when available, a GPS coordinate, and eligible VOR references within 100 NM.
Switching descriptions preserves exact coordinates, entry identity, published
constraints and route distances. Explicitly identifying an editable named point
pins its resolved feature so a homonym cannot replace it after another edit.

The existing sorted ID table is also the radial selector: station names are
buttons, and a checkmark and row highlight mark the selected reference. Name/GPS
choices sit above it; there is no second station list. The table keeps MON
membership, frequency, magnetic/true bearings and map ranking. Missing alignment
keeps TB visible but disables radial selection. Points outside the route retain
the read-only table.

The map includes the selected radial reference even outside the top three nearby
stations or when current station data is unavailable. Its saved station position
and readings supply a blue dashed line with yellow casing, markers and label trim;
other references keep white trim. Name/GPS selection clears the radial highlight.

Selection uses the exact station snapshot displayed by ID, from the selected
feature's edition and its validated, cycle-bound alignment supplement. The table
and map bearings use the route occurrence's current coordinate, so refreshed
route geometry cannot leave selection tied to an older point position. It does
not independently reload or sort the route's navaids. A reference that differs
from the route's current source uses the existing saved-reference/export rules.
Returning to the original station restores the original radial definition; an
original reference absent from the table remains available as **Saved radial**
or **Saved bearing**, depending on its convention.

A named fix or GPS point may have several station-relative descriptions. A radial
point can switch to another station, GPS, or its original radial description.
Radial/distance labels show whole degrees and tenths of a nautical mile, without
an approximation prefix. Display rounding is not fed back into the geometry calculation.

The ID panel applies to all resolved route points, including airway, TEC, SID, STAR
and approach children. A route item with several owned points offers a point
selector. Descriptions are scoped by owning entry and exact point identity,
coordinate and approach phase, plus an ordinal for otherwise identical repeated
occurrences within that entry. Inserting a different child does not change this
identity. Legacy three-field keys still identify the first occurrence; later
repeats use four-field keys. Repeated entries remain independent. Direct To and
endpoint removal preserve descriptions when flattening retained children,
rekeying them as independent points without the old phase or duplicate ordinal. Source changes that no longer match a saved point key do not
apply its old description to a different point.

## Named alternatives are deliberate replacements

Nearby named candidates include airports, navaids, fixes and VFR waypoints within
5 NM, bounded to the closest twelve. Each shows its identifier, type and offset.
Selecting a candidate previews the old and new positions; **Use [identifier]**
commits the replacement and exact feature pin. Cancel leaves the route untouched.
A nearby airport and its navaid are separate choices. No nearest fix is selected
automatically, including when a radial happens to be close to a published fix.

Replacement is available for ordinary editable points. Published children and
anchors, including airports with attached procedures, retain their constraints:
their descriptions can change, but the ID panel does not replace or flatten them.
It explains that moving them requires editing the owning route item. This extends
the original proposal's direct-point scope without weakening published geometry.

## Input and geometry

Accept `CME/285/54` and compact `CME285054` as one station-relative route point.
ForeFlight documents the [slash syntax](https://support.foreflight.com/hc/en-us/articles/204026805-How-can-a-waypoint-be-entered-using-a-VOR-radial-and-distance);
a [worked SkyVector example](https://fencerpts.com/2021/06/20/skyvector-com-manually-entering-waypoints/)
demonstrates the compact form. Decimal radial and NM fields are ZLayer extensions,
not claims about either application's accepted precision.

The shared lexer keeps internal slashes and decimal dots intact during typing
and paste. Valid forms normalize to a slash token internally; north accepts 000
or 360. Radials must be in 0–360 degrees and distance must be finite, positive and
less than half the spherical earth circumference, where the shortest-distance
inverse remains meaningful. The 100 NM ID search radius is not an input limit or
a reception guarantee. Small decimal fields normalize without scientific
notation so accepted input remains parseable after saving. Malformed or unresolved points remain visible and interrupt
resolved legs.

Typed origins may be any resolved named fix, airport or navaid, independently
of the MON/VOR recommendation list. Unsuffixed VOR input uses the published
outbound radial: `true bearing = radial + station declination`. Unsuffixed
non-VOR input uses magnetic bearing at that reference. Explicit `R`, `M`, and
`T` suffixes select published VOR radial, modeled magnetic bearing, and true
bearing respectively. Examples: `CME/285R/54`, `HIGAL/320M/15`, `KSBA/090T/10`.
ForeFlight documents the distinction and the unsuffixed `HIGAL/320/15` example
in its [pilot guide](https://cloudfront.foreflight.com/docs/ff/14.2/ForeFlight%20Mobile%20Pilot%27s%20Guide%20v14.2.pdf).

Magnetic bearings require a valid magnetic-model evaluation at the reference,
using sea level and a day-stable evaluation time. Model coverage and horizontal
field checks apply. True bearings require no magnetic conversion. Published
VOR alignment never falls back to WMM or zero. Primary identifiers take
precedence for named references; missing VOR data cannot silently select an
airport short alias in unsuffixed input. Ambiguous identifiers require explicit
selection through **Choose reference point…**; an unaligned homonym cannot be
silently skipped. Forward/inverse calculations share the route spherical
ground-distance model.

Direct legs, planning connections and reference lines use bounded great-circle
sampling (20 NM maximum step). Map rendering, fitting and terrain/obstruction
corridors share those paths; explicit procedure geometry is unchanged. Exactly
antipodal endpoints use a deterministic display plane because no unique course
exists.

Distance is **ground distance**. Actual DME measures
[slant range](https://www.faa.gov/about/office_org/headquarters_offices/ato/service_units/techops/navservices/gbng/lpdme).
The feature does not model aircraft altitude, radio reception or an instrument
DME reading, and the station type distinguishes VORs without DME equipment.

## Persistence and source identity

Named and GPS entries keep their underlying identifiers and optional per-point
presentation records. Typed radial points save their unrounded coordinate,
reference identity/location/alignment, definition, bearing convention and source
revision/key once they resolve. Magnetic bearings also retain model name, epoch
and evaluation time. Legacy snapshots with no convention remain VOR radials. Route Stash retains these structured records, independently of text export.

A saved radial snapshot resolves offline and does not move when the station data
changes. If its original reference is absent, changed or ambiguous in the current
data, the ID panel explains that it is using a saved reference and export uses
coordinates. Choosing another current reference describes the same saved point.
Editing the route token to a new definition deliberately discards the old snapshot.

Snapshot and presentation validators reject inconsistent geometry. Add and Direct
To carry self-contained radial snapshots; they do not create navigation pins for
synthetic map features. Displayed feature identity and station identity stay separate.

## Copy, share and application handoff

One point formatter serves **Copy Route**, **Share** and
**Open in ForeFlight**. It serializes the selected description, not the rounded
label, and leaves the structured draft unchanged.

| Destination | Exact supported radial example | Coordinate fallback |
| --- | --- | --- |
| ForeFlight | `CME/285/54`, `HIGAL/320M/15`, `KSBA/090T/10` | Slash-separated latitude/longitude, whole seconds |
| SkyVector / ZLayer | `CME285054`; named magnetic/true references use coordinates | Compact latitude/longitude, whole seconds |
| ICAO / 1800WX | Coordinates until reference/bearing semantics are qualified | Latitude/longitude, whole minutes |

Radial output currently requires an unambiguous, unchanged current reference,
integer degrees and integer NM below 1000, and a convention supported by the
destination. Other cases use coordinates and show
the rounding offset against the exact saved position. Both seconds and minutes
introduce rounding; this is not a claim of lossless text interchange. Plain text
also cannot retain a source edition or an exact feature pin.

Ordinary route points export their chosen description. Published routes and their
anchors retain the identifiers needed for their constraints and procedure syntax.
Export controls live in the route menu; the ID panel has no separate point export.
Unresolved radial definitions remain visible in export with a diagnostic rather
than an invented coordinate or omitted point.

Choose the destination format before native sharing because the share sheet does
not disclose its destination. ForeFlight handoff always uses ForeFlight syntax and
URL-encodes the completed route once. External applications may use different
station alignments/editions even for identical station-relative text.

## Lifecycle, verification and remaining qualification

Candidate searches run only while the ID controls or unresolved-reference chooser
are mounted, reuse loaded navigation data and retain bounded results. Alignment recovery uses source keys,
cancellation and inventory/online signals. The bearing model is acquired only
when an active route/view needs magnetic reference input; it uses the same
resource recovery and cancellation path. VOR IDs are indexed per collection,
not rescanned across national fixes on each edit. There are no added timers, GPS watches
or continuous map animation. Closing or changing the selected point clears its
replacement preview and ignores late data results.

Regression coverage includes forward/inverse geometry, dateline/high latitude,
missing alignment and homonyms, both input syntaxes, saved/offline snapshots,
source changes, invalid persistence, repeated occurrences, published children,
Add/Direct To, export precision, phone/desktop input, ID integration and restoration.
See `test/route-identification.test.ts`, `test/e2e/route-identification.spec.ts`,
and the existing route/nearby-navaid suites. Passing these does not qualify radio
navigation or an external flight-planning application.

Remaining qualification: live ForeFlight/SkyVector import comparison and physical
device checks. Named-reference magnetic/true input is implemented locally; this
does not certify any particular Garmin unit’s syntax or import behavior. The
selected-reference overlay uses the saved reference independently of the
recommendation list. Radial intersections and altitude-dependent slant-range
positioning remain out of scope.
