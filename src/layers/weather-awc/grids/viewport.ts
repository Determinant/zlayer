import type { Map } from 'maplibre-gl';
import type { AwcGridManifest } from '@zlayer/contracts';

const mercator = (latitude: number) => Math.log(Math.tan(Math.PI / 4 + latitude * Math.PI / 360));
export type GridViewport = { bounds: [number, number, number, number]; width: number; height: number; pixelRatio: number; columns: Int32Array; rows: Int32Array; key: string };

/** Sample a screen-sized view of the numeric grid. Patterns retain readable pixel
 * spacing when zoomed in; the model cells still use nearest sampling, never smoothing. */
export function gridViewport(map: Map, manifest: Pick<AwcGridManifest, 'grid'>): GridViewport | undefined {
  const view = map.getBounds(), grid = manifest.grid;
  const [west, south, east, north] = grid.bounds;
  const w = Math.max(west, view.getWest()), e = Math.min(east, view.getEast());
  const s = Math.max(south, view.getSouth()), n = Math.min(north, view.getNorth());
  if (w >= e || s >= n) return undefined;
  const ratio = Math.min(2, globalThis.devicePixelRatio || 1), middle = (s + n) / 2;
  const a = map.project([w, middle]), b = map.project([e, middle]);
  const c = map.project([(w + e) / 2, s]), d = map.project([(w + e) / 2, n]);
  const width = Math.max(1, Math.min(2048, Math.ceil(Math.hypot(b.x - a.x, b.y - a.y) * ratio)));
  const height = Math.max(1, Math.min(2048, Math.ceil(Math.hypot(d.x - c.x, d.y - c.y) * ratio)));
  const columns = new Int32Array(width), rows = new Int32Array(height);
  for (let x = 0; x < width; x++) columns[x] = Math.min(grid.width - 1, Math.floor((w + (x + .5) / width * (e - w) - west) / (east - west) * grid.width));
  const top = mercator(north), extent = top - mercator(south), viewTop = mercator(n), viewExtent = viewTop - mercator(s);
  for (let y = 0; y < height; y++) rows[y] = Math.min(grid.height - 1, Math.floor((top - viewTop + (y + .5) / height * viewExtent) / extent * grid.height)) * grid.width;
  const bounds: GridViewport['bounds'] = [w, s, e, n];
  return { bounds, width, height, pixelRatio: ratio, columns, rows, key: `${bounds.join('/')}/${width}/${height}/${ratio}` };
}

/** Full-domain fallback prevents newly exposed areas from going blank in a gesture. */
export function fullGridViewport(manifest: Pick<AwcGridManifest, 'grid'>): GridViewport {
  const grid = manifest.grid, width = Math.min(2048, grid.width), height = Math.min(2048, grid.height);
  return { bounds: [...grid.bounds], width, height, pixelRatio: 1,
    columns: Int32Array.from({ length: width }, (_, x) => Math.floor((x + .5) / width * grid.width)),
    rows: Int32Array.from({ length: height }, (_, y) => Math.floor((y + .5) / height * grid.height) * grid.width),
    key: `full/${JSON.stringify(grid)}` };
}
