# Layer by layer

A ZLayer layer is a complete workspace feature: its data, behavior, presentation,
and lifecycle. VFR/IFR imagery, METAR information, and procedure plates are all layers.
A plate viewer is a layer independently of whether its optional georeferenced map
overlay is enabled. A MapLibre style layer is a lower-level rendering resource owned by a product.

Keep related behavior together. Loading, caching, refresh, status, UI, and cleanup
belong with the feature they serve. The application composes products and connects
user actions between them.

## Source layout

```text
src/
  app.tsx                  workspace composition and cross-product actions
  workspace/
    catalog/               feed discovery, saved catalogs and the catalog hook
    read-context.ts        explicit browsing, routing and saved-edition read model
    use-workspace-read-context.ts   restore ownership, then observe availability
    products.ts            stable product instances and panel registration
    feature-details-panel.tsx      navigation/weather/forecast/plates composition
    nearby-feature-picker.tsx      chooser for overlapping map features
    map/                   lazy runtime, inputs, gestures, style and map registry
  layers/
    charts/                VFR/IFR selection, tiles, archives, readers, cache
    metar-taf/             airport reports, station selection, nearby ranking, refresh lifecycle
      metar/               observation client, visible demand, map circles, decoded reports
      taf/                 forecast client, validity, raw colored periods
    plates/                procedure catalog, selection, PDF viewer and georeferenced map overlay
    navigation/            FAA data, search, airport details, map presentation
    routes/                route draft, planning, editor, map presentation
      history/             history client, store, worker and draft/query conversion
    terrain/               route/viewport DEM demand, packaged elevation, worker, contours and fill
    obstructions/          FAA Daily DOF loader, compact worker index, viewport/route symbols
    ownship/               shared device GPS watch, ground track, one-minute projection and status
    ahrs/                  estimator, calibration, attitude/GPS instruments, HSI and recording
  offline/                 region lifecycle, snapshots, retention and availability
    compatibility/         legacy plan, bundle and supplement migrations
  core/
    data/                  request, validation, resource cache and worker helpers
    format/                shared date, timestamp and currency labels
    geo/                   proximity bounds and compass directions
    storage/               artifact verification, IndexedDB and versioned UI storage
    ui/                    viewport bounds, persistent UI hooks and common controls
    graphics/              numeric pixel canvases and raster bitmap alpha handling
    layers/                identity, snapshots, demand scheduler, panel host
    map/                   map adapter host, label and touch-handler primitives
  shell/                   controls, map-edge tools, camera persistence and layout
  service-worker.ts        shell/data caching and chart worker composition
```

Each product exposes a UI entry (`index.ts` or `index.tsx`), with separate data
(`api.ts`) and static-definition (`definitions.ts`) entries where needed. Non-UI
consumers import these data-only entries, not a UI barrel: offline planning must not
pull in airport cards, viewers or their React hooks. Tests can import internals
directly. Files inside a folder can stay focused without scattering a feature across
the source root.

Charts, plates, navigation, routes, terrain, obstructions and GPS expose separate `map.ts` entries; METAR exposes its
lightweight adapter as `.map` on the product instance. Charts also exposes `worker.ts`
for its service-worker contribution. These entries preserve environment and loading
boundaries: importing a chart selector must not load SQLite or MapLibre;
listing procedures must not load PDF.js; the service worker must not import React.
Feature styles live in their product folder. Cross-product placement and responsive
layout stay in the shell; the details panel owns its own styles in `workspace/`.

`core/` has no dependency on features or application coordination. Features can use
the data-only workspace read context, catalog coverage helpers and feed configuration,
but do not import workspace composition or shell controls. The details panel combines
feature-owned sections; navigation still owns its detail formatting and runway UI.

