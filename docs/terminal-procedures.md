# Terminal procedures

The national `terminal-procedures` product in `nav/manifest.json` contains NASR
filing topology, airport-scoped CIFP SID/STAR branches, and coded approaches. Its
filename includes the content hash. The client validates the publisher JSON
identity, schema version, required families, coverage counts and common edition
before caching or using it. Plates remain a separate catalog: a
published chart is not evidence that FAA supplies its coded path.

## Selecting procedures

Choose **Choose SID…**, **Choose STAR…**, or **Choose approach…** on an airport's
route menu. SID/STAR selection requires an explicit runway/branch and enroute
transition. Previewing does not edit the route; **Add to route** commits it.
Attachments move with their airport, survive reload and Route Stash saves, and
remain removable if their edition or branches are no longer available.

CIFP route types determine runway/common/enroute combinations. Different route
families are never mixed. Adjacent IF branches must share the same surveyed fix.
Heading departures use the selected runway threshold, when published, rather
than the airport reference point. Selected enroute endpoints also support airway
expansion without requiring duplicate editable waypoints.

Approach selection includes coded procedures that do not match a plate title or
have no available plate catalog. Those selections retain an exact airport,
procedure, entry and edition identity. A plate link appears only for an actual
catalog association. Plate-only procedures remain browsable without a guessed
coded substitute. Published IAFs, feeder entries and applicable VTF choices use
the same preview and route resolver.

The map and navlog show exported altitude, speed and RNP restrictions. Holding,
heading, climb and intercept paths are schematic and excluded from route distance.
Terrain covers these depictions as well as fixed paths. Manual vectors, missing
references and inconsistent geometry retain their source diagnostics. Dotted
planning connections join successive known waypoints across these gaps, including
VTF arrivals and unmatched STAR/approach endpoints. These connections contribute
map and terrain coverage only; they do not represent a published or cleared path.
Known maneuver prefixes remain visible when a later leg fails; the planning
connection starts at the prefix's open endpoint instead of bypassing it.
Airport bundle markers are omitted from the flight sequence when an approach or
departure supplies its own points, avoiding backtracking through the airport.

Exports retain filing notation (`airport SID exit`, `entry STAR airport`) without
duplicating adjacent explicit transition fixes. Text alone does not preserve a
runway choice; the structured saved route does. Pasted SID/STAR filing strings
continue to use NASR topology, and the SID picker offers **Browse filing route
previews** for that older representation. Coded selections require the picker;
they are never inferred from similarly named NASR procedures.

## Source coverage and limits

The publisher now indexes airport-reference records, retains runway thresholds,
decodes speed/RNP/vertical-angle and related leg fields, and attaches all terminal
continuation records to their primary legs. W continuations expose authorized
service names such as LPV/LNAV; these are not numerical approach minima. It also
publishes the complete original CIFP text as the `cifp-source` product with encoded and
decoded hashes, so unprojected fields and supporting records remain auditable.
That audit source is not automatically downloaded by the client.

This does not provide complete ForeFlight feature or data parity. FAA's public
CIFP readme excludes CAT II/III, PRM, GLS, visual approaches, alternate missed
approaches, some military procedures and generally converging approaches (some
explicit converging variants do exist in the reviewed edition). Its separate
`Not_In_CIFP` workbook lists additional omissions. Numerical minima, full vertical
guidance and every supporting ARINC record are not decoded into this app.
Additional implementation and another source for omitted coded procedures are
still required; licensed navigation data is one option.

## National verification: FAA 2609, effective 2026-09-03

| Family | Coded procedures | Primary legs exported / source | Selectable path choices | Choices with review diagnostics |
| --- | ---: | ---: | ---: | ---: |
| SID | 2,193 | 34,309 / 34,309 | 19,927 | 93 |
| STAR | 1,916 | 44,563 / 44,563 | 10,429 | 0 |
| Approach | 10,234 | 122,204 / 122,204 | 37,836 | 201 |

