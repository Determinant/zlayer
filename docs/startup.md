# Workspace startup

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
- MapLibre's idle signal after the latest inputs. A style-load notification alone
  does not establish rendering readiness. MapLibre documents the [idle event](https://maplibre.org/maplibre-gl-js/docs/API/type-aliases/MapEventType/#idle)
  as occurring after camera movement, tile loading, and transitions have settled.
- At least 900 ms of startup visibility, including a final 300 ms stretch without a frame
  gap longer than 50 ms. Initial main-thread work postpones the reveal.

Readiness accepts terminal partial/error data states. Live GPS and weather updates
do not need to complete before entry. After ten seconds, **Open workspace** lets
the user enter while outstanding work continues; before a workspace exists,
**Reload** is available instead. Map construction or module failures expose the
existing recovery UI immediately. Once entered, loading never covers the workspace
again during normal map navigation, layer changes, or data refreshes.

`shell/use-startup.ts` owns the one-time readiness latch and frame settling.
`shell/startup-screen.tsx` owns the loading screen and restored-dialog stacking.
`workspace/map/runtime.ts` reports idle transitions independently of its existing
style-ready/error callbacks.
Terminal map-source errors request a final repaint so an offline tile failure
can settle the idle signal even when the source finished after the last frame.

`test/e2e/startup.spec.ts` exercises delayed map code, navigation and tiles,
main-thread startup work, request failures, the slow-start escape, restored modal
ordering, WebGL failure, and failed lazy imports in phone-sized Chromium/WebKit
sessions. Tests inspect the loading and revealed layouts and verify that the map
has nonzero dimensions while the screen is covered.
