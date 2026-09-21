# Zlayer commit and IAP depiction review — 2026-09-21

The current chart/navigation changes are ready to commit after the fixes below.
The shared interpreter, terminal composer, versioned data contracts and shared
map/terrain consumers form a coherent boundary; another rewrite is not warranted.
The earlier [chart/nav review](chart-nav-2026-09-21.md) covers the wider cleanup.
This pass checked the current diff, geometry policy, source identity and offline
coverage boundaries, persistence, route composition, rendering and terrain.
No commit, push or deployment was performed in this review.

## Findings fixed

1. **An FA climb could follow a parallel heading instead of its referenced
   outbound course.** The shared tangent solver now supports both inbound and
   outbound rays. FA captures its course before extending the illustrative climb.
   IAP CI/VI legs can also join outbound FA/FM courses, using the same interpretation
   already used for SIDs and STARs. There are no airport-specific production rules.
2. **A failed later intercept discarded the known IAP climb/turn prefix.**
   Approaches now retain finite open schematic spans just like SIDs and STARs.
   The dotted planning connection continues from the open endpoint to the next
   known waypoint. It no longer bypasses the preserved maneuver. Both portions
   enter terrain coverage; the unresolved portion retains its diagnostic and
   contributes no calculated route distance or invented holding arrival course.
3. **The detour heuristic penalized prescribed outbound legs and reversals.**
   It now allows the distance required by FC legs. The independent chart audit
   checks that the source outbound distance is actually drawn before granting
   this allowance. Long paths with unaccounted-for detours remain reviewable.

Policy is now version 5. The existing earliest practical inbound-capture rule is
unchanged: minimize the distance before capture while preserving the incoming
course, coded turn side, bounded drawing radius, forward ray and endpoint.
Prescribed headings and outbound distances take precedence over this objective.
Radius arcs, procedure turns and holds retain their distinct constructions.

## Maneuver checks

| Case | Checked behavior |
| --- | --- |
| [KVGT ILS/LOC 12L](https://aeronav.faa.gov/d-tpp/2609/06970IL12L.PDF) | The right turn from TUPUC still captures LAS R-330 about 9.65 NM before LAS and follows it inbound to the hold. |
| [KPIH VOR 3](https://aeronav.faa.gov/d-tpp/2609/00327V3.PDF) | Retains the left heading change, PIH R-358 outbound climb, right direct return and hold. |
| [KSCH ILS/LOC 4](https://aeronav.faa.gov/d-tpp/2609/00382IL4.PDF) | Retains the initial climb, HEU outbound bearing, right return and hold. |
| [KLNK ILS Y/LOC Y 18](https://aeronav.faa.gov/d-tpp/2609/00232IYLY18.PDF) | Retains the coded 5.3 NM FC leg and right reversal before joining final. |
| [KPBF ILS/LOC 18](https://aeronav.faa.gov/d-tpp/2609/00901IL18.PDF) | Retains the coded 7.9 NM FC leg and left reversal before joining final. |
| [KCOE ILS/LOC 6](https://aeronav.faa.gov/d-tpp/2609/00527IL6.PDF) | Preserves the climb and establishes COE R-350 outbound. The later constrained return still has an explicit gap; the dotted continuation starts at the outbound endpoint. |

Whole FAA plates and desktop/phone renderings were inspected. Existing regression
fixtures also verify AF/RF arc geometry, radial and DME terminations, station
declination, procedure-turn extent, repeated fixes, holds and the KVGT capture.
A national probe found no nontrivial fixed CF/TF/DF turn opposite its coded side;
that probe does not certify every rendered turn against every plate.

## Remaining limits

The national interpreter audit covers 37,836 entries across 10,234 coded
approaches. It still reports diagnostics for 187 entries, down from 201, with no
newly flagged entries. These are a mix of missing references, unsupported source
legs and geometries the current policy cannot resolve. SID review entries remain
91; STAR review entries remain zero. Manual terminations are counted separately.

KCOE's full climb/return needs further geometry work; preserving its prefix does
not make the return complete. KLAN ILS/LOC 28L also retains a gap: the inspected
[plate](https://aeronav.faa.gov/d-tpp/2609/00224IL28L.PDF) specifies a left missed
turn, while the local CIFP export has a valid right-turn constraint on the CF to
UNSUN. This discrepancy needs source-level investigation. The interpreter does
not silently override it. KLPR ILS/LOC 7 still carries a crossing-review warning
for its successive left turns. These are documented limitations, not newly
introduced regressions.

The magenta line is a planning depiction. Altitude-terminated distances and turn
radii remain illustrative; they are not calculated from aircraft performance.
The general strategy preserves key maneuvers where supported and shows partial
knowledge and gaps explicitly elsewhere. No claim of complete national
plate-equivalent geometry follows from source-record completeness.

## Validation

- 1,316 unit tests pass: 1,161 application, 17 contracts, 138 domain.
- TypeScript/import checks and the production build pass.
- All 53 approach-refinement, coded-terminal and terrain browser cases pass.
  Twelve maneuver cases were rerun for closer screenshots at 320 and 1,280 px.
- The national source audit accounts for all 201,076 primary terminal legs and
  6,744 continuations. Fourteen previously flagged approach entries now resolve;
  none are newly flagged.
- Independent chart screening covers 34,214 chart/entry combinations. Warning
  entries decreased from 134 to 125; zero warning entries are marked complete.
- Publisher-to-client contract checks and the real local publication integrity,
  association and supplement-coverage checks pass against faa-regs commit 7357768.
- `git diff --check` passes.

The unit failures encountered during review were three older assertions requiring
an entire missed depiction to disappear after a gap. They now assert that only a
known open prefix survives and that the unresolved return remains incomplete.

[Evidence and reproducible commands](../evidence/approaches/2026-09-21/maneuver-review/README.md)
include source/implementation hashes, national before/after results and screenshots.
