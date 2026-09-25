# Workspace startup

[Documentation](../README.md) / Architecture

The branded loading screen stays above a fully mounted workspace while its
initial work completes. The map retains its real size while covered, so WebGL,
MapLibre workers, sources, and initial tiles can initialize before interaction.
Controls remain inert, and restored dialogs and full-screen plates initialize
behind the loading screen.

Normal entry waits for:

- The catalog and saved workspace context.
- Enabled navigation collections and airway data, plus a restored route's resolver.
- A saved on-map approach's PDF rendering and geographic placement, or a recoverable restore error.
- Chart cache preparation when charts are selected, and initial terrain and
  obstruction work when those layers are enabled.
- MapLibre's idle signal after the initial required inputs. Loading a style alone
  does not establish rendering readiness. MapLibre documents the [idle event](https://maplibre.org/maplibre-gl-js/docs/API/type-aliases/MapEventType/#idle)
  as occurring after camera movement, tile loading, and transitions have settled.
- At least 900 ms of startup visibility, including a final 300 ms stretch without a frame
  gap longer than 50 ms. Initial main-thread work postpones the reveal.

The workspace can start from a committed regional snapshot when browsing catalogs
or feed discovery are unavailable. Saved metadata restoration finishes before a
feed error can replace the workspace with the recovery screen. The snapshot keeps
its original source identities, Settings remains usable, and feed failures appear
as notices alongside the saved edition. Background file checks can report missing
downloads without revoking the surviving saved workspace.

Once required data and its first settled map render are complete, startup enters a
one-way finishing phase. Completed initial steps and their progress stay fixed;
background weather preparation, refreshes and resulting map redraws cannot restart
them. Background rows continue reporting live progress. The responsive-frame check
still runs before uncovering the workspace, and long frames restart that check
without returning the splash to a loading phase.

The loading screen shows a progress bar and named steps for the workspace,
startup work from enabled plugins using their registered names, and the first map
render. The bar is
indeterminate while restoring the workspace context; afterward it counts finished
steps, not bytes or elapsed time. Navigation, a restored route, an on-map approach,
selected charts, terrain and obstructions appear only when relevant to startup.
Each row distinguishes loading, rendering, ready, cached data, limited data or
unavailable. Layers without requested work omit their rows; terrain and obstruction
`idle`/`zoom` states do not add a "not needed" placeholder. Charts remain
**Rendering…** after cache preparation until the map has rendered; a ready cache
alone must not display **Ready**.
The map step reports rendering independently of plugin data acquisition; both must
settle before the finishing phase.
The step list is capped at eight ordinary rows and shrinks to fit shorter windows.
It uses the shared panel scrollbar and supports keyboard scrolling; the progress
bar and recovery action stay outside the list. Multiple pending plugins use a
compact summary so a growing list cannot expand the heading indefinitely.

Plugin readiness is feature-specific. Initial visible map content waits for data
and rendering, while METAR/TAF and sensor UI can be usable with a local loading or
waiting state. AWC responses, GPS acquisition, and AHRS sensor readings do not
hold the splash. Requested weather acquisition, preparation and rendering,
including Progs coverage, appear as background rows as described in
[startup status](../features/shared-ui.md#startup-status).
They do not count toward the required-step progress bar. Detailed weather and
sensor status remains with the owning UI.

Readiness accepts terminal partial/error data states. After fifteen seconds,
**Open workspace** lets the user enter while outstanding work continues; before a workspace exists,
**Reload** is available instead. Map construction or module failures expose the
existing recovery UI immediately. Once entered, loading never covers the workspace
again during normal map navigation, layer changes, or data refreshes.
An on-map approach and a restored reader of the same book share one PDF.js
document and worker. The [plates guide](../../src/layers/plates/README.md#iaps-on-the-map)
owns that lifetime; startup does not start a second parser or wait for worker
teardown after the map image is ready.

`workspace/startup.ts` derives the named steps and readiness from workspace and
feature snapshots without starting work or changing state.
`shell/use-startup.ts` owns the completed initial-step snapshot, one-time readiness
latch and frame settling.
`shell/startup-screen.tsx` owns the loading screen and restored-dialog stacking.
`workspace/map/runtime.ts` reports idle transitions independently of its existing
style-ready/error callbacks.
Terminal map-source errors request a final repaint so an offline tile failure
can settle the idle signal even when the source finished after the last frame.

`test/e2e/startup.spec.ts` exercises indeterminate workspace discovery, named plugin
progress, disabled plugins, delayed map code/data/tiles, main-thread startup work,
request failures, pending METAR/TAF responses, AWC preparation/redraws during
finishing, the fifteen-second escape, restored modal ordering, WebGL failure, and
failed lazy imports in Chromium/WebKit sessions.
Tests inspect phone, landscape and desktop layouts and verify that the map has
nonzero dimensions while covered. `test/e2e/chart-startup.spec.ts` also holds chart
archives after cache preparation to verify that startup waits for rendering.
