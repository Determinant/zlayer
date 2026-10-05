# Deployment readiness

[Documentation](../README.md) / Development

ZLayer builds to a static `dist/` and deploys a small Node 24 info gateway
behind an HTTPS reverse proxy. The [Docker hosting setup](#docker-hosting-and-staged-migration)
uses Caddy; an nginx API snippet is also provided. It has no dependency on a local
`faa-regs` checkout. App code, lazy viewers, PDF.js/MapLibre/SQLite workers,
WASM, UI fonts and icons are bundled locally and precached by the production service worker.
`tools/dev-proxy.ts` is development tooling, not part of the deployment.

Static application assets do not eliminate data-hosting requirements. Production
hosts must provide the following hosting contract:

| Request | Production requirement |
| --- | --- |
| Chart, navigation, TPP and CS feed | Set `VITE_ZLAYERS_CHART_ROOT` to a readable chart feed. A same-origin `/chart-data` prefix needs a static mapping or proxy, including `cycles.json` for discovery. Cross-origin feeds need chart-host CORS. |
| `/faa-procedures/<cycle>/<filename>.PDF` | Narrow proxy to `https://aeronav.faa.gov/d-tpp/<cycle>/<filename>.PDF`. Restrict cycles to four digits and filenames to the existing development rule; never expose an arbitrary URL relay. Preserve query parameters. |
| `/api/weather/metars.geojson` and `/api/weather/tafs.json` | Forward to the [TypeScript gateway](../../tools/info-server/README.md), which reads AWC and caches bounded station/area queries. These are the blank-setting defaults. |
| `/api/weather/advisories/` | Server-normalized SIGMET/CWA and complete five-frame G-AIRMET snapshots, including freezing contours. |
| `/api/weather/grids/` | Server catalogs and prepared HRRR/IFI native numeric grids, including wind pressure levels and same-run terrain. Google is the server's HRRR upstream; the PWA interpolates wind altitudes. Preserve identity/checksum/source-check headers. |
| `/api/notams/` | Forward to the same info server. FAA NMS credentials and collection stay server-side; airport queries read its retained dataset. See [NOTAM collection](../../tools/info-server/README.md#notam-collection) for enablement and durable state. |
| Esri World Imagery basemap | External raster service; only viewed resources are cached. Regional downloads do not promise offline basemap coverage. Review provider terms before public release. |
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

Install the [info backend](../../tools/info-server/README.md#deployment)
and configure same-origin API forwarding before deploying the frontend. The Docker
setup reaches a backend on the same host; the optional [nginx snippet](info-api.nginx.conf)
supports a separate backend through a managed SSH tunnel. Keep the backend listener
private in either arrangement. Weather uses `/api/weather/` and NOTAMs use
`/api/notams/`; direct `/weather/` proxy routes are retired. The gateway handles metadata refreshes itself; no cron job
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

## Docker hosting and staged migration

[`tools/hosting/compose.yaml`](../../tools/hosting/compose.yaml) runs one
digest-pinned official Caddy container for the app and chart domains. Its
[`Caddyfile`](../../tools/hosting/Caddyfile) implements the static-host contract,
same-origin `/chart-data/`, the bounded FAA PDF proxy, and the two info API prefixes.
The chart domain retains a directory browser for the public `charts/`, `aim/` and
`far/` trees, with CORS and Range support. Hidden work directories are denied.
Neither host falls back to app HTML for missing resources.

Keep the app's hidden-path and method guards ahead of every static and proxy
handler inside one ordered `route` block. Caddy's default
[directive order](https://caddyserver.com/docs/caddyfile/directives#directive-order)
places `handle` before `respond`; guards outside the route can be bypassed even
when they appear first in the file. GET and HEAD are the app's only allowed
methods; the chart domain also allows OPTIONS for CORS.

This Compose setup manages the web tier. The info service has its own lifecycle
under systemd or a separate container, including its weather cache, NOTAM credentials,
durable snapshots and quota journal. Linux host networking lets Caddy reach a
same-host service at `INFO_UPSTREAM` (default `127.0.0.1:8787`); keep that listener
loopback-only. A web-host migration can retain the backend and its state. Do not
start a second collector or mount its state into another writer. A backend move
must preserve single ownership and separately qualify its readiness.

The app mount contains `current -> releases/<id>`, immutable release directories,
shared `assets/`, and `source/`. Copy all of these when moving an existing origin;
rebuilding is unnecessary for a hosting-only move. Publish assets and corresponding
source before switching `current` atomically. Retain old assets, source archives
and releases for existing tabs and rollback. The chart mount contains the complete
published FAA root, including older editions and independently versioned products.
Copy payloads before mutable manifests/catalogs and `cycles.json`; never use a
deleting sync to make the destination match a partial local build.

Install the Compose files together in a dedicated directory. Copy
[`hosting.env.example`](../../tools/hosting/hosting.env.example) to a private path,
set the domains and absolute bind-mount paths, and pin the tested Caddy digest.
Create the bind directories explicitly; Compose refuses to silently create absent
data directories. The app and FAA mounts are read-only inside Caddy. Keep certificate
storage (`/data`), Caddy runtime configuration (`/config`), and bootstrap private keys
on durable storage outside the served trees. Back up certificate state securely.
If published data uses a local SSD, keep its authoritative publisher and a recovery
copy elsewhere; VM stop/deletion or disk loss can require reseeding that data.

Run these from the repository root, with installed paths supplied for the remote host:

```bash
docker compose --env-file /private/hosting.env -f tools/hosting/compose.yaml config --quiet
docker compose --env-file /private/hosting.env -f tools/hosting/compose.yaml \
  run --rm --no-deps web caddy validate --config /etc/caddy/Caddyfile --adapter caddyfile
docker compose --env-file /private/hosting.env -f tools/hosting/compose.yaml up -d
```

The container restarts automatically and rotates its logs. Its health check tests
only the local Caddy listener, not chart completeness or backend readiness. The
admin API uses a Unix socket; the health endpoint binds only to loopback port 9080.
Only TCP ports 80 and 443 need public ingress. Host-specific networking, mount
ordering, certificate inventory and deployment commands belong in the private
operations checkout. Keep any other services and their firewall rules intact.

### HTTPS before the DNS switch

With `TLS_MODE=bootstrap`, install the existing trusted certificate and private key
at `<TLS_BOOTSTRAP_DIR>/<domain>/fullchain.pem` and `privkey.pem` for each domain.
This allows certificate-verified testing before DNS changes. These are imported
certificates: Caddy does **not** renew them in bootstrap mode. Record their expiration
dates and refresh them from the current host if staging lasts longer.

After DNS and ingress reach the new origin, set `TLS_MODE=managed`, validate the
configuration, and run Compose `up -d` to recreate the container with the new
environment. Caddy obtains and renews Let's Encrypt certificates automatically.
Allow for initial issuance, verify both domains and the certificate issuer/expiry,
and keep the bootstrap keys until that check succeeds. Reverting to bootstrap mode
is the immediate TLS rollback while those certificates remain valid. For unattended
renewal before cutover, use a separately configured DNS challenge; the stock image
in this setup does not include a Cloudflare DNS plugin. See Caddy's
[automatic HTTPS](https://caddyserver.com/docs/automatic-https) and
[TLS directive](https://caddyserver.com/docs/caddyfile/directives/tls) documentation.

### Pre-cutover verification

Run the isolated routing regression with the same Caddy version used for hosting:

```bash
python3 tools/hosting/test-routing.py --caddy /path/to/caddy
```

It adapts the real Caddyfile and runs its handlers on loopback with temporary
static files and a recording upstream. It checks existing hidden files under
every app mount, method rejection before the info/FAA proxies, allowed GET/HEAD
routing and query preservation, cache headers, and chart CORS/Range delivery.
Only fixture paths, upstream addresses, listeners and TLS are substituted; it
does not contact production or FAA. HTTPS is checked separately below.

[`tools/hosting/check.py`](../../tools/hosting/check.py) checks real HTTPS with the
production hostnames and SNI while directing connections to the candidate address.
It verifies redirects, MIME/cache headers, old-asset delivery, real 404s, restricted
methods/PDF paths, chart CORS/discovery, and weather catalog readiness. Supply a real
MBTiles path and current individual FAA PDF to also check their delivery:

```bash
python3 tools/hosting/check.py --address CANDIDATE_IP \
  --app-domain zlayer.example.com --charts-domain charts.example.com \
  --mbtiles /charts/EDITION/mbtiles/PACKAGE.mbtiles \
  --pdf /faa-procedures/CYCLE/FILE.PDF
```

When ingress is intentionally closed, forward local ports 18443 and 18080 over SSH
to the candidate's loopback ports 443 and 80, then use `--address 127.0.0.1
--https-port 18443 --http-port 18080`. This still validates the real domain
certificates; do not use `curl -k`. Run the full
[info API readiness check](../../tools/info-server/README.md#deployment-readiness)
separately. The hosting check reports NOTAM state without treating a pre-existing
collector problem as a proxy failure.

Before changing DNS, complete a fresh data/index sync and compare source/destination
file hashes and frontend release identities. Arrange ongoing publisher delivery to
the new host; a staged copy alone does not migrate the publisher. Verify public
ingress and a reserved address, then update the Cloudflare A record and any obsolete
AAAA record. Use [Full (strict)](https://developers.cloudflare.com/ssl/origin-configuration/ssl-modes/full-strict/)
for proxied HTTPS and preserve the existing
service-worker/API cache policy. Keep the old origin and tunnel until the new
origin has passed live checks and publication/renewal have been verified. DNS rollback
points back to the old origin; it does not roll back browser storage.

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

## Build and storage checks

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

## Weather rollout

For nginx deployments, the versioned [snippet](info-api.nginx.conf) forwards
`/api/weather/` and `/api/notams/` through a private connection to the info server.
METAR/TAF retain their AWC queries and
report behavior under this new prefix. AWC advisories and HRRR/IFI grids use normalized/prepared routes.
Raw NOAA acquisition stays inside the server; it has no public raw-proxy routes.
Install the location directly inside the TLS server block,
or save it as `/etc/nginx/snippets/zlayer-info.conf`
and include it there. Use only one copy of each location:

```nginx
include /etc/nginx/snippets/zlayer-info.conf;
```

The current app calls `/api/weather/` and `/api/notams/`; obsolete direct `/weather/` proxies
can be removed when installing this matching frontend/backend release. Existing
tabs must accept the app update to use the native-pressure wind API. The API prefix
preserves queries and identity headers with no nginx cache or response buffering;
nginx handles TLS while the server validates and prepares weather. The backend
restarts automatically under systemd. Its service file and rollback procedure are
in the info server guide. The updater prepares complete native generations
before publishing catalogs; HTTP forecast requests only read saved files. Require
all three forecast readiness flags before production cutover. See
[nginx buffering](https://nginx.org/en/docs/http/ngx_http_proxy_module.html#proxy_buffering).
Connection buffers and network traffic remain server costs.

The snippet uses a loopback SSH forward on port 8788; for a same-host backend,
set its upstream to the backend's loopback listener (default port 8787).
Node verifies source TLS with its normal certificate trust. Keep upstream
certificate verification enabled.

Deploy the weather service and verify its catalogs and representative slices,
then deploy the static app with the METAR/TAF URLs and
both AWC feed overrides blank. Validate and reload nginx as part of deployment.
Metadata refresh runs inside this service; no Python/GDAL installation, separate publisher
or database is required. Frontend assets alone do not install the server or snippet.
This contract does not establish that the live host has these routes installed.

## Public configuration and private operations

This repository owns portable Docker/Caddy/systemd/nginx examples, hosting contracts
and verification tools. Use example domains and configurable paths. Keep actual
machine names, origin addresses, cloud project/account IDs, SSH aliases/users,
installed paths, certificate inventories and rollout observations in the ignored
private `ops/` checkout. Deployment guides describe supported arrangements, not the
topology or status of a particular live installation.

Keep populated environment files, credentials, host-specific scripts and runbooks
outside public Git, Docker build contexts and published source archives. Publish
the corresponding application source and reusable build scripts as required by
the [source contract](#static-host-contract). Public API domains used by the app
remain documented; they do not require documenting the machines behind them.
Changes confined to private operations are not part of a public repository release.
