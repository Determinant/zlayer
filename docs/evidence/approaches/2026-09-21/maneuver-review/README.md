# Policy 5 maneuver review

[Geometry policy](../../../../../src/layers/routes/approach-geometry.md#interpret-legs-in-sequence)
defines the implementation; [coverage and remaining cases](../../../../../src/layers/routes/approach-coverage.md#policy-5-maneuver-review)
retain the unresolved findings. [National comparison](national-comparison.json)
records source and implementation hashes, audit totals and all changed review
entries. The production code contains no airport-specific geometry exceptions.

The browser screenshots show the actual route source after preview, save and
reload. Their camera bounds include procedure geometry and omit the open VTF
extension so the maneuvers are legible. These fixture maps have a plain background.

The September 21 review inspected the complete FAA plates and these desktop/phone
renderings. The cases preserve the following source constraints:

| Plate | Desktop | Phone | Reviewed maneuver |
| --- | --- | --- | --- |
| [KVGT ILS/LOC 12L](https://aeronav.faa.gov/d-tpp/2609/06970IL12L.PDF) | [Image](kvgt-1280.png) | | Right turn from TUPUC captures LAS R-330 about 9.65 NM before LAS and follows it inbound to the hold. |
| [KPIH VOR 3](https://aeronav.faa.gov/d-tpp/2609/00327V3.PDF) | [Image](kpih-1280.png) | [Image](kpih-320.png) | Left heading change, PIH R-358 outbound climb, right direct return and hold. |
| [KSCH ILS/LOC 4](https://aeronav.faa.gov/d-tpp/2609/00382IL4.PDF) | [Image](ksch-1280.png) | | Initial climb, HEU outbound bearing, right return and hold. |
| [KLNK ILS Y/LOC Y 18](https://aeronav.faa.gov/d-tpp/2609/00232IYLY18.PDF) | [Image](klnk-1280.png) | | Coded 5.3 NM FC leg and right reversal before final. |
| [KPBF ILS/LOC 18](https://aeronav.faa.gov/d-tpp/2609/00901IL18.PDF) | [Image](kpbf-1280.png) | | Coded 7.9 NM FC leg and left reversal before final. |
| [KCOE ILS/LOC 6](https://aeronav.faa.gov/d-tpp/2609/00527IL6.PDF) | [Image](kcoe-1280.png) | [Image](kcoe-320.png) | Climb and COE R-350 outbound course remain visible before an unresolved return. |

Existing fixtures also check AF/RF arcs, radial/DME terminations, station
declination, procedure turns, repeated fixes and holds. A national probe found
no nontrivial fixed CF/TF/DF turn opposite its coded side; this is not a
plate-by-plate certification.

Recorded validation passed 1,316 unit tests (1,161 application, 17 contracts,
138 domain), import/type checks, the production build and all 53 focused browser
cases. Twelve maneuver cases were rerun for close screenshots at 320/1280 px.
Publisher-to-client and local publication checks passed against `faa-regs`
commit `7357768`. These results describe that build, not the current working tree
or a hosted deployment.

Checks, run from the repository root against the local FAA 2026-09-03 edition:

```sh
npm run check
npm test
npm run build
PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH=/run/current-system/sw/bin/google-chrome-stable npm run test:browser -- --output=/tmp/zlayer-review-browser test/e2e/route-approach-refinement.spec.ts test/e2e/coded-terminals.spec.ts test/e2e/terrain.spec.ts
node --import=tsx tools/verify-publisher-contracts.mjs ../faa-regs
node --import=tsx tools/verify-published-navigation.mjs ../faa-regs/dist/charts 2026-09-03 /tmp/zlayer-publisher.json
node --import=tsx tools/audit-terminal-coverage.mjs ../faa-regs/dist/charts/2026-09-03/nav /tmp/zlayer-terminal-audit.json
node --import=tsx tools/audit-iap-coverage.mjs ../faa-regs/dist/charts/2026-09-03 /tmp/zlayer-iap-audit.json '*'
```

The application/contracts suites passed together; the domain suite was rerun
after updating its obsolete discard-prefix assertion, and all 138 cases passed.
The final type check and build then passed. No publisher rebuild is required for
these drawing changes; delivering them requires the normal zlayer client release.
