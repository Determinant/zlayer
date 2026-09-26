# Local development

[Documentation](../README.md) / Development

The root package owns the PWA and `tools/weather-server/`, a small Node 24 TypeScript
cache gateway. Only `packages/contracts` and `packages/domain` are npm workspaces.
Vite's local forwarding rules live in `tools/dev-proxy.ts`.

## Contents

- [Run and configure](#run-and-configure)
- [Data and proxies](#data-and-proxies)
- [Compatibility traps](#compatibility-traps)
- [Verification](#verification)

## Run and configure

Use Node.js 24 or newer. `npm ci` installs the committed lockfile; use `npm install`
when intentionally changing dependencies.

```bash
npm ci
npm run dev
npm run verify
```

Run from the repository root. Vite reads `.env` and `.env.local` there; see
[.env.example](../../.env.example). Vite listens on port 4173 with strict port selection.
`npm run build` writes static `dist/`.

```bash
VITE_ZLAYERS_CHART_REVISION=2026-09-03 npm run dev
VITE_ZLAYERS_CHART_ROOT=https://example.test/charts npm run dev
```

Development defaults to `/chart-data`, proxied to `https://charts.tedyin.com/charts`;
production defaults to that chart origin directly (requiring CORS). Blank or `latest`
`VITE_ZLAYERS_CHART_REVISION` discovers dates from that root's `cycles.json` and defaults
to the latest supported release. An explicit date sets the initial preference; the
FAA data cycle menu under Settings → General can pin any published or saved edition
and return to Default · Latest. Reload after publishing new dates/files; no client
date list or rebuild is needed. Publication layout, manifest fallback
and cache identity rules belong in the [chart-feed contract](../data/chart-feed.md).

On first launch, the camera centers KPAO at zoom 9, independently of feed ordering;
after that, center, zoom, bearing and pitch are restored, including when refresh
interrupts camera movement. Panel visibility, selected airport/tab, recommendations
and the plate reader also resume; see the [workspace persistence contract](../data/contracts.md#workspace-persistence).
Chart bases, overlays, fix display, FAA/METAR switches, terrain visibility/scope/altitude mode,
obstruction visibility and GPS
visibility restore from each plugin’s `zlayer-plugin:<id>:preferences` record
(localStorage schema version 2) before map creation, including offline. The former
`zlayers-map-preferences-v1` record migrates into those scopes on read. Historical
`VITE_ZLAYERS_*` environment names remain supported.
Invalid preference fields default independently; unavailable chart choices fall back
without overwriting the saved choice, and denied storage leaves session controls usable.
These preferences are per origin, not cookies or cross-device sync. Legacy terminal/
flyway choices become sectional plus that overlay; base-map-only stays off.
See [layer plugins](../architecture/layer-plugins.md) and [fix display](../../src/layers/navigation/fix-display.md) for display rules.
Route drafts use `zlayer-plugin:routes:draft` with version 2 entry records, migrating
the former `zlayer-route-draft-v1` slot and preserving
entry IDs and exact feature pins; see [route persistence](../../src/layers/routes/README.md#persistence-and-compatibility).

## Data and proxies

The app consumes normalized `nav/`, `tpp/` and `cs/` metadata and published chart/PDF
files, never raw FAA source ZIPs. No local publisher path or credential enters the bundle.
All chart reads use the [whole-file I/O invariant](../architecture/overview.md#chart-io-invariant);
chart layers wait for service-worker control before requesting archives. Custom feed
roots must follow the same cache and CORS contract.

For preparation failures and retry behavior, see
[chart-cache startup and recovery](../../src/layers/charts/README.md#startup-and-recovery).

With blank weather URL settings, Vite forwards `/api/weather/` to
`https://zlayer.tedyin.com`, preserving paths and queries. Local development shares
the shared prepared weather data through DO's same-origin proxy; it starts no weather
backend or separate source cache.

To work on the [weather backend](../../tools/weather-server/README.md), run
`npm run weather:serve` in one terminal and
`WEATHER_API_ORIGIN=http://127.0.0.1:8787 npm run dev` in another. This explicit local
backend uses `.cache/weather/` and must prepare its own data. This also sends
Progs through that backend; `/api/weather/progs/{analysis,forecast}.json`
serves only its prepared WPC snapshots. Check `healthz.progs` before using a newly
started backend. `VITE_ZLAYERS_PROGS_FEED_URL` can select an archived directory of
validated surface snapshots; it defaults to `/api/weather/progs/`. Radar also uses
this backend: `/api/weather/radar/latest.json` and immutable scan files. Inspect
`healthz.radar` for readiness and unavailable stations.
`VITE_ZLAYERS_RADAR_FEED_URL` overrides the prepared radar directory. Restart
`npm run weather:serve` after backend edits; that command does not watch source files.
`WEATHER_API_ORIGIN` is a shell setting, not a browser URL or a Vite `.env` variable. Report URL overrides
must follow the AWC GeoJSON/JSON contracts; archived advisory/grid overrides remain
available for fixtures.

Vite also forwards `/chart-data` to the FAA static feed and the qualified
`/faa-procedures/<cycle>/<filename>.PDF` paths to FAA. Raw weather acquisition stays inside the server. Production must install the server and nginx routes
separately; uploading `dist/` does not create them. The
[plugin guide](../../src/layers/metar-taf/README.md#source-access-and-report-presentation)
owns report freshness and [weather delivery](../../src/layers/weather-awc/README.md#development-and-production-delivery)
owns advisory acquisition.
Individual-only FAA plates, including military HIGH procedures, remain required even
when all bound TPP books are hosted. See [deployment readiness](deployment.md)
for exact host requirements and known release gaps.

The default basemap uses opaque USGS Topo tiles, which already include shaded relief.
It does not request the separate USGS shaded-relief service.
`VITE_ZLAYERS_BASEMAP_TILE_URL` replaces it with one opaque raster source;
`VITE_ZLAYERS_BASEMAP_STYLE_URL` supplies a complete style, including attribution.
This is not SkyVector's tile service. Review provider/offline terms before public release.

Route terrain uses separate elevation packages from the chart feed, preferring saved
regional packages when available. Without a packaged source, it falls back to Terrarium
tiles configured with `VITE_ZLAYERS_TERRAIN_TILE_URL` (Mapzen terrain on AWS by default).
Basemap settings do not change the route DEM; see [route terrain](../../src/layers/terrain/README.md).
GPS uses the device Geolocation API with permission and requires HTTPS or localhost.
It starts enabled unless the user saved an Off preference. AHRS acquires the same
GPS watch when activated, even with the map marker off. Its Calibrate action requests
motion permission where required; calibration can finish without a GPS fix.
AHRS remains experimental and has not been validated in flight. Its
[calibration and display policy](../../src/layers/ahrs/README.md#calibration-and-validity)
and [sensor/stow lifecycle](../../src/layers/ahrs/README.md#sensors-and-display-lifecycle)
own the warnings, pause recovery and Stop/Background/Cancel behavior.

The [METAR/TAF plugin guide](../../src/layers/metar-taf/README.md) owns map/card demand,
request limits, nearby stations, cached-report recovery and forecast presentation.
Use it when debugging weather through the proxies above.

## Compatibility traps

- Workspace controllers live in `App` state. `src/workspace/products.ts` reloads
  the development page when controller/factory updates reach it, so React Fast
  Refresh cannot leave old instances or map callbacks running after a source edit.
  Component-only updates still use Fast Refresh; production builds omit this boundary.
- `comlink` is pinned to **4.3.0**, matching the numeric message protocol embedded in
  the prebuilt `sql.js-httpvfs` worker. Upgrade wrapper and worker together; keep the
  bundled worker protocol test passing.
- MapLibre's worker uses Vite's explicit `?worker&url` entry. The library's relative
  default does not emit its worker/shared imports into the production build.
- Touch rotation requires at least a 20-degree twist before engaging; close fingers
  retain MapLibre's larger native threshold. The activation movement is discarded,
  then normal rotation continues until a finger lifts. Pinch zoom is unaffected.
  `src/core/map/touch-rotation.ts` adapts the pinned MapLibre handler because it has
  no public rotation-threshold setter; its tests use the real library handler.
- PDF.js and its worker both use the matching compatibility build for Safari polyfills.
- The production shell inventory includes lazy chunks, workers and WASM. Test the
  built app for offline launch; Vite's development module graph is not equivalent.

## Verification

`npm run verify:full` is the full local CI command. Run it before committing;
the smaller automatic GitHub check does not replace it. It runs the existing
`verify` command, every Chromium browser test (including graphics), and additional
graphics coverage in Firefox, WebKit and 2× WebKit, without smoke filtering.

```bash
npx playwright install --with-deps chromium firefox webkit
npm run verify:full
```

Suites run sequentially because tests mutate the fixture server's state. A failed
suite does not skip subsequent suites, and any failure makes the command fail.
Browser artifacts are kept separately under `test-results/local/browser`,
`test-results/local/graphics` and `test-results/local/firefox`. On Linux, Firefox
runs headed, using `xvfb-run -a` if `DISPLAY` is unset; install Xvfb when running
without a desktop display. Missing browsers or display dependencies are failures.
This checks the current OS; the manual GitHub matrix retains separate Linux and
macOS coverage.

On Linux hosts without Playwright's Ubuntu-compatible browser libraries, use its
matching container image (currently `v1.63.0-noble`, Node 24). Keep the image version
aligned with the installed Playwright package. Run with the workspace owner's UID
and GID so builds and test artifacts remain writable:

```bash
docker run --rm --init --shm-size=1g --user "$(id -u):$(id -g)" \
  -e npm_config_cache=/tmp/zlayer-npm \
  -e XDG_CACHE_HOME=/tmp/zlayer-cache -e XDG_CONFIG_HOME=/tmp/zlayer-config \
  -v "$PWD:/work" -w /work \
  mcr.microsoft.com/playwright:v1.63.0-noble npm run verify:full
```

The init process reaps browser children and supports Xvfb's startup signalling.
Writable XDG directories let Firefox initialize its caches even when the host UID
maps to an image account without a writable home directory.

The container's fixture port is isolated from host development servers. For a
native run with an occupied fixture port, set `ZLAYER_TEST_PORT` to a free port.

`npm run verify` runs import-boundary checks, strict TypeScript, tests and the production build.
`npm run check:imports` separately checks source ownership, persistence migration entries,
data/worker isolation from UI runtimes, and lazy renderer/decoder loading. Node tests
cover contracts, routing, cache integrity, queue recovery, worker messages and lifecycle
races. A small hook scheduler covers lifecycle behavior; server-rendered markup covers
labels/states, not real focus, layout, touch or DOM events. Avoid fixed-delay sleeps,
source-text assertions and incidental markup ordering.

`npm run test:browser` runs the Playwright suite in `test/e2e/`, including offline
launch, saved-edition ownership, source recovery, responsive layout, routes, plates,
TAF, terrain, GPS, AHRS, recordings and full reset. Its server builds into a temporary
directory and supplies synthetic FAA/PDF/DEM/weather data without an external feed.
Native weather samples are prepared once through the real weather server; resets
restore a pristine copy of that cache. Startup allows four minutes for preparation;
ordinary browser assertions retain their shorter timeouts.
It uses port 4197 by default (`ZLAYER_TEST_PORT` overrides it) and does not replace `dist/`.

```bash
npx playwright install chromium
npm run test:browser
```

On Linux, `npx playwright install --with-deps chromium` also installs required system
libraries. Alternatively, set `PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH` to a working Chrome
or Chromium executable. That override can use a different version from CI; reproduce
CI browser failures with Playwright's installed browser before changing assertions.
GitHub Actions runs `npm run verify` and `npm run test:smoke` as separate jobs on
pushes and pull requests. The smoke command selects five existing Chromium tests
tagged `@smoke`: first-visit acknowledgment, map/WebGL recovery, GPS rendering,
cold offline startup with saved routes and PDFs, and app updates across windows.
It uses the same production-build server and assertions as the complete suite.
Each automatic job has a ten-minute limit; a newer run cancels an older run for
the same event and ref. Failure traces are retained.

Browser tests must wait for the UI lifecycle they depend on: service-worker
control alone does not mean startup has released the workspace controls, and
closing a plate returns focus only after its slide finishes. The two-window
update smoke test allows extra time for concurrent software-rendered maps and
waits for workspace readiness before interacting with restored Settings.
The graphics smoke test also waits for its expected pixels after WebGL restoration:
the context/idle notifications can precede a readable restored drawing buffer.
Its bounded wait retains the exact color and route-pixel assertions.

Storage-recovery tests must leave the running app before deleting browsing
metadata. The installed worker serves the app shell for all navigation requests,
including asset paths such as `/icon.svg`. Bypass that navigation only for the
cleanup document, verify its content type, and restore interception before
testing offline launch; otherwise a new app instance can repopulate the records.

For focused work, `npm run test:browser` runs the full Chromium regressions
independently. `npm run test:graphics` covers graphics,
terrain, GPS rendering and plate fullscreen/pinch cases in Chromium, Firefox,
WebKit and 2× WebKit; see [graphics setup](../verification/graphics-compatibility.md#run-the-checks)
for dependencies and Linux Firefox's display requirement. Both complete suites
remain part of full local CI. Device performance and memory benchmarks run locally;
installed-device verification remains separate release work.

For a complete hosted run, select **Actions → Verify → Run workflow**, choose
the branch and leave **full** enabled (the default), or run:

```bash
gh workflow run verify.yml --ref main -f full=true
```

This runs the full Chromium suite (60-minute job limit), plus graphics jobs for
Linux Firefox, WebKit and 2× WebKit, and macOS 2× WebKit (15-minute limits).
Disable **full** to run only the ordinary verification and smoke checks manually.
Only the full hosted run is opt-in. Full local CI retains all test coverage;
moving suites off GitHub's automatic path does not resolve their test failures.

Interactive browser fixtures, served by Vite but excluded from ordinary builds:

- `/test/browser/weather-progs.html`: actual MapLibre isobars, labels, fronts and pressure centers
  from prepared WPC snapshots, forecast selection and style recovery.
- `/test/browser/fixes.html`: real MapLibre placement, zoom/category/altitude controls,
  and selected fixes with background fixes off. Click rendered fixes too: tile-query
  properties must round-trip to the priority layer without worker errors.
- `/test/browser/plates.html`: hosted KHWD approach, individual and named-destination
  FAA fallbacks, cached reopening with PDF requests disabled, and lazy-panel recovery.
  Each path must render a PDF.js canvas. The side panel leaves the map interactive;
  its edge tab or Escape stows it without losing the page, zoom, or scroll position.
  Airport details and the PDF are independent windows, with one instance of each.
  Each side has at most one unstowed panel. Switching binder tabs retains each
  panel’s own dimensions and contents; both tabs follow the active panel’s edge.
  Stowing the active panel leaves all panels on that side stowed. Closing or
  changing the airport keeps the PDF loaded.
  Full screen traps focus, Escape returns to the side panel, and Close restores focus to the opener or its stowed panel’s tab.
  Both layouts fit phone/tablet sizes without a dimmed or blurred map backdrop.
  Airport buttons cover diagram-before-CS ordering, VFR-only airports and Alaska/Pacific books.
- `/test/browser/routes.html`: real route interaction checks.
- `/test/browser/route-map.html`: route labels, feature selection and map rendering.
- `/test/browser/terrain.html`: route-corridor contours, altitude controls and terrain lifecycle.
- `/test/browser/ownship.html`: GPS motion, projection, freshness and map controls.
- `/test/browser/ahrs-geometry.html`: attitude-display geometry and clipping.
- `/test/browser/ahrs-drums.html`: rolling instrument digits and rollover transitions.
- `/test/browser/graphics.html`: pixel/alpha checks and worker-transfer benchmarks.

Publisher commands run in `faa-regs`, not this app. `npm run build:nav` rebuilds
current navigation, preferred/TEC routes, SID/STAR topology and packaged history;
local dated rebuilds use the source options in [contracts](../data/contracts.md).
Build missing supplement metadata with
`npm run build:supplements -- --effective-date=YYYY-MM-DD`; publish
`cs/catalog.json` alongside `cs-*.pdf`. Existing PDFs alone do not provide airport/page
lookup. A missing supplement index must not hide working procedures.

The routes, terrain and ownship fixtures also participate in the production-build
Playwright suite. Interactive fixture checks alone do not replace that suite.
Follow [offline release checks](../features/offline-storage.md#release-checks),
[responsive checks](../features/shared-ui.md) and [deployment readiness](deployment.md)
before claiming a device or deployment is ready.

### Local AWC forecast grids

Leave `VITE_ZLAYERS_AWC_GRID_URL` blank to use the shared prepared forecasts through
Vite's `/api/weather/` proxy. Backend development is an explicit opt-in described
under [data and proxies](#data-and-proxies).
The [grid guide](../../src/layers/weather-awc/grids/README.md) owns numeric meanings,
worker budgets, source identity and offline behavior.
