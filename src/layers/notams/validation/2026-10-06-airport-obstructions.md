# Airport obstruction coverage audit — October 6, 2026

This review uses the unchanged 1,000-airport, 19,469-record capture described in
the [owning guide](../README.md#frozen-1000-airport-regression). The original
regression guaranteed source/evidence preservation and both reader paths. It did
not assert complete obstruction depiction. This follow-up adds an independent
source inventory, coordinate checks, map publication and explicit omissions.
Counts include distinct FAA source filings and retained expired/future notices;
they do not count physical objects or currently visible symbols.

## Findings and fixes

| Source inventory | Before this follow-up | After |
| --- | ---: | ---: |
| Standalone OBST notices | 4,976 | 4,976 |
| Notices depicted as points | 4,916 | 4,957 |
| Notices depicted as areas | 3 | 4 |
| Standalone notices without geometry | 57 | 15 |
| Other explicit obstruction-coordinate reports | 47 | 47 |
| Other reports with geometry | 2 | 45 |

The 85 additional depictions cover silo, water-tower, ship-mast and other object
names; ASN/ASR spacing and captured truncated identifier suffixes; bounded
relative annotations; explicitly single-datum heights; ICAO tower headings;
final-approach obstacle references; ramp-light coordinates; and a moored-balloon
area with a COA suffix. Location still requires an explicit coordinate or complete
area. ASN/ASR identifiers, runway-relative descriptions and airport centers never
become replacement obstacle positions. Ambiguous heights stay unknown; the entire
source remains readable for incomplete or nonstandard reports.

`test/notams-us1000.test.ts` inventories every OBST notice and other explicit
coordinate reports containing crane/tower/windmill/obstacle/obstruction wording,
independently of the accepted object grammar. It decodes every accepted point
from its exact source span, checks publication at the source's validity interval,
and verifies source immutability. Thirty-seven notices use exact 60-second
carries; their map labels identify the recovered coordinate.

## Remaining limitations

All 17 omitted source versions are pinned with reasons in
[`obstructions.json`](../../../../test/fixtures/notams-us1000/obstructions.json).
The 15 standalone omissions include 13 ambiguous or conflicting coordinates:
shortened latitude/longitude fields, extra digits, latitude minutes of 90,
longitude marked `N`, mixed malformed DMS/decimal fields, and missing hemispheres
whose adjacent annotations do not corroborate the proposed point. Two notices
only refer to another NOTAM and supply no position.

The other two omitted versions are KEWR procedure notices whose crane clauses
follow a missed-approach instruction without an explicit scope closure. The shared
document state remains conservative; punctuation alone cannot promote later text
to independently operative facts. Their complete readable/raw source remains
available. These are known scope limitations, not successful geometry parses.

The reference subset contains AUS, HYA, LRD and the co-named LRD navaid from the
October 1 navigation edition. It preserves all candidate identities, source file
hashes and feature bytes. Results were compared with the full published airport
and navaid sources before freezing the subset. Missing-hemisphere cases were
reviewed against those references; corroboration thresholds were not relaxed to
raise coverage counts.

The independent [ARTCC/FIR audit](2026-10-06-artcc-areas.md) still records 1,107
areas, 24 reviewed boundary omissions, and 264 standalone OBST notices: 121 point
notices, 138 areas and five unrecoverable coordinate cases. Passing these captured
corpora does not prove that arbitrary future notices or malformed source data can
all be depicted safely.

## Replay

```sh
npm run test:notams:corpus
```

This runs both captured cohorts locally with no network or recapture. Focused
obstacle tests additionally exercise object/annotation variants, height datums,
lighting retention, shared instruction scope and exact source spans.

The isolated commit candidate passed 265 focused Node tests, including both
captured cohorts, map lifecycles, reader/matching behavior and route interaction.
All 52 NOTAM Playwright cases passed: 50 in the initial run and two TFR inspection
cases after correcting an outdated layer-count expectation for the new hover
outlines. The follow-up also verifies that idle highlights render no geometry.
TypeScript, import-boundary and diff whitespace checks passed. The installed
Playwright container supplied browser libraries and avoided host child-process
lock issues. Full verification was not run, as requested; no deployment occurred.
