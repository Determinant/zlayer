# Policy 5 maneuver review

[Review findings](../../../../reviews/iap-depiction-2026-09-21.md) explain the fixes
and remaining limitations. [National comparison](national-comparison.json)
records source and implementation hashes, audit totals and all changed review
entries. The production code contains no airport-specific geometry exceptions.

The browser screenshots show the actual route source after preview, save and
reload. Their camera bounds include procedure geometry and omit the open VTF
extension so the maneuvers are legible. These fixture maps have a plain background.

| Case | Desktop | Phone |
| --- | --- | --- |
| Early inbound capture | [KVGT](kvgt-1280.png) | |
| Known prefix with unresolved return | [KCOE](kcoe-1280.png) | [KCOE](kcoe-320.png) |
| Outbound radial and directed return | [KPIH](kpih-1280.png) | [KPIH](kpih-320.png) |
| Outbound bearing and directed return | [KSCH](ksch-1280.png) | |
| Published right reversal | [KLNK](klnk-1280.png) | |
| Published left reversal | [KPBF](kpbf-1280.png) | |

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