`packages/domain/src/features.ts` owns shared point identity, normalized identifier
aliases, display labels, and airport classification. Map deduplication, search,
route matching, and plate/supplement lookup use these helpers. Entity identity stays
separate from repeated route occurrences and reference-data edition matching. GPS
identity uses its coordinate token so map rounding and drag previews preserve the
selected point. Route-token validation, weather-station aliases, and plates
eligibility remain with their respective features.

Navaid subtype spellings are defined in `packages/domain/src/navaids.ts` and shared
by map symbols, Morse details, and nearby-station lookup. `weather.ts` owns METAR
station IDs and observation-time parsing for both airport enrichment and the live
client. Weather requests use published ICAO codes; report joins retain their FAA
aliases. Missing observation times stay distinct from a valid Unix epoch zero.

Offline lifecycle is application infrastructure, separate from generic storage.
`offline/bundle-repository.ts` restores selections and checks availability. Its restore
API explicitly includes adoption of eligible older records; compatibility helpers own
that migration's exact-edition matching and guarded writes. Modern committed metadata
loads without dependency reads or migration writes. Product readers use the repository
and supplement persistence entries rather than importing migration code.

`npm run check:imports` (also part of `npm run check` and CI) enforces these ownership
rules, the migration entry points, data/worker isolation from UI runtimes, and lazy
MapLibre/PDF/SQLite loading from the initial page. It examines imports and re-exports,
including transitive runtime dependencies. Type-only imports do not load runtimes.

## Product capabilities

`core/layers/product.ts` defines a small identity (`definition.id` and `title`) and
an optional panel capability. A product exposes the capabilities its feature needs;
there is no mandatory map dependency or universal refresh timer.

| Product | Current entry points | Ownership |
| --- | --- | --- |
| Charts | Selection/cache UI and `map.ts` adapters, one per VFR/IFR family | Tile demand, archive selection, verified cache, bounded readers and map resources |
| METAR/TAF | `metar-taf/index.ts`: METAR `.map` and snapshot subscription, combined `AirportWeather` detail contribution | Shared station selection, nearby ranking and detail lifecycle; METAR minute refresh and map circles; TAF five-minute refresh and colored forecast periods |
| Plates | Viewer/overlay commands, snapshot, `Panel`, `MapControl` and `map.ts` | Selected plate, catalog access, lazy PDF viewer, page/zoom state, georeferenced map image and cleanup |
| Navigation | Data/search hooks, airport/runway details UI and map adapter | Shared FAA references, runway metadata, search, static point presentation |
| Routes | Draft actions, planning/editor UI and map adapter | User route, airway/TEC resolution, SID/STAR and approach previews, recommendations and route presentation |
| Terrain | Controls/legend and `map.ts` adapter | Route/viewport DEM demand, packaged elevation and fallback tiles, bounded decoding cache, contours, fading and sampled-high labels |
| Obstructions | Controls/legend and `map.ts` adapter | Validated FAA Daily DOF, worker index, viewport height thresholds, route corridor fading and source date |
| GPS aircraft | Controls/status, snapshot subscription, shared GPS leases and `map.ts` adapter | Device location watch, fix freshness, ground track and one-minute projection |
| AHRS | `AhrsTool`, calibration/stop commands and snapshot subscription | Local estimator, motion permission, flight leveling/gyro calibration, GPS instruments, HSI and recordings |

`metar-taf/airport-weather.tsx` composes two instances of `station-weather.tsx`,
which owns selection, the station dropdown, refresh and cleanup. `nearby-stations.ts`
handles both report formats' station identity, freshness and nearby ranking.
The METAR and TAF report views remain separate, as do their clients' validation,
request formats, retry policies and cache keys (`zlayers.metars.v1` and `zlayers.tafs.v1`).
Selections and refresh timers remain independent. The METAR map identity and saved
visibility setting remain `metar`; the directory name describes the module's scope.

