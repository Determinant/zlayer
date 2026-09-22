# FAA 2609 approach evidence

These final local audit artifacts support [approach coverage](../../../../src/layers/routes/approach-coverage.md).
The retained JSON and images are unchanged; documentation cleanup does not
make their results a fresh verification. Embedded source and implementation hashes,
schema/policy versions and diagnostic assumptions remain authoritative for each run.

| Artifact | Recorded scope | Original filename |
| --- | --- | --- |
| [California JSON](california.json) | Every California chart/entry after the ordered-interpreter rebuild, policy 1; 1,648 offered entries pass. | `iap-redesign-2026-09-20.json` |
| [Arizona JSON](arizona.json) | Every Arizona chart/entry after the missed-return refinement, policy 2; 403 offered entries pass. | `iap-arizona-refined-2026-09-20.json` |
| [National diagnostics](national-diagnostics.json) | Policy-2 summary, unresolved-entry details, and the seven KIWA before/after changes. This is a diagnostic extract, not every passing national entry. | `iap-return-national-2026-09-20.json` |
| [Geometry panel 1](geometry-1.png), [panel 2](geometry-2.png) | Sixteen selected procedure depictions inspected during the interpreter rebuild. These are historical figures, not rendered views of a newer build. | `iap-redesign-2026-09-20-1.png`, `iap-redesign-2026-09-20-2.png` |

The companion CSV inventories were removed after checking all 607 California and
147 Arizona rows against the retained JSON. Every CSV field is recoverable from
the airport/chart records, entry counts and diagnostics; they contained no
additional findings or provenance. New audit runs still produce JSON and CSV in
the requested output directory; keep those working exports outside this folder.

The national comparison retains its old baseline filename as a historical identifier,
the baseline geometry hash and each changed entry's before/after diagnostics. The
superseded baseline payload was removed. Earlier source investigations, constraints,
remaining unmatched identities and reproduction commands are consolidated in the
coverage guide; raw trials and duplicate airport tables are not retained here.

The current [coverage summary](../../../../src/layers/routes/approach-coverage.md#recorded-faa-2609-results)
distinguishes geographic scope, all-offered-entry coverage, unoffered feeder starts
and the recorded radar/source-review exceptions. Later generated scans and
comparison reports live in ignored `tmp/`; their reporting classifications do not
modify these historical raw diagnostics.
