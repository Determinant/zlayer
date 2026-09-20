# Local development

ZLayer has no runtime application server. The root package owns `src/`, `public/`,
`test/` and Vite; `packages/contracts` and `packages/domain` are the only npm
workspaces. Local proxies live in `tools/dev-proxy.ts`, not a separate application.

## Run and configure

Use Node.js 24 or newer. `npm ci` installs the committed lockfile; use `npm install`
when intentionally changing dependencies.

```bash
npm ci
npm run dev
npm run verify
```

Run from the repository root. Vite reads `.env` and `.env.local` there; see
[.env.example](../.env.example). Vite listens on port 4173 with strict port selection.
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
and cache identity rules belong in the [chart-feed contract](chart-feed.md).

On first launch, the camera centers KPAO at zoom 9, independently of feed ordering;
after that, center, zoom, bearing and pitch are restored, including when refresh
interrupts camera movement. Panel visibility, selected airport/tab, recommendations
and the plate reader also resume; see the [workspace persistence contract](contracts.md#workspace-persistence).
Chart bases, overlays, fix display, FAA/METAR switches, terrain visibility/altitude mode and GPS
visibility restore from `zlayers-map-preferences-v1`
(localStorage schema version 2) before map creation, including offline. The historical
`VITE_ZLAYERS_*` names and storage keys intentionally survive the ZLayer rename.
Invalid preference fields default independently; unavailable chart choices fall back
without overwriting the saved choice, and denied storage leaves session controls usable.
These preferences are per origin, not cookies or cross-device sync. Legacy terminal/
flyway choices become sectional plus that overlay; base-map-only stays off.
See [layer modules](layer-modules.md) and [fix display](fix-display.md) for display rules.
Route drafts use `zlayer-route-draft-v1` with version 2 entry records, preserving
entry IDs and exact feature pins; see [route persistence](routes.md#persistence-and-compatibility).

## Data and proxies

The app consumes normalized `nav/`, `tpp/` and `cs/` metadata and published chart/PDF
files, never raw FAA source ZIPs. No local publisher path or credential enters the bundle.
All chart reads use the [whole-file I/O invariant](architecture.md#chart-io-invariant);
chart layers wait for service-worker control before requesting archives. Custom feed
roots must follow the same cache and CORS contract.

Transient chart-cache startup failures retry automatically after 1, 3, and 10 seconds.
Charts appear on the same page once preparation succeeds; catalog refreshes do not
restart cache preparation. Persistent failures expose **Retry chart cache**, and
reconnection or a new controlling worker starts a fresh attempt.

Vite provides four development-only proxies:

| Local path | Purpose |
| --- | --- |
| `/chart-data` | FAA static feed without cross-origin development requests |
| `/weather/metars.geojson` | AWC METAR API, which does not permit direct browser CORS |
| `/weather/tafs.json` | AWC TAF API; selected-airport and bounded nearby forecasts in JSON |
| `/faa-procedures/<cycle>/<filename>.PDF` | Narrow FAA-only PDF fallback for the same in-app PDF.js viewer |

Production must separately provide its data access/proxies; uploading `dist/` does
not create them. Set `VITE_ZLAYERS_METAR_URL`, `VITE_ZLAYERS_TAF_URL` or
`VITE_ZLAYERS_PROCEDURE_PROXY_ROOT` to test alternative delivery endpoints.
Individual-only FAA plates, including military HIGH procedures, remain required even
when all bound TPP books are hosted. See [deployment readiness](deployment-readiness.md)
for exact host requirements and known release gaps.

The default basemap softens USGS Topo over shaded relief.
`VITE_ZLAYERS_BASEMAP_TILE_URL` replaces it with one opaque raster source;
`VITE_ZLAYERS_BASEMAP_STYLE_URL` supplies a complete style, including attribution.
This is not SkyVector's tile service. Review provider/offline terms before public release.

Route terrain uses a separate Terrarium elevation source, configurable with
`VITE_ZLAYERS_TERRAIN_TILE_URL`; blank uses Mapzen terrain on AWS. Basemap settings
do not change the route DEM. Terrain has no explicit offline-download guarantee.
GPS uses the device Geolocation API with permission and requires HTTPS or localhost.
It starts enabled unless the user saved an Off preference. AHRS acquires the same
GPS watch when activated, even with the map marker off. Its Calibrate action requests
motion permission where required; calibration can finish without a GPS fix.
After calibration, live IMU attitude stays visible under the red cross with no fix,
low-speed GPS or high tilt uncertainty. Usable GPS clears the cross only while tilt
uncertainty is acceptable; see the [display policy](../src/layers/ahrs/README.md#calibration-and-validity).
Stowing the toolbox keeps the session running;
Stop releases its sensor subscriptions. AHRS remains experimental and has not been
validated in flight. See [terrain](route-terrain.md), [GPS](gps-aircraft.md) and
[AHRS](../src/layers/ahrs/README.md).

Map METAR demand follows rendered airport circles, zoom and visibility. Movement settles
before uncached/expired stations are requested (100 IDs per batch, two requests in
flight); a stationary visible map checks each minute. Hidden tabs and disabled map
layers pause map demand. Requests have a 20-second timeout and one transient retry. Failed/empty
responses preserve latest-known reports with cached/stale labels. Up to 5,000 stations
are retained; details show UTC observation time, age and last successful check.
These are observations, not a weather-history archive.

The open airport Info card independently checks its METAR on opening and every
minute while online and visible, even when map weather or Airports is hidden.
Without a current local observation it searches within 50 NM and offers nearby
stations from the shared METAR cache. Closing the card, changing airport, or opening
Plates cancels card demand; any visible-map demand continues independently. Nearby
reports stay in the labeled weather section and do not supply the selected
airport's map category or runway wind.

TAF demand follows the open airport Info card, independently of map weather visibility.
The selected ICAO station is checked on opening and every five minutes while online
and visible. Closing the card, changing airport, or opening Plates cancels its request.
Up to 200 forecasts are persisted; restored reports are revalidated, and cached,
expired, cancelled, missing and failed-refresh states are shown explicitly.
The raw text appears below METAR, one colored line per forecast period; no decoded
TAF panel is added. Airports without a current TAF select the nearest available
forecast within 50 NM and offer other nearby stations in a dropdown with distance
and direction. These forecasts share the direct-station cache and remain selectable
after an offline reload. The card explicitly identifies the forecast's source
airport; an empty search or failed refresh has a distinct status.
The opening line includes the local validity range, and each FM group includes
its local start time, in muted text aligned beneath the forecast. Times use
the device's time zone, with an abbreviated month, day, 24-hour time and zone
abbreviation. Other years are included; same-day ranges share the date and zone
unless the zone changes. See [date and currency labels](date-time-display.md).

## Compatibility traps

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
It uses port 4197 by default (`ZLAYER_TEST_PORT` overrides it) and does not replace `dist/`.

```bash
npx playwright install chromium
npm run test:browser
```

On Linux, `npx playwright install --with-deps chromium` also installs required system
libraries. Alternatively, set `PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH` to a working Chrome
or Chromium executable. That override can use a different version from CI; reproduce
CI browser failures with Playwright's installed browser before changing assertions.
GitHub Actions runs both `verify` and the browser suite and
retains failure traces. The full suite targets Chromium. `npm run test:graphics`
runs the graphics, terrain, GPS rendering and plate fullscreen/pinch cases in
Chromium, Firefox, WebKit and 2× WebKit. Separate CI jobs cover Linux Firefox/WebKit
and macOS 2× WebKit; see [graphics setup](graphics-compatibility.md#run-the-checks)
for browser dependencies and Linux Firefox's display requirement. Installed-device
verification remains separate release work.

Interactive browser fixtures, served by Vite but excluded from ordinary builds:

- `/test/browser/fixes.html`: real MapLibre placement, zoom/category/altitude controls,
  and selected fixes with background fixes off. Click rendered fixes too: tile-query
  properties must round-trip to the priority layer without worker errors.
- `/test/browser/plates.html`: hosted KHWD approach, individual and named-destination
  FAA fallbacks, cached reopening with PDF requests disabled, and lazy-panel recovery.
  Each path must render a PDF.js canvas. Focus enters the named modal, Tab stays inside,
  Escape/Close restores a keyboard opener, and the slide-in layout fits phone/tablet sizes.
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
local dated rebuilds use the source options in [contracts](contracts.md).
Build missing supplement metadata with
`npm run build:supplements -- --effective-date=YYYY-MM-DD`; publish
`cs/catalog.json` alongside `cs-*.pdf`. Existing PDFs alone do not provide airport/page
lookup. A missing supplement index must not hide working procedures.

The routes, terrain and ownship fixtures also participate in the production-build
Playwright suite. Interactive fixture checks alone do not replace that suite.
Follow [offline release checks](offline-storage.md#release-checks),
[responsive checks](responsive-checks.md) and [deployment readiness](deployment-readiness.md)
before claiming a device or deployment is ready.
