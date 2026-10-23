# NOTAM source comparison

[NOTAM guide](README.md#collection-and-delivery)

This contract governs source-conflict decisions and equal-revision reconciliation. It establishes when
two retained representations supply the same content; it is not a validator of
every aviation statement or an implementation of every NOTAM processing procedure.
Acquisition, source ordering, cancellation and publication have separate owners.

## Authority and applicability

The implementation uses the following sources, reviewed on 2026-10-12. Standards
describe fields and processing principles; captured NMS evidence qualifies the
specific distribution transformations we automate. A documented manual correction
procedure does not authorize the server to guess a missing fact.

| Source | What it establishes | Implementation boundary |
| --- | --- | --- |
| NMS API 1.0.18, revised 2026-02-12, supplied production OpenAPI | AIXM 5.1 delivery, source-ID queries, updated active/inactive records and bulk acquisition | Namespace-aware `normalize.ts`, bounded collection and existing durable acquisition policy; do not silently migrate to AIXM 5.2 |
| [AIXM 5.1 Event schema](https://aixm.aero/schema/5.1/event/Event_Features.xsd), `NOTAMPropertyGroup` and `NOTAMTranslationPropertyGroup` | Separate identity, issue time, effective interval, Q qualifiers, E text, F/G limits and translations; `year` belongs to the NOTAM number, not its effective date | Preserve the structured fields in our record contract and retained translations independently; schema structure alone establishes neither NMS revision precedence nor which conflicting rendering is authoritative |
| [FAA Order 7930.2U](https://www.faa.gov/regulations_policies/orders_notices/index.cfm/go/document.current/documentNumber/7930.2), including [Change 2 dated 2026-09-30](https://www.faa.gov/documentLibrary/media/Order/7930.2U_Chg_2_dtd_9_30_26_Final.pdf), §8-1-2 and [Appendix B](https://www.faa.gov/air_traffic/publications/atpubs/notam_html/appendix_b.html) | Ordered Q/A/B/C/D/E/F/G fields; replacement/cancellation references; selection-code meanings | Explicit parser states, preserved field boundaries and references; parsing R/C syntax does not grant N-only comparison relaxations |
| [EUROCONTROL OPADD 4.1](https://www.eurocontrol.int/sites/default/files/2021-07/eurocontrol-guidelines-opadd-ed4-1.pdf), ch. 3, §§3.9–3.12, 3.18 (pp. 89–93) and 6.2.2 | Distinct syntax correction, data correction and editing; original evidence retention; query warnings; E-based selection-code correction, QXXXX replacement and purpose upgrades; multipart processing | Lossless parsing separate from correction policy; complete evidence for each transformation; uncertainty is not resolved by arrival order |
| [FAA-distributed foreign NOTAM PDF](https://notams.aim.faa.gov/notamSearch/createNotamPdf?transactionid=76687894) and [retained OBBI variants](../../../test/fixtures/notams-obbi-2026-10-12.json) | A USNOF foreign-data disclaimer is distribution material; NMS can append the expanded wording to both E text and its ICAO rendering | Recognize only the two evidenced terminal statements in active INTL NOTAMN records, then require complete envelope/body equivalence |

OPADD is advisory processing guidance, not the NMS wire contract. The supplied
OpenAPI references FNS NDS WSDD, FNS NDS WSRD and AIDAP IRD. The
[FAA agreement portal](https://aa.data.faa.gov/data/service.jsf?uuid=56910255-54c7-49d9-8577-cf93291bf698)
identifies `WSDD-FNSNDS-001`, but its contents were not obtained. The
[FAA service catalog](https://nsrr.faa.gov/home?page=5) lists FNS NOTAM Distribution
as retired; historical FNS guidance is not automatically the current NMS profile.
Unverified interface details do not prevent a project policy: the priorities below
state our decisions explicitly, with their evidence requirements and implementation
limits. They must not be presented as an undocumented FAA mandate.

## Conflict-resolution priority

Apply these decisions in order, within the same source environment and identity.
A rule resolves only the fields it covers. In particular, a text-equivalence proof
cannot waive a lifecycle, identity, time or location conflict. These are project
decisions informed by the references above, not a ranking of XML, ICAO and local
text by format or a numerical confidence score.

| Priority | Decision and required evidence | Current implementation |
| --- | --- | --- |
| 1. Establish identity and completeness | Match the canonical NMS source ID; validate the envelope and lifecycle; require all parts and retained variants for a content proof. Notice number, airport or similar prose alone cannot link two source IDs. | Implemented, including bounded/truncated evidence handling. |
| 2. Apply a qualified source revision | A later NMS source update supersedes the prior revision for that ID. Retrieval time, issue time and unqualified AIXM counters do not establish that relationship. | Implemented using update time through nanoseconds. Equal-time observations remain subject to content/lifecycle comparison; counter differences cannot select a winner. A separate publisher-correction message workflow is not implemented. |
| 3. Establish notice identity, then apply lifecycle evidence | All supplied classification, number, series, year and change-type values must agree through the shared identity rules. At equal ordering, a qualified original-ID cancellation timestamp takes precedence over omission of that optional timestamp. A replacement/cancellation notice's textual reference alone does not authorize deleting another NMS ID. | `identity.ts` owns precise source ordering, identity/year evidence and the cancellation predicate; `revision.ts` applies lifecycle authority only after identity agrees, including for duplicate inactive observations. |
| 4. Prefer a demonstrated native witness over its conversion | When both DOMESTIC/FDC variants contain the same complete, record-bound native notice, use that witness to reconcile auxiliary conversion differences. A `LOCAL_FORMAT` or `OTHER:ICAO` label alone supplies no authority; an INTL translation is not automatically inferior to structured XML. | Implemented for the documented native-notice grammars; all structured operational fields still undergo comparison. |
| 5. Resolve a qualified coding discrepancy | Use a complete operational statement to establish a dependent coding value only through a named, bounded rule. Require record-bound envelopes and agreement on all unaffected fields. | Implemented for the four closure subjects, QXXXX replacement and supplied purpose-upgrade chain below. Other code/qualifier corrections are not implemented. |
| 6. Supplement a demonstrated omission | A supplied numbering year, optional association, reference, translation or schedule may supplement an absent value only under that field's qualified compatibility rule. Identity/year proof is also available before lifecycle decisions. Two supplied, different values are not an omission. | Implemented for the documented field cases below; there is no generic nonempty-field-wins merge. |
| 7. Reconcile equivalent representations | Compare complete meanings using the supported lexical, schedule, multipart and distribution-annotation rules. Select a retained original for presentation only after equivalence is established. | Implemented; distinct qualified raw translations remain retained. Shorter text is a presentation choice, never evidence of truth. |
| 8. Contain the remaining disagreement | If only auxiliary airport associations disagree, publish the agreed filing scope and retain the disputed alternatives. Otherwise retain the bounded issue and report `contradictory` or `unproven`; independent records continue advancing. | Implemented. A sparse repeat at the same revision cannot erase retained contradictory evidence. |

An authentic, ordered correction from the responsible publisher/processor is
stronger evidence than the superseded version. OPADD §§3.12–3.15 distinguish
corrections from duplicates and direct conflicting same-number content to query.
Its instruction to use the last processor version assumes that correction chain;
it does not establish response-arrival precedence among NMS bulk, delta and
single-ID queries. The server therefore gives none of those endpoints an intrinsic
authority advantage. Repeated copies from one distribution system are not
independent votes.

### Field-specific boundaries

These boundaries apply even when one variant appears more detailed or plausible:

- **Identity and references:** preserve series/number/year and N/R/C relationships.
  Decimal zero padding can compare equal. Do not repair a year from effective
  dates or choose a different source ID from a matching header. The OBBI example
  below demonstrates equivalence without establishing a corrected year.
- **Validity and schedule:** keep B/C boundaries, EST/PERM status and D's activity
  windows distinct. A shorter interval or a longer closure is not automatically
  more authoritative. Supplementation requires the complete matching witness;
  supplied unequal operational times remain conflicting. The shared schedule
  projection compares `SR`/`SS` symbolically without evaluating solar activity.
  A complete, record-bound ICAO NOTAMN D field or matching domestic native body
  may witness omitted schedule metadata; all retained renderings and supplied
  structured days/endpoints must agree. This rule applies by evidence, including
  MIL/INTL notices, rather than by preferring an ICAO translation label. See the
  [schedule contract](README.md#collection-and-delivery) and the retained
  [October 13 source pairs](../../../test/fixtures/notams-schedule-2026-10-13.json).
  Schedule omission and Q-code/purpose qualification can compose: every retained
  envelope must bind identity, interval and primary body, all supplied schedules
  must fit the same complete D field, and the complete envelope set must otherwise
  be equal or satisfy the existing qualification rule. A missing structured
  schedule cannot make a previously qualified Q-code disagreement reappear;
  differing supplied schedules or operational text remain unresolved.
- **Operational body and qualifiers:** OPADD §3.18.3.3 permits clear E content to
  determine the selection code without downgrading purpose. This supports a
  bounded semantic rule, not a blanket E-over-Q or prose-over-XML preference.
  Changed restrictions, exceptions, purpose, traffic or scope need their own proof.
- **Altitude and geography:** Q filtering bounds and F/G operational limits serve
  different roles. OPADD's qualification and item-processing guidance (pp. 89–97)
  allows coverage that is deliberately broader
  than the detailed statement. Our policy must not narrow a radius, intersect
  altitude ranges, copy Q levels into F/G or erase a disagreeing location merely
  to obtain equality. Such automation is not implemented.
- **Warnings and distribution material:** preserve operational query warnings.
  Only recognized distribution material can be segmented, with the originals
  retained and complete content agreement established. An unfamiliar footer is
  still evidence, not automatically noise.

### NMS revision ordering

Order records for the same NMS source ID by `FNSE:lastUpdated`, preserving precision
through nanoseconds. The supplied production API's `/v1/notams` `lastUpdatedDate`
parameter identifies modifications (creation, update and cancellation) by their
modification time. An equal timestamp establishes only a shared source-time
boundary: it does not establish identical content or order AIXM counters.

[AIXM 5.1 Temporality 1.0](https://aixm.aero/sites/default/files/imce/AIXM51/aixm_temporality_1.0.pdf),
§§2.6, 3.2 and 3.8, identifies corrections within a feature/TimeSlice and evaluates
overlapping changes with validity information. Higher corrections replace the same
slice; they are not a universal ordering of NOTAM records.
[AIXM 5.1.1 Temporality 1.1](https://aixm.aero/sites/default/files/imce/AIXM511/aixm_temporality_1.1.pdf),
§3.6, explicitly removes an ordering role from sequence numbers. NMS advertises
5.1; the adapter does not silently adopt a later temporal model.

Sequence/correction values do not break timestamp ties. They are provenance,
separate from the operational-content comparison: when identity, applicability,
lifecycle and every content field reconcile, differing counters cannot by
themselves establish contradictory notice content. The merge retains the distinct
observed pairs in optional `sourceCounters`, bounded to eight pairs. The scalar
pair is the lexicographically smallest observed pair for a stable representation;
it does not identify a winning or newer TimeSlice. Independent maxima must never
form a pair that the source did not supply. Legacy records imply their scalar pair.

This is content equivalence, not an implementation of AIXM correction precedence.
Different operational content still conflicts regardless of counter values.
Overflow and previously truncated evidence remain unresolved. Full reconciliation
and authenticated restore preserve the pairs and source clocks; a sparse replay
cannot erase them. A genuinely later NMS update supersedes the older source-time
group, including when its counters decrease. The captured DVV case showed why
counter inequality must not be treated as operational inequality.

Positive original-ID cancellation evidence retains its separate qualified
precedence at the same source time. Thus a higher sequence or correction number
alone cannot resurrect a cancelled notice. Existing inactive-record handling also
remains independent of any presumed AIXM counter ordering.

This snapshot adapter does not reconstruct general AIXM feature histories or
claim to apply same-slice corrections without feature identity and TimeSlice
context. The ordering decision no longer depends on that missing context. Adding
a future temporal interpreter would require its own retained context and contract;
it is not an outstanding assumption in the current comparator.

The additive counter field needs no generation-schema migration. Old snapshots
remain readable, and saved source clocks and admission journals are unchanged. Previously discarded
variants cannot be recreated from a selected record alone; normal admitted deltas
and full reconciliation supply subsequent evidence. Do not reset request history
or force another bulk request to compensate.

### Decision acceptance criteria

Each additional automatic rule must identify the exact affected fields, evidence
it consumes, applicable source profile, and reason it outranks the alternative.
Preserve the raw evidence needed to reproduce the decision. Check both arrival
orders, repeated delivery, three-way disagreement, omission versus contradiction,
and authenticated restore. A proof for two variants cannot discard a contradictory
third variant. Do not manufacture freshness or clear continuity failures to make a
content decision appear healthy. Local arrival order, response endpoint, majority,
notice issue time, text length and lexical/digest order never establish authority.

Qualification must combine each new rule with the applicable existing identity,
optional-field, representation and lifecycle rules. Exercise active, original-ID
cancelled and separate NOTAMC observations, arrival orders, batch partitions,
sparse repeats, full-snapshot rebasing and authenticated restart. Include
contradictory supplied values, invalid cancellation times, unknown lifecycle and
truncated evidence.
`test/notams-composition.test.ts` uses captured source profiles with explicitly
invented transformations and expected identity/lifecycle outcomes. Extend that
matrix when adding a rule; replaying the current conflict cohort alone is
insufficient qualification. Run `npm run test:info:notams` for this server boundary.

Treat presentation, optional metadata and field roles as independent dimensions.
For example, domestic/international headers, station/FIR A fields, keyword and
station wrappers, fixed/estimated/permanent validity, whitespace and missing years
can combine in one notice. A captured example establishes provenance; a generated
matrix checks those combinations and their nearest contradictions. Unknown body
prose needs no operational interpretation when the whole supplied bodies agree.
Unsupported syntax cannot establish a correction, and must remain distinct from
proved unequal content. Neither an unrecognized rendering nor a human typo
authorizes guessing a location, frequency, date, limit or restriction.

## Processing stages

1. `representation.ts` creates bounded lexical views with original token offsets
   and parses local/ICAO envelopes through field states. No acquisition, record
   precedence or correction policy belongs in that parser.
2. `notice-evidence.ts` accounts for the whole record body and **every** retained
   rendering. It distinguishes equal enclosing text from a notice whose identity,
   location, interval and schedule also bind to the structured record.
   Native evidence is parsed and bound once per immutable record, then shared by
   identity, text, schedule and association decisions. Its compact cache retains
   content and comparison keys, not token graphs. Domestic month/number keys
   ignore decimal zero padding only; an international series-number/year header
   cannot masquerade as a domestic number or supply missing-year authority.
3. `notice-comparison.ts` applies the evidence rules below;
   `notice-qualification.ts` owns the standards-based Q-code and purpose rules.
   Comparison selects an original body and reports the proof and failure kind.
   It never writes a corrected Q line, invents a body or advances source time.
   Complete evidence rules run independently. A shared ICAO proof cannot disable
   a native-rendering rule needed after merging or restoration. Priority chooses
   the retained presentation only; each rule must account for all supplied
   representations in the fields it covers.
4. Server `identity.ts` establishes revision and notice identity independently of
   operational text equivalence. `content.ts` evaluates structured-field and
   representation evidence together, returning both the comparison and the
   selected original schedule/supplied association scopes. `revision.ts` applies
   lifecycle authority and merges those evaluated values; it does not recompute
   acceptance or infer publication values from diagnostic proof names.
   `structured-fields.ts` assigns every `NotamRecord` field a comparison rule or
   an explicit owner (source ordering, publication metadata, retained evidence,
   counters, digest or query projection). The exhaustive TypeScript policy and
   rule dispatch require a decision when the record contract or rules grow.
   `collection.ts` retains unresolved variants;
   `store.ts` authenticates and replays them on restore. Health derives from that
   same result, without a separate allowance for an inconvenient conflict.

`resolveNotamRevision` is the shared pure decision for one source identity. It
first selects the newest qualified source-time group, then applies identity,
lifecycle and content rules. It returns a resolved record with named proofs or an unresolved
reason with comparison evidence. Collection, authenticated restore and filing-scope
projection consume this result; ordinary source uncertainty does not throw.
The array-based `mergeNotamRecords` compatibility API still throws for callers
requiring a completely resolved array. Envelope, ownership and storage failures
remain failures of their separate owners.

Structured comparison uses field meaning rather than a generic fuzzy match.
Primary and ICAO location lists compare as sets of exact codes: order is not
membership, but adding, removing or substituting a primary location is a conflict.
Optional ICAO omissions and qualified complementary scopes keep their separate
evidence requirements. No prefix stripping, inferred aliases or spelling-distance
correction is allowed. Equivalent sets report `location-set-equivalence`.

Effective start/end spellings compare through the UTC grammar already accepted by
ingestion: compact minutes/seconds and ISO UTC seconds with up to nine fractional
digits. Both values must parse, agree with their derived timestamps and denote
the same exact instant, including sub-millisecond precision. EST is admitted only
for a known estimated end; the independent end-kind rule still constrains fixed,
estimated, permanent and unknown validity. Unknown/invalid dates and unsupported
time zones cannot establish equality. This reports `validity-time-equivalence`.
Neither rule rewrites source fields or advances source clocks: the merged record
keeps an observed original spelling/order; full-sync raw archives retain the
bulk input for replay. These are constructed representation tests, not claims of new
captured FAA incidents. All other identity, lifecycle, body and schedule rules
still apply, and a contrary third observation remains a constraint.

Batch merging defers initially conflicting pairs and retries them against admitted
evidence until no further observation can merge. Each successful pass removes at
least one pending observation; a pass without progress returns the remaining
comparisons as explicit issues. Confirming renderings can complete chains of
proofs without a one-retry assumption. Every deferred variant must pass the
ordinary rules; arrival/digest order grants no authority, and representation and
retained-evidence bounds remain enforced.
Filing-scope projection uses this same batch resolver after checking that every
variant has the same source identity and revision. It excludes only the disputed
ICAO associations from comparison; a later confirming witness can establish the
agreed content without granting a disputed alias or clearing the durable issue.

Evidence caches use record-object identity and retain compact content only, not a
second national dataset of token graphs. Records are treated as immutable.

## Field and transformation rules

### Structured text and rendered notices

[FAA Order 7930.2, §8-1-2](https://www.faa.gov/air_traffic/publications/atpubs/notam_html/chap8_section_1.html)
defines E as the description and F/G as separate altitude limits. The
[AIXM 5.1 Event schema](https://aixm.aero/schema/5.1/event/Event_Features.xsd),
`NOTAMPropertyGroup`, separately declares `text`, `lowerLimit`, `upperLimit` and
`translation`; `NOTAMTranslationPropertyGroup` carries rendered representations.
These field boundaries were rechecked on October 19, 2026. They do not require
AIXM `text` to duplicate F/G.

Source reconciliation accepts either an exact complete E body or the existing
complete E-through-G rendering, after the supported lexical transformations.
Each retained ICAO translation must parse completely and account for that body.
F/G stay in its comparison key and raw translation: changed limits, units, datum,
missing versus supplied limits, and partial E/F/G bodies still need independent
proof and remain unresolved. This establishes representation binding, not authority
to correct or infer altitude values. It composes with the existing year, schedule,
and distribution-annotation rules; none bypass the other content checks.

`icaoEvidence` requires the explicit `aixm` mode for this source-text layout.
The default rendered-text mode and its separate cache retain the client subject
recovery contract. Source code alone never changes PWA interpretation implicitly.

The retained KLSF/MYEH cohort exposed one common field-binding gap through two
symptoms: an omitted structured year and a terminal foreign-data disclaimer.
`test/notams-composition.test.ts` covers the real pairs through AIXM decoding,
arrival order, delivery partitions, sparse repeats, cancellation and two restarts.
Its constructed matrix varies separate/rendered limits, field spacing, missing
year/schedule/associations and contradictory third variants. Tests must derive
expected field ownership from the schema, rather than building every fixture by
copying the entire rendered E/F/G tail into AIXM `text`.

### Numbering-year omissions

`source-year-omission` admits an empty structured year paired with one supplied
four-digit year at the same precise NMS revision, after all other supplied notice
identity fields agree. Identity evidence is reusable across representations and
lifecycle transitions. At least one observation must supply a complete native
DOMESTIC/FDC notice or complete ICAO evidence bound to that identity and interval
after applying the supplied year to a comparison view. Each supplied schedule
must fit its ICAO witness; an omitted schedule does not prevent identity proof.
Decimal zero padding has the same meaning in identity comparison and ICAO binding.
Separate content comparison still checks every supplied schedule, body,
translation, location and effective time across the observations. The FDC wrapper
proof can use the same native witness.

A separate NOTAMC message can witness its own numbering year through a complete
ICAO cancellation envelope: matching notice identity, item A location, item B
start and the entire primary body. [OPADD 4.1](https://www.eurocontrol.int/sites/default/files/2021-07/eurocontrol-guidelines-opadd-ed4-1.pdf),
§2.3, excludes items C/D/F/G from NOTAMC; its NMS retention end is not item C.
The [October 18 OJKF pair](../../../test/fixtures/notams-notamc-2026-10-18.json)
combines that envelope with an omitted year and a terse header/A rendering.
A header alone cannot supply the year proof. Supplied headers and structured
references constrain the decision before and after a year has been established;
headers with different years remain contradictory even when both structured years
are empty. A contradictory own identity or referenced notice stays unresolved,
and diagnostics report the evidence fields that prevented resolution. Merges retain
raw translations, a primary cancellation header and a supplied reference so
sparse repeats and restart cannot erase those constraints. This establishes only
the cancellation message's own identity, never authority to cancel the referenced
source ID.

A qualified original-ID cancellation timestamp supplies an alternative identity
witness: it names that source ID at or after the same source revision, even when
its text is terse or the other observation is sparse. The shared predicate
requires `lifecycle: cancelled` and a valid timestamp, including fractional
ordering. An active record or a NOTAMC reference supplies no such authority.
This is an explicit project event policy, not an undocumented FAA precedence rule.
Text equivalence alone cannot grant cancellation authority. Two populated years,
a malformed year, another supplied identity disagreement, or the absence of any
qualified witness remain unresolved. Effective/issue dates never supply a year.

The result retains the supplied year and both actual spellings in `sourceYears`
(`['', suppliedYear]`), including on a cancellation. That authenticated proof
remains valid for the same ID, precise revision and notice identity through sparse
repeats and terse cancellation updates; content and lifecycle retain their own
checks. It cannot cross a revision or clear a third populated-year disagreement,
including across batch partitions, rebasing and authenticated restore. No new
persisted field or generation format is needed.

The [October 18 DWH pair](../../../test/fixtures/notams-cancellation-2026-10-18.json)
shows why identity proof precedes lifecycle: one representation omits the year and
cancellation field, while the other supplies both with the same source ID, source
time and complete notice. The earlier active-only year rule and exact-year
cancellation guard handled their separate cases but failed in combination.
The composition matrix also covers sparse/terse events and missing years combined
with schedules, counters, padding and lookup scopes.

### Complementary station and FIR scopes

`complementary-association-scopes` is a query-membership policy qualified by the retained
[LSU/VIO examples](../../../test/fixtures/notams-state-2026-10-16.json) and
[FIM conversion](../../../test/fixtures/notams-fim-association-2026-10-22.json), not a
general location-correction rule. FAA 7930.2U §8-1-2 identifies item A as an
aerodrome **or FIR** scope. The NMS extension exposes both through the same
`icaoLocation` field. A complete native notice can therefore arrive once with
a source-supplied station-prefixed lookup and once with an explicit FIR lookup.

Only active DOMESTIC NOTAMN observations with one identical three-letter filing
location, matching complete native notices and agreeing supplied numbering years
qualify. Every original association set must contain exactly one code; the two
distinct codes must be `K` plus that filing location and a `KZ..` FIR scope.
At least one complete ICAO-layout NOTAMN conversion must witness the supplied FIR
in Q. A may identify the filing station, its supplied prefixed lookup or the FIR;
these fields have different roles and need not contain identical codes. A domestic
header must match the complete native notice's month/number, allowing decimal zero
padding in every retained native rendering and conversion. Month changes remain
different identities. An international header must have a year suffix matching the supplied
numbering year. Two absent years remain absent; dates never manufacture a year.

Every conversion must match the interval, schedule and entire native body. The
body may carry the filing station prefix or omit its single leading domestic
keyword, as witnessed by the captured NAV/COM conversions. The recognized keyword
set comes from [FAA 7930.2U §1-2-1](https://www.faa.gov/air_traffic/publications/atpubs/notam_html/chap1_section_2.html).
This is a project comparison policy grounded in those captures, not an FAA rule
permitting arbitrary word removal. Every remaining word must agree; no frequency,
restriction, suffix, altitude limit or unrecognized prefix is discarded. The
complete native body and all original translations remain intact.

Every retained conversion must meet these checks, except the captured legacy
domestic NOTAMR conversion: its exact
native notice number, station, interval and NAV body, and the same Q FIR, must
all agree. Its missing reference supplies no lifecycle or FIR authority. Unknown
translations, different FIRs, changed content and arbitrary airport pairs fail.

The resolved record keeps **both** supplied lookup codes in `icaoLocations` and
their original singleton sets in `sourceIcaoLocations`. This asserts source
query membership; it does not identify either code as an alias for the other.
It neither guesses a geographic scope nor removes a source association. A sparse
repeat cannot withdraw the established scopes; retained native evidence must
still bind to the incoming fields. PJOH/PACV and other airport-to-airport disputes
keep their existing intersection projection and remain unresolved globally.

### Comparison and retention

Merging equivalent active content keeps every distinct raw translation, including whitespace-only variants.
Lexical views establish equivalence but do not replace source bytes. The existing
eight-translation representation bound still applies; overflow becomes an explicit
issue rather than dropping a rendering to obtain a resolved record.
Qualified lifecycle precedence retains the selected original inactive rendering
and accumulated year provenance. Its authority to withdraw that source ID is
independent of equivalence with the preceding active body.

The [October 17 aggregate production audit](validation/2026-10-17-conflict-reconciliation.json)
applied these pure decisions in place to all 90 retained source issues: 88 used
the year-omission proof and two used complementary scopes. All 90 resolved in
both delivery orders and retained every raw translation and source revision time;
sparse replay/rebasing remained resolved. The report identifies its immutable
input and candidate-module hashes. This is dated conflict-cohort evidence, not a
whole-dataset release replay or a claim that production was deployed or healthy.

| Field/evidence | Permitted comparison | Required evidence / rejection boundary |
| --- | --- | --- |
| Source ID and revision | NMS ID alias and timestamp ordering through nanoseconds | Counter values remain evidence, not tie-breakers; equal source time still requires content/lifecycle proof |
| Record identity and lifecycle | Exact/qualified rules in `identity.ts` and `revision.ts` | A text proof cannot erase a differing structured value or cancel another source ID |
| Primary and ICAO locations | Exact set membership, independent of list order | No invented aliases; primary omission remains a difference; optional ICAO omission/complementary-scope rules need their own evidence |
| Effective interval | Equivalent supported UTC spellings through nanoseconds, consistent with derived timestamps | Unknown dates cannot establish equivalence; changed instants, fixed/estimated/permanent semantics remain constrained |
| Translation lexical form | Whitespace and observed literal outer `<pre>` | Preserve punctuation, case, unknown markup and literal entity spelling at baseline |
| Surface designator spacing | A witnessed compact letter/number identifier after `TXL`/`TWY` can match its split spelling at a bounded surface-clause slot | Active DOMESTIC NOTAMN, complete bound local notices, every supplied rendering accounted for; no distance, list, runway, gate or arbitrary word joining |
| XML references | Exactly one layer of the five XML entities and valid non-whitespace numeric references | Complete shared notice/body evidence; no recursive decoding, control-reference tokenization or standalone body guessing |
| ICAO field spacing | Attached or spaced values at the expected Q/A/B/C/D/E/F/G state | No global marker replacement inside E prose; reordered/duplicate fields fail |
| ICAO whole/multipart body | Exact complete parsed contents; at most 32 complete primary-body copies | All identities, headers, part counts and closing markers agree; no missing/duplicate parts or partial repeated sentences |
| Lost line separator before a time interval | `icao-line-break`: an actual ICAO body line break after a letter and before a valid `YYMMDDHHMM-YYMMDDHHMM` interval witnesses a space or its omission at that exact position | Every active NOTAMN observation has a complete record-bound single-part ICAO notice; all envelopes and unaffected body characters agree. At most 32 boundaries; no F/G limits, unknown translations, arbitrary word splitting or missing interval digits. Supplied local envelopes must match identity, accountability, location and interval. |
| Complete enclosing ICAO notice | Same identity, reference, all eight Q components, A/B/C/D/E/F/G across every retained rendering | Each primary body matches its complete E field or E-through-G rendering; reports `icao-notice` when record-bound, otherwise `icao-rendering` |
| Native DOMESTIC/FDC notice | Same complete record-bound local notice, including supported schedule/body wrappers | Authoritative native evidence can coexist with differing auxiliary ICAO conversions; it does not assert that their Q fields are equal |
| E-only versus full ICAO primary text | Identical retained ICAO rendering and complete E-onward match | Existing `icao-body` proof may preserve an omitted C field, but cannot supply that end or authorize a correction |
| Optional ICAO traffic/purpose/scope | A missing value can coexist with a supplied value | Supplied differences need an independent qualification proof; omission does not authorize that proof |
| Selection code | Qualified `QFALC`/`QMNLC`/`QMRLC`/`QMXLC` and `QXXXX` alternatives | Record-bound complete notice, exact whole-body grammar, one retained agreeing code; other fields equal except a separately proved purpose upgrade |
| Purpose | Supplied `M → B → BO → NBO` upgrade chain | Record-bound complete notice; compare against the highest supplied purpose, retain every raw variant; missing/unknown values cannot be ranked |
| Distribution annotation | Two exact terminal USNOF disclaimer forms described below | Active INTL NOTAMN; full enclosing notice/body agreement; originals retained |
| Quality warnings and operational prose | Full content remains significant | `NOTAM SUBJECT TO QUERY`, exceptions, limitations and unfamiliar annotations are not ignorable formatting |
| FDC ODP continuation | Existing complete native notice plus agreeing ICAO conversion | `source-text.ts` consumes every token; only the evidenced repeated footer/airport-heading boundary can vary |
| Unknown representation | No inferred equivalence | Keep bounded evidence and report `unproven`; known differing fields report `contradictory` |

The existing [collection contract](README.md#collection-and-delivery) additionally
owns schedule supplementation, estimated-end derivation, cancellation, association
projection, truncation and replay. These are independent of text equivalence.

### Surface identifier spelling

The [October 22 EWR capture](../../../test/fixtures/notams-ewr-designator-2026-10-22.json)
contains the same source ID, revision, interval and closure with `TXL A 12`
in one complete native rendering and `TXL A12` in another native/ICAO rendering.
The numbering-year omission is handled independently by the existing identity
proof. This is a comparison gap, not failed collection or full synchronization.

`notice-designators.ts` compares identifier slots after `TXL` or `TWY` in
APRON/TWY bodies. It admits one/two letters plus one/two digits without a leading
zero, only before `CLSD`, `BTN` or a spelled-out cardinal direction followed by
`OF`. Each joined slot needs an actually supplied compact spelling. Every other
token remains significant. Units, dimensions, comma/hyphen lists, runway/gate
identifiers, unknown boundaries and arbitrary word spacing are outside this rule.
[FAA use-of-terms guidance](https://www.faa.gov/air_traffic/publications/atpubs/notam_html/chap3_section_3.html)
defines taxiway letter/number designators, cardinal-direction segments, measurement
units and list separators. It establishes those grammar boundaries; the captured
NMS pair qualifies this comparison rule, not a general permission to edit NOTAMs.

The `surface-designator-spacing` proof requires active DOMESTIC NOTAMN observations
with complete native notices bound to each record's identity and validity. Native
envelopes must agree. All supplied ICAO renderings must parse, match the compared
body and record interval/schedule/locations, and agree on their complete envelopes;
unknown translation types and F/G limits cannot be discarded. Comparison keys
alone change. The selected body is an observed original, and every distinct raw
translation survives merging within the existing evidence limit. The rule also
runs when a shared ICAO rendering already establishes body equality, so retained
split native spellings remain usable on replay and restart. Changed identifiers,
directions, exceptions, times or a contrary third observation stay unresolved.

`test/notams-designators.test.ts` covers the capture, XML, invented identifiers and
boundaries, rejection cases, all third-variant orders/batches, sparse replay,
rebasing and evidence limits. The composition suite combines this rule with year
omission, number padding, counters, omitted associations/translations, UTC forms
and cancellation; authenticated restart verifies both EWR queries with unchanged
source clocks and admission history.

### Equality and correction have different authority

Equal source renderings need not be internally perfect to be equivalent. The
OBBI capture has structured `year: 2027` and ICAO headers ending `/26` in **both**
variants. The complete envelopes and their operational content agree. Comparison
can establish that the added distribution annotation changes no notice content;
it cannot declare either year correct. Both values remain available unchanged.
A different supplied structured year or ICAO header in the other variant still
conflicts. No year is derived from effective time or silently rewritten.

Semantic correction requires the stronger `recordBound` evidence. For the
[RKTI capture](../../../test/fixtures/notams-rkti-2026-10-11.json), this includes
series/number/year, N type, matching location, interval/end qualifier, schedule and
the whole body. The closure grammar consumes one of these complete statements,
optionally followed by `DUE TO WIP`:

| Statement | FAA Appendix B subject / condition |
| --- | --- |
| `AD CLSD` | `FA` aerodrome / `LC` closed |
| `APRON [designator] CLSD` | `MN` apron / `LC` closed |
| `RWY <direction or pair> CLSD` | `MR` runway / `LC` closed |
| `TWY <designator> CLSD` | `MX` taxiway / `LC` closed |

Runway directions are 01–36 with optional L/C/R suffixes. The automatic proof
admits taxiway designators of one or two letters followed by up to two digits;
apron designators are one letter with up to two digits, or one/two digits alone.
These are intentionally bounded project grammars, not a claim to enumerate every
facility name. Arbitrary words must not become designators: `PARTLY` or `TEMPO`
would change the interpretation. Unrecognized names remain unproven.

At least one retained code must agree with the parsed subject. Other alternatives
must be one of the four closure codes or `QXXXX`; the latter is supported by
OPADD's explicit generic-code replacement procedure (p. 90). F/G limits exclude
this closure proof. Exceptions, other statuses, multiple instructions and unbound
headers cannot authorize it. The `icao-selection-code` proof retains the originals;
replay must still supply the agreeing code as part of the retained set.

OPADD's purpose procedure (p. 91) permits upgrades along `M → B → BO → NBO`.
For otherwise matching, record-bound notices, `icao-purpose-upgrade` compares all
supplied variants at their highest supplied purpose. This does not claim knowledge
of which rendering arrived first or invent an NBO value when only B/BO exists.
Every original qualifier remains in the retained translations; subsequent sparse
or lower-purpose input cannot remove the higher-purpose evidence. The server does
not filter notices by a selected Q-purpose value. Unknown values (including K,
which is not part of this upgrade chain) and missing values do not participate in
this ranking; the existing optional-field comparison remains separate.

Both independent proofs may compose as `icao-qualification`. All other Q
components, headers, schedules and complete E/F/G content must agree. Purpose-only
comparison can preserve identical F/G fields; it cannot correct differing limits.
These decisions reconcile representations, without asserting that two original
Q strings are literally equal or publishing a synthesized FAA notice.

### Distribution material

The two supported terminal statements are:

- `UNITED STATES NOTAM OFFICE DISCLAIMS FOREIGN NOTAM ACCURACY OR COMPLETENESS`
- `UNITED STATES NOF DISCLAIMS FOREIGN NOTAM ACCURACY OR COMPLETENESS`

Whitespace can differ, and the statement can occur in the primary body, the
ICAO translation, or both. Segmentation consumes exactly one terminal statement
with nonempty preceding content. It never searches for a substring to delete.
An annotation following F/G is outside those fields; changed altitude values
still conflict. An annotation embedded within operational prose or before later
fields receives no special removal. Missing words, altered wording, added trailing
instructions and repeated disclaimers do not match the clean form.

Segmentation alone is not a proof. Each parsed translation must account for the
entire primary body, and all retained envelopes must agree under the comparison
policy. No translation is skipped because it fails parsing. Raw translations
remain retained; the selected body is one supplied original, usually the shorter
clean rendering. If no retained translation contains the disclaimer, selection
keeps an original annotated primary body so the disclaimer remains available.
This is an evidence-backed NMS distribution rule, not a claim that FAA Order
7930.2 grants general authority to strip E text.

## Bounds and conformance

Lexical views allow at most 262,144 UTF-16 code units and 32,768 tokens; ICAO
envelopes allow 32 locations/parts and body matching allows 32 complete copies.
Entity handling and compact field consumption preserve original offsets.
Incomplete parts, unsupported envelopes and exhausted bounds remain unresolved.
Wire/member/record limits and source issue truncation retain their existing
independent checks. SNOWTAM, ASHTAM, arbitrary AFTN wrappers and free-form editing
are not silently admitted as understood ICAO NOTAMN envelopes.

Server-scoped conformance coverage:

- `test/notams-structured-fields.test.ts`: set membership, exact UTC equivalence,
  precision and invalid-date rejection, source-value preservation through XML,
  third contradictions, independent identity progress and full-snapshot rebasing.
  `test/notams-composition.test.ts` combines these variations with all 256 masks
  of omission, identity, counter and representation changes across source profiles
  and lifecycle states, plus authenticated restore without clock/quota changes.
- `test/notams-omission-scopes.test.ts`: invented missing-year variants across
  DOMESTIC/FDC/INTL/MIL, captured LSU/VIO/FIM complementary scopes, independent
  header/A-field/validity/body-wrapper/format combinations, all delivery orders
  and batch partitions, sparse repeats, third contradictions, raw rendering
  retention/overflow and repeated authenticated restore with unchanged source
  clocks/quota. The composition suite combines the FIM roles with omissions,
  native/structured number padding, counters, UTC representations and cancellation;
  native headers are checked across modern and legacy conversions and surface
  designator proofs. International headers cannot supply a domestic number or
  authorize year supplementation through a misread suffix.
- `test/notams-state-machine.test.ts`: captured separator loss and association
  evidence, generated delivery orders and batch partitions, sparse/contradictory
  replay, lifecycle precedence, rebasing, fixed-end impact, rollback, HTTP caches,
  authenticated restart and isolated baseline/candidate release replay.
- `test/notams-revision-order.test.ts`: timestamp precision independent of
  counters, all three-variant delivery orders, changed operational facts,
  independent progress, full-sync replay, truncated evidence, cancellation and
  authenticated restart with unchanged source clocks and admission history.
- `test/notams-counter-evidence.test.ts`: captured DVV counter-only discrepancy,
  all retained translations, sparse/full replay, bounded paired provenance and
  a matrix of identity, validity, lifecycle and content contradictions.
- `test/notams-qualification.test.ts`: standards-derived closure subjects,
  generic-code replacement, every purpose ordering, combined proofs, confirming
  third-variant recovery in collection and filing-scope queries, retained disputed
  associations, nearest contradictions and authenticated restart with
  unchanged admission and source clocks. These constructed cases are explicitly
  distinguished from captured NMS evidence.
- `test/notams-source-comparison.test.ts`: captured OBBI variants, independent
  annotation placement, compact fields, entity encoding, altitude limits, changed
  Q components/headers/body/quality warnings, multiple retained variants, sparse
  replay, AIXM chunk decoding and authenticated restart with unchanged quota.
- `test/notams-representation.test.ts`: independent field spacing combinations,
  lexical spans, ordering, multipart completeness, RKTI correction, replay and
  HTTP publication/health after restore.
- `test/notams-fdc-continuations.test.ts` and `test/notams-reconciliation.test.ts`:
  native authority, retained conflict families, schedules, associations,
  cancellations, full-sync/delta and persistence behavior.
- Collection, admission, server and health tests enforce the unchanged owner,
  lifecycle, freshness and resource boundaries.

For a new family, first classify the discrepancy by this table. Add official
authority where available, complete retained evidence and tests spanning the
equivalence class and its nearest contradictions. Do not add airport/source-ID
exceptions, health exemptions, broad suffix deletion or arrival-order preference.
