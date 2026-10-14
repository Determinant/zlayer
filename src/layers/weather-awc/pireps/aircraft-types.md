# Aircraft type names

The PIREP heading preserves the source code and adds a readable name in parentheses
only for an exact recognized code. Lookup ignores case and surrounding whitespace;
it does not guess prefixes, equipment suffixes or similar codes. Missing/unmapped
types, `ZZZZ`, and AIREP/other report references receive no appended name. AIREP
references in the captured AWC feed are flight identifiers, not proven type codes.

`aircraft-types.json` bundles 2,704 names for offline display, about 87 KiB before
compression. This is the full 2,704-designator Appendix A of FAA JO 7360.1K, with
the unknown placeholder `ZZZZ` omitted and the active JO 7360.7 `EL2` addition.
It is a comprehensive snapshot of that FAA publication, not a claim to contain
every future or unassigned code. No per-report network request is needed.

The source code remains authoritative. A name labels the designator's aircraft
family, not the exact variant, engine, manufacturer/licensee of the individual
airframe, performance or wake category. The default is the first source-listed
manufacturer/model; reviewed choices favor familiar names for common families
and avoid overly specific PA-28, PA-32, Caravan and R-44 variants. Other source
aliases remain available in the FAA reference. Manufacturer casing is normalized
for reading; model spelling is preserved.

## Sources and regeneration

Retrieved and checked October 13, 2026:

- [FAA JO 7360.1K](https://www.faa.gov/documentLibrary/media/Order/FAA_Order_JO_7360.1K_Aircraft_Type_Designators.pdf),
  effective June 12, 2025; Appendix A, PDF pages 10–121.
  SHA-256: `64a709bf8863e177c3daffade253aa6362519186ba807943165f68490ee0c8fe`.
- [FAA JO 7360.7](https://www.faa.gov/documentLibrary/media/Notice/GENOT_N_JO_7360.7_Change_to_FAA_Order_JO_7360.1_Aircraft_Type_Designators.pdf),
  effective October 14, 2025; temporary FAA designator EL2, Electra EL-2.
  SHA-256: `bc659054b08e5b1d9fa63d8e4e78d925fdff1b380ef613ecbe6c0777429746e3`.

These are public U.S. government reference facts. The generated file contains
only designator names; it does not copy operational separation data.

From the repository root, download those two PDFs and run:

```sh
node tools/generate-pirep-aircraft-types.mjs /path/to/7360.1K.pdf /path/to/7360.7.pdf
```

The generator uses the existing PDF.js dependency, checks both source hashes,
reads the complete decode table in PDF reading order, rejects missing/duplicate
codes or preferred names, and verifies the expected count before writing. For a
new edition, inspect the tables and active amendments, update the pinned source
and layout/count checks, review changed labels, regenerate and run
`test/pirep-aircraft.test.ts` plus the PIREP browser checks. Do not silently accept
a changed PDF layout or replace this with a short hand-maintained list.