`workspace/products.ts` creates stable METAR, plates, GPS aircraft and AHRS instances
for the workspace. AHRS uses a lease on the shared GPS source and appears as a map-edge
tool, without a right-hand layer toggle. The lease does not require a GPS fix for
calibration or live attitude: the cross warns of missing/slow GPS or high tilt
uncertainty without hiding a calibrated, working IMU indication. The HSI also
retains its moving IMU card under the GPS cross, explicitly labeled **REL** when
confident heading is unavailable, even with GPS track available. GPS track appears
as a separate marker on the aligned heading card. The horizon and HSI share the
60 FPS display clock; status controls retain their 20 Hz publication timer. Calibration accepts small
movements and vibration around the pilot-confirmed level pose. Its estimator and
feature code live in `src/layers/ahrs/`; see the
[AHRS display policy](../src/layers/ahrs/README.md#calibration-and-validity) for
calibration assumptions, warning states and validation limits.

`LayerPanels` renders registered panel contributions on their chosen edge. Opening an airport card sends
an action to the plates product; `App` does not manage the selected PDF or its viewer.
The dialog mounts immediately, while the PDF renderer loads lazily. Replacing a plate
starts a new viewer session, and a delayed close from an older session cannot close
the new one. Selection and per-plate reading state restore through the shared
[UI persistence contract](contracts.md#workspace-persistence).

### Stowable panels

`core/ui/edge-panels.tsx` owns selection, the outgoing/incoming slide sequence,
mounted-panel registration, inert content, tab accessibility, Escape/focus return,
and dismissal after stowing. Each `EdgePanels` group has one selected panel or none;
the left and right groups operate independently. A switch slides the outgoing panel
back before the incoming panel enters. Stowing preserves mounted content and feature
state. Closing runs the feature's cleanup after the exit, including a page reload
during that exit; reopening cancels the pending close.

A `PanelLayer` chooses its edge and a stable tab slot. The workspace renders its
registry under both groups; the host mounts each contribution only on its chosen
side. Register the product once in `workspace/products.ts`; the feature does not
import shell or workspace composition:

```tsx
import { EdgePanel } from '../../core/ui/edge-panels';
import type { PanelLayer } from '../../core/layers/product';

export const checklist: PanelLayer = {
  definition: { id: 'checklist', title: 'Checklist' },
  panel: { side: 'right', tab: { edge: 'bottom', order: 2 } },
  Panel: () => (
    <EdgePanel autoOpen={false} icon={<path d="M4 4h16v16H4Z" />}>
      <ChecklistContents />
    </EdgePanel>
  ),
};
```

Slots are 44px high with a 4px gap, counted from `top` or `bottom`. Choose an unused
slot; right bottom slots 0 and 1 currently belong to plate and airport details.
Adding or removing a panel leaves other slots in place. The shell owns the group's
map-edge insets, while a feature can supply its own dimensions through `className`.
Both compact attached tabs and separate tab rails use the same controller and
support either side. Existing left tools keep their individual heights and positions.

`EdgePanel` inherits its name, label, and placement from the registration. It opens
on mount by default; use `autoOpen={false}` for a persistent, initially stowed tool.
A render-function child receives `setOpen`, `stow`, and `close(onClose)`. A feature
with a custom body, such as the native plate dialog, uses `useEdgePanel` with
`EdgePanelFrame` and spreads `panel.bodyProps` onto its `.edge-panel-body` element.
The frame still supplies its tab, keyboard behavior and registration. Nested menus
consume Escape with `stopPropagation`; preventing a field's native Escape behavior
alone still allows the panel to stow after the field discards its draft. Native modal
dialogs keep their own Escape/cancel behavior.

A feature can provide `beforeStow(next, proceed)`. Return `true` to continue, or
`false` to display a feature-owned confirmation and call `proceed()` after acceptance.
Cancellation leaves the current panel open. A deferred confirmation cannot override
a newer request or dismiss a replacement instance. AHRS uses this hook for its
Stop/Background/Cancel decision; sensor and recording policy remain in the feature.

A product can expose an immutable snapshot through `LayerStore<T>`. The generic
`useLayerSnapshot` hook uses React's external-store subscription API. Controls and
details observe shared product state. Any detail-specific refresh demand stays
inside the product.

## Map contribution lifecycle

`core/map/layer.ts` defines `MapLayerModule<Input>`:

- `id`: adapter identity, distinct from individual MapLibre style-layer IDs.
- `slot`: charts, plates, terrain, navigation, weather, route, or ownship rendering order.
- `mount(map)`: attach owned sources, style layers, and listeners.
- `update(input)`: accept typed configuration or reference data without remounting.
  Inputs can arrive before mounting.
- `unmount()`: cancel work, unsubscribe listeners, and remove owned layers before
  sources. Cleanup also works after partial initialization or repeated teardown.
- `interactiveLayerIds`: optional hit targets for selection and route snapping.
- `foregroundLayerIds`: optional layers raised after all adapters mount, keeping
  context and route labels above waypoint circles and drag previews.

`MapLayerHost` mounts adapters in slot order and unmounts them in reverse order.
It isolates lifecycle failures so a failed map contribution reports an error while
other contributions remain mounted. A later map attachment can retry it.

`workspace/map/registry.ts` registers built-in map contributions. It includes the METAR
product's `.map` adapter, the optional plates controller's map adapter, obstructions
and navaid-identification connections.
`MapRuntime` owns the WebGL map, camera and resizing; `workspace/map/gestures.ts` owns
selection, route dragging/snapping and gesture cleanup. Catalog refreshes update
chart resources in place, beneath a stable chart-slot anchor, without destroying
the map or resetting its camera. Identical chart definitions do not reinstall sources.
The route editor similarly delegates pointer/long-press/menu state to
`routes/use-editor-gestures.ts`; route parsing and draft changes remain in pure functions.
See [route parsing and editing](routes.md) for module ownership, expansion/index
invariants, editing lifecycle and supported grammar.
The basemap style supplies initial rendering and attribution. Product renderer
helpers create style resources; the runtime does not discover weather stations or
schedule their refreshes.

## Demand and freshness

Each product chooses its natural unit of work. Charts use tile coordinates to select
immutable, complete MBTiles archives. METAR uses station IDs and observation times.
Plates loads its TPP and Chart Supplement catalogs when the airport tab opens;
Settings also loads those indexes to plan regional saves. PDF demand starts on
selection or an explicit download. Both paths use the same whole-document cache.
A periodic timer fits METAR but adds nothing to a dated chart or plate.

`core/data/fetch-json.ts` validates reference documents before writing the shared
data cache. Navigation, airways, plates and preferred routes include export counts
and cycle checks in that validation. Invalid older cache entries are evicted and
retried once from the network with a bounded timeout; `no-store` bypasses the service
worker/HTTP cache on that fetch. Mutable manifests revalidate with a validated
offline fallback. Regional saves reuse the same cache and require successful storage.
Search keeps healthy products and identifies unavailable ones; navigation loaders
ignore superseded requests, include chart coverage in their request identity, and
retry when connectivity returns or saved-file inventory changes. Airways also key
visible results by the complete resource identity, including its digest and cache-only
policy. Route planning and failed terrain requests observe inventory changes so
repairing a saved download can recover an open view. Chart families also track
failed reads, including a regional tile rendered with only some of its source
editions. Inventory changes or reconnect rebuild the affected family's map sources
to discard cached gaps; healthy families keep their sources. Local inventory
delivery remains available when the browser denies cross-window BroadcastChannel
access, and notification failure does not fail an already committed save.
`core/use-online.ts` supplies shared connectivity.

Contract validation is split by product under `packages/contracts/src/guards/`,
with shared primitives in `validation.ts`. Strict package rectangles and legacy
antimeridian-crossing chart bounds intentionally use different guards.

`core/layers/on-demand-refresh.ts` supplies reusable observation scheduling:

1. Debounce a changed demand set for 250 ms by default; airport cards use zero delay.
2. Keep one refresh active, cancelling obsolete work and waiting for it to settle.
3. Refresh after the previous refresh completes at the product's interval: one minute
   for METAR and five minutes for TAF.
4. Stop when demand is empty or disabled; destroy cancels timers and active work.

Map METAR demand comes from rendered airport circles. Loading national airport references
for search does **not** fetch METAR for every airport. Panning clears demand until
movement settles. Airport visibility, the METAR toggle, document visibility, and
network availability control whether map requests run. The client batches eligible visible
stations, limits concurrency to two, times out requests, and retries transient failures
once. Cached station checks avoid repeat requests when revisiting a view.

An open airport Info card adds independent METAR and TAF demand through
`metar-taf/station-weather.tsx`, even when map weather or Airports is hidden.
Each report checks the airport's station on opening and at its own interval while
online and visible. If the local report is absent or no longer current, a nearby
search covers 50 NM; a manually selected alternative keeps nearby refreshes active.
Changing airport, closing or stowing the card, or opening Plates cancels these requests without
stopping map demand. Stowing preserves the selected stations and resumes demand
when the card reopens. The card and map share the METAR client and cache. Nearby
reports are labeled with their source and never substitute for the selected
airport's map category or runway wind.

Latest-known observations survive viewport changes and map remounts; browser storage
restores up to 5,000 stations across page loads. Observation time and successful-check
time remain separate. Empty or failed refreshes retain the previous observation and
expose its cached status in airport details. A valid observation replaces a
future-dated cached report even if its timestamp is earlier; response batches use
the same preference. Both weather clients treat negative cache age after a clock
rollback as eligible for refresh. Requests use `cache: 'no-store'` so the
service worker cannot turn a failed refresh into a successful cached response. The
product owns that fallback and its labeling.

METAR owns a separate `metar-airports` GeoJSON source above static navigation.
Refreshing weather does not resubmit the national navigation source. Cached circles
can remain gray when categories are disabled; hiding Airports hides both sets of
circles. Shared airport identity ties circles, search, routes, and details together.

Airport runway metadata belongs to navigation. The METAR product contributes wind
components to the runway panel, using the selected airport's own observation from
the shared METAR cache. Renderer-independent component calculations live in the
domain package; the runway component adds no request loop beyond map/card demand.

## Working on built-in products

[Route terrain](route-terrain.md) documents the elevation source, 4/8 NM corridor,
500/1,000 ft contour display, sampling precision and offline limitations.
[Obstructions](route-obstructions.md) documents the FAA source, height thresholds,
route context, worker validation and offline limitations.
[GPS aircraft](gps-aircraft.md) documents device location, track, projection,
freshness, accuracy and background behavior.

Create a folder under `layers/` with a small internal entry. Keep its data, UI, styles,
and lifecycle together. Expose a panel or a separate map entry as needed; register
stable controllers in the workspace registry and map adapters in the map registry.
Use the shared scheduler only when periodic visible-demand refresh fits the feature.
Pass explicit actions between products, such as opening a plate from navigation.

These are trusted, repository-owned modules. Their entry points describe current
internal boundaries, not a stable extension API. Extracting packages requires further
interface design. External plugin distribution, compatibility, permissions and
untrusted-code execution remain separate decisions. Catalogs describe data, never
executable plugins.

## Rules for changes

- Keep one owner for each source, style layer, listener, timer, request, and viewer.
- Keep cache identity and successful-refresh status honest across offline fallback.
- Keep shared reference services usable without map visibility: search and routes
  can need data that has not been rendered.
- Preserve one map and stable product instances across ordinary UI and panel updates.
- Preserve lazy map, SQLite worker, and PDF viewer loading through separate entries.
- Check demand changes, stationary refresh, cancellation, remounting, panel replacement,
  failure isolation, and the real renderer/worker boundary. A build alone cannot prove
  that the map renders or that a plate opens correctly.
