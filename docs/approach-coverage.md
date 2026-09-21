# Approach coverage and validation

The broader coded terminal audit is documented in
[terminal procedures](terminal-procedures.md#national-verification-faa-2609-effective-2026-09-03).
It includes all coded approaches independently of plate-title matching, plus
SID/STAR choices, continuations and source integrity. The chart-based counts
below describe their original review scope; they are not totals for that newer
coded-procedure audit.

Coverage has three separate dimensions: a chart can be available without an
unambiguous coded route; a matched route can omit an entry; and an offered entry
can contain fixed geometry, declared schematics or unresolved connections.
A connected drawing alone does not establish correctness. The
[geometry design](approach-geometry-plan.md) defines those outcomes, while
[routes](routes.md#anchored-approaches) describes their user-facing behavior.

## Recorded FAA 2609 results

The latest local audit was recorded on **2026-09-20**, using FAA cycle **2609**,
effective **2026-09-03 through 2026-10-01**, and the rebuilt schema-2 navigation
export. Matching and heliport-export improvements recovered 163 U.S. chart records,
including 47 additional distinct coded routes. U.S. all-chart coverage rose from
81.23% to 82.69%. All 9,018 previously matched full-catalog charts retained the
same offered entries and geometry diagnostics.

| Scope | Instrument chart records | Matched charts | Unmatched charts | Offered chart/entry combinations | Entries with raw diagnostics |
| --- | ---: | ---: | ---: | ---: | ---: |
| California | 597 | 448 | 149 | 1,676 | 0 |
| Arizona | 147 | 112 | 35 | 403 | 0 |
| U.S. 50 states/DC | 10,980 | 9,126 | 1,854 | 33,854 | 134 |
| Full FAA catalog | 11,089 | 9,184 | 1,905 | 34,155 | 134 |

Instrument totals exclude visual charts. Catalog records include SA CAT I
supplements and continuation pages that can share a coded route; they are not
counts of distinct procedures. There are 9,010 distinct selectable U.S. coded
routes and 9,068 in the full FAA catalog. Entry totals count each chart's choices.
The full catalog includes territories and foreign Pacific locations.

After the reporting exceptions below, U.S. coverage is **9,079/10,980 charts
(82.69%)** and **33,722/33,854 offered entries (99.61%)**, with **132 unresolved
entries on 47 charts**. Full-catalog coverage is 9,137/11,089 charts (82.40%) and
34,023/34,155 entries (99.61%). Every offered entry must pass for a chart to count.
These dated results do not verify a hosted deployment, another edition or an older
pinned offline copy. Generated national reports and comparison ledgers belong in
ignored `tmp/`, not in `docs/reviews`.

### Reporting exceptions

- **KRFD ILS/LOC 07 and its SA CAT I supplement:** the coded ending calls for
  radar vectors. The [SA CAT I plate](https://aeronav.faa.gov/d-tpp/2609/00954I7SAC1.PDF)
  confirms the intentional open end. Eight entries across two charts are accepted
  as expected radar discontinuities without removing their raw diagnostics.
- **PABT VOR 02:** CIFP `S::030` ends at BTT with rho zero, while the
  [plate](https://aeronav.faa.gov/d-tpp/2609/01501V2.PDF) puts the MAP at BTT 1.3 DME.
  The renderer preserves coded coordinates; all six entries require source review
  and remain excluded from coverage even though the drawing is connected.

The raw 134 diagnostic entries minus eight expected radar endings plus six PABT
source-review cases yield 132 unresolved entries. The matching changes exposed
nine additional warnings on already available routes: KDEN SA CAT I 35R (five),
KGEG SA CAT I 03 (one), and KOKC SA CAT I 35R (three). Their warnings remain visible.

The earlier [retained evidence](evidence/approaches/2026-09-20/README.md) contains
California policy-1 and Arizona/national policy-2 artifacts and selected geometry
panels. Those historical snapshots do not represent the latest matching results.

## Coverage work still open

| Primary unmatched-chart evidence | U.S. records | Full FAA records |
| --- | ---: | ---: |
| No raw PF/HF approach records for the airport | 970 | 998 |
| Listed in the edition's FAA omission workbook | 435 | 458 |
| Category/PRM/GLS/converging family outside published CIFP scope | 304 | 304 |
| HI, TACAN or helicopter family without a verified association | 140 | 140 |
| Other chart with no exact source record | 5 | 5 |
| **Total** | **1,854** | **1,905** |

After checking available associations, the audit classifies scope exclusions,
FAA-listed omissions, airports without records, special families, and remaining
exact-ID misses, in that order. These primary categories are disjoint, although
the underlying reasons can overlap. A missing exact identifier alone does not
prove that FAA deliberately excluded a chart. Workbook aliases are diagnostic
evidence only and never authorize route substitution.

- **Source availability:** the five unlisted misses are KMFE VOR 14 and 32,
  KPCM VOR 28, KSHR VOR 15, and PAEM VOR 16. Their airports have other coded
  approaches but no corresponding VOR procedure. Arizona's KDMA/KLGF/KNYL misses
  still have no PF/HF approaches in this cycle. The 140 special-family cases
  require source/plate work; they are not all proven permanently impossible.
- **Edition-specific associations:** the reviewed exceptions below expire after
  the 2026-09-03 edition and require renewed evidence before carrying forward.
  They now live in the publisher’s dated association data, pinned to the reviewed
  CIFP/XML source hashes; the browser consumes the resulting TPP catalog records.
  Do not strip variants or substitute a fixed-wing procedure for a helicopter
  chart based only on the runway.
- **Unoffered feeder starts:** KDAF R36/CMY, KDXE R18/GENTE and R36/GADLE,
  KERI I24/JONLI, KGSP I04/OXABY and I22/RAYCE, and PASM L17/SAWNY remain.
  KGSP's SA CAT I 04 chart repeats OXABY, giving eight chart-level occurrences
  of seven distinct starts. Offered-entry coverage does not cover these starts.
- **Geometry diagnostics:** review missing references, forward-intercept failures,
  inconsistent constraints, unsupported legs and geometry warnings against their
  source branches and plates. Categories overlap and cannot be summed into an
  entry total. Intentional manual/vector endings remain explicit open ends.

## Reviewed associations

The publisher generates edition-specific chart associations and preserves chart
names, qualifications, variants and exact route IDs. Standard title handling
supports conventional combined titles, continuation pages, SA CAT I and helicopter
approaches named by three-digit course. The publisher exports HA variation,
airport-scoped HC fixes and HF approaches, restoring 87N R190 and KJRA R210.

Shared parallel-runway charts require both complete source routes. Identical
transitions, final/missed legs and altitude constraints can share one route
(KJFK 13L/R and KLAS 26L/R). Different routes require a runway selection; KBJC
30L/R retains the selected runway and its exact route through save/reload.

The following 26 exceptions are restricted to **2026-09-03**. Plate references,
courses, turns and missed altitude constraints were checked against the source;
matching a runway number alone was insufficient. Their FAA-derived records and
regression cases remain in
[the domain matching fixture](../packages/domain/test/fixtures/approach-matching.json)
and [tests](../packages/domain/test/approach-matching.test.ts).

| Airport | Chart | CIFP route | FAF / MAP / missed hold |
| --- | --- | --- | --- |
| K50 | [RNAV (GPS)-A](https://aeronav.faa.gov/d-tpp/2609/11772RA.PDF) | `K50:RNVA` | REPPO / RW35 / BAHMM |
| KAST | [COPTER LOC RWY 26](https://aeronav.faa.gov/d-tpp/2609/00024COPTERL26.PDF) | `KAST:L26` | UWYUK / RW26 / AST |
| KDFW | [ILS V RWY 13R (CONVERGING)](https://aeronav.faa.gov/d-tpp/2609/06039IV13RCON.PDF) | `KDFW:I13RV` | HODAX / RW13R / SLOTT |
| KEWR | [COPTER ILS Y OR LOC Y RWY 04L](https://aeronav.faa.gov/d-tpp/2609/00285COPTERIYLY4L.PDF) | `KEWR:I04LY` | RODII / RW04L / FLYRS |
| KHUM | [COPTER VOR RWY 12](https://aeronav.faa.gov/d-tpp/2609/05037COPTERV12.PDF) | `KHUM:S12` | SEYVO / RW12 / BOURG |
| KMKT | [COPTER ILS Z OR LOC Z RWY 33](https://aeronav.faa.gov/d-tpp/2609/05755COPTERIZLZ33.PDF) | `KMKT:I33-Z` | RATEL / RW33 / ANIMY |
| KMSP | [ILS RWY 35 (SA CAT I)](https://aeronav.faa.gov/d-tpp/2609/00264I35SAC1.PDF) | `KMSP:I35-Z` | LORAH / RW35 / LYDIA |
| KMSP | [ILS V RWY 35 (CONVERGING)](https://aeronav.faa.gov/d-tpp/2609/00264IV35CON.PDF) | `KMSP:I35-V` | LORAH / RW35 / LYDIA |
| KNOW | [COPTER RNAV (GPS) RWY 26](https://aeronav.faa.gov/d-tpp/2609/00653COPTERR26.PDF) | `KNOW:R26` | GOLTE / RW26 / KACNE |
| KOTH | [COPTER ILS Y OR LOC Y RWY 05](https://aeronav.faa.gov/d-tpp/2609/00929COPTERIYLY5.PDF) | `KOTH:I05-Y` | EMIRE / RW05 / YICBU |
| KPHL | [ILS V RWY 09R (CONVERGING)](https://aeronav.faa.gov/d-tpp/2609/00320IV9RCON.PDF) | `KPHL:I09RV` | KELEE / RW09R / OOD |
| KPHL | [ILS V RWY 17 (CONVERGING)](https://aeronav.faa.gov/d-tpp/2609/00320IV17CON.PDF) | `KPHL:I17-V` | HYILL / RW17 / ARD |
| KPMD | [VOR OR TACAN Z RWY 25](https://aeronav.faa.gov/d-tpp/2609/00310VTZ25.PDF) | `KPMD:S25` | THERO / EKOTY / PMD |
| KPNS | [VOR RWY 08](https://aeronav.faa.gov/d-tpp/2609/00318V8.PDF) | `KPNS:V08` | NUN / RW08 / NUN |
| KRST | [COPTER ILS Y OR LOC Y RWY 31](https://aeronav.faa.gov/d-tpp/2609/05041COPTERIYLY31.PDF) | `KRST:I31-Y` | MINGO / RW31 / RST |
| KSBD | [ILS OR LOC Z RWY 06](https://aeronav.faa.gov/d-tpp/2609/00547ILZ6.PDF) | `KSBD:I06` | PETIS / RW06 / PDZ |
| KSLE | [ILS OR LOC Z RWY 31](https://aeronav.faa.gov/d-tpp/2609/00361ILZ31.PDF) | `KSLE:I31` | LOTKE / RW31 / ARTTY |
| KSMX | [VOR RWY 12](https://aeronav.faa.gov/d-tpp/2609/00379V12.PDF) | `KSMX:V12` | GLJ / RW12 / MQO |
| KTBN | [VOR RWY 33](https://aeronav.faa.gov/d-tpp/2609/05093V33.PDF) | `KTBN:V33` | HAUKE / WOVNU / REBBS |
| KTEB | [COPTER ILS Y OR LOC Y RWY 06](https://aeronav.faa.gov/d-tpp/2609/00890COPTERIYLY6.PDF) | `KTEB:I06-Y` | TORBY / RW06 / UBUCK |
| KWAY | [COPTER RNAV (GPS) Y RWY 09](https://aeronav.faa.gov/d-tpp/2609/10357COPTERRY9.PDF) | `KWAY:R09-Y` | ULUFY / RW09 / TIKKU |
| PASD | [NDB RWY 32](https://aeronav.faa.gov/d-tpp/2609/06537N32.PDF) | `PASD:Q32` | JOTOK / RW32 / HBT |
| PGSN | [NDB Z RWY 07](https://aeronav.faa.gov/d-tpp/2609/06293NZ7.PDF) | `PGSN:Q07-Z` | SHAKA / SN / SHAKA |
| PGUM | [NDB RWY 24R](https://aeronav.faa.gov/d-tpp/2609/02146N24R.PDF) | `PGUM:Q24R` | MOGOE / NOVKE / ADAYI |
| PTKK | [NDB RWY 22](https://aeronav.faa.gov/d-tpp/2609/02655N22.PDF) | `PTKK:Q22` | ZELIB / WIROS / DAMAY |
| W99 | [COPTER RNAV (GPS) X RWY 31](https://aeronav.faa.gov/d-tpp/2609/06500COPTERRX31.PDF) | `W99:R31-X` | CAPIV / RW31 / ESL |

SA CAT I supplies the Category I route depiction while retaining the chart's
qualification. CAT II/III, mixed SA CAT I–II, PRM, GLS and general converging-title
substitutions remain unsupported. The four reviewed converging exceptions have
their own V-variant source records that agree with the plates.

Rejected helicopter substitutions include KHGR RNAV 09/27 (fixed-wing identifier
collisions), KFCM ILS 10R and KGYY ILS 30 (different initial fixes and missed
altitudes), KACY ILS 13, KINL ILS 31 and KLGA ILS 13/22 (different initial fixes),
and KEWR ILS/DME 22L (different initial/final fixes and missed instructions).
Available low-altitude routes likewise do not establish complete HI approaches.

## Geometry lessons retained in the implementation

| Case | Constraint and evidence to preserve |
| --- | --- |
| KWLW VOR 34 | ILA's 18° station alignment differs from airport variation of 14°. Preserve the source reference before checking the right-turn/intercept shape. The previous two suspect entries were marked complete, demonstrating why independent geometry checks matter. |
| KLAX 25L/25R and KTOA 29R; KVNY ILS Z 16R | Terminate at the referenced radial or VNY 1.5 DME before following the next instruction. Missing-reference mutations must produce an explained gap. DME plan-view approximations remain schematic. |
| KCMA VOR 26; KCEC VOR/DME 12 | Carry successive CA → FA → DF endpoints; returning to the starting navaid must not erase the climb/return maneuver. |
| KAPC, KAVX and KPOC procedure turns | Preserve coded orientation, turn side, extent and inbound return. A representative reversal is not an exact flight track. |
| KRDD ILS/LOC 35, RBL feeder | Advance FC by 7.9 NM; its endpoint lies about 0.022 NM from DIBLE and fits the half-unit source-precision tolerance. Do not add the following CF's 2.0 NM as a universal rule. |
| KOAK ILS/LOC 28R; KMOD ILS/LOC 28R | Bounded representative climb and direct-return geometry replace unconstrained curves. KOAK's 9 NM drawing length is not aircraft climb performance. Only justified return crossings receive an exception. |
| KAWO LOC 34, KGLH ILS/LOC 18L and KDEN ILS/LOC 16L | Join only to the inbound phase, preserve intermediate fixes and the FAF, and follow only a unique onward feeder. Procedure-turn joins use shared references and bounded courses. Separate ILS DME antennas require exact airport/region/identifier matches; ambiguous references remain gaps. |
| O69, KAPC REBAS, KSTS, KMCE, KLGB RNP, KSNS and KNUQ | Preserve feeder/entry choices, fixed arcs, surveyed FC endpoints, intercepts, landing/missed roles, distance/terrain exclusions and persistence. Fixtures retain the FAA-derived cases. |

The historical review inspected 16 California baseline plates, then Oakland and
Modesto, plus the KIWA plate for the later refinement. Generated geometry for 16
procedures was inspected in the retained panels. This was targeted source review
and automated screening, not manual validation of every chart or its restrictions.

### KIWA missed return and partial rendering

The seven KIWA ILS/LOC 30C entries share one missed branch: CA at 302.6° magnetic
to at least 2,800 ft, right VI at 145° to intercept, CF inbound to IWA at 195° and
at least 5,000 ft, then a right one-minute hold. IWA's 13° station declination is
available. Policy 2 permits one final inbound straight crossing the initial
straight climb when station, direction and increasing altitude conditions are
unambiguous. Crossings in turns or additional segment pairs still require review.
The bounded retry chooses a representative 0.75 NM climb for this source case.
The [FAA plate](https://aeronav.faa.gov/d-tpp/2609/00074IL30C.PDF) supports the branch;
no airport-specific production override or source-data patch was added.

The span retains `climb-return`, `altitude-dependent`, `turn-radius` and
`no-wind-heading` assumptions. Source altitude conditions do not establish a
vertical trajectory, climb performance or altitude separation at the crossing.
The audit independently checks source conditions and the crossing course; a return
annotation alone cannot exempt arbitrary crossings.

If the intercept heading is missing, the connection stays unresolved while known
IWA coordinates and holding data remain visible, including after reload. Arrival
course stays unknown (**ENTRY ?**), the explanation remains in the picker/summary,
and no artificial line, distance or terrain corridor bridges the gap. A known
holding fix does not establish the path needed to reach it.

## Audit method and reproduction

Use Node/tsx dependencies and Python 3's standard library with a complete matching
cycle directory. The audit requires `tpp/catalog.json`,
`nav/terminal-procedures.json`, `nasr/FAACIFP18`, and the matching CIFP ZIP containing
the FAA excluded-procedure workbook. It validates source editions before scanning.

```sh
node --import=tsx tools/audit-iap-coverage.mjs tmp/iap-matching-cycle-2609 tmp/ca-iap.json CA
node --import=tsx tools/audit-iap-coverage.mjs tmp/iap-matching-cycle-2609 tmp/az-iap.json AZ
node --import=tsx tools/audit-iap-coverage.mjs tmp/iap-matching-cycle-2609 tmp/us-iap.json '*'
```

The example directory contains the rebuilt approach export and links to the
original cycle's catalog and NASR inputs. Rebuild with the current
`faa-regs/lib/approach-routes.ts` before measuring changes that require new fields.
Each command writes detailed JSON and a companion chart CSV, including source and
implementation hashes. Keep generated scans, plate downloads, comparison ledgers
and dated working reports in ignored `tmp/` or outside the repository.

With a saved baseline for the same FAA 2609 catalog, compare matching changes using:

```sh
node --import=tsx tools/summarize-iap-matching.mjs \
  tmp/iap-before.json tmp/us-iap.json tmp/iap-comparison
```

The comparison verifies that previously matched entries and diagnostics are
unchanged and applies the recorded KRFD/PABT reporting exceptions. Other editions
require renewed source review. Keep durable conclusions here and source cases in
regression fixtures; do not write generated output back into `docs/reviews`.

Screen every nondeleted catalog approach and every offered branch, including the
missed phase. Reconcile raw/exported IDs, entries and unoffered starts independently
of interpreter success. Geometry checks include finite coordinates, source-specific
CF course discrepancies over 15°, non-hold crossings, bends over 90°, and excessive
extent (normally length over twice endpoint distance plus 3 NM, with declared
maneuver exceptions). Incomplete entries without a classified cause are flagged.
Smaller datum errors, hold semantics, source omissions and operational restrictions
can escape these checks; holds are excluded from ordinary crossing screening.

The latest recorded validation passed 178 domain/approach/direct-to tests,
19 publisher tests, both repositories' type checks, the production build, and
20 browser cases at 320/1280 px through preview, save and reload. The browser cases
include rejected helicopter collisions and explicit parallel-runway selection.
Those dated results do not replace the current
[full verification gate](local-development.md#verification). Run per-cycle
inventories and inspect new or changed failures against source plates.

Sources: [FAA dTPP](https://www.faa.gov/air_traffic/flight_info/aeronav/digital_products/dtpp/),
[2609 catalog XML](https://aeronav.faa.gov/d-tpp/2609/xml_data/d-tpp_Metafile.xml),
[CIFP archive](https://aeronav.faa.gov/Upload_313-d/cifp/CIFP_260903.zip), and
[Instrument Procedures Handbook, chapter 6](https://www.faa.gov/sites/faa.gov/files/regulations_policies/handbooks_manuals/aviation/instrument_procedures_handbook/FAA-H-8083-16B_Chapter_6.pdf).

## Publication and saved editions

The recorded rebuild updated schema-2 references with navigation manifest revision
`2026-09-21T03:58:40.748Z`. Those audit records described local changes, not a hosted
publication. Release work must coordinate the supporting client, data and manifest;
publish data before the manifest and verify the deployed edition separately.
Pinned offline copies use explicit Verify/update. Loading a new client cannot
recover fields absent from old saved exports. Follow the
[same-cycle rebuild contract](chart-feed.md#navigation-rebuilds-within-a-cycle).
