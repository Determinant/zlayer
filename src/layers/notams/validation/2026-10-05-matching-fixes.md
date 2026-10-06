# NOTAM matching implementation follow-up — 2026-10-05

Parser 11 / matcher 7 implement the six work areas from the
[initial review](2026-10-05-matching-audit.md). This is local implementation and
focused validation evidence, not a deployment record or a certification of every
operational association. Source records, server collection, sync and cache formats
are unchanged.

## Implemented behavior

1. **Captured regression expectations.** The complete cycle 2610 catalog is now
   retained beside the 1,000-airport corpus. `test/notams-matching.test.ts` checks
   independently specified complete match sets, missing sibling headings and
   negative airport/runway/variant/authorization/PRM/revision cases. Catalog and
   corpus hashes are verified; no network or current-time data is used.
2. **Title and amendment knowledge.** Bounded SAT CAT I → SA CAT I, category
   spelling, ORIG → 0 amendment comparisons and PRM `(CLOSE PARALLEL)` handling
   preserve source titles, evidence spans and different amendment letters.
3. **Category scope.** Single-category headings can address the corresponding
   portion of a combined-category plate without making their identities equal.
   All matching headings are checked for amendment conflicts. Explicit NAV ILS
   category prohibitions retain their runway/authorization/category scope.
4. **Heading and envelope boundaries.** Shared amendments, AMT/AMDT2, separated
   ORIG, qualified ILS headings without RWY, HNL's airport preamble, and first-part
   multipart subjects are covered. Unknown/conditional prefixes fail closed.
   Multipart numeric clauses are not assembled; raw text and coverage uncertainty
   remain available.
5. **Additional plate kinds.** Generic takeoff minimums, DVA, radar minimums and
   named graphical ODPs use their actual catalog kinds. Exact shared-page section
   choices prevent inheriting another airport while paging. Unknown amendments
   still require review.
6. **Useful uncertainty.** Generic parsing/matching flairs are removed from
   individual entries. Operational exceptions and reading limits remain. Plate
   counts expose incomplete matching, list unmatched references and always offer
   **Show all airport NOTAMs**, even with zero established matches. The confirmed
   association group is labeled **Related to this plate**.

