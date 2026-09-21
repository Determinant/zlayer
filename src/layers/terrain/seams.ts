import { segmentsForTile, type Point, type Segment, type Tile } from './geometry';
import { terrainIsolines, type TerrainIsoline } from './isolines';

export type TerrainBorder = {
  tile: Tile; size: number; interval: number; displaySize: number;
  top: Float32Array; right: Float32Array; bottom: Float32Array; left: Float32Array;
};

/** Retain just the outer samples: 4 KiB per native DEM at the finest detail. */
export function terrainBorder(values: Float32Array, size: number, tile: Tile, interval: number, displaySize: number): TerrainBorder {
  return { tile, size, interval, displaySize,
    top: values.slice(0, size), bottom: values.slice((size - 1) * size),
    left: Float32Array.from({ length: size }, (_, y) => values[y * size]!),
    right: Float32Array.from({ length: size }, (_, y) => values[(y + 1) * size - 1]!),
  };
}

/** Complete the cells between loaded DEMs, including four-tile corners. No
 * neighbor requests or invented closures across unavailable samples are needed. */
export function stitchTerrainContours(lines: TerrainIsoline[], borders: readonly TerrainBorder[], segments: readonly Segment[]): TerrainIsoline[] {
  if (!borders.length) return lines;
  const key = ({ z, x, y }: Tile) => `${z}/${x}/${y}`;
  const tiles = new Map(borders.map(border => [key(border.tile), border]));
  const seams: TerrainIsoline[] = [];
  for (const border of borders) {
    const { tile, size, interval, displaySize } = border;
    const neighbor = (dx: number, dy: number) => {
      const result = tiles.get(key({ z: tile.z, x: (tile.x + dx) % 2 ** tile.z, y: tile.y + dy }));
      return result?.size === size && result.interval === interval ? result : undefined;
    };
    const right = neighbor(1, 0), bottom = neighbor(0, 1), diagonal = neighbor(1, 1);
    if (!right && !bottom) continue;
    const nearby = segmentsForTile(tile, segments);
    // A two-sample grid spans two source cells; tracing between its sample
    // centers covers exactly the one missing cell, with the same edge crossings.
    const z = tile.z + Math.log2(size) - 1, baseX = tile.x * size / 2, baseY = tile.y * size / 2;
    const cell = (x: number, y: number, heights: number[]) => {
      const low = Math.min(...heights), high = Math.max(...heights);
      if (!Number.isFinite(low + high) || low === high || Math.max(interval, Math.ceil(low / interval) * interval) > high) return;
      const result = terrainIsolines(new Float32Array(heights), 2, { z, x: baseX + x / 2, y: baseY + y / 2 },
        nearby, interval, displaySize * 2 / size, false);
      seams.push(...result.lines);
    };
    for (let i = 0; i < size - 1; i++) {
      if (right) cell(size - 1, i, [border.right[i]!, right.left[i]!, border.right[i + 1]!, right.left[i + 1]!]);
      if (bottom) cell(i, size - 1, [border.bottom[i]!, border.bottom[i + 1]!, bottom.top[i]!, bottom.top[i + 1]!]);
    }
    if (right && bottom && diagonal) cell(size - 1, size - 1,
      [border.bottom[size - 1]!, right.bottom[0]!, bottom.top[size - 1]!, diagonal.top[0]!]);
  }
  return joinPaths([...lines, ...seams]);
}

/** Match only coincident ends at the same elevation and opacity. Ambiguous
 * junctions stay separate. Longitude wrapping must not produce a 360° chord. */
function joinPaths(lines: readonly TerrainIsoline[]): TerrainIsoline[] {
  const groups = new Map<string, TerrainIsoline>();
  for (const line of lines) {
    const key = `${line.elevation}/${line.opacity}`;
    let group = groups.get(key);
    if (!group) { group = { elevation: line.elevation, opacity: line.opacity, coordinates: [] }; groups.set(key, group); }
    group.coordinates.push(...line.coordinates);
  }
  // The tolerance absorbs projection roundoff (about 0.1 mm in latitude),
  // many orders below the source spacing. It cannot span a missing terrain cell.
  const key = ([lng, lat]: Point) => `${Math.round((((lng + 180) % 360 + 360) % 360 - 180) * 1e9)}/${Math.round(lat * 1e9)}`;
  for (const group of groups.values()) {
    const paths = group.coordinates, joined: Point[][] = [], visited = new Set<number>();
    const ends = new Map<string, { index: number; reverse: boolean }[]>();
    const keys = paths.map(path => [key(path[0]!), key(path[path.length - 1]!)]);
    paths.forEach((path, index) => {
      if (keys[index]![0] === keys[index]![1]) { joined.push(path); visited.add(index); return; }
      for (const end of [0, 1]) {
        const k = keys[index]![end]!, entries = ends.get(k) ?? [];
        entries.push({ index, reverse: end === 1 }); ends.set(k, entries);
      }
    });
    const walk = (index: number, reverse: boolean) => {
      const result: Point[] = [], start = keys[index]![reverse ? 1 : 0]!;
      while (!visited.has(index)) {
        visited.add(index);
        const path = paths[index]!, first = path[reverse ? path.length - 1 : 0]!;
        const shift = result.length ? Math.round((result[result.length - 1]![0] - first[0]) / 360) * 360 : 0;
        for (let i = result.length ? 1 : 0; i < path.length; i++) {
          const point = path[reverse ? path.length - 1 - i : i]!;
          result.push(shift ? [point[0] + shift, point[1]] : point);
        }
        const end = keys[index]![reverse ? 0 : 1]!;
        if (end === start) { result[result.length - 1] = result[0]!; break; }
        const entries = ends.get(end);
        if (entries?.length !== 2) break;
        const next = entries.find(entry => entry.index !== index)!;
        index = next.index; reverse = next.reverse;
      }
      joined.push(result);
    };
    for (let i = 0; i < paths.length; i++) {
      if (visited.has(i)) continue;
      if (ends.get(keys[i]![0]!)?.length !== 2) walk(i, false);
      else if (ends.get(keys[i]![1]!)?.length !== 2) walk(i, true);
    }
    for (let i = 0; i < paths.length; i++) if (!visited.has(i)) walk(i, false);
    group.coordinates = joined;
  }
  return [...groups.values()];
}
