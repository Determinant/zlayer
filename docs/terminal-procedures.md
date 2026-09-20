# SID/STAR route previews

The optional NASR manifest product `terminal-procedures` points to
`nav/terminal-procedures.json` (`ZLayerTerminalProcedures`). FAA DP/STAR BASE, APT
and RTE tables supply identities, airport associations and ordered typed points.
The contracts package validates cycle, identity and ordering; the domain package
expands procedures independently of React and the map renderer.

For example, `KSJC SPTNS1 VLREE EBAYE BURGL ELLBC OHSEA3 KSNA` selects the VLREE
departure transition and ELLBC arrival transition. Dotted filing notation works
too: `SPTNS1.VLREE` and `ELLBC.OHSEA3`. The input retains its compact procedure
tokens; implicit points appear on the map and cannot be dragged as independent
route entries. Recommendation previews use the same resolver.

A SID must follow its served departure airport; a STAR must precede its served
destination. An adjacent explicit fix selects the enroute transition. Without a
runway/branch selection, only the common departure suffix or arrival prefix is
shown; divergent portions are omitted with a warning. The resolver never selects
a runway by proximity, wind or source ordering. Runway selection is not implemented
yet. Missing/invalid transitions, unavailable typed fixes and explicit source
discontinuities leave gaps rather than inventing connections.

These are dashed **waypoint-route previews**, not flight-guidance paths. NASR does
not supply the complete leg coding needed here for vectors, arcs, turn anticipation
or altitude/speed constraints. Airport-to-procedure connections are not invented,
and preview distance must not be presented as a complete airport-to-airport total.
Consult the plates; exact procedure geometry would need a leg-aware source such as
FAA CIFP and a separate rendering model.

The national file is fetched lazily for route planning and cached whole, once per
versioned URL, using the same validation and durable cache as regional downloads.
Every newly saved region includes this shared reference when published; auto-cached
copies are reused, not downloaded per procedure, point or rendered tile. Re-saving
an older region adds the new reference without re-fetching its verified chart files.

To publish support, run `npm run build:nav` in faa-regs and upload the complete
cycle's `nav/` directory, including its new manifest. No MBTiles/TPP rebuild is
needed. Existing feeds without the product still work, but cannot expand SIDs/STARs.
Online builds select the current FAA cycle. A local dated rebuild requires
`--source-dir=/path/to/zips --cycle=YYYY-MM-DD`, with APT, FIX, NAV, AWY, PFR, DP
and STAR source groups available. The former `build:nasr` command has been renamed.

Source: [FAA 28-day NASR subscription](https://www.faa.gov/air_traffic/flight_info/aeronav/aero_data/NASR_Subscription/).
The test fixture is a subset of the September 3, 2026 SPTNS1 and OHSEA3 records.
