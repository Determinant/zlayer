# Saved workspace state

The workspace restores user choices before the map and panels become interactive.
Feature owners validate their records and rebuild derived data through the normal
loaders. A saved selection identifies what to reopen; it does not claim that a
download, live sensor, route resolution, or render is still valid.

## Coverage

| Area | Restored state | Owner / storage |
| --- | --- | --- |
| Map camera | Center (including wrapped longitude), zoom, bearing, pitch | `shell/use-map-view.ts`; `zlayers-map-view-v1` |
| Map orientation | North-up / track-up preference; current GPS track is reacquired | `workspace/map/navigation-control.ts`; UI `map-track-up` |
| Layer choices | Chart base and overlay; airports, VFR waypoints, navaids and fixes; fix detail/airspace; METAR, GPS, terrain and obstructions; terrain route/viewport coverage and selected altitude | `shell/use-map-preferences.ts`; `zlayers-map-preferences-v1`, record version 2 |
| Terrain toolbox | Last clearance altitude while elevation coloring is selected | `layers/terrain/controls.tsx`; UI `terrain-last-altitude` |
| Route | Ordered entry IDs, text, feature pins and approach attachments; route summary expansion | `layers/routes/use-draft.ts`; `zlayer-route-draft-v1`, record version 2; UI `route-summary-open` |
| Recommendations | Open state, aircraft filter, selection scoped to airport pair/data edition/filter, expanded conditions and row limits | `layers/routes`; UI `recommendation-*` / `recommendations-open` |
| Edge panels | Selected left toolbox or stowed state; selected right panel or stowed state | `shell/map-edge-tools.tsx` / `app.tsx`; UI `edge-tool` / `side-panel` |
| Feature details | Feature snapshot and edition identity, selected route entry, Info/Plates tab, navaid identification overlay | `app.tsx` / `workspace/feature-details-panel.tsx`; UI `selected-feature`, `selected-route-entry`, `feature-tab:*`, `identification-open` |
| Plate reader | Selected document/approach/edition; original target; actual reader page, zoom, scroll and fullscreen preference | `layers/plates`; UI `plate-selection`, `plate-view:*` |
| On-map IAP | Exact document URL, optional integrity metadata, edition and original approach target, independently of the reader | `layers/plates/layer.ts`; UI `plate-on-map` |
| Shell | Layers, Settings, region query/filter/storage details, About and welcome acknowledgement | `shell`; corresponding UI records |
| AHRS presentation | Toolbox selection, fullscreen, upright/flat mount preference | `layers/ahrs/controls.tsx`; UI `ahrs-fullscreen`, `ahrs-mount` |
| Offline inventory and editions | Browsing cycle selection, saved regions and their committed data editions, document caches, recordings | Dedicated IndexedDB/Cache Storage owners; see [offline storage](offline-storage.md) |

UI keys above use the `zlayer-ui:` prefix and `{ version: 1, value }` envelope.
The route and layer preference key suffixes remain `v1` for compatibility even
though their current record schema is version 2.

## Saving and restoration

- UI, route and layer changes save synchronously in the action, through
  `core/ui/use-persistent-state.ts`. An immediate reload does not need a React
  effect to commit them. Default/fallback values do not overwrite storage merely
  because a component mounted. A valid legacy route is migrated once to preserve
  its generated entry IDs; legacy chart choices are read compatibly and written
  in the current format on the next change. Unknown record versions are ignored.
- Camera writes happen at movement completion, page hiding and teardown, without
  rerendering the workspace. Reader scroll/zoom writes are debounced and flushed
  on page hiding/unmount, sampling the live scroll position even if the final
  scroll event is still queued. These gesture paths avoid localStorage on every frame.
- A stowed panel retains its selection and stays stowed after reload. Existing
  installations without a right-panel record use the prior selection-based
  default. Missing selections cannot leave an active empty right panel.
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
- Corrupt records and unavailable/full storage leave session controls usable.
  [Full local reset](offline-storage.md#full-local-reset) clears all of these app
  keys and caches. UI persistence does not guarantee against browser eviction.

## Deliberate boundaries

Search text, unfinished route text fields, undo history, manual METAR/TAF station choices, context menus, gestures,
loading/errors, feature-list scroll positions, and pending confirmations are
session state. AHRS calibration, test mode, entered initial heading, live attitude,
GPS fixes and active recording do not resume after reload. Saved recordings have
their own recovery lifecycle.

These records are local to the browser's storage partition, without cloud sync or
live cross-window synchronization. Separate windows save their own actions to the
same keys when they share storage; the last write to each record wins. They are
independent feature records, not a transaction across the entire workspace.
Per-feature and per-document presentation records currently remain until full
reset; there is no age-based pruning of those small UI records.

When adding a layer or changing a panel, update this table, validate new fields
independently, preserve explicit false/zero/null choices, and cover reload plus
explicit removal. Tests should also exercise async failure, stale completion,
offline restoration and camera preservation when those lifecycles apply.

`test/e2e/workspace-persistence.spec.ts` and `workspace-restore.spec.ts` cover the
composed workspace in Chromium/WebKit. `test/plate-persistence.test.ts`,
`map-preferences.test.ts`, `map-view.test.ts`, `route-persistence.test.ts` and
`ui-state.test.ts` cover validation, migration, action-time writes and cancellation.
