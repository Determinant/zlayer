# Deployment readiness

ZLayer builds to a static `dist/`; it has no runtime application server or dependency
on a local `faa-regs` checkout. App code, lazy viewers, PDF.js/MapLibre/SQLite workers,
WASM, UI fonts and icons are bundled locally and precached by the production service worker.
`tools/dev-proxy.ts` is development tooling, not part of the deployment.

Static application assets do not eliminate data-hosting requirements. Production
hosts must provide the following hosting contract:

| Request | Production requirement |
| --- | --- |
| Chart, navigation, TPP and CS feed | Set `VITE_ZLAYERS_CHART_ROOT` to a readable chart feed. A same-origin `/chart-data` prefix needs a static mapping or proxy, including `cycles.json` for discovery. Cross-origin feeds need chart-host CORS. |
| `/faa-procedures/<cycle>/<filename>.PDF` | Narrow proxy to `https://aeronav.faa.gov/d-tpp/<cycle>/<filename>.PDF`. Restrict cycles to four digits and filenames to the existing development rule; never expose an arbitrary URL relay. Preserve query parameters. |
| `/weather/metars.geojson` | Proxy to `https://aviationweather.gov/api/data/metar`, preserving query parameters. This supplies live METARs; failures must leave cached observations usable and visibly stale. |
| `/weather/tafs.json` | Proxy to `https://aviationweather.gov/api/data/taf`, preserving query parameters (`ids`, `bbox`, `format=json`) for selected and bounded nearby stations. Configure the route before publishing the TAF UI; frontend deployment alone does not add it. |
| USGS terrain basemap | External raster service; only viewed resources are cached. Regional downloads do not promise offline basemap coverage. Review provider terms before public release. |
| Terrain elevation | Prefer the chart feed's `terrain/manifest.json` and versioned USGS 3DEP packages; regional saves include published packages at supported DEM zooms. Without a packaged source, use Mapzen Terrarium tiles on AWS or `VITE_ZLAYERS_TERRAIN_TILE_URL`; a replacement must provide readable 256px Terrarium PNG tiles. Elevation is independent of the basemap, and fallback PNG coverage is not a regional offline guarantee. See [terrain](route-terrain.md). |
| FAA obstructions | Optional chart-feed `obstacles/manifest.json` and its compressed Daily DOF export. Cached on demand, independently versioned, and outside regional offline completeness. See [obstructions](route-obstructions.md). |
| GPS aircraft | Device Geolocation API on HTTPS with user permission. No location backend is required; provider availability and installed-device behavior need separate checks. |
| Experimental AHRS | Device Motion API on HTTPS, with explicit permission where required. Shared GPS supports aiding and GPS instruments; a fix is optional for calibration and live attitude under the [warning cross](../src/layers/ahrs/README.md#calibration-and-validity). Optional WMM coefficients come from the chart feed; without a usable model the HSI uses true north. Sensor and flight behavior need separate validation. |
| Map-label glyphs | Identifier-label glyphs are bundled locally and precached with the shell. Custom external map styles may have additional dependencies. |

Use a same-origin chart prefix or verify that the feed permits the application's
origin through CORS. A successful HTTP response alone does not establish browser
readability; cross-origin deployments must verify the response headers.

Individual FAA PDFs are not merely a temporary missing-upload fallback: the current
catalog includes military HIGH procedures without bound-book pages. Regional saves
include them. A working FAA proxy is required to finish those downloads and to view
uncached individual plates. Neither environment variables nor uploading `dist/`
creates that proxy automatically.

## Static-host contract

- HTTPS, with the app and service worker served at the origin root.
- Correct MIME types for `.js` and `.mjs` (JavaScript), `.wasm`
  (`application/wasm`), and `.webmanifest` (`application/manifest+json`).
- Revalidate `index.html`, `sw.js`, and the web manifest. Hashed assets can be immutable.
  Return real errors for missing assets/data, not the SPA's HTML fallback.
- Publish all assets before switching the shell, and retain previous hashed assets
  for clients finishing updates. Service-worker installation precaches a complete
  shell atomically; it does not clear chart or PDF caches on release.
- Preserve whole-file MBTiles delivery. The service worker serves SQLite ranges from
  verified cached files; the host must not turn this into per-tile fetching/storage.
- Serve the feed root's `cycles.json` with revalidation. The default Latest
  mode discovers new supported FAA dates without rebuilding the frontend. The
  existing `/chart-data/` prefix serves this file without directory listing.
  Explicit date choices stay pinned; all saved downloads remain independent by date.
  `VITE_ZLAYERS_CHART_REVISION` is an optional initial date override.
- Provide the corresponding source for the deployed build as described in the
  [license and source requirements](../README.md#license), including build scripts
  and any local source changes.

## Verification and remaining release gates

Run `npm run verify`, `npm run test:browser`, the
[graphics matrix](graphics-compatibility.md#run-the-checks) and
`npm audit --omit=dev` before release. The full browser suite uses Chromium and a
production build with synthetic FAA/PDF/DEM/weather fixtures. Targeted graphics,
terrain, GPS rendering and plate cases also run in Firefox and WebKit, including
2× WebKit on Linux/macOS CI. Configured CI coverage is not evidence of a passing run.

These remain release gates:

- Installed iOS/Android airplane-mode cold launch, large-book rendering,
  interrupted downloads, process termination and low-storage recovery:
  [offline checks](offline-storage.md#release-checks).
- Actual GPS movement, first-use permission, denial/recovery and background return:
  [GPS checks](gps-aircraft.md#release-verification).
- AHRS motion permission, calibration with no GPS fix, sensor orientation,
  suspension/recovery and instrument behavior on physical devices. Verify moving
  attitude beneath the cross with no fix, low-speed GPS and prolonged high tilt
  uncertainty; usable GPS should clear the cross only once tilt uncertainty is
  acceptable. Simulation and desktop emulation do not establish flight accuracy;
  see the [AHRS policy and limits](../src/layers/ahrs/README.md#calibration-and-validity),
  [statistical/reference validation work](ahrs-validation.md#remaining-validation-work)
  and [combined-resource scrolling checks](memory-resources.md#ahrs-session-memory-and-scrolling).
- Full reset on installed devices, including other open windows, interruption and
  offline completion; confirm a fresh online start afterward.
- Real keyboards, folding/rotation, PDF gestures and physical GPU behavior:
  [responsive checks](responsive-checks.md) and
  [graphics device checks](graphics-compatibility.md#device-verification-boundary).
- Reference-device startup, total memory, interaction and battery measurements:
  [product budgets](product.md#performance-and-quality-budgets). The reporting Android
  device still needs direct confirmation of the terrain precision fix.
- Live HTTPS checks after each publication: MIME/cache headers, service-worker scope,
  chart discovery, METAR/TAF and individual PDFs. Check the TAF route with
  `node --import=tsx tools/check-taf-proxy.ts https://your-app.example`.
  Missing assets and malformed proxy paths must return errors rather than app HTML.

The shell precaches lazy viewers, workers and fonts. PDFs use local Blob ranges and
bounded canvases; integrity checks stream in bounded chunks and reuse matching PDF
receipts. These limit application allocations, but do not measure browser storage,
PDF.js or GPU memory on devices. See [offline storage](offline-storage.md#storage-contract).

## Recorded local verification

These local records apply only to the build and environment tested, not subsequent
working-tree changes or any production host. Preserve their dates when comparing
test counts, measurements or release evidence.

The 2026-09-20 commit-readiness check ran `npm run verify:full` in
`mcr.microsoft.com/playwright:v1.63.0-noble`, using Node 24.20.0, Chromium
153.0.8010.12, WebKit 26.6 and Firefox 155.0:

- Import boundaries, TypeScript checks, all 1,231 unit tests and the production
  build passed.
- The complete Chromium suite passed 502 of 504 cases. Both failures were test
  defects: the regional-rendering expectation omitted the new incomplete-tile
  count, and a pinch check captured coordinates before the shared panel finished
  sliding. After correction, the regional case passed; all five Chromium pinch
  cases passed three consecutive repetitions, retaining their precision checks.
- The subsequent Chromium, WebKit and Retina WebKit graphics matrix passed 121
  cases with two existing skips. Firefox passed 40 with one existing skip. The
  three skips cover native multitouch injection, which requires Chromium's CDP;
  shared gesture handling ran on every engine.
- `npm audit --omit=dev` reported no known production dependency vulnerabilities.
  Documentation checks found no broken targets among 287 local links, including
  80 heading links, across 56 Markdown files. Tracked changes and new text files
  passed whitespace checks.

Application sources, fixtures and build inputs stayed unchanged during this run
and its focused reruns. Only the two browser specs above were corrected after the
full run began. The full command therefore exited with a failed Chromium stage;
it was not rerun end to end after those test-only corrections. The passing evidence
combines the full run, the focused reruns and the subsequent graphics matrices.

A 2026-09-16 production-build check resolved all 54 feed-covered regions without
missing-book warnings. Alabama saved 188 files (358.7 MiB), including KMGM's
individual-only plates; reverification transferred no chart/PDF files. With the
origin disconnected, Chrome restored search, charts and PDF.js plates/supplements.

The 2026-09-17 local build measured the main chunk at approximately 453 kB minified /
144 kB gzip, and the separately hashed, module-preloaded boundary topology at 1.29 MB /
503 kB. These are dated build measurements, not current bundle sizes or device budgets.
That build passed `npm run verify` and 79 Playwright cases using
`PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH`. Splitting topology kept its hash stable across
UI edits and removed the warning at the 1,300 kB threshold; it did not materially
reduce total initial download size. The topology remains in the offline shell.
New builds must report their own sizes.

All performance observations above used desktop Chrome mobile emulation, not physical
mobile hardware. [Responsive checks](responsive-checks.md#plate-modal-regression-checks)
records the plate profile's method; [graphics compatibility](graphics-compatibility.md)
records pixel regressions and benchmark limits. Local verification does not deploy a
release, and a server rollback does not roll back browser storage.

Storage is per origin; localhost downloads do not migrate to the production hostname.
Saved regions and open views protect their shared files from the app's 14-day temporary
cache cleanup. Site-data deletion can still erase them. Bulk offline basemap coverage
and automatic cycle migration remain outside the current contract; see
[offline storage](offline-storage.md).
