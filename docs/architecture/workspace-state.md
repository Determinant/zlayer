# Saved workspace state

[Documentation](../README.md) / Architecture

The workspace restores user choices before the map and panels become interactive.
Feature owners validate their records and rebuild derived data through the normal
loaders. A saved selection identifies what to reopen; it does not claim that a
download, live sensor, route resolution, or render is still valid.

## Coverage

| Area | Restored state | Owner / storage |
| --- | --- | --- |
| Map camera | Center (including wrapped longitude), zoom, bearing, pitch | `shell/use-map-view.ts`; `zlayers-map-view-v1` |
| Map orientation | North-up / track-up preference; current GPS track is reacquired | `workspace/map/navigation-control.ts`; UI `map-track-up` |
| Layer choices | Chart base and overlay; airports, VFR waypoints, navaids and fixes; fix detail/airspace; METAR, GPS, terrain and obstructions; terrain route/viewport coverage and selected altitude | `workspace/use-map-preferences.ts` with feature-owned decoders; each plugin’s `preferences` record, version 2 |
| Plugin activation | Disabled built-in identities; prerequisites/dependents resolved by the host | `core/layers/use-plugins.ts`; UI `plugins-unloaded` |
| Terrain toolbox | Last clearance altitude while elevation coloring is selected | `layers/terrain/controls.tsx`; UI `terrain-last-altitude` |
| Route | Ordered entry IDs, text, feature pins and approach attachments; route summary expansion | `layers/routes/use-draft.ts`; `zlayer-plugin:routes:draft`, record version 2; UI `route-summary-open` |
| Route stash | Named structured route snapshots, stable save IDs and list order; loading replaces the active draft | `layers/routes/stash.ts`; `zlayer-plugin:routes:stash`, record version 1 |
| Recommendations | Open state, aircraft filter, selection scoped to airport pair/data edition/filter, expanded conditions and row limits | `layers/routes`; UI `recommendation-*` / `recommendations-open` |
| Edge panels | Selected left toolbox or stowed state; selected right panel or stowed state | `shell/map-edge-tools.tsx` / `app.tsx`; UI `edge-tool` / `side-panel` |
| Feature details | Feature snapshot and edition identity, selected route entry, Info/Plates tab, navaid identification overlay | `app.tsx` / `workspace/feature-details-panel.tsx`; UI `selected-feature`, `selected-route-entry`, `feature-tab:*`, `identification-open` |
| Plate reader | Selected document/approach/edition; original target; actual reader page, zoom, scroll and fullscreen preference | `layers/plates`; UI `plate-selection`, `plate-view:*` |
| On-map IAP | Exact document URL, optional integrity metadata, edition and original approach target, independently of the reader | `layers/plates/layer.ts`; UI `plate-on-map` |
| Shell | Layers, Settings and its General/Plugins tab, region query/filter/storage details, About and welcome acknowledgement | `shell`; corresponding UI records, including `settings-tab` |
| AHRS presentation | Toolbox selection, fullscreen, upright/flat mount preference | `layers/ahrs/controls.tsx`; UI `ahrs-fullscreen`, `ahrs-mount` |
| Offline inventory and editions | Browsing cycle selection, saved regions and their committed data editions, document caches, recordings | Dedicated IndexedDB/Cache Storage owners; see [offline storage](../features/offline-storage.md) |

