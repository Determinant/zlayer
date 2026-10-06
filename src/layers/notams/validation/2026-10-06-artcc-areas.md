# U.S. ARTCC/FIR parser audit — October 6, 2026

This dated validation covers the prepared records returned from every selected
U.S. center/FIR. It does not guarantee that every FAA publication is present in
the feed or that arbitrary future prose can yield geometry. The
[owning guide](../README.md) defines current behavior; the
[fixture contract](../../../../test/fixtures/notams-us-artcc/README.md) records
source hashes, official scope references and replay instructions.

## Capture and results

The expanded 17:36 UTC capture contains 27 ARTCC queries and 27 FIR queries,
5,810 returned records and 2,960 distinct source ID/revision pairs. The earlier
17:05 UTC pass used 26 domestic selectors and missed New York Oceanic and
FIR-only filings. The expanded pass found 141 IDs absent from that earlier pass;
other retained notices disappeared between captures. The exact supplied ZOA
6/7169 is pinned separately because it disappeared before the later read.

All 54 responses have zero local source issues. The global feed still reports
degradation. FIR-only association remains incomplete by contract; these audit
reads do not invent airport/FIR associations or relabel source coverage.

The broad explicit-area inventory found 1,219 candidates. After the parser review
and refactor, these account for 1,107 map depictions (825 circles and 282
polygon/corridor/multiple-area notices), 86 TFR descriptions owned by the national
layer, two laser-source point notices, and 24 reviewed boundary omissions.
Forty-two areas depend on navigation references; 47 show
GPS altitude-tier envelopes. All 264 standalone OBST notices were reviewed:
121 point notices and 138 areas map, while five have unrecoverable coordinates.
Five additional non-OBST notices identify controlling windmills or tower-light
positions. Six notices identify activity source points (laser, balloon, volcano).
Counts include expired/future source forms and repeated FAA filings.

The initial replay reported 1,110 areas and 22 omissions. The refactor found two
false positives: `3473792392352477` repeats an ending and opening part marker,
and `7785136805319430` has an ambiguous `M179NM` GPS tier. Both now retain full
text without geometry. The third difference is `1768315550338021`, whose
line-wrapped temporary-flight-restriction wording now correctly excludes a second
temporary footprint. Its national-layer ownership is separate from proving a
current national rendering receipt. The original captured responses are unchanged.

The parser now supports multi-leg corridors (including NOAA paths with crossings
and holes), multiple separate areas, complete multipart boundaries, station arcs,
redundant damaged annotations, and radius wording variants. The map publishes all
components of a notice together and preserves holes. A missing component prevents
acknowledgment. Exact geometry/label duplicates share depiction while every source
identity retains its reader, raw text, receipt and highlight.

Eleven area notices and two obstruction notices use explicit coordinate recovery.
Exact 60-second carries and a displaced hemisphere preserve the numeric fields.
Missing/invalid hemispheres need an independent distance/direction annotation and
a unique published reference; no US-wide north/west assumption is used. A
missing-decimal interpretation must meet stricter corroboration. Recovered
coordinates are marked on the map and remain visible in the source reader.
Extra digits with several possible interpretations stay unresolved.

The supplied Bull Fire 6/7106 retains its four-vertex national polygon and
SFC–10000 ft MSL limits. The regional reader references only matching geometry
accepted by the renderer; raw and search remain complete. The NMS end metadata is
one minute later than the identical raw/national validity, handled by exact local
source-text agreement rather than a broad time tolerance.

## Scope inventory

The FIR list is explicit and includes the FAA's oceanic filing identifiers.
The table presents independent query counts; overlapping deliveries are deduplicated
only when computing the 2,960-version inventory.

| ARTCC query | Returned records |
| --- | ---: |
| ZAB | 259 |
| ZAK | 81 |
| ZAN | 154 |
| ZAP | 0 |
| ZAU | 43 |
| ZBW | 74 |
| ZDC | 139 |
| ZDV | 94 |
| ZFW | 157 |
| ZHN | 39 |
| ZHU | 210 |
| ZID | 48 |
| ZJX | 90 |
| ZKC | 119 |
| ZLA | 246 |
| ZLC | 172 |
| ZMA | 67 |
| ZME | 88 |
| ZMP | 166 |
| ZNY | 75 |
| ZOA | 72 |
| ZOB | 64 |
| ZSE | 228 |
| ZSU | 23 |
| ZTL | 114 |
| ZUA | 9 |
| ZWY | 19 |

| FIR query | Returned records |
| --- | ---: |
| KZAB | 260 |
| KZAK | 81 |
| KZAU | 48 |
| KZBW | 77 |
| KZDC | 151 |
| KZDV | 96 |
| KZFW | 161 |
| KZHU | 219 |
| KZID | 61 |
| KZJX | 90 |
| KZKC | 120 |
| KZLA | 260 |
| KZLC | 172 |
| KZMA | 69 |
| KZME | 88 |
| KZMP | 178 |
| KZNY | 80 |
| KZOA | 83 |
| KZOB | 76 |
| KZSE | 229 |
| KZTL | 117 |
| KZWY | 19 |
| PAZA | 154 |
| PAZN | 0 |
| PGZU | 9 |
| PHZH | 39 |
| TJZS | 23 |


