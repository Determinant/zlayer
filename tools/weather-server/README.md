# Weather server

One small TypeScript service for all default ZLayer weather requests. It shares
AWC reports/advisories, NOMADS IFI and Google HRRR acquisition, normalizes advisories,
and prepares compact numeric grids with the existing TypeScript algorithms. The
PWA keeps altitude interpolation, validation, rendering, point inspection and offline storage. nginx owns TLS.

Forecast delivery has two paths: the background updater discovers and prepares
native fields; HTTP only reads published catalogs and saved files. A new catalog
becomes visible after every file is saved. The preceding complete generation stays
available during preparation and for at least six minutes after replacement.
Winds retain 37 pressure levels; the PWA interpolates selected MSL/flight levels.
There is one bounded disk cache, no database or separate publishing process.

## Run locally

`npm run dev` forwards weather to `https://zlayer.tedyin.com`, reusing GCP's shared
prepared data through DO's HTTPS proxy. It starts no local backend. To develop this
service, use Node 24+ and run `npm run weather:serve` separately from the repository root. It listens on
`127.0.0.1:8787` with `.cache/weather/`. Start the PWA with
`WEATHER_API_ORIGIN=http://127.0.0.1:8787 npm run dev` to opt into that local backend.

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

Up to four Node workers, capped by the host CPU count, acquire and convert native
fields. Updaters submit bounded batches to that shared pool; one remaining product
can use the whole pool without increasing overall concurrency. Each job has a 150-second deadline and bounded GRIB inputs; idle workers
exit after thirty seconds. Each worker reuses geometry/terrain, and the source
block plan is computed once per candidate. Terrain is read only when its run
changes. No selected-altitude slices or full vertical cubes are produced here.
The [grid guide](../../src/layers/weather-awc/grids/README.md#browser-source-and-cache-contract)
owns numeric formats and validation.

The **4 GiB / 5,000-entry** cache covers prepared artifacts and disposable source
responses together. Published, preceding and building generations are protected;
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

The weather backend runs on gcp0, with DigitalOcean retaining the app's HTTPS
domain. DO nginx forwards `/api/weather/` to its loopback port 8788; the
[managed SSH tunnel](zlayer-weather-tunnel.service) carries that connection to
GCP's loopback port 8787. Browser requests stay same-origin, including local
development through Vite. No public GCP weather port or browser CORS setup is
needed. Direct `/weather/` source proxies remain retired.

<a id="digitalocean-droplet"></a>

### Deployment readiness

Use the same checks on GCP's loopback service, through the DO tunnel before a
proxy cutover, and through public HTTPS after activation:

- Require `healthz.forecasts.clouds`, `.icing` and `.winds`, both `healthz.progs`
  families, and `healthz.progsCoverage` to report `ready: true`.
- Read reports, all three advisory snapshots, and a prepared numeric slice for
  each model. Read both pressure-chart catalogs and a referenced chart file from
  each family, plus the coverage catalog and a referenced PNG. Verify chart/PNG
  lengths and hashes against their catalog references. Unpublished coverage images remain
  explicit gaps and do not prevent a complete catalog from being ready.
- Check that repeated reads and restart hits preserve bytes and source-check
  timestamps. Review failures with `journalctl -u zlayer-weather`.

### Service installation

Build from the repository root with installed dependencies:

```bash
npm ci
npm run weather:build
```

Install a supported Node 24 runtime at `/opt/zlayer-weather/node` (or adjust
`ExecStart` in the supplied unit). Copy the complete `tools/weather-server/dist/`
contents to `/opt/zlayer-weather/releases/<release>/` and atomically point
`/opt/zlayer-weather/current` at that directory. The build includes its module
package metadata, the server entry, all worker entries and shared algorithms; production needs no npm
installation. Keep previous releases for rollback.

```bash
sudo install -m 644 tools/weather-server/zlayer-weather.service /etc/systemd/system/zlayer-weather.service
sudo systemctl daemon-reload
sudo systemctl enable --now zlayer-weather
curl --fail http://127.0.0.1:8787/api/weather/healthz
```

The base unit starts at boot after network setup, runs with a dynamic unprivileged
user and a persistent `/var/lib/zlayer-weather` cache, and restarts five seconds
after an unexpected exit. A listener failure stops background work and exits unsuccessfully
so the service can restart. The unit caps weather at four CPUs and 2 GiB RAM, with
lower CPU/I/O priority for other host services. Restart attempts remain enabled during a prolonged failure; no SSH login or user
session is required. Subsequent releases switch `current`, restart the unit, and
must meet the [readiness checklist](#deployment-readiness).
For the initial publication or a converter migration, prepare on a separate
loopback port/cache first, then stop both processes and move the prepared cache
with the release pointer. Never let two processes write one cache directory.
Rollback switches `current` back and restarts the same unit.

On DO, install `zlayer-weather-tunnel.service`, a restricted SSH key at
`/etc/zlayer-weather-tunnel/id_ed25519`, verified GCP host keys at
`/etc/zlayer-weather-tunnel/known_hosts`, and an environment file
`/etc/zlayer-weather-tunnel.env` containing `WEATHER_SSH_TARGET=user@host`.
The GCP SSH account should allow forwarding only to `127.0.0.1:8787`.
Enable the tunnel with systemd; it reconnects automatically and binds only DO's
loopback. Apply the [readiness checklist](#deployment-readiness) through
`127.0.0.1:8788` before changing nginx. Keep the old backend available until that
cutover succeeds, then disable it so only GCP performs background source updates.

Add
[weather-api.nginx.conf](../../docs/development/weather-api.nginx.conf) inside
the app's TLS server block, run `sudo nginx -t`, and reload nginx. Keep the service
on loopback. The matching PWA uses `/api/weather/`; direct `/weather/` proxy locations
are retired. The server and app have no raw-proxy fallback.
The native-pressure update requires its matching PWA: the pre-native PWA
requests server-interpolated wind altitude URLs, which this source no longer serves.
Do not deploy this backend alone under that PWA. Coordinate the frontend/backend
cutover and tell existing tabs to accept **Update now** for the changed wind API.
Deploying this service does not publish the frontend. Publish its corresponding
source archive and set `WEATHER_SOURCE_URL` to the immutable HTTPS URL; API responses
offer it with a `Link` header and `/healthz` includes the same source link.
FAA/chart hosting follows the [deployment guide](../../docs/development/deployment.md).

Process environment (systemd optionally reads `/etc/zlayer-weather.env`):

| Variable | Default |
| --- | --- |
| `WEATHER_HOST` | `127.0.0.1` |
| `WEATHER_PORT` | `8787` |
| `WEATHER_CACHE_DIR` | `.cache/weather`; systemd uses `/var/lib/zlayer-weather` |
| `WEATHER_CACHE_MIB` | `4096` (8–102400), combined source and processed-response payload budget |
| `WEATHER_USER_AGENT` | `ZLayer-weather-gateway/0.1`; operator contact may be appended |
| `WEATHER_SOURCE_URL` | Unset locally; deployed releases link their corresponding source archive |
| `WEATHER_CORS_ORIGIN` | Unset for same-origin nginx; optionally one exact HTTP(S) origin |

Alternatively build and run the container from the repository root:

```bash
docker build -f tools/weather-server/Dockerfile -t zlayer-weather .
docker run -d --name zlayer-weather --restart unless-stopped \
  -p 127.0.0.1:8787:8787 -v zlayer-weather:/var/lib/weather zlayer-weather
```

Use systemd or Docker with persistent storage and prepare data before serving the
first forecast catalog. The standard 4 GiB cache fits on gcp0’s root disk; no large
data-disk mount or storage drop-in is required. Replicas do not share
caches or upstream quotas. The same [readiness checklist](#deployment-readiness)
applies to either installation method.

## Verification and ownership

Cache/expiry/range behavior is covered by `test/weather-server.test.ts`; complete
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

The server build includes `worker.js`, `radar-worker.js`, `progs-worker.js` and
`progs-coverage-worker.js`; deploy the entire build with its matching `main.js`,
package metadata and shared files. See the [Radar guide](../../src/layers/weather-awc/radar/README.md)
for exact source semantics, binary format qualification and client/storage limits.
