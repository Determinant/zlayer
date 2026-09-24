import { gridCell, gridValue, isGridSentinel, type DecodedGrid } from './format';

export function windSample(east: number, north: number) {
  if (!Number.isFinite(east) || !Number.isFinite(north) || isGridSentinel(east) || isGridSentinel(north)) return undefined;
  const speed = Math.hypot(east, north);
  return { speed, direction: (Math.atan2(-east, -north) * 180 / Math.PI + 360) % 360,
    barb: Math.min(550, Math.round(speed / 5) * 5) };
}

type Point = { x: number; y: number };
export type WindView = { zoom: number; width: number; height: number; bounds: readonly [number, number, number, number]; project(lng: number, lat: number): Point };
export type WindSymbol = { longitude: number; latitude: number; direction: number; barb: number; cell: number };
const worldY = (lat: number) => (1 - Math.log(Math.tan(Math.PI / 4 + lat * Math.PI / 360)) / Math.PI) / 2;
const latitude = (y: number) => Math.atan(Math.sinh(Math.PI * (1 - 2 * y))) * 180 / Math.PI;

/** Nested, world-anchored lattice. Cost follows viewport area, not model size. */
export function windSymbols(data: DecodedGrid, view: WindView): WindSymbol[] {
  // 80–160 CSS px between candidates. Stop subdivision at the converted grid's
  // resolution; enlarging model cells cannot manufacture finer forecast detail.
  const nativeStep = (data.manifest.grid.bounds[2] - data.manifest.grid.bounds[0]) / 360 / data.manifest.grid.width;
  const level = Math.min(Math.floor(Math.log2(512 * 2 ** view.zoom / 80)), Math.floor(-Math.log2(nativeStep)));
  const step = 2 ** -level, [west, south, east, north] = view.bounds;
  const fromX = Math.ceil((west + 180) / 360 / step), toX = Math.floor((east + 180) / 360 / step);
  const fromY = Math.ceil(worldY(Math.min(85, north)) / step), toY = Math.floor(worldY(Math.max(-85, south)) / step);
  const limit = Math.ceil((view.width + 160) * (view.height + 160) / (64 * 64));
  const occupied = new Map<string, Point[]>(), result: WindSymbol[] = [];
  // A pitched/horizon view can cover a large geography. Bound candidate work
  // too, while retaining the same nested anchors by using power-of-two strides.
  const candidates = Math.max(0, toX - fromX + 1) * Math.max(0, toY - fromY + 1);
  const stride = 2 ** Math.max(0, Math.ceil(Math.log2(Math.sqrt(candidates / Math.max(1, limit * 8)))));
  const cells = new Set<number>();
  for (let y = Math.ceil(fromY / stride) * stride; y <= toY; y += stride) for (let x = Math.ceil(fromX / stride) * stride; x <= toX; x += stride) {
    const longitude = x * step * 360 - 180, lat = latitude(y * step), point = view.project(longitude, lat);
    if (!Number.isFinite(point.x) || !Number.isFinite(point.y) || point.x < -64 || point.y < -64 || point.x > view.width + 64 || point.y > view.height + 64) continue;
    const cell = gridCell(data.manifest, longitude, lat);
    if (cell === undefined || cells.has(cell)) continue;
    const sample = windSample(gridValue(data, 'windEast', cell), gridValue(data, 'windNorth', cell));
    if (!sample) continue;
    const sx = Math.floor(point.x / 64), sy = Math.floor(point.y / 64);
    let collision = false;
    for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) {
      if (occupied.get(`${sx + dx}/${sy + dy}`)?.some(p => Math.hypot(p.x - point.x, p.y - point.y) < 64)) collision = true;
    }
    if (collision) continue;
    const key = `${sx}/${sy}`, bucket = occupied.get(key) ?? []; bucket.push(point); occupied.set(key, bucket); cells.add(cell);
    result.push({ longitude, latitude: lat, direction: sample.direction, barb: sample.barb, cell });
    if (result.length >= limit) return result;
  }
  return result;
}

/** Geometry in CSS pixels, shaft pointing toward the meteorological source. */
export function barbGeometry(speed: number) {
  const value = Math.round(speed / 5) * 5;
  const lines: number[][] = [], flags: number[][] = [];
  if (value < 5) return { lines, flags, calm: true };
  lines.push([32, 32, 32, 6]);
  const spacing = Math.min(1, 26 / (Math.floor(value / 50) * 9 + Math.floor(value % 50 / 10) * 5 + (value % 10 ? 5 : 0)));
  let y = 6, remaining = value;
  // Northern-hemisphere feathers project rightward and toward the wind's source
  // (up in this unrotated image). Keep the halo inside the icon's top edge.
  while (remaining >= 50) { flags.push([32, y, 44, y, 32, y + 8 * spacing]); y += 9 * spacing; remaining -= 50; }
  while (remaining >= 10) { lines.push([32, y, 43, y - 4 * spacing]); y += 5 * spacing; remaining -= 10; }
  if (remaining >= 5) { if (value === 5) y += 5; lines.push([32, y, 38, y - 2 * spacing]); }
  return { lines, flags, calm: false };
}
