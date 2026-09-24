# Deployment readiness

[Documentation](../README.md) / Development

ZLayer builds to a static `dist/` and deploys a small Node 24 weather cache gateway
behind nginx. It has no dependency on a local `faa-regs` checkout. App code, lazy viewers, PDF.js/MapLibre/SQLite workers,
WASM, UI fonts and icons are bundled locally and precached by the production service worker.
`tools/dev-proxy.ts` is development tooling, not part of the deployment.

Static application assets do not eliminate data-hosting requirements. Production
hosts must provide the following hosting contract:

| Request | Production requirement |
| --- | --- |
| Chart, navigation, TPP and CS feed | Set `VITE_ZLAYERS_CHART_ROOT` to a readable chart feed. A same-origin `/chart-data` prefix needs a static mapping or proxy, including `cycles.json` for discovery. Cross-origin feeds need chart-host CORS. |
| `/faa-procedures/<cycle>/<filename>.PDF` | Narrow proxy to `https://aeronav.faa.gov/d-tpp/<cycle>/<filename>.PDF`. Restrict cycles to four digits and filenames to the existing development rule; never expose an arbitrary URL relay. Preserve query parameters. |
| `/api/weather/metars.geojson` and `/api/weather/tafs.json` | Forward to the [TypeScript gateway](../../tools/weather-server/README.md), which reads AWC and caches bounded station/area queries. These are the blank-setting defaults. |
| `/api/weather/advisories/` | Server-normalized SIGMET/CWA and complete five-frame G-AIRMET snapshots, including freezing contours. |
| `/api/weather/grids/` | Server catalogs and prepared HRRR/IFI native numeric grids, including wind pressure levels and same-run terrain. Google is the server's HRRR upstream; the PWA interpolates wind altitudes. Preserve identity/checksum/source-check headers. |
| USGS terrain basemap | External raster service; only viewed resources are cached. Regional downloads do not promise offline basemap coverage. Review provider terms before public release. |
| Terrain elevation | Prefer the chart feed's `terrain/manifest.json` and versioned USGS 3DEP packages; regional saves include published packages at supported DEM zooms. Without a packaged source, use Mapzen Terrarium tiles on AWS or `VITE_ZLAYERS_TERRAIN_TILE_URL`; a replacement must provide readable 256px Terrarium PNG tiles. Elevation is independent of the basemap, and fallback PNG coverage is not a regional offline guarantee. See [terrain](../../src/layers/terrain/README.md). |
| FAA obstructions | Optional chart-feed `obstacles/manifest.json` and its compressed Daily DOF export. Cached on demand, independently versioned, and outside regional offline completeness. See [obstructions](../../src/layers/obstructions/README.md). |
| GPS aircraft | Device Geolocation API on HTTPS with user permission. No location backend is required; provider availability and installed-device behavior need separate checks. |
| Experimental AHRS | Device Motion API on HTTPS, with explicit permission where required. Shared GPS supports aiding and GPS instruments; a fix is optional for calibration and live attitude under the [warning cross](../../src/layers/ahrs/README.md#calibration-and-validity). Optional WMM coefficients come from the chart feed; without a usable model the HSI uses true north. Sensor and flight behavior need separate validation. |
| Map-label glyphs | Identifier-label glyphs are bundled locally and precached with the shell. Custom external map styles may have additional dependencies. |

Use a same-origin chart prefix or verify that the feed permits the application's
origin through CORS. A successful HTTP response alone does not establish browser
readability; cross-origin deployments must verify the response headers.

Individual FAA PDFs are not merely a temporary missing-upload fallback: the current
catalog includes military HIGH procedures without bound-book pages. Regional saves
include them. A working FAA proxy is required to finish those downloads and to view
uncached individual plates. Neither environment variables nor uploading `dist/`
creates that proxy automatically.

Install the [weather backend](../../tools/weather-server/README.md#deployment)
and add the separate API [nginx location](weather-api.nginx.conf)
before deploying the frontend. The backend runs on gcp0. DigitalOcean keeps the public HTTPS domain and forwards
same-origin requests through a managed SSH tunnel on loopback port 8788 to GCP’s
loopback port 8787. The current PWA uses only
`/api/weather/`; direct `/weather/` proxy routes are retired. The gateway handles metadata refreshes itself; no cron job
or database is needed. `/api/weather/healthz` checks the process, not upstream availability.
Fresh cache files survive restarts; user offline weather remains browser-owned.

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
  [license and source requirements](../../README.md#license), including build scripts
  and any local source changes.
  About links to `/source/<zlayer-release>.tar.gz` for the exact running build.
  Publish that archive before switching the shell, exclude private operations,
  credentials and runtime caches, and retain older archives with hashed assets.

## Verification and remaining release gates

Run `npm run verify`, `npm run test:browser`, the
[graphics matrix](../verification/graphics-compatibility.md#run-the-checks) and
`npm audit --omit=dev` before release. The full browser suite uses Chromium and a
production build with synthetic FAA/PDF/DEM/weather fixtures. Targeted graphics,
terrain, GPS rendering and plate cases also run in Firefox and WebKit, including
2× WebKit on Linux/macOS CI. Configured CI coverage is not evidence of a passing run.

These remain release gates:

- Installed iOS/Android airplane-mode cold launch, large-book rendering,
  interrupted downloads, process termination and low-storage recovery:
  [offline checks](../features/offline-storage.md#release-checks). Repeat the KVGT iPhone
  download that crashed at approximately 177 MiB, including rendering and offline
  reopening; [download memory constraints](../verification/memory-resources.md#iphone-download-constraint-kvgt-2026-09-21)
  distinguish transfer size from measured RAM.
- Actual GPS movement, first-use permission, denial/recovery and background return:
  [GPS checks](../../src/layers/ownship/README.md#release-verification).
- AHRS motion permission, calibration with no GPS fix, sensor orientation,
  suspension/recovery and instrument behavior on physical devices. Verify moving
  attitude beneath the cross with no fix, low-speed GPS and prolonged high tilt
  uncertainty; usable GPS should clear the cross only once tilt uncertainty is
  acceptable. Simulation and desktop emulation do not establish flight accuracy;
  see the [AHRS policy and limits](../../src/layers/ahrs/README.md#calibration-and-validity),
  [statistical/reference validation work](../../src/layers/ahrs/validation.md#remaining-validation-work)
  and [combined-resource scrolling checks](../verification/memory-resources.md#ahrs-session-memory-and-scrolling).
- Full reset on installed devices, including other open windows, interruption and
  offline completion; confirm a fresh online start afterward.
- Real keyboards, folding/rotation, PDF gestures and physical GPU behavior:
  [responsive checks](../features/shared-ui.md) and
  [graphics device checks](../verification/graphics-compatibility.md#device-verification-boundary).
- Reference-device startup, total memory, interaction and battery measurements:
  [product budgets](../product/brief.md#performance-and-quality-budgets). The reporting Android
  device still needs direct confirmation of the terrain precision fix.
- Live HTTPS checks after each publication: MIME/cache headers, service-worker scope,
  chart discovery, gateway METAR/TAF reports, advisory snapshots, prepared forecast
  catalogs/slices and individual PDFs. Check the default TAF gateway route with
  `node --import=tsx tools/check-taf-api.ts https://your-app.example`.
  Missing assets and malformed proxy paths must return errors rather than app HTML.

The shell precaches lazy viewers, workers and fonts. PDFs use local Blob ranges and
bounded canvases; integrity checks stream in bounded chunks and reuse matching PDF
receipts. These limit application allocations, but do not measure browser storage,
PDF.js or GPU memory on devices. See [offline storage](../features/offline-storage.md#storage-contract).

## Recorded local verification

The 2026-09-20 local check used Node 24.20.0 and Playwright 1.63's Linux
container. Imports, types, unit tests and build passed. The full command exited
at Chromium after two fixture failures; both passed after test-only corrections,
and the subsequent graphics matrices passed with existing native-touch skips.
It was not rerun end to end. These combined results establish neither a current
working-tree pass nor a hosted release; each release needs its own recorded checks.

Report bundle sizes for each build. The boundary topology is separately hashed,
module-preloaded and included in the offline shell; splitting it preserves its
cache identity across UI edits but does not remove its initial download cost.
Use the [plate startup method](../features/shared-ui.md#plate-modal-regression-checks)
and [graphics benchmarks](../verification/graphics-compatibility.md) for comparable measurements,
then measure on physical devices. Local verification does not deploy a release,
and a server rollback does not roll back browser storage.

Storage is per origin; localhost downloads do not migrate to the production hostname.
Saved regions and open views protect their shared files from the app's 14-day temporary
cache cleanup. Site-data deletion can still erase them. Bulk offline basemap coverage
and automatic cycle migration remain outside the current contract; see
[offline storage](../features/offline-storage.md).

For both weather plugins, the versioned [nginx snippet](weather-api.nginx.conf)
forwards `/api/weather/` through the private connection to the service. METAR/TAF retain their AWC queries and
report behavior under this new prefix. AWC advisories and HRRR/IFI grids use normalized/prepared routes.
Raw NOAA acquisition stays inside the server; it has no public raw-proxy routes.
Install the location directly inside the TLS server block, as the current
DigitalOcean host does, or save it as `/etc/nginx/snippets/zlayer-weather.conf`
and include it there. Use only one copy of the location:

```nginx
include /etc/nginx/snippets/zlayer-weather.conf;
```

The current app only calls `/api/weather/`; obsolete direct `/weather/` proxies
can be removed when installing this matching frontend/backend release. Existing
tabs must accept the app update to use the native-pressure wind API. The API prefix
preserves queries and identity headers with no nginx cache or response buffering;
nginx handles TLS while the server validates and prepares weather. The backend
restarts automatically under systemd. Its service file and rollback procedure are
in the weather server guide. The updater prepares complete native generations
before publishing catalogs; HTTP forecast requests only read saved files. Require
all three forecast readiness flags before production cutover. See
[nginx buffering](https://nginx.org/en/docs/http/ngx_http_proxy_module.html#proxy_buffering).
Connection buffers and network traffic remain server costs.

nginx connects to the loopback SSH forward; Node verifies source TLS with its normal
certificate trust. Keep upstream certificate verification enabled.

Deploy the weather service and verify its catalogs and representative slices,
then deploy the static app with the METAR/TAF URLs and
both AWC feed overrides blank. Validate and reload nginx as part of deployment.
Metadata refresh runs inside this service; no Python/GDAL installation, separate publisher
or database is required. Frontend assets alone do not install the server or snippet. Host-specific `ops/` configuration
stays ignored; changes there alone are not a deployable repository artifact.
This contract does not establish that the live host has these routes installed.