All 201,076 primary legs and 6,744 continuations reconcile. Every coded approach
has an entry and every SID/STAR branch reaches at least one selectable path.
The 11,878 SID/STAR choices with intentional manual endings are counted
separately from the 294 choices needing source or geometry review. These numbers
measure source accounting and resolver diagnostics, not independent chart
certification. Repeated runway/transition choices can share the same issue.
The [retained national report](evidence/terminal-procedures/2026-09-21/national.json)
includes independent source/export recounts, source and implementation hashes,
and each choice with a review diagnostic.

Indexing PA airport references resolves 646 of the previous 648 unresolved
reference occurrences. The two remaining references are `PGSN:Q07-Z` (blank
reference section for SN) and `KDAF:R36` (CMY NDB absent from this CIFP input).
Missing KORF runway 14/32 threshold records also leave affected departures without
a surveyed starting point. These omissions are not repaired by proximity.

Reproduce integrity checks and the national path report with:

```sh
node --import=tsx tools/audit-terminal-coverage.mjs /path/to/cycle/nav /tmp/terminal-audit.json
```

The report separates source coverage, intentional manual endings, missing choices
and geometry diagnostics. For plate-to-code matching and chart comparisons, see
[approach coverage](approach-coverage.md) and `tools/audit-iap-coverage.mjs`.

## Build and refresh

In `faa-regs`, rebuild navigation, then the TPP catalog so its chart associations
reference the new navigation identity. Refresh Chart Supplements to publish their
expected regional coverage. Existing FAA source downloads and unchanged PDF page
indexes are reusable; chart imagery, terrain and MBTiles do not need rebuilding.
A dated local navigation build requires all eight NASR ZIP groups plus matching
`FAACIFP18` or `CIFP_YYMMDD.zip`:

```sh
npm run build:nav -- --source-dir=/path/to/cycle/nasr --cycle=2026-09-03 --route-history-source=/path/to/routes.sqlite.zst
npm run build:procedures -- --effective-date=2026-09-03 --source-xml=/path/to/d-tpp_Metafile.xml
npm run build:supplements -- --effective-date=2026-09-03 --source-xml=/path/to/afd_03SEP2026.xml
```

The history argument preserves the chosen local filed-route source. Omitting it
from a local navigation build omits that optional product. Online builds acquire
history through the publisher's normal source workflow.

Navigation and TPP publish immutable files before atomically replacing one small
manifest. Missing or mismatched input leaves the previous manifest readable.
Keep earlier content files until edition retention removes them. When uploading,
upload content files first and manifests last; directory synchronization by itself
is not an atomic remote publication. Local builds do not change the hosted feed.
After deployment, **Verify / update** refreshes saved regional downloads.

The TPP catalog records matched, ambiguous and unmatched associations, tied to
both FAA source identities and the terminal JSON digest. Reviewed exceptions are
publisher data in `data/approach-associations/YYYY-MM-DD.json`, with source hashes
and plate/fix evidence. The browser has no edition-specific exception table. A
saved selection retains the exact coded route and entry; its display title does
not reinterpret geometry. Legacy catalogs keep conservative title matching.

Saved attachments migrate to an explicit kind/source union at the persistence
boundary. NASR topology and CIFP legs retain separate capabilities. One terminal
composition boundary owns children, enroute connections and STAR/approach gaps;
source spans, assumptions and diagnostics stay attached to the plan. The three
pickers share loading, retry, stale-result and preview logic. Navigation and
terminal indexes are prepared once per immutable document, and synthetic fix
features are created only when used. Legacy editions retain filing previews.

The [implementation evidence](evidence/chart-nav-review/2026-09-21/implementation/)
contains consumer validation against the rebuilt national products, the geometry
audit and resolver measurements.

Sources: [FAA CIFP](https://www.faa.gov/air_traffic/flight_info/aeronav/digital_products/cifp/),
[2609 archive and readme](https://aeronav.faa.gov/Upload_313-d/cifp/CIFP_260903.zip),
[FAA NASR](https://www.faa.gov/air_traffic/flight_info/aeronav/aero_data/NASR_Subscription/).
