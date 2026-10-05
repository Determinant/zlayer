# Info server

One TypeScript service for ZLayer weather and NOTAM data. It shares AWC
reports/advisories, NOMADS IFI and Google HRRR acquisition, normalizes advisories,
prepares compact numeric grids, and maintains a local FAA NMS dataset. The
PWA keeps altitude interpolation, validation, rendering, point inspection and offline storage. nginx owns TLS.

Forecast delivery has two paths: the background updater discovers and prepares
native fields; HTTP only reads published catalogs and saved files. A new catalog
becomes visible after every file is saved. The preceding complete generation stays
available during preparation and for at least six minutes after replacement.
Winds retain 37 pressure levels; the PWA interpolates selected MSL/flight levels.
Weather uses one bounded disk cache, without a database or separate publishing
process. Optional FAA NMS collection has separate durable state and admission.

## NOTAM collection

The [NOTAM guide](../../src/layers/notams/README.md#info-server-integration)
owns the collector, local-query API and integration into this listener,
build and deployment. Its [collection policy](../../src/layers/notams/README.md#collection-and-delivery)
keeps a full local dataset and durable FAA quota history outside the weather cache.
The cache warm/swap procedure must preserve that state and one active collector.
Collection defaults to disabled for new deployments. Staging and production
full-load and delta paths were exercised; see the NOTAM guide's
[production verification](../../src/layers/notams/README.md#production-verification-october-5-2026).
Sustained combined weather/NMS capacity checks remain release work.

`GET`/`HEAD /api/notams/airports?faaId=…&icaoId=…` reads the local dataset, accepting
at least one named selector. These requests never contact FAA. `/api/notams/healthz`
reports NOTAM readiness; `/api/weather/healthz` includes the same `notams` summary.
Disabled/misconfigured collection or no bridged baseline returns 503 for airport
queries. Retained snapshots return 200 with explicit source time and continuity.

Enable only the chosen environment with `NOTAMS_ENABLED=true` and
`NOTAMS_ENVIRONMENT=staging` (or qualified production). Set
`NOTAMS_CLIENT_ID_FILE` and `NOTAMS_CLIENT_SECRET_FILE` to private readable files.
The FAA workbook's Key is the OAuth client ID. Tokens stay in memory; these values
must never enter `VITE_*`, command arguments, images or source control.
For systemd, use a private credential drop-in such as:

```ini
[Service]
LoadCredential=notams-client-id:/etc/zlayer/notams-client-id
LoadCredential=notams-client-secret:/etc/zlayer/notams-client-secret
Environment=NOTAMS_ENABLED=true
Environment=NOTAMS_ENVIRONMENT=staging
Environment=NOTAMS_CLIENT_ID_FILE=/run/credentials/zlayer-info.service/notams-client-id
Environment=NOTAMS_CLIENT_SECRET_FILE=/run/credentials/zlayer-info.service/notams-client-secret
```

These credential paths assume the unit is named `zlayer-info.service`. An explicit
path also works on systemd 249, which supports `LoadCredential` but does not resolve
the newer `%d` credential-directory specifier in `Environment`. An existing
`EnvironmentFile` overrides `Environment` assignments; if it sets collection to
disabled, put the enabled/environment settings in a later private environment file.

`NOTAMS_STATE_DIR` defaults locally to `.cache/notams`; systemd uses
`/var/lib/zlayer-notams`, separate from `/var/lib/zlayer-weather`. Docker includes
util-linux `flock` and declares a separate `/var/lib/notams` volume; mount that
durably and mount credential files read-only, readable by the container user.
State is partitioned by environment. `budget.json` is a durable pre-request journal;
do not delete or roll it back to repair dataset files. A corrupt/missing journal
blocks collection instead of replenishing quota. Checksummed NDJSON generations
and current/previous/candidate manifests provide independent dataset recovery.
Unchanged deltas update only the manifest and reuse records/indexes. The lock owner
collects unreferenced datasets at startup and after publication/candidate disposal;
it retains the current dataset, the previous distinct dataset and one candidate.
Failed replacement syncs preserve live continuity and resume live deltas when eligible.
Saved records are checksummed before derived validity/revision upgrades; upgrades
preserve source times and the separate quota journal.

Keep candidate-release warming at `NOTAMS_ENABLED=false`. Stop/drain the old
collector before starting its replacement against the same state. A local kernel
lock prevents concurrent writers on one host; enforce one credential owner across
hosts as well. Data requests are at least three minutes apart, bulk attempts at
least 24 hours apart; failed attempts consume their reserved slots. Browser refresh
and weather test spacing never change those allowances. See the owning guide for
size bounds, recovery, staging evidence and remaining source qualifications.

## Run locally

`npm run dev` forwards weather and NOTAM reads to `https://zlayer.tedyin.com`, reusing
its prepared data over HTTPS. It starts no local backend. To develop this
service, use Node 24+ and run `npm run info:serve` separately from the repository root. It listens on
`127.0.0.1:8787` with `.cache/weather/`. Start the PWA with
`INFO_API_ORIGIN=http://127.0.0.1:8787 npm run dev` to opt into that local backend.

`/api/weather/healthz` separates process status from each product's readiness,
source times, preparation progress and failures. Use the
[deployment readiness checklist](#deployment-readiness) before serving a release;
`ok: true` alone is insufficient.

Restart and unchanged-source reuse authenticate referenced prepared files,
including both stored HTTP encodings. Readiness requires the catalog and its
required artifacts to remain present. Progs and grids require complete families;
NDFD's explicit unpublished stops remain valid gaps; radar requires the national
scan and prunes unavailable terminal/history files. Detected disk damage is
repaired by the background updater even when upstream bytes are unchanged.

HTTP delivery is classified once in `routes.ts` as query, catalog or immutable
artifact. Only queries can enter on-demand acquisition. Catalog marker checks and
missing-resource responses use that classification, not repeated URL inspection.
Worker replies distinguish invalid bytes, future source timestamps and retryable
processing failures; only explicit source failures suppress an unchanged radar
digest. MRMS and NDFD PNG validation share a bounded scanline preflight and reject
unsupported compressed metadata before pixel decoding. Upstream admission uses
a bounded FIFO with one spacing timer, woken by completion or cancellation.

## Source and cache contract

| Request | Content | Cache age |
| --- | --- | --- |
| `/api/weather/metars.geojson?ids=…` or `?bbox=…` | Original AWC METAR GeoJSON | 30 seconds |
| `/api/weather/tafs.json?ids=…` or `?bbox=…` | Original AWC TAF JSON | 60 seconds |
| `/api/weather/advisories/{gairmet,sigmet,cwa}.json` | Normalized advisories | 60 seconds |
| `/api/weather/radar/latest.json` and `/api/weather/radar/<site>/<time>-<hash>.json` | MRMS/NEXRAD composite and TDWR numerical contours, with recent history | Background checks every minute; immutable prepared scans, two-hour history and 15-minute observation-age limit |
| `/api/weather/radar/motion/latest.json` and `/api/weather/radar/motion/<hash>.json` | NOAA STI projected cell tracks, with individual station observation times | Independent background rounds; prepared snapshots with accumulated two-hour history |
| `/api/weather/progs/{analysis,forecast}.json` | Small catalogs of complete prepared AWC/WPC chart families | Source checks every five minutes |
| `/api/weather/progs/{analysis,forecast}/<sha256>.json` | Immutable native-vector pressure chart | Retained up to 24 hours within the shared byte budget |
| `/api/weather/progs/coverage.json` and `/api/weather/progs/coverage/<sha256>.png` | Independent NDFD weather-image catalog with explicit unpublished stops, and authenticated AWC PNGs | Source checks every five minutes; 30-second failure retry; immutable images retained within the shared budget |
| `/api/weather/grids/{clouds,icing,winds}.json` | Latest complete prepared generation | Up to 24 hours; original source times retained |
| `/api/weather/grids/<product>/<run>-<lead>-<level>-<identity>.zwp.gz` | Immutable native numeric grid; wind levels use `p<pressure-hPa>` | Up to 24 hours, within the shared byte budget |
| `/api/weather/grids/winds/<run>-terrain-<identity>.zwt.gz` | Same-run model terrain for PWA masking | Up to 24 hours, within the shared byte budget |

Raw AWC and model index/range acquisition is internal; the API exposes no upstream
proxy routes. G-AIRMET reads 0/3/6/9/12 h at one lookup instant, validates their
common cycle and publishes only complete packages, preserving freezing contours.
METAR/TAF batching, nearby queries and report interpretation remain in their plugin.
Station requests allow up to 100 IDs or one bounding box. Unknown hosts, paths,
parameters and multipart ranges fail locally. Only METAR/TAF 204 responses become
empty report results. Advisory GeoJSON requires a successful document, including
an explicit empty feature collection; a missing G-AIRMET frame rejects the package.
Responses at the 400-record ceiling fail rather than silently truncate.

The server discovers the newest complete horizon within six preceding hourly
cycles. Clouds/winds cover F00–F18; IFI covers F001–F018 at all 60 native altitudes.
Wind catalogs contain 37 native pressure levels per hour. These support all 71 PWA
altitude/flight-level selections without producing 71 derived grids on the server.
Each candidate must supply every required index, selected field and same-cycle
terrain before it is accepted. Publication gaps or invalid indexes try an older
cycle; outages and rate limits fail without probing more cycles. Expected missing
index probes do not produce error logs; exhausted discovery and failed pinned
preparation errors are logged. Artifacts stay pinned to their cycle, lead,
altitude and converter/source identity. A missing HTTP artifact returns 404;
it never starts discovery or conversion.
HRRR indexes and ranges use the same Google bucket, including model terrain; IFI
uses NOMADS. An index is limited to 512 KiB, a GRIB range to 8 MiB, and a prepared
artifact to 16 MiB. Exact HTTP 206 range/length and GRIB envelope checks precede
model/field/level/geometry validation. A source-index change cannot satisfy an older artifact identity.
Internal ranges without an index hash have a 60-second cache lifetime.
Adjacent model records from the same index share downloads of at most 8 MiB through
the existing source cache. Each GRIB envelope in the combined range is validated;
the processor extracts exact indexed records before decoding. Gaps, changed index
identities and open-ended final records start separate downloads. Preparing other
altitudes reuses those blocks instead of requesting each field separately.

The updater has one job per product. It finishes that candidate rather than
abandoning partially prepared runs whenever a newer index appears. An unchanged
source reuses authenticated artifacts. Changed, removed or invalid source data, including
malformed GRIB envelopes and incorrect ranges, trigger discovery again; transient failures retry after thirty seconds while the previous
catalog remains available. After a complete publication, the next source check is
six minutes later, covering the PWA's five-minute refresh and request lifetime.
Advisories refresh independently every thirty seconds when their cache age expires.

Up to two Node workers, capped by the host CPU count, acquire and convert native
fields. Updaters submit bounded batches to that shared pool; one remaining product
can use the whole pool without increasing overall concurrency. Each job has a 150-second deadline and bounded GRIB inputs; idle workers
exit after thirty seconds. Each worker reuses geometry/terrain, and the source
block plan is computed once per candidate. Terrain is read only when its run
changes. No selected-altitude slices or full vertical cubes are produced here.
The [grid guide](../../src/layers/weather-awc/grids/README.md#browser-source-and-cache-contract)
owns numeric formats and validation.

The default **8 GiB / 5,000-entry** cache covers prepared artifacts and disposable
source responses together. The former 4 GiB default filled during concurrent
forecast replacement and radar retention; 8 GiB provides additional working space.
Published, preceding and building generations are protected;
raw inputs and older runs are evicted first. A replacement that cannot fit fails
without deleting the published generation. Files are atomic and checksummed;
serialized publication reserves space before writing. Completed catalogs carry
`X-Weather-Catalog: complete-native-v1`. Startup authenticates their listed files
before accepting them; malformed cache metadata and incomplete catalogs are discarded and rebuilt in the
background. A cold installation has no ready catalog until initial preparation
finishes. It must be prepared before production cutover.

HTTP forecast requests perform no upstream work. Numeric files stream from disk
with bounded buffers, without a conversion queue or whole-response allocation.
Catalogs keep their original source-check, run and valid times; reading a file
cannot advance freshness. Clients validate the supplied artifact identity and
compressed-byte SHA-256 before accepting data. The PWA keeps its own offline cache.

Source acquisition remains bounded independently of viewers: AWC starts at most
once per second (two in flight), NOMADS every 600 ms (four), and Google HRRR every
100 ms (four), with upstream 429/503 backoff. These limits apply to background
forecast preparation and report/advisory misses, never to saved forecast reads.
METAR/TAF preserve their query-based shared caching; they do not enter the numeric
preparation workers.

`Cache-Control: no-store` prevents intermediary caches from extending freshness.
Prepared JSON of at least 1 KiB stores a gzip representation beside the original
bytes during atomic publication (when smaller). Both encodings count toward the
disk ceiling. HTTP streams the negotiated representation without buffering or
recompressing it, and HEAD reads only metadata/stat information. Content digests
are verified with bounded read buffers on the first body read after restart or a
file-stat change; clients also authenticate their complete artifact. Forecast warmer
completeness checks reuse this authentication while file size, modification time
and change time remain unchanged, avoiding body reads and hashing every six minutes.
Restarted or changed files authenticate both raw and gzip bytes before reuse;
missing or damaged files return to preparation. Older saved
files without a compressed representation stream unchanged until replaced.
Query-based report/advisory JSON still uses negotiated gzip on response. Already compressed numeric
slices are sent unchanged. Responses carry `X-Weather-Cache` and the decoded
response payload's byte SHA-256; grids also carry their converter/source identity.
HTTP forecasts always report HIT; query-based report/advisory misses can report MISS. No request bodies are logged.

## Surface analysis and Progs

`progs.ts` shares AWC's public Progs catalog acquisition between independent
analysis and forecast background updates; `progs-coverage.ts` independently
publishes companion NDFD images. Both use this service's shared source queue and
disk cache. Chart preparation runs in `progs-worker.js`, and PNG validation in
`progs-coverage-worker.js`, outside the HTTP event loop. HTTP serves the resulting
catalogs and immutable files without acquiring or processing upstream data.

The Progs guide owns [pressure-chart acquisition and recovery](../../src/layers/weather-awc/progs/README.md#acquisition-and-recovery)
and [NDFD coverage](../../src/layers/weather-awc/progs/README.md#precipitation-and-weather-coverage),
including source interfaces, publication markers, format limits, polling/retry
intervals, retention, migration and rollback/correction rules. It also owns weather
meaning and PWA selection, rendering and recovery.

## Deployment

Place the info backend behind the app's HTTPS reverse proxy, forwarding
`/api/weather/` and `/api/notams/` to its private listener. Browser requests stay
same-origin, including local development through Vite. No public backend port or
browser CORS setup is needed. Direct `/weather/` source proxies remain retired.

The [Docker web-host example](../../docs/development/deployment.md#docker-hosting-and-staged-migration)
uses Caddy on the same Linux host to reach the backend's loopback listener directly.
The backend can remain under systemd or run in a separate container with its port
published only to loopback. For a separate backend host, the optional nginx example
uses a [managed SSH tunnel](zlayer-info-tunnel.service) from proxy-host loopback
port 8788 to backend loopback port 8787. Moving the web tier does not require a
second collector or a weather/NOTAM state migration. Keep live host details in
[private operations](../../docs/development/deployment.md#public-configuration-and-private-operations).

### Deployment readiness

Use the same checks on the backend's loopback listener, through the candidate
proxy or tunnel before cutover, and through public HTTPS after activation:

- Require `healthz.forecasts.clouds`, `.icing` and `.winds`, both `healthz.progs`
  families, and `healthz.progsCoverage` to report `ready: true`.
- Read reports, all three advisory snapshots, and a prepared numeric slice for
  each model. Read both pressure-chart catalogs and a referenced chart file from
  each family, plus the coverage catalog and a referenced PNG. Verify chart/PNG
  lengths and hashes against their catalog references. Unpublished coverage images remain
  explicit gaps and do not prevent a complete catalog from being ready.
- Check that repeated reads and restart hits preserve bytes and source-check
  timestamps. Review failures with `journalctl -u zlayer-info`.

The bundle includes a read-only check for these routes and authenticated artifacts:
`node tools/info-server/dist/check-info-api.js https://your-app.example disabled`.
Use `staging` or `production` instead of `disabled` when that NOTAM environment
is enabled; the check requires a ready, complete feed and a valid local airport
response. It also checks national radar and the storm-motion catalog. Run it on
the candidate loopback listener before activation and on public HTTPS afterward.

### Service installation

Build from the repository root with installed dependencies:

```bash
npm ci
npm run info:build
```

Install a supported Node 24 runtime at `/opt/zlayer-info/node` (or adjust
`ExecStart` in the supplied unit). Copy the complete `tools/info-server/dist/`
contents to `/opt/zlayer-info/releases/<release>/` and atomically point
`/opt/zlayer-info/current` at that directory. The build includes its module
package metadata, the server entry, all worker entries and shared algorithms; production needs no npm
installation. Keep previous releases for rollback.

```bash
sudo install -m 644 tools/info-server/zlayer-info.service /etc/systemd/system/zlayer-info.service
sudo systemctl daemon-reload
sudo systemctl enable --now zlayer-info
curl --fail http://127.0.0.1:8787/api/weather/healthz
```

The base unit starts at boot after network setup, runs with a dynamic unprivileged
user and a persistent `/var/lib/zlayer-weather` cache, and restarts five seconds
after an unexpected exit. A listener failure stops background work and exits unsuccessfully
so the service can restart. The unit caps the shared server at four CPUs and 4 GiB RAM, with
lower CPU/I/O priority for other host services. Restart attempts remain enabled during a prolonged failure; no SSH login or user
session is required. Subsequent releases switch `current`, restart the unit, and
must meet the [readiness checklist](#deployment-readiness).

Two forecast workers reduce overlapping decoded-grid allocations; the 4 GiB
allowance leaves room for independent radar/chart workers and resident NOTAM generations. This
does not reduce grid or chart resolution. Check `MemoryCurrent`, `MemoryPeak` and
the cgroup's `memory.events` across forecast replacement, radar backfill and a
NOTAM full sync after rollout; a short local replay is not a production soak test.

For the initial publication or a converter migration, prepare on a separate
loopback port/cache first, then stop both processes and move the prepared cache
with the release pointer. Never let two processes write one cache directory.
Rollback switches `current` back and restarts the same unit.

For a separate backend host, install `zlayer-info-tunnel.service` on the HTTPS
proxy host, a restricted SSH key at `/etc/zlayer-info-tunnel/id_ed25519`, verified
backend host keys at `/etc/zlayer-info-tunnel/known_hosts`, and an environment file
`/etc/zlayer-info-tunnel.env` containing `INFO_SSH_TARGET=user@host`.
The backend SSH account should allow forwarding only to `127.0.0.1:8787`.
Enable the tunnel with systemd; it reconnects automatically and binds only to the
proxy host's loopback. Apply the [readiness checklist](#deployment-readiness) through
`127.0.0.1:8788` before changing nginx. Keep the old backend available until that
cutover succeeds, then disable it so only the selected backend performs background
source updates.

Add
[info-api.nginx.conf](../../docs/development/info-api.nginx.conf) inside
the app's TLS server block, run `sudo nginx -t`, and reload nginx. Keep the service
on loopback. The matching PWA uses `/api/weather/`; direct `/weather/` proxy locations
are retired. The server and app have no raw-proxy fallback.
The native-pressure update requires its matching PWA: the pre-native PWA
requests server-interpolated wind altitude URLs, which this source no longer serves.
Do not deploy this backend alone under that PWA. Coordinate the frontend/backend
cutover and tell existing tabs to accept **Update now** for the changed wind API.
Deploying this service does not publish the frontend. Publish its corresponding
source archive and set `INFO_SOURCE_URL` to the immutable HTTPS URL; API responses
offer it with a `Link` header and `/healthz` includes the same source link.
FAA/chart hosting follows the [deployment guide](../../docs/development/deployment.md).

Process environment (systemd optionally reads `/etc/zlayer-info.env`):

| Variable | Default |
| --- | --- |
| `INFO_HOST` | `127.0.0.1` |
| `INFO_PORT` | `8787` |
| `WEATHER_CACHE_DIR` | `.cache/weather`; systemd uses `/var/lib/zlayer-weather` |
| `WEATHER_CACHE_MIB` | `8192` (8–102400), combined source and processed-response payload budget |
| `INFO_USER_AGENT` | `ZLayer-info-server/0.1`; operator contact may be appended |
| `INFO_SOURCE_URL` | Unset locally; deployed releases link their corresponding source archive |
| `INFO_CORS_ORIGIN` | Unset for same-origin nginx; optionally one exact HTTP(S) origin |

Alternatively build and run the container from the repository root:

```bash
docker build -f tools/info-server/Dockerfile -t zlayer-info .
docker run -d --name zlayer-info --restart unless-stopped --memory=4g --cpus=4 \
  -p 127.0.0.1:8787:8787 -v zlayer-weather:/var/lib/weather \
  -v zlayer-notams:/var/lib/notams zlayer-info
```

Use systemd or Docker with persistent storage and prepare data before serving the
first forecast catalog. Allow disk space for the 8 GiB weather payload budget,
cache metadata, temporary writes and separate durable NOTAM state. An explicit
`WEATHER_CACHE_MIB` overrides the default; restart the server after changing it.
Replicas do not share caches or upstream quotas. The same [readiness checklist](#deployment-readiness)
applies to either installation method.

### Migrating the former weather-server name

The shared process now lives in `tools/info-server/`, exports `createInfoServer`,
and uses `npm run info:serve` / `npm run info:build`. Shared settings use `INFO_HOST`,
`INFO_PORT`, `INFO_CORS_ORIGIN`, `INFO_SOURCE_URL`, `INFO_USER_AGENT`,
`INFO_API_ORIGIN` and `INFO_SSH_TARGET` in place of their former `WEATHER_` names.
The development proxy also accepts legacy `WEATHER_API_ORIGIN` when
`INFO_API_ORIGIN` is unset, so an existing dev session keeps its selected backend.
Weather-specific `WEATHER_CACHE_DIR` / `WEATHER_CACHE_MIB` and all `NOTAMS_*`
settings keep their names. The public API routes, port 8787, `.cache/weather`,
`.cache/notams`, and persistent weather/NOTAM state directories retain their identities.

Existing installations must copy their release/runtime to `/opt/zlayer-info/`,
move their environment configuration to `/etc/zlayer-info.env`, and update the
shared setting names. Carry over credential drop-ins to `zlayer-info.service`.
The tunnel uses `zlayer-info-tunnel.service` and its matching `/etc/` paths.
Stop and disable the old service/tunnel before enabling their renamed replacements;
never run both collectors against the same credentials. Reuse the existing cache
and NOTAM volumes, including the NOTAM quota journal. This repository rename does
not migrate or restart a deployed installation.

## Verification and ownership

Cache/expiry/range behavior is covered by `test/info-server.test.ts`; complete
horizons and pinned identities by `weather-discovery.test.ts`; worker outputs and
restart reuse by `weather-processing.test.ts`; atomic publication and recovery by
`weather-warming.test.ts`. Captured GDAL fixtures provide
independent numeric references. Tests are not device or upstream-availability
qualification. Follow the [repository release checks](../../docs/development/local-development.md#verification)
before committing.

The server owns acquisition, preparation and shared cache policy. Plugin contracts
own weather meaning; the PWA owns altitude interpolation, presentation and user
storage. Source references: [AWC API](https://aviationweather.gov/data/api/),
[DAFS inventory](https://www.nco.ncep.noaa.gov/pmb/products/dafs/) and the
[grid contract](../../src/layers/weather-awc/grids/README.md).

## Radar preparation and history

TDWR decompression uses a [vendored seek-bzip runtime](vendor/seek-bzip/README.md)
with explicit buffer allocation, preserving the qualified decoder and bounded
output callback without the deprecated `Buffer()` warnings emitted by each new
worker. The build ships its MIT license alongside the bundle.

`radar.ts` acquires NOAA MRMS GRIB2 from its public S3 bucket and 45 TDWR product
180 files from NWS TGFTP. Two additional isolated Node workers decode and prepare
contours with 60-second job deadlines. The radar upstream queue permits two
in-flight requests with 250 ms start spacing and normal overload backoff.
Unchanged source hashes reuse prepared files. A complete catalog requires a
national scan; individual terminal failures preserve saved scans with their original
times and remain explicit in catalog status. The client limits observation age at
the selected time, so an expired live image can still be eligible for history.
National refresh has a dedicated slot and publishes independently of terminals;
terminal rounds publish partial results every five stations. Between national
checks, the idle slot backfills at most eight missing five-minute buckets per
batch, with cancellation when live work is due. MRMS S3 listings use `start-after`
to bound the listing to the history window throughout the UTC day. Scan timestamps
are checked before expensive decoding; rejected unchanged hashes skip conversion
and repeated identical station errors are suppressed. Terminal history accumulates as
scans arrive. The rolling two-hour catalog retains one sample per station/bucket,
bounded to one quarter of the configured cache budget and at most 1 GiB, prioritizing
national history. The shared disk budget protects current/building files, published
history and six minutes of preceding radar catalogs. HTTP reads never acquire or
process radar. `healthz.radar` reports readiness, checked time, unavailable sites
and the count of retained historical scans.

`radar-motion.ts` independently collects small NOAA NEXRAD STI/product 58 files,
prepares their native projected tracks, and publishes a small catalog plus immutable
national snapshots. It shares source admission and the disk budget but no reflectivity
worker slots. HTTP never starts collection or decoding. `healthz.radarMotion` exposes
preparation, station availability and catalog status. The
[Storm motion contract](../../src/layers/weather-awc/radar/README.md#storm-motion)
owns time alignment, collection cadence, history retention and decoding limits.

The server build includes `worker.js`, `radar-worker.js`, `progs-worker.js`,
`progs-coverage-worker.js` and `notams-worker.js`; deploy the entire build with its matching `main.js`,
package metadata and shared files. See the [Radar guide](../../src/layers/weather-awc/radar/README.md)
for exact source semantics, binary format qualification and client/storage limits.
