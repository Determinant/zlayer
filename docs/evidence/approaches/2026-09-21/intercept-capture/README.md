# Early course capture: KVGT and shared geometry

The KVGT ILS/LOC 12L missed approach reaches TUPUC/LAS 10 on R-310,
then turns right to follow R-330 inbound to LAS and hold. The
[FAA 2609 plate](https://aeronav.faa.gov/d-tpp/2609/06970IL12L.PDF)
and the local SW4 book, zero-based page 396, were inspected.

The previous shared `joinCourse` helper fixed its capture point at 1 NM before
the terminating fix, then minimized the total arc/straight/arc join length.
That needlessly delayed establishing the radial. Policy 4 selects the shortest
acceptable path **before capture**, then follows the defined inbound course.
It preserves the incoming direction, coded turn side, bounded schematic radius,
forward course and terminating fix. Candidates that cross the preceding
schematic chain remain unacceptable; unresolved joins remain gaps.

| KVGT depiction | Policy 3 | Policy 4 |
| --- | ---: | ---: |
| Distance from LAS when established on R-330 | 1 NM | 9.648 NM |
| Coded initial turn at TUPUC | Right | Right |
| Inbound true course, using LAS station declination | 165° | 165° |
| Geometry classification | Schematic | Schematic |

These dimensions describe drawing policy, not an aircraft performance model.
No airport-specific production rule was added. Prescribed headings, altitude
conditions, radial/DME terminations and procedure-turn bounds remain intact.
The change applies wherever approach, missed-approach, SID or STAR geometry
uses the shared free-course join. It requires a client update, not new FAA data.

## Validation

- All 1,309 client unit tests passed: 1,158 application, 17 contracts and 134 domain.
- General regressions move the terminating fix farther along the same course
  and verify that capture stays near the maneuver. Cases cover both turn
  directions, three course orientations and three locations including the date line.
- The real KVGT fixture verifies early radial capture, station declination,
  entering heading/right turn, source legs, unchanged holding fix and schematic
  exclusion from route distance.
- All 51 approach and coded-terminal browser cases passed. KVGT's early capture
  is checked during preview, after adding to the route and after reload at both
  320 px and 1,280 px. The [desktop](kvgt-1280.png) and [phone](kvgt-320.png)
  screenshots were inspected.
- TypeScript/import checks and the production build passed.
- The national terminal audit found no newly affected review choices. Existing
  review choices decreased from 294 to 292; the two resolved cases are KMSO
  GRZLY4/RW12 and KLMT CRATR1/RW32.
- Independent national chart screening retained 34,214 offered chart/entry
  combinations and the same 134 entries with diagnostics. Eight previously
  flagged crossing depictions at KCOE and KLAN now produce explicit gaps when
  no acceptable candidate remains. No warning entry is marked complete.

[National comparison](national-comparison.json) records exact source and
implementation identities, before/after totals and changed diagnostics. The
source fixture is [approach-course-capture.json](../../../../../packages/domain/test/fixtures/approach-course-capture.json).
All builds and browser checks were local; this change has not been deployed.
