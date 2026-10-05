# NOTAM semantic and mapped-content audit — 2026-10-05

This follows the [earlier structural audit](2026-10-05-structural-audit.md).
It documents local code and retained FAA data, not a deployed release or universal
operational qualification. [Machine-readable evidence](2026-10-05-semantic-audit.json)
records counts, generation checks and source hashes.

## Fixed findings

- Five previously identified KMDW/PHOG wind-turbine and KSAT/KSAV international
  crane lighting outages now retain **Obstacle Light Outage** in their mapped
  entries. Associated bare airport prefixes are recognized without changing
  source classification or inferring an unrelated location.
- Mapping no longer clears an entire standalone obstacle body. It removes the
  validated location description and retains marking/lighting state, negations,
  schedules, exceptions and further operational instructions. Only an exact
  unconditional status already represented by a badge may be omitted. An unknown
  annotation inside the location description prevents that interpretation.
- Explicit DAL JETS/PROPS takeoff branches keep separate aircraft/runway scopes;
  MIA's fully labeled staged climb retains its gradient/altitude sequence; APA's
  `OR DEPARTURE NA` retains the prohibition; ONT's value-before-RVR ordering keeps
  DA, HAT and visibility in the correct row and category scope.
- Unsupported conditional introductions prevent later numeric clauses from being
  promoted into operative-looking rows or badges. Missing altitude types, missing
  gradient units, unlabeled RNP scope, ambiguous radio-altitude shorthand and
  broken multipart clauses still remain visible prose. They are negative semantic
  cases, not inferred values or successful structural coverage.

## Coverage and methods

The same 108-airport cohort (FAA passenger top 100 plus eight GA airports) was
captured at 20:39:41Z and 20:47:21Z. Each contained 8,026 retained IDs. The audit
checks every record and actual React output; all 1,361 mapped entries additionally
receive independent deletion and mapped-render checks with raw disclosures excluded.
No preservation, rendering or supported field-binding failures remain in either
capture. There are 1,024 notices with numerical structure and 5,918 entirely prose
notices; prose preservation is not full interpretation.

The numerical audit now independently checks label/value and category bindings,
approach scope, runway identity, aircraft branches, climb-stage order and declared
distances. Mutation tests substitute the same set of numbers under wrong labels,
swap category scopes and stage order, or delete mapped qualifiers; these must fail.
This is stronger than the earlier numerical/lexical multiset checks, which remain
useful for untouched prose and conditions but do not establish applicability.

There are 45 captured golden cases across the existing corpus and
`test/fixtures/notams-semantic.json`, with manually specified expectations. The
follow-up includes obstacle lighting/marking, communications/service outages,
inner-marker versus ILS failure, qualified closures, bird activity, STAR altitude
and speed changes, VFP applicability, route aircraft restrictions and mapped
UAS/military-airdrop altitude limits. Existing tests cover minima, takeoff,
declared distances, note actions, missed approaches, GPS altitude-dependent
footprints, schedules and unsupported grammar. Unknown families still fall back
to complete prose; this is not an exhaustive manual review of 8,026 notices.

Local validation: 79 focused Node tests and `npm run check` passed. Browser checks
cover all 27 NOTAM scenarios across the main run and targeted reruns, including
320 px/desktop aircraft and staged-climb layouts in both themes, raw disclosure,
map lifecycle, and airport/plate hosts. The added screenshots were inspected for
alignment and wrapping. Full verification was not run, as requested.

## Temporal qualification remains open

Both downloads contained the same generation
`044a92ceded9ea3202ce70d52b30cfcb27ef1413d88bbea84b0f2d4313aee2aa`, checked at
18:27:23Z, with degraded/incomplete `revision-conflict` health. The second capture
added **zero** record versions. These are two captures of one retained generation,
not two fresh generations. The audit cannot establish upstream completeness.

`tools/audit-notam-generations.ts` now enforces the missing qualification: at least
two distinct, fresh, complete source generations for the same airport cohort,
with no semantic/preservation errors. It rejects repeated, stale, future-dated,
degraded and mixed-generation captures, and reports genuinely new record versions.
Synthetic lifecycle cases test that gate but are not counted as live evidence.
The actual two-capture report correctly exits unsuccessfully with zero qualifying
fresh generations. Complete this live check after production collection advances;
do not relabel repeated downloads as new evidence.

Scratch captures and reports are under `/tmp/zlayer-notam-semantic-20261005-{a,b}`
and `/tmp/zlayer-notam-semantic-generations.json`. Browser artifacts are under
`test-results/notam-semantic`, `notam-semantic-layout` and `notam-semantic-long`.
The [owning guide](../README.md#broad-airport-presentation-audit) gives repeatable
commands and separates implemented behavior from this dated qualification.
