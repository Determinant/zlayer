# Layer plugins

[Documentation](../README.md) / Architecture

This guide owns the built-in plugin contracts, module boundaries and authoring
workflow. It is not a versioned external extension API. Start with
[Adding a product](#adding-a-product) for implementation steps; the detailed contracts
follow. Feature behavior and algorithms live in the [plugin guides](../README.md#plugin-guides),
and common controls follow the [shared UI guide](../features/shared-ui.md#shared-controls).
Dated [verification history](#verification-history-and-remaining-checks) stays at the end.

A ZLayer layer is a complete workspace feature: data, behavior, presentation and
lifecycle. A plate viewer remains a feature independently of its optional map
overlay. A MapLibre style layer is a rendering resource owned by that feature.
Keep feature lifetime, map attachment, panel visibility and persistent intent
separate; an ordinary visibility change does not imply disposal.

Use trusted, repository-owned modules, explicit workspace composition, typed
services, observable stores and direct callbacks. Prefer `openPlate(selection)`
over a string-based message protocol. Core supplies a typed, workspace-local plugin registry for optional live integrations.
There is no general DI container, global event bus, security sandbox or runtime code discovery. Resource ownership in trusted code is
not a security boundary. Catalogs describe data, never executable plugins;
external distribution, compatibility and permissions remain separate decisions.

## Contents

- [Working on built-in products](#working-on-built-in-products)
  - [Adding a product](#adding-a-product)
  - [Rules for changes](#rules-for-changes)
- [Source layout](#source-layout)
- [Plugin contract and composition](#plugin-contract-and-composition)
- [Inter-plugin communication](#inter-plugin-communication)
- [Shared GPS service](#shared-gps-service)
- [Enabling and disabling](#enabling-and-disabling)
- [Map contribution lifecycle](#map-contribution-lifecycle)
- [Stowable panels](#stowable-panels)
- [Persistent state](#persistent-state)
- [Demand and freshness](#demand-and-freshness)
- [File downloads](#file-downloads)
- [Verification history and remaining checks](#verification-history-and-remaining-checks)

## Working on built-in products

### Adding a product

1. **Define the feature.** Create `src/layers/<plugin>/` with a small factory exposing
   only the needed `LayerPlugin` capabilities. Keep data, UI, styles and lifecycle
   together; add a `README.md` linking longer design/validation notes and list it in the
   [documentation index](../README.md#plugin-guides). Construct one stable instance
   per workspace. Construction must not acquire live sensors, listeners or workers
   for an initially disabled plugin. Keep renderer imports behind `mapContribution.load`
   and separate data-only entries from UI entries.
2. **Connect inputs and optional providers.** Receive committed workspace inputs through
   a `createLayerInput` store when needed. For optional live integration, import another
   plugin's `public.ts` types and declare `PluginExports<OwnApi, { providerId: ProviderApi }>` alongside
   `LayerPlugin` using `satisfies`; include extra factory members in that constraint,
   such as `& { input: typeof input }`. Expose stores and commands through the activation
   scope and connect through `bridge.watch` or `bridge.get`; do not reach into another
   feature instance. Handle unavailable providers and clear derived state on
   disconnect. Use `requires` only when the feature cannot operate without that
   provider: it changes enablement, unlike an optional bridge lookup.
3. **Register once.** Add the stable plugin ID and public API type to
   `workspace/plugin-apis.ts` (`object` when there are no public capabilities).
   Instantiate the factory in `createWorkspaceLayers` and append its registration
   to the existing plugin list.
   For the [checklist example](#stowable-panels), add `checklist: object` to
   `WorkspacePluginApis`, then use:

   ```ts
   const checklist = createChecklistPlugin();
   const plugins = layerPlugins([
     // Keep the existing registrations here.
     { ...checklist, communication: registry.registration('checklist', checklist) },
   ] as const);
   ```

   Import the factory from its feature entry. Preserve the inferred factory type
   and readonly tuple; widening them to `LayerPlugin` or `LayerPlugin[]` loses the
   preference fields inferred by the workspace. Registration IDs must match
   `definition.id`. Generic hosts and core need no feature-specific branches.
4. **Place panels.** Assign each contributed edge panel a position in
   `workspace/panel-layout.ts`.
   Placements use **panel IDs**, which may differ from plugin IDs (`plate` belongs
   to `plates`). Controls, overlays and ordinary content tabs need no edge-panel
   placement. Use `EdgePanel`, `ToolPanel` or `PanelSurface` as appropriate;
   feature code owns the contents and explicit-close policy.
5. **Persist intent.** Add persistence only for state that should survive reload. Create
   a plugin storage scope with the same plugin ID. Map preferences use `pluginPreferences`
   from `core/storage/preferences.ts` and the scope's `preferences` record; expose both
   `storage` and `preferences` on the plugin. The workspace discovers slices from
   the registration list, including disabled plugins, so no second preference-owner
   list is needed. Keep top-level preference fields distinct across plugins and
   preserve existing keys through deliberate migrations.
6. **Reuse core UI.** Use core's [shared UI](../features/shared-ui.md#shared-controls)
   for ordinary buttons, fields, switches, content tabs, confirmations and modal lifecycle.
   Shared typography and scrollbar appearance already come from the application stylesheet.
   Keep feature layout, compact report formatting such as TAF, and specialized
   instrument or map graphics local; avoid copying shared control rules into plugin CSS.
7. **Own cleanup and acquisition.** Bind live work to its actual lifetime:
   activation/connection scopes for integrations, map scopes for attachments, and
   component cleanup for UI demand. Make `dispose` release live resources while retaining
   user intent and allowing the same instance to activate again. Use core's
   [file acquisition](#file-downloads) and shared GPS
   service where applicable; use the refresh scheduler only for periodic visible
   demand. Keep reusable geometry/cache code shared when it has independent consumers.
8. **Verify behavior.** Follow the [verification guide](../development/local-development.md#verification),
   covering initially disabled startup, provider enable/disable/replacement, failure
   cleanup, late async completion and remounting as applicable. Include persistence
   and panel/focus checks for contributed capabilities. Historical results below
   do not validate a new plugin or later edits.

Use [Terrain's factory](../../src/layers/terrain/plugin.tsx) as an example of optional
Routes integration, preferences and a toolbox; [Ruler](../../src/layers/ruler/plugin.tsx)
for session-only map/overlay state; and [Plates](../../src/layers/plates/index.tsx) for a
persistent viewer with public commands and events. These are examples, not mandatory
capabilities for every plugin.

### Rules for changes

- Keep one owner for each source, style layer, listener, timer, request, and viewer.
- Keep cache identity and successful-refresh status honest across offline fallback.
- Keep shared reference services usable without map visibility: search and routes
  can need data that has not been rendered.
- Preserve one map and stable product instances across ordinary UI and panel updates.
- Preserve lazy map, SQLite worker, and PDF viewer loading through separate entries.
- Check demand changes, stationary refresh, cancellation, remounting, panel replacement,
  failure isolation, and the real renderer/worker boundary. A build alone cannot prove
  that the map renders or that a plate opens correctly.

## Source layout

| Under `src/layers/` | Feature ownership |
| --- | --- |
| [charts/](../../src/layers/charts/README.md) | VFR/IFR selection definitions, rendering, MBTiles/package readers, archive caching, offline planning and service-worker adapter |
| [navigation/](../../src/layers/navigation/README.md) | Navigation/airway loaders, search, airport/runway/frequency details, symbols, fix display and navaid identification |
| [metar-taf/](../../src/layers/metar-taf/README.md) | Report clients/caches, station selection, refresh, weather details, runway wind and METAR map rendering |
| [plates/](../../src/layers/plates/README.md) | Procedure/supplement catalogs, PDF cache/viewer, selected document and reader state, georeferenced overlay and offline planning |
| [routes/](../../src/layers/routes/README.md) | Draft/editing, planning, procedures, recommendations, navlog, history, named saves, direct-to and rendering |
| [terrain/](../../src/layers/terrain/README.md) | Elevation acquisition/decoding, workers, route/viewport demand, contours, colors, controls and offline planning |
| [obstructions/](../../src/layers/obstructions/README.md) | FAA DOF acquisition/validation, worker index, viewport/route demand, symbols and controls |
| [ownship/](../../src/layers/ownship/README.md) | Map GPS demand, centering, track/projection, status and map presentation |
| [ahrs/](../../src/layers/ahrs/README.md) | Motion estimator, calibration, instruments/HSI, recording and presentation |
| [ruler/](../../src/layers/ruler/README.md) | Measurement state, bearings, map drawing, grips and pointer behavior |

Each folder's `README.md` is the entry point for its behavior, algorithms and
validation. Keep longer notes beside their implementation and link them from that
README. Shared plugin/host contracts stay in this guide; project-wide contracts,
ADRs and evidence remain under `docs/`.

The host spans several directories; it is broader than `src/core/`:

| Location | Responsibility |
| --- | --- |
| `core/` | Request/worker/storage primitives, shared GPS acquisition, validation helpers, stores, map hosting, panel placement/collision/focus, shared controls/typography/scrollbars and formatting/geometry |
| `workspace/` | Service and plugin composition, catalog/read-context policy, shared map/camera/input coordination, selection and detail hosting |
| `offline/` | Regional saves, committed editions, availability, retention, download orchestration and legacy persistence compatibility |
| `shell/`, `app.tsx` | Application layout, startup, settings, PWA integration and workspace composition; generic contribution hosts |
| `packages/contracts`, `packages/domain` | Shared data contracts/guards and renderer-independent aviation calculations and identities |
| `service-worker.ts` | Application-shell caching and transport/cache coordination with data-only product adapters |

Within the workspace, `catalog/` discovers feeds, `read-context.ts` resolves browsing
and saved-edition ownership, and `use-workspace-read-context.ts` restores that
ownership before observing availability. `feature-details-panel.tsx` composes
feature-owned bodies; `nearby-feature-picker.tsx` handles overlapping map hits.
`use-selection.ts` coordinates saved selection, its source edition and retention,
navaid identification and right-panel actions. `startup.ts` derives initial
readiness steps from feature state; the shell owns their presentation and timing.
Shared numeric pixel work belongs in `core/graphics/`, date/time labels in
`core/format/`, and storage compatibility in `offline/compatibility/`.

Each product exposes a UI entry (`index.ts` or `index.tsx`), with separate data
(`api.ts`) and static-definition (`definitions.ts`) entries where needed. Non-UI
consumers import these data-only entries, not a UI barrel: offline planning must not
pull in airport cards, viewers or their React hooks. Tests can import internals
directly. Files inside a folder can stay focused without scattering a feature across
the source root.

Charts, plates, navigation, routes, terrain, obstructions and GPS expose separate
`map.ts` entries; METAR exposes its lightweight adapter as `.map` on the product
instance. Charts also exposes `worker.ts`
for its service-worker contribution. These entries preserve environment and loading
boundaries: importing a chart selector must not load SQLite or MapLibre;
listing procedures must not load PDF.js; the service worker must not import React.
Feature styles live in their product folder. Cross-product placement and responsive
layout stay in the shell; the details panel owns its own styles in `workspace/`.
Core supplies [shared typography, controls, content tabs and scrollbar styles](../features/shared-ui.md#shared-controls).
Plugins use those primitives for ordinary buttons, fields and tabs, retaining feature layout
and specialized visualizations. Core also owns shared switch styling, reduced-motion
policy and native modal lifecycle helpers. UI styles are imported directly, independently of
the inter-plugin communication bridge.

`core/` has no dependency on features or application coordination. The permitted
workspace imports for features are the data-only `workspace/read-context.ts`,
`workspace/catalog/catalog.ts` and `workspace/catalog/feed.ts` entries. Features do
not import workspace composition or shell controls. The details panel combines
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
including transitive runtime dependencies. Generic map and shell hosts cannot
import individual features. Type-only imports do not load runtimes.

## Plugin contract and composition

`core/layers/plugin.ts` defines `LayerPlugin`. All ten feature directories expose
one; most use `plugin.ts`/`plugin.tsx`, while plates keeps `createPlatesLayer` as its
entry. `workspace/products.ts` creates stable instances and validates identities.

| Capability | Contract |
| --- | --- |
| `definition`, `requires` | Feature identity and required plugin IDs, when any; unknown dependencies and cycles are rejected. |
| `mapContribution` | Optional lazy factory returning detached map adapters; features need not render on the map. |
| `panels`, `controls`, `overlays`, `footer` | Plain descriptors/components for existing UI surfaces; panel placement belongs to the host. |
| `preferences`, `storage` | Feature-owned preference records and a core-managed storage scope matching the plugin ID. |
| `communication` | Workspace-bound registry registration; activation exposes the public API and connects optional consumers. |
| `dispose()` | Optional cleanup of live resources when disabled; retain intent and allow reuse of the same instance. |

Plugin IDs, map contribution IDs and per-kind UI contribution IDs must be unique.
A storage scope must match its plugin ID, and a declared preference record must use
that scope's `preferences` slot. Core namespaces every local record name, so identical
names in different plugins cannot collide. Panel placements are validated separately before mounting.
`core/layers/use-plugins.ts` selects active contributions for generic hosts, which
own mounting, error boundaries, subscription cleanup and placement.

`App` composes workspace and feature controllers, publishes their inputs and renders
the application layout. Workspace controllers own selection/source retention and
startup readiness policy. Routes owns draft/planning/preview state and edit callbacks in
`use-controller.ts`; its feature-detail actions live alongside the route editor.
The workspace publishes committed feature inputs in a layout effect. `createLayerInput`
and `bindMapLayer` selectors suppress renderer updates for unrelated controls.
Workspace actions and derived arrays keep stable identities; UI contributions
select only their own inputs and memoized hosts skip unrelated parent commits.
A `LayerStore<T>` exposes immutable snapshots; `useLayerSnapshot` uses React's
external-store subscription API. Detail-specific refresh demand stays in the feature.
Public feature commands/components may extend the common contribution contract;
new dependencies remain typed composition changes.

Navigation owns detail presentation. The workspace supplies route actions, weather,
elevation, runway wind and plate bodies through typed props/render functions.
Terrain and obstructions share `core/geo/route-corridor.ts`; weather and obstructions
use navigation's explicit data-only map contract. Core's label contract preserves
existing route label-claim keys and style IDs.

Published data, temporary caches and saved editions continue through
`WorkspaceReadContext`, feature data APIs and offline ownership policy. Resolve
edition/resource identity before choosing available bytes; keep browsing and
national routing contexts, integrity, freshness, cancellation and availability
explicit. Shared providers must outlive visual demand when another consumer still
needs them. A new service facade requires a concrete consumer and must preserve
these guarantees; the plugin boundary adds neither a second cache nor a universal
data or window manager.

## Inter-plugin communication

`core/layers/bridge.ts` provides `PluginRegistry<Apis>`, `PluginBridge<Apis>` and
`PluginScope`. There is one registry per workspace. `workspace/plugin-apis.ts` is a
type-only catalog mapping stable plugin IDs to public interfaces; core imports no
feature types. Providers with public capabilities own a data-only `public.ts`
contract and a `publicApi(scope)` factory. `PluginExports<Api, Dependencies>` declares
the factory's API and optional integration types; TypeScript infers its `publicApi`
and `connect` parameters from that contract. A plugin without public capabilities
can expose an empty object, either from its factory or inline during registration;
it does not need a `public.ts` file. The workspace registers known built-ins alongside
their contributions in one `products.ts` list, attaching each `communication`
lifecycle directly. `publicApi` and `connect` belong to `PluginExports`;
`LayerPlugin.communication` holds the resulting workspace-bound registration.

`usePlugins` activates communication in passive effects, following the workspace’s
layout-effect input publication, and revokes it before feature disposal. UI and map
contributions attach only after successful activation, with required providers ready.
Connection cleanup errors are reported while feature disposal and other plugins' cleanup continue.
Public APIs provide empty/not-ready snapshots while startup is still waiting for
its read context. Initially disabled plugins expose no API and acquire no connection
resources. All built-in IDs are discoverable while enabled;
plugins with no current public capabilities expose an empty object. Optional
lookup does not change enablement or add a `requires` edge. Required dependencies
retain the existing activation policy.

```ts
connect(bridge: PluginBridge<{ routes: RoutesApi }>, scope: PluginScope) {
  scope.add(() => updateRoutes([]));
  bridge.watch('routes', (routes, connection) => {
    if (routes) connection.observe(routes.displayedRoutes, updateRoutes);
    else updateRoutes([]);
  });
}
```

- `bridge.get(id)` returns the current public API or `undefined`. IDs determine
  API types. Use it for immediate actions; use `watch` for enduring connections.
- `bridge.watch(id, connect)` reports current availability, then provider removal
  or replacement. Explicit retry reruns only failed watches. Data changes do not
  reconnect watches. The returned unsubscribe is
  idempotent, and consumer teardown unsubscribes automatically. Availability changes
  made inside a callback are drained synchronously after that callback; observers
  never receive an obsolete replacement. A new watch made during delivery receives
  its initial value as that delivery drains, before the outer operation returns.
- Each connection gets a fresh `PluginScope`. Provider changes dispose the previous
  scope before connecting the replacement. `scope.observe(store, listener)` subscribes
  and delivers the current snapshot; `scope.listen(events, listener)` subscribes to
  future events. Both clean up automatically. A failing connection setup, including
  initial snapshot delivery, releases partially acquired resources and appears in
  the consumer registration's `failures` store. This also covers providers enabled
  later. `retryFailed()` creates fresh scopes for only that registration's failed
  watches. Provider changes can recover a connection; unsubscribe and consumer
  teardown clear its failure. Later listener errors are reported without blocking
  other consumers. Failure-status observers are isolated too: a broken observer
  cannot disable a healthy provider or prevent other consumers from connecting.
- Providers expose read-only stores through `scope.store`. Existing snapshots are
  shared by reference; callers must not mutate them. Existing selected stores filter
  unrelated updates. Combined stores release partially acquired subscriptions on
  setup failure and release all subscriptions even if one cleanup fails.
  Consumers explicitly clear derived data when a provider is absent; saved user
  intent stays with its owner.
- Providers wrap commands and queries with `scope.command`. Old function references
  reject with `PluginUnavailableError` after their activation ends, including async
  results arriving after disable/re-enable. A synchronous command already in progress
  may close its own attachment and still return its result. Query implementations use `scope.signal`
  to cancel owned work; consumers check their own connection signal before publishing
  an awaited result. Cancellation does not replace complete resource/edition identity
  checks or shared-download ownership.
- `createLayerEvents<T>` supplies synchronous, typed notifications without replay.
  New listeners start with the next event, listener errors are isolated, and removed
  listeners are skipped. Keep current values in stores and imperative requests in
  commands. Plates uses an `opened` notification so the workspace can select the
  reader panel after a public `open` command; reconnecting never reopens it.

Workspace consumers use `registry.forScope(owner)` with the same connection and
cleanup rules. Their failures and targeted retry live in
`registry.scopedConnections`, separately from plugin registrations. The shell's
workspace notice identifies the affected providers and offers **Retry workspace
connections**. Retry preserves healthy watches, feature activation and the map;
unsubscribing or disposing an owner removes only its failures. Successful retry or
provider reconnection clears the notice. This covers both map selection's route/ruler
connections and the workspace's plate-open listener. These transient failures are
not persisted, and do not change provider enablement or activation status.

A plugin API's availability means its enabled instance can be contacted; data readiness
and individual capabilities have their own state. Routes exposes its plan, preview
and scoped edit commands while an observable `editing` capability is present only
for a healthy map attachment. Its public editing types do not depend on the renderer.
Renderer failure revokes editing without disconnecting core selection.
Ruler exposes its active-tool state; Plates exposes its optional map context action.
Selection watches these through the registry for its own map lifetime.

Terrain and obstructions discover Routes and observe its displayed plans, including
recommendation previews. AHRS observes the committed plan. METAR discovers Navigation
and observes airport data and visibility. Connections survive ordinary state updates
and clear when providers disappear. The workspace composes feature controllers,
selection and detail presentation; it publishes committed inputs to the owning
plugin. The bridge creates no competing source of truth, cache or request scheduler.

Data-only readers remain independent of plugin enablement: Routes can load navigation
and procedure catalogs with their visual plugins disabled, and offline preparation
works with all plugins disabled. Shared GPS remains a separately leased core service;
Ownship and AHRS do not discover or depend on one another. Pure geometry, formatting
and render constants remain explicit public module imports.

Cross-plugin imports are restricted to `public.ts` (type-only) and the explicit
`api.ts`, `data.ts`, `definitions.ts` and `map-contract.ts` entries. `check:imports`
rejects feature-internal imports and runtime imports of public contracts, and checks
designated data/worker entry graphs for UI runtime leaks.
The registry uses a map for lookup and per-ID listener sets; it neither scans all
plugins on state updates nor serializes data. Subscriptions and completed cleanup
callbacks release their references when stopped. Large arrays and sensor processing
remain with their owners.

Run the focused lifecycle tests and optional local dispatch benchmark with:

```bash
node --import=tsx --import=./test/helpers/assets.ts --test test/plugin-bridge.test.ts test/plugin-integrations.test.ts
node --import=tsx tools/benchmark-plugin-bridge.ts
```

The benchmark reports median costs against direct store subscriptions; it is not a
portable performance threshold. Browser activation, weather, map-selection and plate
regressions remain part of the full verification gate. This is a trusted built-in API;
external distribution, API-version negotiation and worker transports remain separate
future requirements.

## Shared GPS service

Core groups shared capabilities by responsibility. `core/gps/service.ts` exports
`createGpsService()` and its `GpsService` type; `core/gps/position.ts` owns fix
validation and motion normalization. The service uses the common layer store's
`getSnapshot()` / `subscribe()` contract without UI or plugin dependencies.

The workspace creates one `GpsService` and passes the same instance to
`createOwnshipPlugin(gps)` and `createAhrsPlugin(gps)`. Either
plugin can be enabled or disabled independently. GPS ownership belongs to core;
neither plugin provides GPS to the other or declares it as a prerequisite.

The service exposes `getSnapshot()`, `subscribe()`, `acquire()` and `retry()`.
Construction and subscriptions are passive. The first lease starts one browser
Geolocation watch; additional leases reuse it. Each release callback is idempotent.
The last release clears the watch, retries, expiry timer, visibility listener and
velocity sampling history. Consumers release their own leases rather than shutting
down the shared source. The service instance outlives individual plugin attachments.
Notifications are synchronous: stopping or replacing a consumer during a callback
must not leave a lease behind, start a cancelled watch, or interfere with the new
session's retries. Late callbacks from released watches are ignored.

| Active GPS demand | Watch ownership |
| --- | --- |
| Ownship only | Ownship's lease keeps one watch active. |
| AHRS only, including with Ownship disabled | AHRS's lease keeps one watch active. |
| Both | Two independent leases share one watch. Releasing either preserves the other. |
| Neither | No watch or acquisition timers remain. |

Core validates fixes and timestamps, normalizes speed/track/altitude, marks velocity
inferred from positions, expires stale fixes and handles permission/errors, retries
and background suspension. Hiding the app pauses the watch while retaining demand;
returning resumes one watch if a consumer still needs it. Subscriptions receive the
same fixes, but each feature applies its own display and quality policy. AHRS retains
its stricter freshness/aiding gates and smooth gyro-driven HSI heading; Ownship owns
centering, turn trends and map projection. GPS data and subscriptions alone never
enable the map aircraft, move the camera or start motion sensors.

## Enabling and disabling

**Settings → Plugins** lists all built-ins with labeled on/off switches. Compact rows
show state through the switch and reserve secondary text for dependency notes.
Switches retain a 44px minimum touch target. Changes apply
immediately and persist at action time. The saved list contains disabled IDs, so
new built-ins default to enabled; restoration validates IDs and includes disabled
dependents before attachment. `requires` names prerequisite plugin identities.
Enabling includes prerequisites; disabling includes active dependents, named in the
settings row. The activation policy rejects missing dependencies and cycles and
orders cleanup before prerequisites.

Saved enablement and successful activation are separate. A failed activation is
cleaned up, shown as failed in Settings, and contributes no UI or map attachments;
required dependents remain blocked. **Retry** retries that plugin and its failed
prerequisites. A failure inside a `bridge.watch` setup instead marks its consumer
as degraded: its working connections, public API, UI and map attachments remain
available, as do healthy providers and required dependents. Settings identifies the
failed connection and offers **Retry** for only its failed watches. Disabling then
re-enabling also retries. Both retry paths preserve healthy connections and unrelated
failures. Failure and dependency blocking do not rewrite saved intent, and ordinary
renders or unrelated toggles do not repeatedly retry failures. Activation status
describes activation and connection health; data/render readiness remains with the
feature and the workspace startup policy.

Navigation and METAR/TAF can be enabled independently. Weather uses navigation's airport map
data and Info panel when available; disabling navigation leaves weather enabled
with no airport demand. Disabling weather removes the METAR/TAF sections and runway
wind without removing navigation's airport information.

Disabling removes the plugin's UI and map attachments, stops live demand and calls its
optional `dispose()`. This method must support reuse: release sensors, timers and
temporary rendering resources, while retaining preferences, drafts and selected
documents. Re-enabling mounts fresh attachments against the same feature model. A plugin
constructor must not start live work; an initially disabled plugin never attaches.
JavaScript modules remain cached by the browser. Navigation and route hooks drop
transient loaded collections when their demand ends; METAR detaches its airport
input while preserving its bounded report cache. Derived input subscriptions release
their cached snapshots when their last subscriber leaves.

Chart map adapters share attachment leases for archive readers and the package
decoder. The last detach cancels pending opens/tiles, releases resident readers and
unregisters the protocol; re-enabling starts a fresh generation against the saved files.
Route-history views and individual queries hold separate leases. Cancelling or
closing the final consumer terminates the query worker; standalone offline checks
release it after completion. Offline preparation owns its own worker.

Ruler setup registers each cleanup as resources are acquired, so a partial mount
failure releases sources, style layers, DOM, listeners and observers. Teardown is
idempotent and continues even when one cleanup fails.

Each mounted chart adapter holds a lease on the shared readers. Detaching the
last adapter cancels queued/active reader work, releases in-memory packages and
terminates SQLite/decoder workers, including after a failed mount. Late opens
cannot restore those resources; re-enabling creates fresh readers. Verified offline
files and shared service-worker downloads keep their independent storage lifetime.

Changing the active plugin set reconciles attachments on the existing MapLibre
instance. Unchanged adapters retain their resources and subscriptions; removed
adapters detach immediately. Each added contribution imports independently, so a
stalled import cannot suspend existing layers or other additions. Superseded lazy
imports cannot attach. The host keeps drawing order using declared overlay IDs,
foreground IDs and fixed insertion anchors, regardless of import completion order.
A fresh attachment preserves camera intent without replaying a previous fit request.
Selection has its own always-mounted workspace contribution. Routes publishes an
editing capability only while its renderer is healthy; failure or disabling revokes it,
cancels any drag and restores map controls without disconnecting selection.
Disabling weather also removes runway wind columns/notes and cached-weather
enrichment from search/selection, while preserving runway metadata and cached reports.
Core Settings and offline downloads remain available with every plugin disabled.

Use this tab to exercise cleanup, late imports and re-enabling behavior while developing
a built-in. Disabling differs from stowing a panel or hiding map imagery: it removes
the feature's contributions, while retaining its saved choices and assigned tab slots.

## Map contribution lifecycle

`core/map/layer.ts` defines `MapLayerModule<Input>`:

- `id`: adapter identity, distinct from individual MapLibre style-layer IDs.
- `slot`: charts, plates, terrain, navigation, weather, route, annotation, or ownship rendering order.
- `mount(map)`: attach owned sources, style layers, and listeners.
- `update(input)`: accept typed configuration or reference data without remounting.
  Inputs can arrive before mounting.
- `subscribeInputs`: optional subscription used by bound plugin adapters; the host
  disconnects it before teardown and isolates update failures.
- `unmount()`: cancel work, unsubscribe listeners, and remove owned layers before
  sources. Cleanup also works after partial initialization or repeated teardown.
- `interactiveLayerIds`: optional hit targets for selection and route snapping.
- `overlayLayerIds`: unanchored style layers in drawing order. The host orders these
  by slot and registration; layers inserted below a fixed anchor omit this list.
- `foregroundLayerIds`: optional layers raised after each reconciliation, keeping
  context and route labels above waypoint circles and drag previews.

`MapLayerHost.reconcile` preserves adapter identity, mounts additions in slot order,
orders their style layers, and detaches removals in reverse order. It isolates
lifecycle failures while other contributions remain mounted. Reconciliation does
not retry a failed adapter; disabling/re-enabling its plugin or replacing the map does.

`workspace/products.ts` collects lazy map contributions from the plugins. Their
factories construct detached adapters. The runtime calls `loadMapContributions`
independently per contribution, with a separate cancellation signal. The loader
isolates import failures and discards completions after disabling. Each contribution
attaches when its own import and the map style are ready; rendering order still
follows registration, not completion order.
`bindMapLayer` binds a typed input store to an existing adapter; selectors suppress
updates from unrelated controls. `LayerScope` provides reverse-order, idempotent
cleanup for subscriptions and gesture listeners, continuing after cleanup errors.
Renderer entries may use MapLibre directly; adapters own their source/layer/image
identities and cleanup without an exhaustive proxy API. Attachment cancellation
must prevent stale asynchronous work from mutating a replacement attachment.
Style/map replacement rebuilds rendering while retaining feature intent.

`MapRuntime` owns the map, camera persistence, orientation control and resizing.
It receives contributions and callbacks, with no individual-feature imports.
`routes/map-contribution.ts` owns route fitting and publishes the live editing
capability. `workspace/map/selection.ts` owns the shared gesture coordinator's
lifetime and its own `MapSelectionInput`, independently of that renderer. It observes
the Routes public plan/preview/editing stores and invokes scoped edit commands;
it does not read `RoutePluginInput`. The existing `routes/map-gestures.ts`
algorithm handles selection, dragging/snapping and control restoration. Its hit-test
identities come from a data-only contract, so selection does not import the renderer.
The workspace supplies a scoped bridge for selection's map lifetime. Selection
watches Routes and the ruler's active-tool store, and looks up the plates context
action when needed. The ruler receives occupied rectangles from the workspace
instead of querying shell selectors.
Navigation identification uses the annotation band above routes/ruler and below
ownship, preserving its previous drawing order.

Catalog refreshes update chart resources in place, beneath a stable chart-slot
anchor, without destroying
the map or resetting its camera. Identical chart definitions do not reinstall sources.
The route editor similarly delegates pointer/long-press/menu state to
`routes/use-editor-gestures.ts`; route parsing and draft changes remain in pure functions.
See [route parsing and editing](../../src/layers/routes/README.md) for module ownership, expansion/index
invariants, editing lifecycle and supported grammar.
The basemap style supplies initial rendering and attribution. Product renderer
helpers create style resources; the runtime does not discover weather stations or
schedule their refreshes.

## Stowable panels

`core/ui/edge-panels.tsx` owns selection, the outgoing/incoming slide sequence,
mounted-panel registration, inert content, tab accessibility, Escape/focus return,
and dismissal after stowing. Each `EdgePanels` group has one selected panel or none;
the left and right groups operate independently. A switch slides the outgoing panel
back before the incoming panel enters. Stowing preserves mounted content and feature
state. Closing runs the feature's cleanup after the exit, including a page reload
during that exit; reopening cancels the pending close.

`workspace/panel-layout.ts` assigns every tab its side, anchor and slot. Core validates
missing placements and collisions before mounting; a registered frame uses the host
placement. `LayerPanels` renders the same contribution list under both side groups,
mounting each on its assigned side. A plugin supplies identity and content:

```tsx
import { EdgePanel } from '../../core/ui/edge-panels';
import type { LayerPlugin } from '../../core/layers/plugin';
import type { PluginExports } from '../../core/layers/bridge';

export function createChecklistPlugin() {
  return {
    definition: { id: 'checklist', title: 'Checklist' },
    publicApi: () => ({}),
    panels: [{ id: 'checklist', title: 'Checklist', Component: () => (
      <EdgePanel autoOpen={false} icon={<path d="M4 4h16v16H4Z" />}>
        <ChecklistContents />
      </EdgePanel>
    ) }],
  } satisfies LayerPlugin & PluginExports<object>;
}
```

`ChecklistContents` is the feature-owned body. Follow [Adding a product](#adding-a-product)
to register the factory and assign its panel an unused position in `PANEL_LAYOUT`;
there is no feature branch to add to either panel host.

Slots are 44px high with a 4px gap, counted inward from their anchor: top slots
descend and bottom slots ascend. `workspace/panel-layout.ts` reserves these positions:

| Panel / identity | Side | Anchor | Slot |
| --- | --- | --- | --- |
| Chart status / `charts` | Left | Top | 0 |
| GPS status / `gps` | Left | Top | 1 |
| AHRS toolbox / `ahrs` | Left | Top | 2 |
| Terrain toolbox / `terrain` | Left | Bottom | 0 |
| Plate reader / `plate` | Right | Bottom | 0 |
| Feature details / `details` | Right | Bottom | 1 |

Every tabbed contribution requires a placement. Duplicate panel IDs and occupied
`(side, anchor, slot)` positions fail validation. Hidden or closed panels and panels
of disabled plugins reserve their slots; lazy-load order cannot move tabs. Multiple panels in one
plugin each need an identity and placement. Preserve saved panel IDs or migrate them.
Core owns rail bounds and collision/overflow handling; features cannot override
placement or compensate with positioning offsets. The shell supplies responsive
insets and features can size their bodies through `className`. AHRS's tab offset
does not lower its entire panel. Compact attached tabs and separate rails use the
same controller and support either side.

`EdgePanel` inherits its name, label, and placement from the registration. It opens
on mount by default; use `autoOpen={false}` for a persistent, initially stowed tool.
A render-function child receives `setOpen`, `stow`, and `close(onClose)`. A feature
with a custom body, such as the native plate dialog, uses `useEdgePanel` with
`EdgePanelFrame` and spreads `panel.bodyProps` onto its `.edge-panel-body` element.
The frame still supplies its tab, keyboard behavior and registration. Nested menus
consume Escape with `stopPropagation`; preventing a field's native Escape behavior
alone still allows the panel to stow after the field discards its draft. Native modal
dialogs keep their own Escape/cancel behavior.

`core/ui/panel-surface.tsx` provides `PanelSurface` and `FullScreenButton` for
stowable content that can expand to the viewport. Plates and AHRS share this
implementation. The surface keeps one native dialog and one mounted content tree;
inline/fullscreen changes preserve the PDF reader or live instruments. It owns
native modality, viewport framing, initial focus, fullscreen-button focus return,
and Escape/cancel handling. PWA Back uses the existing native cancellation path:
fullscreen exits first, then the edge panel can stow. Hiding or removing the surface
releases its modal state; hiding preserves the feature's fullscreen preference.

Compose it inside `EdgePanelFrame`; pass `visible={panel.open}` and spread
`panel.bodyProps` onto the surface when it is the panel body. The feature supplies
controlled `expanded` state, `onExitFullScreen`, the fullscreen-button ref and an
optional `initialFocus` ref. Body layout, header/actions, document/sensor state and
persistence keys stay with the feature. `usePanelReturnFocus` captures an opener
and restores it after explicit close, falling back to its edge tab if necessary.
Stowing and disabling do not run the feature's explicit-close action.

The plate wrapper retains its document heading, lazy reader, Show on map action,
and close/selection policy. AHRS retains its instrument layout, calibration,
recording and stow confirmation. This shared surface is an inline/fullscreen panel
primitive; ordinary confirmation dialogs and anchored menus keep their own entries.

A feature can provide `beforeStow(next, proceed)`. Return `true` to continue, or
`false` to display a feature-owned confirmation and call `proceed()` after acceptance.
Cancellation leaves the current panel open. A deferred confirmation cannot override
a newer request or dismiss a replacement instance. AHRS uses this hook for its
Stop/Background/Cancel decision; sensor and recording policy remain in the feature.

Opening a plate from an airport card invokes the plates public API; `App` does not
own the selected PDF or viewer. The dialog mounts before its lazy renderer loads.
Replacing a plate starts a new session; a delayed close from an older session
cannot close the replacement. Selection and per-plate reading state follow the
[UI persistence contract](../data/contracts.md#workspace-persistence).

AHRS leases the shared GPS source independently of whether a fix is available.
Its instrument, warning and calibration behavior belongs to the
[AHRS display policy](../../src/layers/ahrs/README.md#calibration-and-validity).

## Persistent state

Plugins that persist state create their scope in `storage.ts` through
`core/storage/plugin-storage.ts` and expose it on `LayerPlugin.storage`. Session-only
plugins, such as Ruler, need no storage scope. Core assigns browser keys as
`zlayer-plugin:<plugin-id>:<local-name>`; plugin IDs exclude namespace separators.
Plugins define local names, defaults, validation and schema migrations. Core owns
browser storage access and JSON record I/O. This is ownership isolation for trusted
built-ins, not a sandbox for untrusted JavaScript.

`storage.ui` provides the version-1 UI envelope; `storage.record` accepts a feature's
versioned codec. Both use the existing action-time React helpers. Dynamic records,
including per-document reader state, use the same scope. `storage.slot` provides
scoped raw reads/writes for existing cache formats and coordinated named saves;
it propagates failures so explicit saves can report them. Plugin code cannot use
browser storage globals, unscoped UI helpers, or another plugin's storage module;
`check:imports` enforces these boundaries.

Map preferences are separate version-2 `preferences` records for charts, navigation,
terrain, ownship, obstructions and metar. `workspace/use-map-preferences.ts` combines
the preference slices declared by the complete registered plugin list, including
disabled plugins. The combined TypeScript value is inferred from that same registration
list, which stays fixed for a workspace's lifetime. Duplicate top-level fields are
rejected with both owner IDs instead of silently overwriting another plugin's value.
The hook combines decoded values in memory and writes only changed plugin slices;
there is no second list of preference owners. Updating one
plugin therefore does not overwrite another plugin's settings from an older window.

Legacy global keys are read only when the corresponding namespaced record is absent.
Validated UI/preferences/draft records migrate on read; known route migrations commit
generated entry IDs once. Invalid or unknown-version records remain untouched and
never fall back to stale legacy data. Legacy slots remain available until full reset.
Named saves migrate on the next successful locked mutation, and weather caches on
the next cache write. Keep saved records small and serializable; runtime state stays private.

- Restore preferences and intent: visibility, draft entries, exact plate/edition,
  reader position. Recompute resolved routes and rendered images. Reset gestures,
  menus, requests, live fixes and AHRS estimator/calibration state.
- Restore validated records before activation; expensive data/render restoration
  follows asynchronously. Restoration must preserve camera and panel intent and
  must not replay user-action side effects.
- Save committed intent at action time; batch continuous presentation changes
  with bounded flushes. Missing data must not clear selections. Defaults and unknown
  versions must not silently overwrite existing records on startup.
- Preserve existing saved intent through deliberate key/schema migration. Ordinary
  preferences/drafts currently use last-write-wins across windows; named route
  saves coordinate writes. Keep that distinction explicit and expose write failure.
- Offline artifacts, recordings and named saves retain dedicated storage APIs.
  Disabling a plugin disposes runtime resources while retaining saved state;
  resetting/deleting saved state is a separate action.

[Workspace persistence](workspace-persistence.md) lists the saved records, restoration order,
write-failure behavior and deliberate session-only state.

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
3. Refresh after the previous refresh completes at the product's interval.
4. Stop when demand is empty or disabled; destroy cancels timers and active work.

The [METAR/TAF guide](../../src/layers/metar-taf/README.md#demand-refresh-and-recovery)
owns station demand, refresh intervals, nearby selection, cached-report recovery,
map presentation and runway-wind behavior.

## File downloads

`core/storage/file-transfer.ts` owns file transfer scheduling, request deadlines,
optional bounded retries, cancellation and response consumption. Plugins call
`transferFile` with the URL, published byte length (or a conservative maximum),
label and format-specific response/byte validation. Its callback consumes the file
or publishes verified bytes with `storeDownloadedFile` before returning. Core always
discards uncommitted temporary files, including on validation or storage failure.
The existing writer preserves 64 KiB awaited disk writes and the 8 MiB in-memory
fallback ceiling. Large files use local files and receipt-only Cache Storage.
HTTP requests default to `cache: 'no-store'`; callers can supply a `cache` policy
when browser HTTP caching is part of their acquisition contract.

One queue is shared across products in each page/worker: up to four files of at
most 4 MiB may transfer together; large, unknown-size and explicitly exclusive
document transfers occupy the entire queue through validation and publication.
Cached reads bypass that queue. Pages, workers and the service worker are separate
execution contexts; this is not a global browser-process RAM budget. The offline
manager still owns region pause/resume and progress: pausing stops new files and
lets active files finish; resume verifies and skips complete files.

`core/storage/archive-cache.ts` supplies whole-file coalescing, verified receipt
inspection, repair and bounded archive retention for charts and packaged terrain.
The chart `archive-cache.ts`/`worker.ts` entries are compatibility exports only.
Plates supplies PDF signature/content checks and progress presentation; obstruction
data supplies hash/schema/index checks and uses the file-aware shared data cache.
Legacy terrain PNGs use the same transfer path with a 4 MiB response ceiling.

`readManagedFile` is for bounded decoder reads of files whose acquisition already
belongs to the service worker; it does not start a second origin-transfer queue.
Reference JSON continues through core's validated `fetchJson`, and small weather
results through their shared clients. Decoded indices, raster tiles and render
caches remain product-owned. Import checks prohibit plugin-local `fetch` calls and
direct use of the low-level `downloadFile` writer so new plugins reuse these tools.

## Verification history and remaining checks

The September 21, 2026 migration was checked against baseline `f618e83` with
Node 24.20 and the Playwright 1.63 Linux container, including headed Firefox under
Xvfb. The baseline passed `npm run verify`. Migration results combined the full run
with focused reruns after fixture corrections and a Firefox launch recovery:

| Check | Recorded result before later activation fixes |
| --- | --- |
| Imports, TypeScript, production build | Passed |
| Unit tests | 1,340 passed |
| Chromium | 568 passed; 3 failures also reproduced on the baseline |
| WebKit and Retina WebKit graphics | 82 passed; 2 existing platform skips |
| Headed Firefox graphics | 41 passed; 1 existing platform skip |

The full command exited nonzero, initially with 565 Chromium passes and six
failures. Three fixture assertions were corrected: waypoint-menu initial focus,
AHRS GPS-tick timing after resume, and a 0.001px tolerance for translated touch
controls. Firefox recovery supplied a writable container home and reran its
interrupted case. Graphics skips concern Chromium-only native-touch injection.
This is combined evidence, not a successful end-to-end `verify:full` invocation.

Three baseline failures remain recorded:

- Offline verification leaves Resume disabled after pause/reopen while a stalled
  cache read holds the per-file lock. It failed three repetitions on both revisions.
- The two KIWA missing-intercept cases (320/1280px) find an `approach-missed` segment
  where the fixture expects none. Both revisions fail; connected-intercept cases
  pass on the baseline. Geometry and the affected fixture were unchanged by the
  migration. These remain separate from the activation fixes below.

The subsequent live Load/Unload follow-up passed `npm run verify` with 1,344 unit
cases and 61 focused Chromium cases. Coverage included all ten plugins,
dependencies, initially unloaded startup, saved route/camera/plate state, delayed
imports, GPS/worker cleanup, keyboard tabs and three viewport sizes. It did not
rerun the complete cross-browser matrix or resolve the three baseline failures.

Four later corrections preserve plate camera intent, remove weather enrichment
when unloaded, reconcile attachments/imports independently, and keep selection
usable when route rendering fails or unloads. Their regression cases were updated,
but those fixes received **static review only**: tests, builds and type checks were
not run. All passing counts above predate these fixes and do not validate them.

For the next verification, run the [full gate](../development/local-development.md#verification).
Include input filtering, partial failure, cleanup/remount, duplicate identities,
fixed tab slots, stow/close/focus/Back behavior, storage migration and denied writes,
late imports, preserved camera intent and optional runway weather. The real
renderer/worker boundary and installed-device behavior require their own checks.

### Inter-plugin bridge verification, September 22, 2026

The bridge follow-up ran the full gate in the Playwright 1.63 / Node 24.20 Linux
container. Chromium recorded 585 passes and five failures. Four failures also
reproduced on an untouched checkout of `7f2b8f1`: the stalled offline verification,
both KIWA missing-intercept cases, and the AHRS test that expects the vertical
`hsi-deviation` SVG path to satisfy Playwright's visibility assertion. The fifth,
AHRS uncertainty diagnostics, found an empty unaided trend path in the full run;
it then passed three focused repetitions on both revisions. That intermittent
failure remains unresolved; the reruns do not make the full gate green.
WebKit/Retina graphics passed 82 cases with two platform skips; headed Firefox
passed 41 with one platform skip. `verify:full` exited nonzero for Chromium only.

After the synchronous command teardown fix, import/type checks, all 1,401 unit
tests and the production build passed again. Focused coverage includes optional
discovery, late connection, repeated disable/re-enable, listener cleanup,
reentrancy, stale commands/results, renderer failure, shared route references and
the real app clearing/restoring terrain demand when Routes is disabled/enabled.
These counts describe the tested working tree, which also contained concurrent
workspace changes; they are historical evidence, not a promise about later edits.
