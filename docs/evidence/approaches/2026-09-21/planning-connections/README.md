# Connections across planning gaps

Known route points now connect in order across VTF entries, unresolved tokens,
procedure gaps and unmatched STAR/approach endpoints. The route composer records
these separately from resolved legs. Dotted blue lines display the connections;
terrain coverage includes them, schematic curves, holds and final extensions.
Source diagnostics remain available and route distance still uses resolved legs.

Existing fixed or schematic paths suppress extra chords. Airport bundle markers
do not introduce a return from a missed endpoint to the airport. Consecutive
approaches connect through their procedure endpoints, and intermediate airport
stops reached before a SID remain in the sequence. Unknown positions are never
invented; only known endpoints can be connected.

Validation:

- `npm test`: 1,311 passing tests (1,160 application, 17 contracts, 134 domain).
- `npm run check`, `npm run build`, and `git diff --check` passed.
- 43 browser cases passed across `route-approach.spec.ts`,
  `coded-terminals.spec.ts` and `terrain.spec.ts`. The two new VTF cases were rerun
  after correcting the test to account for the picker's isolated procedure view.
- Phone and desktop checks verify exact incoming VTF and onward gap endpoints
  after attachment and reload. The terrain worker renders shading along a route
  containing only gap connections, verified by a canvas pixel sample.
- Unit regressions cover missing tokens, coincident fixes, dateline wrapping,
  waypoint drags, alternative routes, STAR/approach joins, missing missed-approach
  intercept data, consecutive approaches and curved geometry without extra chords.

Screenshots:

- [VTF connections at 1280px](vtf-connections-1280.png)
- [VTF connections at 320px](vtf-connections-320.png)
- [Terrain across unresolved tokens](planning-connections-terrain.png)

This requires a client deployment. It does not change FAA data or require a data
rebuild, and it does not change the shared course-capture policy.
