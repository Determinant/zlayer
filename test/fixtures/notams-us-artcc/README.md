# U.S. ARTCC/FIR NOTAM regression

This regional fixture contains 54 prepared queries captured October 6, 2026,
17:36:13–17:36:17 UTC: 27 domestic center selectors and 27 published FIR selectors.
There are 5,810 returned records and 2,960 distinct source ID/revision pairs.
The airport corpus remains a separate reader and obstruction-map regression.

`manifest.json` pins the uncompressed JSON-lines payload size/hash, exact queries,
capture endpoint/time and per-scope counts. Every line in `snapshots.jsonl.gz` is
an unchanged complete response, including feed state, coverage, records and
translations. These were prepared API reads, without triggering FAA acquisition.
Counts include retained expired/future records and distinct filings, not just
notices visible at one instant. The global feed's degraded state is retained.

The scope inventory uses the published U.S. ARTCC identities plus New York
Oceanic (ZWY), and the FAA's NAS FIR table and international filing identifiers.
The official sources are linked in the manifest. PAZA, PAZN, PHZH, PGZU and TJZS
are queried explicitly; no generic K-prefix mapping is assumed. ZAP and PAZN
returned no records and remain in the replay. FIR-only association coverage is
`incomplete` by the API contract; domestic queries report `complete`. All 54
responses have zero local source issues. This does not prove the upstream feed
contains every FAA publication, or change the app's airport-to-region associations.

`area-references.json` pins 573 airports and 119 navaids from the October 1, 2026
published navigation edition. Full-source sizes/hashes are retained. The subset
includes every candidate sharing an alias, including ambiguous airport/VOR pairs,
VOTs and stations without radial alignment. It also includes references needed
for coordinate corroboration. Geometry and obstacle results were compared with
the full navigation source before freezing.

`unsupported.json` records each unresolved explicit area candidate by source ID,
revision and reviewed reason. `wider-review.json` accounts for other coordinate
or area prose, including route instructions and regulatory material without a
standalone footprint. `obstacles.json` separately accounts for every OBST notice,
including five unrecoverable coordinate cases. These lists are omissions, never
claims of successful map depiction. Of 264 standalone OBST notices, 121 depict
points and 138 depict areas. The five remaining coordinate defects are shortened
longitude `113242W`, two copies of latitude `4355616N`, latitude `34424250.39N`,
and longitude `11920545W` conflicting with its published 34 NM annotation.

The parser-refactor replay accounts for 1,107 areas, 86 national-TFR descriptions
and 24 reviewed boundary omissions among 1,219 explicit-area candidates (the
remaining two are laser source points). Compared with the initial replay, it
rejects duplicated multipart markers in `3473792392352477` and the ambiguous
`M179NM` tier in `7785136805319430`. Line-wrapped TFR `1768315550338021` belongs
to the national layer. Only expected interpretation counts/review reasons changed;
the captured source payloads and hashes are unchanged.

`bull-fire-tfr.json` retains the unchanged national 6/7106 notice from the earlier
capture. `zoa-service.json` retains the exact supplied 6/7169 regional notice from
17:04:59 UTC; it was no longer returned in the later capture. Both have independent
source/checksum metadata. Keeping these examples separate avoids altering the
new regional responses or losing regressions when a notice disappears.

`zny-hover.json` selects unchanged FDC records `8436`, `2811` and `7096` from
the pinned `artccId=ZNY` response; its original feed/coverage metadata is retained.
`zny-tfrs.json` selects the two ZNY national notices and their issues from the
prepared TFR response checked at `2026-10-06T17:05:05.486Z`
(`https://zlayer.tedyin.com/api/notams/tfrs`). The full source was 319,668 bytes,
SHA-256 `8077e14955df5b2c6c5aa026da6df6782e28ce1f1270adcea447f14743a9ad96`.
This isolates the actual multipart New York and two-area Baltimore hover cases.
`zny-navaids.json` selects all eight station identities used by the 26 radial
notices in that ZNY response from the October 1 navigation file pinned above;
source features are unchanged, with subset count metadata. The radial regression
replays all 26 notices (30 references) from `snapshots.jsonl.gz`, verifies published
alignment, and retains distance/altitude qualifications without inventing an extent.

Run only the regional replay:

```bash
node --import=tsx --import=./test/helpers/assets.ts --test test/notams-artcc.test.ts
```

The replay checks all source/readers, source immutability, exact scope identities,
geometry publication, radii, closed rings and holes, complete multi-area admission,
obstructions and all reviewed omissions. `npm run test:notams:corpus` additionally
runs the independent 1,000-airport reader and obstruction replay. The
[NOTAM guide](../../../src/layers/notams/README.md#verification) owns current
parser, map-publication and reader requirements.