## Remaining boundaries and source defects

Every omitted ID/revision is pinned in `unsupported.json`. The three NALU notices
parse as arcs, but their published **clockwise** arc intersects an earlier straight
segment near 23°N, 157.3°W. Reversing that direction would change the source. The
other self-crossing polygon is also rejected. Missing closure, two-vertex polygons,
ambiguous airport/navaid centers and TACAN radials without station alignment do
not acquire invented geometry.

Four flight-check notices now depict their complete explicit polygons while
retaining the following runway-final/sector qualification in full; the map label
also directs the reader to that qualification. No extra sector is invented.
Three Washington regulatory notices and the Dorado geographic letter still need
richer regulatory/geographic interpretation. These are explicit
remaining limitations, not successful map parses. The wider inventory separately
reviews 33 other coordinate/area-text notices, including route instructions and
national restriction prose.

| Reviewed reason | Unique records |
| --- | ---: |
| TACAN without published alignment | 3 |
| ambiguous airport or navaid | 3 |
| extra latitude digit has no unique repair | 2 |
| geographic prose | 1 |
| malformed coordinate | 2 |
| missing closure | 3 |
| published clockwise arc crosses an earlier boundary segment | 3 |
| regulatory prose | 3 |
| self crossing | 1 |
| two vertices and duplicated AS | 1 |
| duplicate/out-of-order multipart transport markers | 1 |
| malformed GPS radius tier | 1 |

The five remaining OBST source defects are the ambiguous shortened longitude
`113242W`, two copies of extra-digit latitude `4355616N`, extra-digit latitude
`34424250.39N`, and longitude `11920545W` whose missing-decimal interpretation
conflicts with its published 34 NM annotation. The PIT service coordinates
`4030119N08015737W` also lack a unique defensible repair. Their complete readable
and raw source remains available.

## Verification

The KEWR/ZNY hover follow-up recognizes the complete three-part New York TFR
`5/2811` and the two-area Baltimore TFR `6/7096`. Both use exact source/body
agreement and accepted national geometry. Hover and keyboard focus highlight every
area of the matched notice; filtering, reader release and renderer failure clear
the interaction without removing the persistent national layer.

All 26 ZNY notices containing `R-xxx` in the capture describe VOR radials;
30 affected radial references resolve through eight published stations. These
now offer direction arrows on hover/focus, with one label per station. The arrows
have no geographic extent and retain the full notice's distances, altitudes and
exceptions. They do not claim radio coverage or replace restricted-area boundaries.
The follow-up passed 46 focused tests plus the added radial map-lifecycle test,
TypeScript/import checks, and four browser cases (airport hover, ARTCC hover,
Bull Fire, and KEWR national/radial hover). Screenshots of New York's boundary
and HTO's 223° true direction for R-236 were inspected. No full verification ran.

The focused parser/corpus, lifecycle and reader run passed 62 tests. TypeScript
and import-boundary checks also passed. Final focused follow-ups passed the
minute-coordinate receipt regression, multipart completeness regression and the
entire regional replay again.
The expanded regional replay audits all 2,960 versions, including the ordinary and
mapped readers. Geometry regressions cover corridor holes/crossings/dateline
wrapping, multipart and multi-area atomic publication, arc direction, coordinate
recovery corroboration, reference replacement and explicit source-point depiction.
The 1,000-airport reader replay remains separate. No full verification is run,
as requested. Browser checks use the installed Playwright container because the
Nix host lacks Chromium's Ubuntu shared libraries. Seven focused browser cases
passed (six together, then the new multi-area/recovery/source-point case after
correcting its duplicate test-fixture source IDs); screenshots were inspected.

The subsequent parser-refactor run passed 73 focused tests, including all 54
ARTCC/FIR scopes and the separate 1,000-airport/19,469-record reader replay.
New regressions exercise instruction/conditional scope across area introductions
and radial references, ordered multipart assembly (including ten-part sources),
unknown boundary qualifications, fractional radius tokens, and exact obstacle
coordinate elision with repeated/quoted tokens. A deliberately damaged reader is
rejected by the independent mapped-content audit. TypeScript, import boundaries
and diff whitespace checks passed. Six final Playwright cases passed: obstacle
previews, areas, ZOA duplicate service labels, Bull Fire, KEWR TFR/radial hover,
and multiple/recovered areas with activity points. Full verification was skipped
as requested.

The [airport-obstruction follow-up](2026-10-06-airport-obstructions.md) subsequently
replayed this same regional capture and the 1,000-airport corpus from an isolated
commit candidate. It passed 265 focused Node tests and all 52 NOTAM browser cases,
plus TypeScript/import checks. Regional counts and reviewed omissions above remain
unchanged. The airport review adds independent point-coordinate and map-publication
checks; reader preservation alone is not a guarantee of complete geometry coverage.
