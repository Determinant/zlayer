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
| 3. Apply positive lifecycle evidence | At equal ordering, a qualified original-ID cancellation timestamp takes precedence over omission of that optional timestamp. A replacement/cancellation notice's textual reference alone does not authorize deleting another NMS ID. | Implemented with identity, lifecycle and time guards in `revision.ts`. |
| 4. Prefer a demonstrated native witness over its conversion | When both DOMESTIC/FDC variants contain the same complete, record-bound native notice, use that witness to reconcile auxiliary conversion differences. A `LOCAL_FORMAT` or `OTHER:ICAO` label alone supplies no authority; an INTL translation is not automatically inferior to structured XML. | Implemented for the documented native-notice grammars; all structured operational fields still undergo comparison. |
| 5. Resolve a qualified coding discrepancy | Use a complete operational statement to establish a dependent coding value only through a named, bounded rule. Require record-bound envelopes and agreement on all unaffected fields. | Implemented for the four closure subjects, QXXXX replacement and supplied purpose-upgrade chain below. Other code/qualifier corrections are not implemented. |
| 6. Supplement a demonstrated omission | A supplied optional association, reference, translation or schedule may supplement an absent value only under that field's existing compatibility rule. Two supplied, different values are not an omission. A nil/unknown value must not silently become an asserted fact. | Implemented for the documented optional-field cases; there is no generic nonempty-field-wins merge. |
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
  supplied unequal operational times remain conflicting.
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

The former sequence/correction tie-breaks have been removed. Both values remain
raw, validated comparison fields. Tied active variants with different counters
remain an explicit `revision-conflict`, even if their prose agrees. A higher
counter cannot hide operational differences, erase bounded/truncated evidence,
or clear a conflict during bulk reconciliation or authenticated restore.
Independent notices continue advancing. A genuinely later NMS update supersedes
the entire older source-time group, including when its counters decrease.

Positive original-ID cancellation evidence retains its separate qualified
precedence at the same source time. Thus a higher sequence or correction number
alone cannot resurrect a cancelled notice. Existing inactive-record handling also
remains independent of any presumed AIXM counter ordering.

This snapshot adapter does not reconstruct general AIXM feature histories or
claim to apply same-slice corrections without feature identity and TimeSlice
context. The ordering decision no longer depends on that missing context. Adding
a future temporal interpreter would require its own retained context and contract;
it is not an outstanding assumption in the current comparator.

No wire or generation-schema migration is needed. Old snapshots remain readable,
and saved source clocks and admission journals are unchanged. Previously discarded
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

## Processing stages

1. `representation.ts` creates bounded lexical views with original token offsets
   and parses local/ICAO envelopes through field states. No acquisition, record
   precedence or correction policy belongs in that parser.
2. `notice-evidence.ts` accounts for the whole record body and **every** retained
   rendering. It distinguishes equal enclosing text from a notice whose identity,
   location, interval and schedule also bind to the structured record.
3. `notice-comparison.ts` applies the evidence rules below;
   `notice-qualification.ts` owns the standards-based Q-code and purpose rules.
   Comparison selects an original body and reports the proof and failure kind.
   It never writes a corrected Q line, invents a body or advances source time.
4. Server `revision.ts` independently compares the remaining structured fields,
   then merges qualified evidence. `collection.ts` retains unresolved variants;
   `store.ts` authenticates and replays them on restore. Health derives from that
   same result, without a separate allowance for an inconvenient conflict.

Batch merging defers initially conflicting pairs and retries them once against
the evidence admitted from the rest of the batch. A confirming third rendering
can therefore complete a proof even when its digest sorts last. Every deferred
variant still has to pass the ordinary rules; failed comparisons remain explicit
issues. This is a bounded evidence retry, not an arrival/digest precedence rule.
Filing-scope projection uses this same batch resolver after checking that every
variant has the same source identity and revision. It excludes only the disputed
ICAO associations from comparison; a later confirming witness can establish the
agreed content without granting a disputed alias or clearing the durable issue.

Evidence caches use record-object identity and retain compact content only, not a
second national dataset of token graphs. Records are treated as immutable.

## Field and transformation rules

| Field/evidence | Permitted comparison | Required evidence / rejection boundary |
| --- | --- | --- |
| Source ID and revision | NMS ID alias and timestamp ordering through nanoseconds | Counter values remain evidence, not tie-breakers; equal source time still requires content/lifecycle proof |
| Record identity, location, lifecycle, effective interval | Existing exact/qualified rules in `revision.ts` | A text proof cannot erase a differing structured value or cancel another source ID |
| Translation lexical form | Whitespace and observed literal outer `<pre>` | Preserve punctuation, case, unknown markup and literal entity spelling at baseline |
| XML references | Exactly one layer of the five XML entities and valid non-whitespace numeric references | Complete shared notice/body evidence; no recursive decoding, control-reference tokenization or standalone body guessing |
| ICAO field spacing | Attached or spaced values at the expected Q/A/B/C/D/E/F/G state | No global marker replacement inside E prose; reordered/duplicate fields fail |
| ICAO whole/multipart body | Exact complete parsed contents; at most 32 complete primary-body copies | All identities, headers, part counts and closing markers agree; no missing/duplicate parts or partial repeated sentences |
| Complete enclosing ICAO notice | Same identity, reference, all eight Q components, A/B/C/D/E/F/G across every retained rendering | Each primary body matches its own envelope in full; reports `icao-notice` when record-bound, otherwise `icao-rendering` |
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

- `test/notams-revision-order.test.ts`: timestamp precision independent of
  counters, all three-variant delivery orders, changed operational facts,
  independent progress, full-sync replay, truncated evidence, cancellation and
  authenticated restart with unchanged source clocks and admission history.
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
