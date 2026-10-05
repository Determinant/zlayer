# NOTAM structural presentation audit — 2026-10-05

The later [semantic follow-up](2026-10-05-semantic-audit.md) fixes mapped-status
omissions, extends several grammar families and audits value associations. This
earlier report remains the evidence for its original tree and capture.

This is dated evidence for the local working tree based on commit
`a6f346653465d53a37d6242727dd5c4980f49126`, not a production release or proof
of universal operational accuracy. [Machine-readable results](2026-10-05-structural-audit.json)
include per-airport counts, feed state, snapshot digests and presentation source digests.

## Sample and collection limits

The sample contains all 100 leading airports in the FAA's
[CY2025 final passenger-boardings workbook](https://www.faa.gov/airports/planning_capacity/passenger_allcargo_stats/passenger/arp-cy2025-all-enplanements.xlsx),
published September 24, 2026, plus APA, CVH, TEB, SCK, PAO, VNY, SDL and FRG.
The [dated manifest](../../../../test/fixtures/notams-airports-2026-10-05.json)
records ranks and explicit FAA/ICAO identifiers, including Alaska, Hawaii and Puerto
Rico. Rank 51 uses the published DJT/KDJT identifiers; it is not mapped to KPBI.

The capture finished at **2026-10-05 19:02:25 UTC**. All 108 prepared-API reads
succeeded and returned nonempty snapshots, totaling **8,026 distinct retained record
IDs**: 3,587 DOMESTIC, 1,069 FDC, 3,289 INTL and 81 MIL. Distinct IDs are not
necessarily distinct operational events: domestic/international representations
can repeat a notice. The audit includes every retained classification and does not
claim all records are currently effective. The default airport view and plate
matching remain scoped as documented in the owning README; INTL/MIL are exposed
through the airport's Other filter, not added to D/FDC plate counts by this work.

**All captured snapshots reported degraded feed state, incomplete continuity and
`revision-conflict`.** Airport association coverage was complete, but that does not
establish collection completeness. This audit tests retained content and cannot
prove that every active FAA notice reached the cache. The revision-conflict issue
remains a separate backend finding; this presentation change does not fix it or
establish whether its cause is FAA data or server reconciliation.

## Findings and changes

- DFW taxiway restrictions and LAX airport restrictions received the same Closed
  badge as an unrestricted closure. Qualified closures now receive a caution
  Closure Restriction badge with the complete qualification in its source evidence.
  This changes 220 badges in the captured corpus, including cross-format copies.
- RDU mixed LNAV/VNAV and LNAV minima now become separately scoped sections. BWI
  unavailable LPV/LNAV-VNAV minima display Not authorized. SEA's explicitly labeled
  DA/RVR/HAT triplet retains all three field assignments and category scope.
- ABQ and PDX takeoff options retain either ordering and independent climb
  requirements. HNL runway shorthand stays exactly as published. CHS obstacle
  references remain attached. Neither omitted units nor a preceding runway's
  heading is borrowed.
- LIH declared distances use the same metric typography as approach minima, with
  independent TORA/TODA/ASDA/LDA labels and feet. No missing distances are supplied.
- RSW inoperative-note edits, ONT planview notes and MSY obstacle notes retain their
  full instructions under consistent labels. Numeric flairs and structured minima
  do not promote values from deleted, replaced or conditional notes into standalone
  operative-looking values.

| Measure | Before this audit's changes | After |
| --- | ---: | ---: |
| Notices containing structured numerical values | 882 | 999 |
| Takeoff clauses | 12 | 102 |
| Standalone minima blocks | 1,571 | 1,599 |
| Compound minima groups | 0 | 8 |
| Declared-distance blocks | 0 | 13 |
| Instruction blocks | 567 | 648 |
| Prose blocks | 10,911 | 10,691 |

There are 17,138 top-level reading blocks after the change, including 1,760 context
blocks and 2,317 headings. Compound minima groups contain their own child sections.
**5,973 notices remain entirely prose.** Most concern taxiways, obstacles, facilities
or other subjects outside the numerical grammar. Source preservation is not counted
as full structural parsing.

## What was verified

1. Every snapshot passed the delivery contract. Every record was audited for source
   immutability, ordered source spans, uncovered clauses, numerical and lexical
   preservation, and valid badge/target evidence offsets. Only a recognized local
   identity header and an exactly matching validity footer can be omitted from the
   main body; the raw source remains available.
2. Numerical and lexical checks operate independently of extraction, with explicit
   display aliases and grammar normalizations. They compare multisets, so they do
   **not** prove associations or applicability. Golden expectations separately
   check runway, field, category, alternative and note-action associations.
3. The shared React reader was rendered for all 8,026 records; its displayed content
   was compared with the reading model without including the raw disclosure or
   metadata. **Zero preservation or rendering issues remained.**
4. Twenty-four complete captured examples from 21 airports are retained in
   [the regression corpus](../../../../test/fixtures/notams-corpus.json), with
   manually specified expectations plus deliberately corrupted output and adversarial
   grammar cases. These are representative semantic checks, not an exhaustive
   manual review of every notice.
5. Fifty-four focused Node tests and `npm run check` passed. All 20 NOTAM browser
   scenarios passed across targeted runs after correcting test fixture transport
   metadata and a duplicate locator. New structure cases cover 320, 393 and 1440 px,
   both themes, increased text spacing, search and exact raw text; existing cases
   cover both airport and plate hosts. Representative screenshots were visually
   inspected for alignment, wrapping and hierarchy.
6. The repeatable capture command was smoke-tested against one prepared ATL API
   response (103 records). Full verification was not run, as requested.

Browser artifacts are local under `test-results/notam-corpus`,
`test-results/notam-corpus-fixed` and `test-results/notam-corpus-flairs`.
The complete snapshots and fallback inventory are local under
`/tmp/zlayer-notam-top100-20261005`; they are not committed operational data.
See the [owning guide](../README.md#broad-airport-presentation-audit) for repeatable
capture/audit commands. Future captures must be reviewed again; this result is not
an assertion about subsequent feed generations.

## Explicit remaining fallbacks

- IAD circling clauses omit the altitude type for one category. The reader does not
  infer MDA from an adjacent category. Other IAD clauses omit the RNP scope label.
- EWR radio-altitude/slash shorthand is retained verbatim apart from prose casing.
- ONT clauses combine altitude and visibility without the supported delimiter and
  place RVR after the value; the entire clause remains visible as prose.
- Aircraft-specific JETS/PROPS rules, staged climb gradients, missing gradient units,
  and APA's `300-1 OR DEPARTURE NA` alternative remain complete prose.
- MIA multipart notices include misspelled headings and continuations inside words
  and clauses. Part markers and every continuation stay visible; nothing is silently
  repaired, joined into an invented procedure, or dropped.
- Following a note edit or condition, later numbers remain prose because sentence
  punctuation does not establish the end of the quoted/conditional scope. This can
  sacrifice structure, and must not be relaxed without evidence for scope boundaries.

The next useful grammar increments are explicit aircraft-type takeoff branches,
staged climbs and published alternate visibility ordering, each with whole-clause
acceptance and independently reviewed examples. Resolving collection continuity
is necessary before using this sample as evidence of complete upstream coverage.

## Airport coverage

The table counts retained IDs. “Value clauses” counts top-level minima, compound
minima groups, takeoff and declared-distance blocks; it is not a notice-completeness
percentage. All rows passed the automated preservation and rendered-content audit.

| FAA rank | FAA / ICAO | Retained IDs | Value clauses |
| ---: | --- | ---: | ---: |
| 1 | ATL / KATL | 103 | 26 |
| 2 | DFW / KDFW | 192 | 80 |
| 3 | ORD / KORD | 119 | 14 |
| 4 | DEN / KDEN | 122 | 22 |
| 5 | LAX / KLAX | 155 | 63 |
| 6 | JFK / KJFK | 241 | 28 |
| 7 | MCO / KMCO | 84 | 8 |
| 8 | LAS / KLAS | 67 | 10 |
| 9 | MIA / KMIA | 193 | 34 |
| 10 | SFO / KSFO | 246 | 18 |
| 11 | CLT / KCLT | 103 | 12 |
| 12 | SEA / KSEA | 101 | 13 |
| 13 | PHX / KPHX | 119 | 14 |
| 14 | EWR / KEWR | 115 | 42 |
| 15 | IAH / KIAH | 120 | 58 |
| 16 | BOS / KBOS | 91 | 0 |
| 17 | MSP / KMSP | 162 | 2 |
| 18 | DTW / KDTW | 122 | 14 |
| 19 | LGA / KLGA | 123 | 20 |
| 20 | FLL / KFLL | 97 | 25 |
| 21 | PHL / KPHL | 140 | 14 |
| 22 | IAD / KIAD | 152 | 128 |
| 23 | SLC / KSLC | 119 | 10 |
| 24 | SAN / KSAN | 61 | 26 |
| 25 | BNA / KBNA | 121 | 32 |
| 26 | BWI / KBWI | 73 | 10 |
| 27 | TPA / KTPA | 89 | 10 |
| 28 | DCA / KDCA | 116 | 0 |
| 29 | AUS / KAUS | 64 | 18 |
| 30 | HNL / PHNL | 194 | 16 |
| 31 | MDW / KMDW | 41 | 0 |
| 32 | PDX / KPDX | 59 | 23 |
| 33 | DAL / KDAL | 52 | 12 |
| 34 | RDU / KRDU | 54 | 2 |
| 35 | STL / KSTL | 118 | 12 |
| 36 | SMF / KSMF | 36 | 42 |
| 37 | HOU / KHOU | 122 | 20 |
| 38 | SJU / TJSJ | 65 | 8 |
| 39 | MSY / KMSY | 88 | 50 |
| 40 | MCI / KMCI | 68 | 60 |
| 41 | SNA / KSNA | 32 | 0 |
| 42 | RSW / KRSW | 96 | 20 |
| 43 | SJC / KSJC | 66 | 36 |
| 44 | SAT / KSAT | 36 | 33 |
| 45 | IND / KIND | 54 | 28 |
| 46 | CLE / KCLE | 75 | 0 |
| 47 | PIT / KPIT | 89 | 24 |
| 48 | OAK / KOAK | 64 | 10 |
| 49 | CMH / KCMH | 80 | 30 |
| 50 | CVG / KCVG | 73 | 6 |
| 51 | DJT / KDJT | 76 | 6 |
| 52 | JAX / KJAX | 70 | 24 |
| 53 | ONT / KONT | 70 | 14 |
| 54 | OGG / PHOG | 15 | 2 |
| 55 | BDL / KBDL | 32 | 6 |
| 56 | BUR / KBUR | 42 | 6 |
| 57 | CHS / KCHS | 89 | 66 |
| 58 | MKE / KMKE | 65 | 4 |
| 59 | ANC / PANC | 79 | 12 |
| 60 | BOI / KBOI | 81 | 24 |
| 61 | OMA / KOMA | 77 | 18 |
| 62 | ABQ / KABQ | 60 | 14 |
| 63 | BUF / KBUF | 26 | 4 |
| 64 | RIC / KRIC | 56 | 4 |
| 65 | ORF / KORF | 56 | 30 |
| 66 | RNO / KRNO | 40 | 0 |
| 67 | MEM / KMEM | 77 | 16 |
| 68 | OKC / KOKC | 25 | 2 |
| 69 | SRQ / KSRQ | 33 | 4 |
| 70 | SDF / KSDF | 131 | 0 |
| 71 | GRR / KGRR | 48 | 30 |
| 72 | PVD / KPVD | 69 | 4 |
| 73 | GEG / KGEG | 72 | 8 |
| 74 | SAV / KSAV | 46 | 6 |
| 75 | KOA / PHKO | 10 | 0 |
| 76 | ELP / KELP | 62 | 8 |
| 77 | TUS / KTUS | 29 | 10 |
| 78 | LGB / KLGB | 29 | 0 |
| 79 | LIH / PHLI | 31 | 10 |
| 80 | TYS / KTYS | 85 | 22 |
| 81 | MYR / KMYR | 57 | 0 |
| 82 | PSP / KPSP | 26 | 4 |
| 83 | BHM / KBHM | 139 | 0 |
| 84 | TUL / KTUL | 32 | 16 |
| 85 | DSM / KDSM | 35 | 14 |
| 86 | ALB / KALB | 44 | 6 |
| 87 | SFB / KSFB | 34 | 2 |
| 88 | PNS / KPNS | 97 | 14 |
| 89 | GSP / KGSP | 26 | 0 |
| 90 | SYR / KSYR | 64 | 16 |
| 91 | BZN / KBZN | 59 | 14 |
| 92 | PIE / KPIE | 51 | 0 |
| 93 | FAT / KFAT | 53 | 0 |
| 94 | ROC / KROC | 9 | 0 |
| 95 | PWM / KPWM | 23 | 2 |
| 96 | XNA / KXNA | 27 | 16 |
| 97 | COS / KCOS | 51 | 14 |
| 98 | MSN / KMSN | 43 | 12 |
| 99 | VPS / KVPS | 21 | 0 |
| 100 | HPN / KHPN | 56 | 0 |
| GA | APA / KAPA | 53 | 14 |
| GA | CVH / KCVH | 1 | 2 |
| GA | TEB / KTEB | 64 | 6 |
| GA | SCK / KSCK | 27 | 16 |
| GA | PAO / KPAO | 9 | 2 |
| GA | VNY / KVNY | 26 | 2 |
| GA | SDL / KSDL | 6 | 3 |
| GA | FRG / KFRG | 40 | 10 |