Plugin UI keys use `zlayer-plugin:<plugin-id>:<key>` and `{ version: 1, value }`.
This includes routes, plates, AHRS, terrain's last altitude and navigation's feature
tabs. Host UI records (panels, selection, map orientation, activation and shell) retain
`zlayer-ui:<key>`. Core assigns plugin namespaces and performs record I/O; features
own decoding and migration. The [plugin storage contract](layer-plugins.md#persistent-state)
describes isolation and the compatibility reads from former global keys.

## Saving and restoration

- UI, active-route and layer changes save synchronously in the action, through
  `core/ui/use-persistent-state.ts`. An immediate reload does not need a React
  effect to commit them. Default/fallback values do not overwrite storage merely
  because a component mounted. A valid legacy route is migrated once to preserve
  its generated entry IDs; legacy chart choices and other validated preferences migrate into their owner’s
  namespace on read. Unknown record versions are ignored.
- Route-stash mutations acquire a Web Lock before reading and writing the shared
  list. Success is shown only after storage accepts the write; contention or
  unavailable coordination leaves saved routes untouched. Open stash dialogs
  refresh on storage events, and edits reject a changed or removed save. The dialog's
  unfinished name/text and open state are session-only. See [route persistence](../../src/layers/routes/README.md#persistence-and-compatibility).
- Camera writes happen at movement completion, page hiding and teardown, without
  rerendering the workspace. Reader scroll/zoom writes are debounced and flushed
  on page hiding/unmount, sampling the live scroll position even if the final
  scroll event is still queued. These gesture paths avoid localStorage on every frame.
- A stowed panel retains its selection and stays stowed after reload. Existing
  installations without a right-panel record use the prior selection-based
  default. Missing selections cannot leave an active empty right panel.
- Plates and AHRS use the shared `core/ui/panel-surface.tsx` presentation primitive.
  Panel visibility and the feature's saved fullscreen preference remain separate:
  stowing releases native modality without erasing that preference. Presentation
  changes keep the same mounted reader/instruments; the primitive creates no new
  persistence keys and does not clear feature selection when disabled.
- Plugin activation saves at action time without changing feature visibility
  preferences. The existing `plugins-unloaded` key retains disabled identities for
  compatibility. New built-ins default to enabled; stored disabled identities are
  validated and expanded to include dependent plugins before attaching anything.
  Disabling retains routes, plate selection/reading state and downloaded artifacts;
  re-enabling restores UI and map attachments without replaying a previous camera fit.
  A disabled plates plugin does not block startup waiting for PDF restoration.
- The on-map IAP is rebuilt from its exact PDF through the verified document
  cache, including offline when available. The original approach target is
  independent of the reader's browsed page. Its PDF is retained against automatic
  cache cleanup while the overlay is selected. Canvas pixels, map source objects,
  menu coordinates and progress/error states are never serialized.
- Restoring an IAP does not fit the map, dismiss another reader, clear the selected
  feature, or change the active panel. Explicit **Show on map** still fits the
  approach. **Hide IAP from map** clears the saved choice. Cancellation prevents a
  late restore from reviving a hidden plate or replacing a newer one, and releases
  its canvas. The restore status banner disappears once the plate is ready.
- [Startup](startup.md) waits for IAP restoration to finish or fail. Failure keeps
  the selection and shows **Retry IAP** and **Hide IAP from map**. The existing
  slow-start escape remains available. A missing PDF never silently substitutes a
  different approach or data edition.
- Corrupt UI records and unavailable/full storage leave session controls usable.
  The stash preserves unreadable saved records and reports an error instead of
  overwriting them; it cannot confirm a save when persistent storage fails.
  [Full local reset](../features/offline-storage.md#full-local-reset) clears all of these app
  keys and caches. UI persistence does not guarantee against browser eviction.

## Deliberate boundaries

Search text, unfinished route text fields, manual METAR/TAF station choices, context menus, gestures,
loading/errors, feature-list scroll positions, and pending confirmations are
session state. AHRS calibration, test mode, entered initial heading, live attitude,
GPS fixes and active recording do not resume after reload. Saved recordings have
their own recovery lifecycle.

These records are local to the browser's storage partition, without cloud sync.
Presentation preferences and the active draft do not synchronize live across
windows: the last write to each record wins. The route stash coordinates writes
and refreshes open lists across windows as described above. Feature records remain
independent, without a transaction across the entire workspace.
Per-feature and per-document presentation records currently remain until full
reset; there is no age-based pruning of those small UI records.

When adding a layer or changing a panel, update this table, validate new fields
independently, preserve explicit false/zero/null choices, and cover reload plus
explicit removal. Tests should also exercise async failure, stale completion,
offline restoration and camera preservation when those lifecycles apply.

`test/e2e/workspace-persistence.spec.ts` and `workspace-restore.spec.ts` cover the
composed workspace in Chromium/WebKit. `test/plate-persistence.test.ts`,
`map-preferences.test.ts`, `map-view.test.ts`, `route-persistence.test.ts` and
`ui-state.test.ts` and `plugin-storage.test.ts` cover validation, migration, action-time writes and cancellation.
