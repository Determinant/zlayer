# Architecture

[Documentation](../README.md) / Architecture

ZLayer is a static TypeScript PWA. Browsers read versioned files from a CDN; there
is no application server, server-side database, account service, or per-user backend.
Local state lives in browser storage.

```text
FAA sources ──► faa-regs builder ──► dated static files ──► charts.tedyin.com ──► PWA
AWC API ─────────────────────────────────────► Vite / production nginx proxy ───────┘
USGS 3DEP / FAA Daily DOF ──► packaged static feed ──► terrain / obstruction workers ┘
Terrarium elevation tiles ───────────────────► terrain fallback worker ─────────────┘
Device Geolocation API ──────────────────────► shared GPS source ─► map / AHRS ──────┘
Device Motion API ──────────────────────────► experimental AHRS toolbox ────────────┘
```

## Contents

- [Responsibilities](#responsibilities)
- [Layer plugins](#layer-plugins)
- [Data layout](#data-layout)
- [Map rendering stack](#map-rendering-stack)
- [Offline model](#offline-model)
- [Performance rules](#performance-rules)

## Responsibilities

### Publishers

- `faa-regs` builds chart MBTiles, normalized navigation GeoJSON, airway JSON, the
  complete d-TPP catalog, and combined electronic paper TPPs. Optional exports include
  preferred/TEC routes, terminal/approach geometry, route history and magnetic-model
  coefficients. Feed-wide terrain and obstruction products have independent versions.
- Planned scheduled jobs fetch AWC/WPC/NOAA products, preserve raw fields and times, and
  publish immutable snapshots plus an atomic `current.json` pointer.
- Publishers validate schemas, bounds, cycles, checksums, and source freshness once
  for all clients.

### Client

- React owns controls, search, route editing, and details; shareable URL state is planned.
- A small imperative runtime owns one MapLibre/WebGL instance. React publishes
  committed feature inputs to observable stores; map adapters subscribe to their
  feature's inputs. `MapRuntime.setContributions` reconciles plugin map contributions
  on that same map, with independent loading and cancellation. Focus and route
  fitting remain explicit commands.
- A product catalog maps stable IDs to raster/vector/GeoJSON assets and styles.
- Runtime guards reject malformed catalogs, navigation collections, and weather
  documents at the network boundary.
- Workers open only the visible chart base/overlay's spatial/zoom MBTiles needed by visible
  tiles. Prestitched packages use one MapLibre layer per family; legacy feeds retain
  viewport-gated sheet layers.
- File downloads share core scheduling, bounded streaming/storage and SHA-256
  verification; product adapters own format validation and demand. The service worker precaches the shell,
  caches requested metadata, and downloads each
  newly viewed MBTiles package once. A reusable SQLite worker extracts small packages
  into a bounded whole-package memory cache; legacy byte ranges stay local as well.

`WorkspaceReadContext` keeps the browsing catalog, committed regional bundles and
one national routing catalog explicit. It does not manufacture a mixed-edition
`CatalogResponse` or attach hidden metadata to one. Its combined chart list is only
for display controls; readers resolve an exact source catalog through the context.
Startup resolves committed metadata first, then checks saved-file health in the
background. Missing bytes cannot change edition ownership.

Immutable reference loaders use `ResourceCache` for in-flight coalescing, bounded
retention and retry after failure. Navigation caches raw exports before deriving
coverage views. Route planning and recommendations share resource loading and reuse
resolvers for identical inputs while preserving their distinct product/retry policies.
`WorkerClient` owns RPC deadlines, error/messageerror handling and termination for
package decoding, legacy SQLite, route history, terrain and obstructions. A failed shared initialization
drains healthy calls; a crash settles all calls and permits fresh reader-pool retries.

## Layer plugins

A layer is a whole workspace feature: its data, behavior, presentation, and lifecycle.
Its presentation can be map imagery, weather circles and airport details, or a sliding
procedure panel. A MapLibre style layer is only a rendering primitive within a product.

Source is grouped by product under `src/layers/`: `charts/`, `metar-taf/`,
`plates/`, `navigation/`, `routes/`, `terrain/`, `obstructions/`, `ownship/`, `ahrs/`, and `ruler/`. Each folder
exposes internal entry points; these are still evolving, not a stable framework API.
Map adapters and the chart service-worker adapter have separate entry points so the
PDF viewer and map runtime remain lazy-loaded. `core/` holds reusable request, storage,
lifecycle, typed plugin discovery/connections, GPS acquisition, map primitives and
[shared UI](../features/shared-ui.md#shared-controls), with no imports from application modules. `workspace/`
owns catalog/read-context coordination, plugin registration, map runtime and camera,
gestures, composed preferences, selection/source retention, startup readiness policy,
and the cross-feature details panel. `offline/` owns
region lifecycle and persistence compatibility; `shell/` holds workspace controls
and layout. Route history's client,
store, worker and draft conversion live together in `layers/routes/history/`.

Import checks run with the type checks to enforce those boundaries and preserve lazy
renderers, data-only entries and workers without UI dependencies. Compatibility code
is only reachable through its designated offline persistence entry points.

Map contributions share one WebGL map. METAR owns visible demand, cached observations,
and timed refresh. Plates owns its selection and lazy viewer panel, plus an optional
georeferenced IAP map overlay. The viewer and overlay have independent lifecycles.
React observes product snapshots through `useLayerSnapshot` and sends actions.

The workspace creates one `core/gps/service.ts` instance and injects it into Ownship
and AHRS independently. Each feature leases GPS for its own active use; neither
plugin requires the other. Core owns the shared browser watch and normalized fixes,
while the plugins own map presentation and attitude fusion respectively. See the
[shared GPS service contract](layer-plugins.md#shared-gps-service).

See [Layer plugins](layer-plugins.md) for the implemented boundaries, registration
points and responsibilities. Packaging products separately remains a design question.

## Data layout

```text
charts/cycles.json                # available edition dates
charts/terrain/manifest.json      # feed-wide, versioned elevation packages
charts/obstacles/manifest.json    # feed-wide FAA Daily DOF dataset
charts/<cycle>/
├── *.pdf / *.tif
├── mbtiles/
│   ├── <kind>-z<zoom>-r<depth>-<x>-<y>-<sha256>.mbtiles
│   └── manifest.json
├── nav/
│   ├── airports.geojson
│   ├── fixes.geojson
│   ├── navaids.geojson
│   ├── vfr-waypoints.geojson
│   ├── airways.json
│   ├── preferred-routes.json       (optional)
│   ├── terminal-procedures.json    (optional)
│   ├── route-history.json.gz       (optional)
│   └── manifest.json
├── cs/
│   └── catalog.json
├── nasr/
├── tpp/
│   ├── catalog.json
│   └── manifest.json
└── tpp-<volume>.pdf
```

Weather currently uses same-origin METAR/TAF proxies and product-owned caches.
Optional approach and magnetic-model exports are located through the navigation
manifest rather than fixed client-side filenames.
The proposed `weather/<product>/<revision>/...` snapshots and `current.json`
pointers belong to the future shared publisher, not the current feed contract.

Per-sheet MBTiles, receipts, and work files stay in the publisher's local
`dist/mbtiles/<cycle>/` cache alongside `dist/zips/`, outside the publishable `charts/`
tree. The client reads all chart bounds and content identities from the publisher's chart
manifest for a selected dated folder, then validates the navigation and procedure
manifests. Adding sheets to that manifest needs no client-side region list or rebuild.
The root `cycles.json` supplies available dates; Latest mode selects the newest
supported date with usable chart metadata, while explicit date choices stay pinned.
Every dated manifest is validated against that requested cycle.

## Map rendering stack

1. Continuous USGS topography/shaded-relief basemap, or a configured replacement
2. Exclusive VFR sectional / IFR low chart base, then an optional terminal-area or
   flyway overlay requiring the sectional base (coverage-limited, whole-file cached)
3. Optional georeferenced IAP image
4. Route-corridor terrain fill and contours, or viewport elevation shading
5. Route lines, beneath navigation symbols
6. FAA obstruction, airport, NAVAID, VFR waypoint and IFR fix symbols
7. METAR airport circles
8. Foreground terrain, selection, route and navaid-identification labels/interaction resources
9. Optional GPS aircraft, accuracy and projection

The map host mounts charts, plates, terrain, navigation, weather, route, annotation and ownship slots in
order. Explicit anchors keep route lines below navigation, and foreground resources
are raised after mounting. Airways and SID/STARs appear through resolved route
geometry; there is no standalone national airway layer. Radar/satellite, WPC analysis,
PIREP observations and advisory products remain planned.

Map contributions use fixed slots and namespaced IDs. Toggling one layer never
rebuilds the map or changes unrelated ordering. An absent chart tile means “outside published
coverage,” not a basemap or network failure; chart selection never limits panning.

## Offline model

Today, spatial/zoom chart packages and opened procedure books are cached on demand.
The package index also declares named regions with all intersecting chart files at
all zooms. The region planner deduplicates shared files, totals download bytes, and
requires every exact content identity for completeness. Publisher regions default
to FAA chart footprints. **Settings** instead selects U.S. state/territory
envelopes against that same archive grid, always including VFR/IFR low, navigation
and all applicable whole plate/supplement books, individual-only plates and published
terrain packages at supported DEM detail levels, with sizes, progress, pause/resume, retry,
and removal. On-demand browsing and regional downloads share verified whole files:
small files live in Cache Storage, while large files stream into origin-private
file storage with small Cache Storage receipts. IndexedDB holds catalog/selection
records, not duplicate chart or PDF blobs. StorageManager reports quota
and persistence, and Web Locks coordinate windows. Basemap coverage is only saved as
viewed; weather remains time-stamped and visibly stale. The obstruction dataset is
cached on demand and is not part of regional completeness. See
[offline storage](../features/offline-storage.md) for guarantees, limits, and release checks.
Committed regional snapshots retain their edition online and offline; staged updates
activate only after verification. Route drafts, camera and workspace presentation
persist separately in localStorage; see [persistence contracts](../data/contracts.md#workspace-persistence).
Optional AHRS recordings use bounded IndexedDB chunks in the same offline database.
Settings offers a [full local reset](../features/offline-storage.md#full-local-reset) of app data
across open windows, with recovery if deletion is interrupted.
Route-corridor downloads and automatic cycle migration remain future work.

## Performance rules

- Cached shell/catalog state renders before background revalidation.
- National point files are fetched lazily, validated, then bounded to configured chart
  coverage; no full TPP book or offline package is scanned on startup.
- Navigation GeoJSON uses zoom/density rules. Future dense weather products should
  use bounded GeoJSON or vector tiles; raster animation must stay bounded.
- FAA chart rasters use 2× viewport sampling; WebGL downsamples the next deeper static
  tile level for clean linework on high-density displays. Chart visibility has no
  lower zoom cutoff. The MBTiles reader discovers both native zoom limits once per
  archive. It shrinks intersecting tiles below the minimum or crops/rescales a parent
  above the maximum (for older manifests with incorrect limits). Native missing tiles
  remain transparent; they must not be filled with tiles from another level.
- Obsolete reads and renders are cancelled.
- MapLibre, PDF.js and worker decoders load through separate entries. Settings code
  is bundled with the shell; its content mounts on first open and stays mounted so
  downloads survive closing the dialog.
- Source failure degrades one product, never the complete workspace. Optional runtime
  cache failures fall back to the network; verified chart storage, shell installation
  and explicit offline saves still require successful persistence.

### Chart I/O invariant

The network and persistent-storage cache unit is one `.mbtiles` file; the rendering
unit is one raster tile. Visible chart bases/overlays select only the spatial/zoom
packages they need. Named offline regions group those same files, not duplicate
large per-region archives. Low-zoom views request coarse mosaic files, not every
sheet's detail levels.

The service worker coalesces simultaneous first reads into one complete download,
verifies published SHA-256 and length, then publishes one immutable whole-file entry.
Small files use complete Cache Storage responses; large files use origin-private
file storage and a Cache Storage receipt. The [storage contract](../features/offline-storage.md#stored-files)
defines bounded writes, receipt publication, removal and reader lifetimes.
Chart layers wait for worker control so initial reads cannot bypass this path.
Core's [file-transfer framework](layer-plugins.md#file-downloads) bounds downloads,
streaming and cleanup across product adapters in each execution context; cached
files bypass the download queue.

Small packages use one reusable SQLite decoder and a bounded whole-package memory
pool. Legacy sheets use bounded paged readers, but all HEAD/Range requests are
answered by slicing a verified local file. Reader or memory-pool eviction reopens
from verified local storage, not the origin. Whole-package extraction is not persistent
per-tile caching; copies protect cached tile bytes from MapLibre's transfers.
See [chart-feed identity and caching](../data/chart-feed.md#identity-and-caching) for package
limits, pool sizes and transport details.

Discard queued reader opens when all requesting tiles become obsolete. Once a file
transfer starts, let it finish caching: cancelling one tile must not abort a shared
download. Hidden families must not initiate new reads. Legacy sheets additionally
need viewport-bounds gating, including wrapped antimeridian views, because low-zoom
tile bounds can intersect many large sheets.

Do not turn rendered tiles or SQLite pages into independent origin fetches. Request
fan-out against the same MBTiles file has caused substantially slower chart rendering.
Any exception requires a measured benchmark and an explicit architecture change.
