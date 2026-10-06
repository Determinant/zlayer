# NOTAM plate matching review — 2026-10-05

The 1,000-airport preservation tests do not establish complete plate matching.
Replaying the frozen corpus against the published cycle 2610 catalog found false
amendment warnings, unsupported plate families, and headings that parse successfully
but never match a plate. These are **open findings**, after the local SAT/SA and
category-spelling changes (parser 10, matcher 6). This review adds an offline
inventory and evidence; it does not fix or deploy the findings below.

Follow-up: [parser 11 / matcher 7 implementation and validation](2026-10-05-matching-fixes.md)
addresses these findings and corrects the broad ODP family grouping below.
This report and its JSON retain the original baseline results.

## Inputs and method

- Corpus: `test/fixtures/notams-us1000/`, captured October 6,
  01:30:54–01:34:52 UTC (October 5 Pacific); 1,000 airports, 19,469 records.
  Uncompressed SHA-256:
  `1f38af3b279ac4f5dc34a8912b7c61740995dd86f8069809a9f97d5a3db6a4ad`.
- Published [catalog manifest](https://zlayer.tedyin.com/chart-data/2026-10-01/tpp/manifest.json)
  and [catalog](https://zlayer.tedyin.com/chart-data/2026-10-01/tpp/catalog.a580e518ba734e9c09152d557e7ac59b5bb2189334a8f3843680fffe7d522ee2.json):
  3,197 airports, 24,075 entries, cycle 2610, October 1–29, 2026.
  Downloaded bytes and SHA-256 match the manifest: 16,471,924 bytes,
  `a580e518ba734e9c09152d557e7ac59b5bb2189334a8f3843680fffe7d522ee2`.
  Its source is the [FAA cycle metadata](https://aeronav.faa.gov/d-tpp/2610/xml_data/d-tpp_Metafile.xml).
- Evaluate the actual `procedureNoticeContext` and `matchPlateNotams` for each
  nondeleted catalog entry at each corpus airport. Resolve airport identity only
  from exact FAA/ICAO fields. Separately check **every parsed heading** against
  the matcher's title aliases and procedure kind, rather than accepting one
  matching heading as coverage for the whole notice.
- Retained D/FDC scope contains 13,666 records. INTL/MIL remain outside the
  application's matching scope. No effective-time filter is applied: this is a
  fixed-corpus compatibility inventory, not a count of today's active notices.
  The matcher's cancellation and airport-association rules still apply.
- The corpus's 12 historical source conflicts remain separate; this replay does
  not resolve them or establish collection completeness. Eighteen corpus airports
  have no catalog entry; that alone is not a defect.

[Machine-readable results](2026-10-05-matching-audit.json) retain hashes, versions,
counts, all unmatched heading identities, amendment-review record IDs, and source
text for subject/heading issues. The audit does not manually certify every positive
match, verify every PDF, or qualify the PDF viewer's combined-volume page context.
Four representative FAA PDFs were downloaded, rendered and inspected below.

## Observed matching

These are notice-level outcomes. “Applies” means at least one plate received that
outcome; another target in that notice may still be missing. “Review only” means
there were matches, but all requested review. Counts are not an accuracy score.

| Parsed subject | Notices | At least one applies | Review only | No match |
| --- | ---: | ---: | ---: | ---: |
| IAP | 1,903 | 1,549 | 336 | 18 |
| ODP | 354 | 0 | 203 | 151 |
| SID | 490 | 488 | 0 | 2 |
| STAR | 47 | 45 | 1 | 1 |
| Total | 2,794 | 2,082 | 540 | 172 |

Of 3,309 recognized IAP/SID/STAR headings, **37 across 32 notices have no matching
catalog title of the expected kind**. Fourteen of these headings belong to ten
notices where another heading matches. An airport/notice-level success assertion
would miss those fourteen failures. Some of the 37 reflect a genuinely absent or
different published procedure, not a missing alias.

## Confirmed implementation gaps

### Original amendments use two equivalent spellings

**354 notices at 222 airports** encounter amendment review solely for a matched
target's `ORIG`/`ORIG-A`/etc. versus catalog `0`/`0A`/etc. Among those notices, 298
have no `applies` match at all. The current matcher compares literal amendment
strings after removing an optional `AMDT` prefix.

For example, ORD FDC ending **9281** names `RNAV (GPS) Y RWY 10R, ORIG-B`.
The catalog identifies amendment `0B`, dated April 22, 2021. The
[actual FAA plate](https://aeronav.faa.gov/d-tpp/2610/00166RY10R.PDF) prints
`Orig-B 22APR21`. This warning reflects representation, not a different edition.
There are **43 other notices** with different or unavailable amendments; those
must remain distinct from this correction. Preserve the original amendment text
and letter when normalizing a comparison key.

### Takeoff, DVA and radar pages are excluded from matching context

`procedureNoticeContext` recognizes only approach, departure and arrival kinds.
The matcher also maps every ODP to `departure` and every IAP to `approach`.

| Family in the corpus | Notices | Airport has the corresponding catalog kind | Current consequence |
| --- | ---: | ---: | --- |
| Generic takeoff minimums / obstacle departures | 349 | 348 | No named target; “Affected Procedures Unclear”; generic review on SID plates where available |
| Diverse vector area | 5 | 5 | Title parses, but no DVA plate match |
| Radar minimums (`RADAR-1` / `RADAR 1`) | 11 | 11 | Title parses, but no radar-minimums plate match |

The five DVA records are PHX **2620**, APA **5644**, ABQ **9587**, EMT **5688** and
SBA **1529**. Radar records are TUL **2375**, DLH **1009**, MOB **1614**, PSM **1100**,
HUF **3934**, PWA **9565**, RFD **7398**, EVV **3790**, PWG **1925**, CYS **524** and
LCH **521**. Exact source IDs are in the JSON/corpus; displayed number suffixes
here are only navigation aids.

This needs first-class plate-kind and airport/page handling, not an alias from
all ODPs to all SIDs. Takeoff/DVA/radar pages may contain multiple airports and
often lack catalog amendment metadata. Merely admitting the kinds would neither
establish a unique airport for a shared PDF page nor verify its amendment.
Four additional ODP bodies are currently hidden behind multipart subject failure
and are counted separately below.

### PRM titles differ between catalog and printed plate

ATL **5012** has five parsed headings. Its two ordinary ILS headings match;
all **three PRM headings** fail because they include `(CLOSE PARALLEL)` and the
catalog omits that phrase. This affects ordinary, SA CAT I and CAT II/III PRM
versions, all amendment 5. The
[FAA ILS PRM RWY 10 PDF](https://aeronav.faa.gov/d-tpp/2610/00026IPRM10.PDF)
actually prints `ILS PRM RWY 10 (CLOSE PARALLEL)`, amendment 5, confirming the
catalog-title omission. Any alias must retain PRM, runway and category identity;
it must not merge a PRM plate into an ordinary ILS plate.

### A category-specific notice can address a combined-category plate

HRL **7926** names separate `ILS RWY 18R (SA CAT I)` and `(SA CAT II)` headings.
HRL **9028** does the same for runway 36L. The catalog publishes each as one
`SA CAT I - II` plate. All **four headings** miss because exact category-set
equality is required. The ordinary ILS/LOC heading in each notice still matches,
masking the gap at notice level.

The [FAA runway 18R plate](https://aeronav.faa.gov/d-tpp/2610/00827I18RSAC1_2.PDF)
visibly contains distinct SA CAT I and SA CAT II minima on the same page.
The needed relationship is “this notice addresses this category on this plate,”
not equality of a single category and a combined identity. Keep the notice's
category scope; do not broaden a CAT I restriction to CAT II. Existing negative
tests for unequal normalized identities must not prevent this separate
applicability relationship.

### Subject and heading boundaries miss recognizable source forms

| Record | Source form | Observed limitation / catalog evidence |
| --- | --- | --- |
| STL 3246 | `ILS 12L (CAT II-III) AMDT 6D` | Missing `RWY`; no target, despite matching catalog runway/category/amendment |
| CLE 6389 | Two comma-separated ILS headings sharing `AMDT 3` | Neither target extracted; both published at amendment 3 |
| OMA 8689 | `AMT 6` | Unsupported amendment spelling blocks the title; published CAT II/III plate is amendment 6 |
| HNL 2075 | Airport preamble and `KAENA FIVE ARRIVAL` without the expected separator | STAR recognized but no target; KAENA FIVE exists, including its continuation |
| ENA 6295 | `RNAV (GPS) N RWY 03. ORIG...` and runway 21 | Titles extracted without their separated amendment; headings issue remains; neither title is in this catalog |
| RBG 1630 | Comma-separated copter headings, `AMDT2`, tight spacing | No targets; these copter titles also are absent from the public catalog |

**Five multipart records** begin `PART 1 OF 2` before their explicit IAP/ODP
subject, so the parser does not establish a subject: MIA **1519**, IAD **7644**,
IWA **2812**, OAK **5325**, SUS **5681**. Their complete source is preserved.
Recognizing a bounded first-part subject does not authorize assembling incomplete
parts or interpreting clauses across `END PART` boundaries.

## Discrepancies that must not be guessed away

The remaining unmatched-heading families need source-aware handling or correctly
remain unmatched:

- **Three SA discrepancies:** ORD 4381, DFW 1931 and DTW 388 name `SA CAT II/III`,
  whereas the corresponding catalog titles say `CAT II/III`. This review has not
  established a general equivalence; removing `SA` everywhere would destroy an
  operational distinction.
- **Three DME-title discrepancies:** BIL 6164/7064 say `HI-VOR/DME OR TACAN RWY 28R`
  versus catalog `HI-VOR OR TACAN RWY 28R`; HUM 536 says `COPTER VOR/DME RWY 12`
  versus catalog `COPTER VOR RWY 12`. The
  [HUM PDF](https://aeronav.faa.gov/d-tpp/2610/05037COPTERV12.PDF) confirms the
  catalog title, amendment 4B, and an explicit DME requirement. This supports a
  source-title compatibility investigation; it does not establish a universal
  VOR/VOR-DME alias. BIL also lacks catalog amendment metadata.
- **Thirteen headings lack a same-title published entry or use a different
  revision:** OAK 7507/7056 name SILENT FOUR but the catalog has SILENT THREE;
  PVU 6420 names TAYTR THREE versus TAYTR FOUR. SDF 5704, OMA 4273, ENA
  6295/6829/6827, 1B9 4415, BRO 5690 and SIT 9407/9411 name additional titles
  absent from this catalog. Preserve runway/variant/category/revision differences;
  absence does not prove why a procedure is missing or authorize a nearby match.

The 11 radar, 3 PRM, 4 HRL category, 3 SA, 3 DME and 13 absent/different headings
account for all 37 per-heading misses. The unrecognized STL/CLE/OMA/HNL/RBG titles
and multipart subjects are additional gaps, not part of that recognized-heading
denominator.

## Interpretation flairs

There are 836 D/FDC records with an internal interpretation issue. Issue counts
overlap: 476 facility dependencies, 354 procedure targets, five subjects, three
headings. After the earlier removal of the general heading flair, displayed
interpretation notes are:

- **476 “Procedure Applicability Unconfirmed.”** These are NAV dependencies,
  including genuine uncertainty such as marker/DME/VOR dependencies. The group
  also contains **35 explicit ILS category prohibitions**, for example
  `NAV ILS RWY 28R CAT III NA` and `SPECIAL AUTH CAT II NA`. Those offer a bounded
  runway/category matching extension; they must not become whole-ILS outages.
- **352 “Affected Procedures Unclear.”** Of these, 349 are the generic takeoff/ODP
  family. The other three are HNL, OMA and RBG above. STL/CLE still have internal
  target/heading issues, but the redundant visible target note is suppressed.
- **Five “Subject Unclear.”** All five are the multipart prefixes above.

Removing a flair does not repair a missing plate association. Conversely, numeric
or prose rendering can be correct while procedure applicability remains unknown.
There are no fact-limit/body-limit findings in this corpus.

## Replay and follow-up acceptance cases

Download the pinned catalog linked above to a local file, then run from the root:

```sh
node --import=tsx tools/audit-notam-matching.ts test/fixtures/notams-us1000 /tmp/plate-catalog-2610.json /tmp/notam-matching-review.json
```

The tool validates corpus bytes/hash, snapshot identities/counts, catalog schema
and unchanged source snapshots; the output records the exact catalog hash. It
does not access the network, launch a browser or run verification suites. A
successful exit means the inventory completed, not that matching is complete.

Future fixes should add independent expected matches for the captured cases,
including **each target and each published plate**, and negative cases for wrong
airport/runway/variant/category/PRM/revision. Prioritize original-amendment spelling
and PRM catalog aliases, category-scoped combined plates, then takeoff/DVA/radar
contexts and heading/multipart recognition. Keep the source text, evidence spans,
conditional effects and unknown amendment outcomes intact. Include shared-page
airport ambiguity when adding the omitted plate families.

Validation for this review: the offline full-corpus matching inventory completed;
40 focused NOTAM parser/flair/matcher tests and `npm run check` passed. Full
verification and browser tests were not run, as requested. No deployment occurred.
