# Charts

[Documentation](../../../docs/README.md) / Plugins / charts

This plugin owns VFR/IFR chart selection, rendering, MBTiles readers, archive
caching, chart status and its offline-planning/service-worker adapters. It contributes
to the existing workspace map. Chart selection preserves the camera; an absent
chart tile leaves the continuous basemap visible.

## Source entry points

| Entry | Responsibility |
| --- | --- |
| [plugin.tsx](plugin.tsx) | Preferences, controls, status panel and lazy map contribution |
| [index.ts](index.ts), [overlays.ts](overlays.ts) | UI-facing selection definitions and chart-family rules |
| [map.ts](map.ts), [layer.ts](layer.ts) | Map attachment, selection updates and failed-source recovery |
| [mbtiles-protocol.ts](mbtiles-protocol.ts), [package-loader.ts](package-loader.ts), [reader-pool.ts](reader-pool.ts) | Shared chart readers, tile delivery and reader lifetime |
| [worker.ts](worker.ts), [archive-cache.ts](archive-cache.ts) | Compatibility exports of core's verified whole-file cache; acquisition and scheduling live in `core/storage/` |
| [offline.ts](offline.ts) | Chart-file planning used by regional downloads |

## Startup and recovery

Chart family definitions compile once per immutable catalog in a WeakMap.
Visibility still accounts for antimeridian/world copies and preserves ordering.

Transient chart-cache startup failures retry automatically after 1, 3, and 10 seconds.
Charts appear on the same page once preparation succeeds; catalog refreshes do not
restart cache preparation. Persistent failures expose **Retry chart cache**, and
reconnection or a new controlling worker starts a fresh attempt.

## Contracts and verification

The [rendering pipeline benchmark](benchmark.md) measures built-app cold/warm
loads, camera movement, package reuse and saved-edition composition. It includes
pixel/locality guards and records measurement limits separately from timings.

- Preserve the [whole-file I/O invariant](../../../docs/architecture/overview.md#chart-io-invariant).
  Rendering a tile must not become an independent origin fetch for a tile or SQLite page.
- Use the [chart-feed contract](../../../docs/data/chart-feed.md) for archive identity,
  spatial/zoom selection, legacy compatibility and publisher transport rules.
- Follow [offline storage](../../../docs/features/offline-storage.md) for shared files,
  committed editions, verification receipts and regional completeness.
- Keep decoder/worker loading and map lifecycle within the
  [plugin boundaries](../../../docs/architecture/layer-plugins.md#map-contribution-lifecycle).
- Rendering changes need the [graphics checks](../../../docs/verification/graphics-compatibility.md#run-the-checks),
  including transparency and zoom behavior. Reader/pool changes also need the
  [resource limits](../../../docs/verification/memory-resources.md#resource-limits-by-path)
  and [local verification](../../../docs/development/local-development.md#verification).

## Preparation limits

Package downloads remain shared whole-file reads. Decode admission is serialized
before posting to the reusable SQLite worker. Cancelling a queued package skips
its decode; cancelling the active decode terminates that worker, and the next live
package creates a replacement. Unloading aborts pending reads/admission as well.
A package's signal represents the reader pool's shared demand, not one tile reader.

Legacy underzoom overviews fetch at most 16 source tiles per indexed, ordered
batch and draw them sequentially into one 256-pixel canvas. Cancellation is checked
between queries and bitmaps; no full overview-sized tile array is retained. All
intersecting detail and transparent cutlines are preserved. Very large legacy
sheets can still take substantial total time; published low-zoom tiles remain
preferable to client composition.
