# Chart/navigation cleanup verification

Recorded on 2026-09-21 against the local working trees in `zlayers` and sibling
`faa-regs`, using FAA edition 2026-09-03. These checks validate local artifacts;
the chart URLs in the report were resolved to local files during validation.
They do not verify a hosted deployment.

Current contracts and composition live in [terminal procedures](../../../../../src/layers/routes/terminal-procedures.md).
The [original negative probes](../results.json) retain the pre-fix reproductions;
they are historical evidence, not outstanding defects. Source and geometry limits
remain in the terminal guide and [approach coverage](../../../../../src/layers/routes/approach-coverage.md).

## Results

| Check | Result |
| --- | --- |
| Client unit suite | 1,306 passed: 1,157 application, 17 contracts, 132 domain |
| Added terminal indexing regression | 1 passed; construction does not walk legs, previews stay airport-scoped, saved pins retain exact membership |
| Publisher unit suite | 186 passed |
| Final publisher procedure/cache tests | 13 passed |
| Client and publisher TypeScript; client import boundaries | Passed |
| Client production build | Passed |
| Publisher-to-client fixtures | Passed, including required-family loss, same-count mutation, legacy substitution and association identity/accounting rejection |
| Route, coded terminal and offline browser suite | 163 cases passed across the broad run and focused rerun |
| Actual national publication consumed by client | All required resource guards, navigation wire identities, terminal/association identity and supplement coverage passed |
| Repeated procedure build | Reports already current; no PDF reindexing |
| Whitespace checks in both repositories | Passed |

The broad browser run initially passed 158/163 cases. Two KSBD fixtures still
depended on the removed browser exception table, two helicopter cases expected
the previous unavailable-path wording, and one saved-route test expected the
old selection shape. The fixtures now carry a real published association,
assert the current unavailable-path message, and assert the migrated selection.
All five reran successfully. Cold offline edition switching and saved-selection
migration also passed. Desktop and phone screenshots were inspected.

## National data

- [Published contracts](published-contracts.json): exact client resource URLs and
  JSON identities, complete terminal coverage, 9,183 single-route associations,
  one explicit parallel-runway choice, 1,956 unmatched approach/visual records,
  and 26 reviewed associations. All 5,292 expected supplement entries are
  available across nine books.
- [Terminal audit](terminal-audit.json): independently recounted 201,076 primary
  source legs and 6,744 continuations, with no export loss, unused SID/STAR
  branches or approaches lacking all entries. Includes 294 choices requiring
  review. The two unresolved source references and intentional manual endings
  remain explicit.
- [Chart audit summary](iap-audit-summary.json): 11,089 instrument chart records,
  9,184 associated charts and 1,905 unmatched charts. Includes 34,214 offered
  chart/entry combinations, 134 with raw diagnostics, and eight chart-level
  occurrences of seven unoffered feeder starts. No diagnostic entry is marked
  complete. KVGT's two approach records and their entry results are included.
  This is automated screening, not plate-by-plate certification.
- [Index benchmark](index-benchmark.json): one-airport first terminal use 4.67 ms
  and 0.61 MiB retained; shared terminal index 0.058 ms. The original review
  measured 141 ms and 16.9 MiB. Single local Node 24 samples exclude JSON loading.
- [History generations](history-generations.json): this cleanup's rebuild kept
  all 161,956 routes from its explicitly selected source snapshot. A separate
  local navigation rebuild subsequently selected a newer snapshot with 163,299
  routes. Its source set adds 1,376 and omits 33 original route strings. Both
  immutable generations remain readable; the cleanup did not merge or overwrite
  the newer source snapshot.

The catalog and navigation builders have separate manifest commit points.
After navigation changes, rerun the procedure builder to associate the new
generation. The client rejects associations against another terminal identity;
the chart audit now fails clearly on this mismatch rather than reporting false
export omissions. This was exercised when the navigation generation changed
during the initial national PDF indexing run. The incremental refresh aligned
the identities without reindexing books.

## Earlier terminal audit

The 20:14 and 20:51 UTC audits on 2026-09-21 have identical source coverage,
counts, summaries and all 294 review records. Only `generatedAt`, the terminal
artifact `sha256`, and `implementation` differ. The later full
[terminal audit](terminal-audit.json) is retained. The earlier report's unique
fields are below; overlaying them on the retained report reconstructs every
parsed JSON value of the earlier run. Both runs use the same CIFP source hash.
This preserves the earlier provenance without a second copy of its findings.

```json
{
  "generatedAt": "2026-09-21T20:14:01.331Z",
  "sha256": "6bd930069374186605e00a41e651782b18ff8ae4c7fbaaba5671b1fb0965722e",
  "implementation": {
    "coded-terminals.ts": "4a80a6d5ac04c345f6562c8caccda348ea625b1458f66263a8538ae53aea2968",
    "approaches.ts": "034b55c2f3a612ccdd530db877f06a4d6cf114b8c8b4fac090513948304578ba",
    "approach-path.ts": "daf7a04aa1bc56cd8cf654c12e280f342c87da2475fb3590b894870fd441f16d",
    "approach-geometry.ts": "05714983a97c22d9b6e9ffd08a7ae020a43f4fc78a80df8e3aba18a7c59f8076",
    "approach-path-geometry.ts": "d1572594da4e87aa40932a8023680c59f7d54c7c9e934b19d39fab8e8a965493",
    "approach-joining.ts": "ab48c16f6fa4b37df8fe7c1a9477fcd231733fc4ca9330fcb624f4dc2716618a"
  }
}
```

## Reproduction

From `faa-regs`, with the existing local FAA sources and books:

```sh
npm run build:nav -- --source-dir=dist/charts/2026-09-03/nasr --cycle=2026-09-03 --route-history-source=dist/route-history/2ff8449e34cad706a3176904ff32f0c66da75d4a9e0b189cd4dcaac6e1e4d7fd.sqlite.zst
npm run build:procedures -- --effective-date=2026-09-03 --source-xml=/path/to/2609-Metafile.xml
npm run build:supplements -- --effective-date=2026-09-03 --source-xml=dist/supplements/afd_03SEP2026.xml
npm run check
npm test
```

The explicit history source above reproduces this cleanup's build. Use the
intended source snapshot when rebuilding an existing installation; do not
replace a newer source merely to reproduce old test counts. Incremental
procedure builds normalize the XML BOM, compare source content rather than
local/remote URL, and refresh associations without repeating PDF indexing.

From `zlayers`:

```sh
npm run check
npm test
npm run build
node --import=tsx tools/verify-publisher-contracts.mjs ../faa-regs
node --import=tsx tools/verify-published-navigation.mjs ../faa-regs/dist/charts 2026-09-03 /tmp/published-contracts.json
node --import=tsx tools/audit-terminal-coverage.mjs ../faa-regs/dist/charts/2026-09-03/nav /tmp/terminal-audit.json
node --import=tsx tools/audit-iap-coverage.mjs ../faa-regs/dist/charts/2026-09-03 /tmp/iap-audit.json '*'
PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH=/run/current-system/sw/bin/google-chrome-stable npm run test:browser -- --output=/tmp/chart-nav-browser test/e2e/route-*.spec.ts test/e2e/coded-terminals.spec.ts test/e2e/offline.spec.ts
```

Detailed chart audit JSON/CSV and browser traces/screenshots were generated under
`/tmp`; the compact summaries and source identities above are retained here.
Raster charts were not rebuilt. Nothing was committed or deployed.
