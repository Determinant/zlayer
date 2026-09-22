# Obstructions

[Documentation](../../../docs/README.md) / Plugins / obstructions

The independent `src/layers/obstructions/` module adds FAA Daily Digital Obstacle
File points to the map. Its **Obstructions** switch is enabled by default and
persists independently of terrain and navigation switches.

Symbols and labels appear throughout the viewport according to height **AGL**,
independently of their MSL elevation or proximity to a route. A route is not
required. Taller structures stay visible farther out; the 500-foot floor starts
at the VFR waypoint (`VPxxx`) zoom threshold:

| Map zoom | Minimum height AGL |
| --- | --- |
| 7 to below 8 | 2,000 ft |
| 8 to below 9 | 1,500 ft |
| 9 to below 10 | 1,000 ft |
| 10 and above | 500 ft |

Records below 500 feet AGL remain hidden at every zoom. Layers shows the current
height cutoff and whether route context adds shorter obstructions. The worker
selects eligible points before sending them to the map; matching map filters and
opacity expressions update symbols and labels as the view zooms, including while
updated worker results are pending.

At wider zooms, a route **additionally** shows obstructions at least 500 feet AGL
using the terrain corridor's opacity: full strength within 4 NM of resolved route
legs, smoothly fading to zero at 8 NM. Once an obstruction qualifies by its AGL
zoom threshold, it is fully visible regardless of route distance. Below zoom 7,
only route context is shown. Route recommendations use the same preview plans as terrain.
Unresolved route gaps are not connected, endpoints are rounded, and dateline
crossings wrap correctly. During route updates, points already eligible by height
stay visible while the old corridor-only points and fade values are removed.
This also prevents the old corridor from reappearing if the user zooms out before
the replacement query finishes. Camera changes query only the visible bounds.

## Symbols

Shapes follow the [FAA Aeronautical Chart Users' Guide, July 9, 2026, page 33](https://aeronav.faa.gov/user_guide/cug-complete_20260709.pdf):

- Low obstructions use the inverted V and position dot; obstructions at least
  1,000 feet AGL use the elongated tower symbol.
- Grouped records use paired symbols. Since DOF supplies the group's highest
  height, a tall group uses the mixed tall/low symbol rather than claiming two
  structures exceed 1,000 feet.
- Wind turbines use three-blade symbols, including grouped turbines.
- High-intensity strobe codes `H` and `S` add the FAA starburst. Red, medium,
  unknown, and absent lighting do not imply high-intensity strobes. Lighting
  codes follow the [FAA Daily DOF specification](https://www.faa.gov/air_traffic/flight_info/aeronav/digital_products/DailyDOF/media/DDOF_README_11-20-2017.pdf).
- Labels give top elevation MSL and `(height AGL)` in feet; unverified records
  have `UC`. Labels may declutter, while symbols remain visible.

The magenta palette is adapted to the application's dark map. Unverified records
remain eligible under the same height cutoffs. This point dataset does not provide
wind-farm boundaries.

## Source and lifecycle

The module reads `${chartRoot()}/obstacles/manifest.json`, independently of the
selected chart cycle, then resolves its immutable gzip GeoJSON dataset. The source
date displayed in Layers comes from `source.lastModified`, not the build time.

Loading starts when enabled at zoom 7 or above, or with resolved route legs at any zoom.
A dedicated worker checks SHA-256, compressed and decoded sizes, feature count,
coordinates, heights, codes, and identifiers. It streams the large national JSON
into compact numeric arrays and a spatial index. Only eligible viewport features
are sent to MapLibre; the national file never enters React or a map source.

After validating the complete source, the worker persists only the filtered numeric
index in the shared reference cache. Downloads still use `transferFile` for bounded
disk writes, scheduling and cleanup; the full gzip is temporary. Existing gzip
caches migrate without downloading again and are removed only after a successful
index save. Storage failures leave the validated in-memory index usable.

The local binary format uses an 8-byte version/count header and 34 bytes per
eligible record, with explicit little-endian numbers and Float64 coordinates.
Its cache key includes the source URL/digest, published sizes/count and index
version. Every read checks source identity, snapshot SHA-256, length, record fields
and duplicate IDs, then rebuilds the small spatial grid without gzip or JSON parsing.
Invalid snapshots rebuild from the original source; temporary read failures retain
the stored entry. Bump `OBSTRUCTION_INDEX_VERSION` when retained fields, symbol
mapping or the height floor changes. Snapshot reads/writes are limited to core's
8 MiB memory ceiling; larger future indices remain usable without persistence.

Each worker attachment still revalidates the rolling manifest, with its validated
saved copy as the offline fallback. View and route changes reuse the loaded index.
Disabling the layer or unmounting releases the worker; subsequent attachment
restores the filtered cache. Failed loads remain retryable and are reported in
Layers. This opportunistic cache follows normal cache cleanup/reset and remains
separate from explicitly saved regional packs.

`test/obstructions.test.ts` checks parsing, provenance, symbols, height cutoffs, and corridor
geometry. `test/e2e/obstructions.spec.ts` exercises the real worker, map, zoom
tiers with and without routes, pending route updates, toggle persistence, cache reuse, and failed-download
recovery. `/test/browser/obstructions.html` is the visual fixture.