The full-airport escape path and explicit limits are consistent with ForeFlight's
published [matching limitations](https://support.foreflight.com/hc/en-us/articles/204400105-Why-might-an-applicable-NOTAM-not-be-displayed-on-the-approach-plate)
and [relevant-count / Show All behavior](https://www.foreflight.com/releases/17-8).
Those publications do not document ForeFlight's title-matching algorithm; no
specific internal rule is attributed to it.

## Replay results

The [machine-readable inventory](2026-10-05-matching-fixes.json) records the same
corpus and catalog hashes as the initial review. It evaluates retained D/FDC
records without an effective-time filter; counts are compatibility evidence, not
today's operational state or an accuracy score. “Applies” below is the internal
outcome now presented as “Related to this plate.”

| Metric | Initial review | After changes |
| --- | ---: | ---: |
| Retained records / airports | 19,469 / 1,000 | 19,469 / 1,000 |
| Recognized procedure notices | 2,794 | 2,799 |
| At least one applies association | 2,082 | 2,406 |
| Review-only associations | 540 | 379 |
| No established association | 172 | 14 |
| Recognized IAP/SID/STAR headings | 3,309 | 3,318 |
| Unassociated headings | 37 | 19 |
| Notices with unassociated headings | 32 | 16 |
| Notices with both matched and unassociated headings | 10 | 3 |
| False ORIG-versus-0 amendment warnings | 354 | 0 |
| Internal parser-issue records | 836 | 447 |

Per-subject outcomes after the change:

| Subject | Notices | At least one applies | Review only | No match |
| --- | ---: | ---: | ---: | ---: |
| IAP | 1,904 | 1,850 | 44 | 10 |
| ODP | 358 | 22 | 335 | 1 |
| SID | 490 | 488 | 0 | 2 |
| STAR | 47 | 46 | 0 | 1 |

The five newly recognized procedure notices are the captured multipart records.
Twenty-one of the initial 37 heading misses now have an association: 11 radar,
three PRM, four combined SA-category and three VOR/DME review candidates. Sixteen
original misses remain, and three newly recognized RBG copter headings are also
absent from this catalog, giving 19. Association includes explicit review candidates;
it does not assert title identity or amendment compatibility.

The 35 NAV category prohibitions are recognized. Thirty-two have corresponding
category plates (33 plate associations); IAD 239, COS 104 and ICT 80 lack a
corresponding category in this catalog and retain an explicit coverage gap. The
447 internal parser-issue records comprise 441 facility dependencies, five
multipart envelopes and one missing amendment value (HIO 6527). That parser-only
count excludes recognized references absent from the catalog; the UI tracks both.

**Correction to the initial ODP grouping:** its “349 generic takeoff / ODP” group
was too broad. Reading and recognizing the actual headings divides the original
354 ODP notices into 316 takeoff-only, 15 DVA-only, one naming both, and 22 named
graphical departures. The four multipart ODP notices add four takeoff-only records.
Consequently, the final inventory has 321 takeoff notices (320 with a corresponding
plate), 16 DVA notices (all associated), and 22 named ODP notices (all associated).
OBE 1868 has no takeoff-minimums catalog entry. All 11 radar notices now reach the
radar-minimums kind. These family counts overlap where a notice names both kinds.

Checking associations before/after found 392 added plate associations and 1,626
removed review fallbacks: 1,541 ODP→departure, 72 broad IAP reviews and 13 broad
STAR reviews. The latter belong to STL 3246, CLE 6389, OMA 8689, ENA 6295,
RBG 1630 and HNL 2075; their specific headings now resolve or remain explicitly
absent. No previous `applies` association disappeared. Of 444 changed outcomes,
443 move from review to applies. CLT 690 moves to review because it names the
same approach with both amendments 2A and 2; checking only the first heading
previously concealed that conflict. These numbers count plate entries, including
continuations, rather than unique notices.

There are 392 notices with other amendment-review reasons after the change. This
must not be compared with the original 43 as an error rate: newly supported
minimums pages often lack catalog amendment metadata. Genuine differences and
unknown editions remain review outcomes.

## Remaining distinctions and supporting evidence

- **SA stays distinct.** ORD 4381, DFW 1931 and DTW 388 say SA CAT II/III while
  the corresponding catalog titles use standard CAT II/III. The
  [FAA category guidance](https://www.faa.gov/about/office_org/headquarters_offices/avs/offices/afx/afs/afs400/afs410/cat_ils_info)
  distinguishes those authorizations. This evidence does not justify dropping SA.
- **VOR/DME becomes a review candidate, not an identity alias.**
  [AIM 5-4-5](https://www.faa.gov/air_traffic/publications/atpubs/aim_html/chap5_section_4.html)
  documents moving equipment requirements from titles to chart notes. Rendered
  [HUM COPTER VOR RWY 12](https://aeronav.faa.gov/d-tpp/2610/05037COPTERV12.PDF)
  and [BIL HI-VOR OR TACAN RWY 28R](https://aeronav.faa.gov/d-tpp/2610/00048HVT28R.PDF)
  both show DME required, with printed amendments 4B and 3B respectively. The
  forward VOR/DME→VOR candidate preserves all other identity components and always
  requests equipment/edition review. BIL's missing catalog amendment remains unknown;
  inspecting a PDF for this review does not populate production metadata.
- **Absent or different published titles remain absent.** The original 13
  headings at OAK, PVU, SDF, OMA, ENA, 1B9, BRO and SIT remain unmatched. The three
  newly recognized RBG copter headings are also absent. No SID/STAR revision,
  approach variant, category, runway or circling letter is discarded to force a match.
  Exact record IDs, headings and amendments remain in the JSON inventory.
- **Dependency completeness is not claimed.** General navaid/marker/DME outages
  still need published dependency data. Unknown shared-page targets, missing
  source parts and real source conflicts remain visible. The 12 captured source
  conflicts are retained separately and are not promoted into resolved records.

## Reproduction and validation

Run from the repository root; these commands make no FAA requests:

```sh
node --import=tsx tools/audit-notam-matching.ts test/fixtures/notams-us1000 test/fixtures/notams-us1000/plate-catalog-2610.json.gz /tmp/notam-matching-fixes.json
node --import=tsx --import=./test/helpers/assets.ts --test --test-isolation=none test/notams-matching.test.ts test/notams.test.ts test/notams-formats.test.ts test/notams-flairs.test.ts test/notams-ui.test.ts test/notams-us1000.test.ts test/notams-semantic.test.ts test/notams-corpus.test.ts test/notams-presentation.test.ts
npm run check
```

The focused reader/parser suite passed all 85 tests, including preservation of all
19,469 records and ten captured matching regression groups. TypeScript, theme and import
boundary checks passed. Browser assertions were updated for the changed labels;
full verification and browser tests were not run, as requested. Shared-page context
is covered by Node tests; browser interaction/layout is not qualified by this run.

This evidence covers the local implementation. No commit or deployment was made.
