import clipping, { type Polygon, type MultiPolygon, type Pair } from 'polygon-clipping';
import { isRecord, isWeatherGeometry, type WeatherGeometry } from '@zlayer/contracts';

const wrap = (lon: number) => lon - 360 * Math.floor((lon + 180) / 360);
function line(value: unknown, budget: { points: number }): Pair[] {
  if (!Array.isArray(value) || value.length < 2 || value.length > budget.points) throw new Error('Invalid advisory line');
  budget.points -= value.length;
  const points: Pair[] = [];
  for (const p of value) {
    if (!Array.isArray(p) || p.length !== 2 || !p.every(n => typeof n === 'number' && Number.isFinite(n)) ||
      Math.abs(p[0]) > 540 || Math.abs(p[1]) > 90) throw new Error('Invalid advisory coordinate');
    const previous = points.at(-1)?.[0] ?? wrap(p[0]);
    const lon = p[0] + 360 * Math.round((previous - p[0]) / 360);
    if (Math.abs(lon - previous) >= 180) throw new Error('Ambiguous advisory edge');
    points.push([lon, p[1]]);
  }
  return points;
}
const longitudeBounds = (ring: Pair[]) => [Math.min(...ring.map(p => p[0])), Math.max(...ring.map(p => p[0]))] as const;
const boundaryLength = (ring: Pair[]) => ring.slice(1).reduce((sum, point, i) =>
  sum + Math.hypot(point[0] - ring[i]![0], point[1] - ring[i]![1]), 0);
function polygon(value: unknown, budget: { points: number }): Polygon {
  if (!Array.isArray(value) || !value.length || value.length > 100) throw new Error('Invalid advisory polygon');
  const rings: Polygon = [];
  for (const raw of value) {
    let ring = line(raw, budget);
    const first = ring[0]!, last = ring.at(-1)!;
    // AWC polygons can omit the repeated first coordinate. Complete only that
    // declared boundary, with the same edge and size limits as supplied edges.
    // Topology validation below still rejects crossings, retracing and no area.
    if (first[0] !== last[0] || first[1] !== last[1]) {
      if (Math.abs(first[0] - last[0]) >= 180 || budget.points < 1) throw new Error('Invalid advisory closing edge');
      budget.points--;
      ring.push([...first]);
    }
    const [west, east] = longitudeBounds(ring);
    if (ring.length < 4 || ring[0]![0] !== ring.at(-1)![0] || ring[0]![1] !== ring.at(-1)![1] ||
      east - west >= 360) throw new Error('Invalid advisory ring');
    // Clipping must not silently repair a crossing, retraced or empty ring.
    // A simple ring remains one boundary of the same length when canonicalized;
    // winding, collinear vertices and adjacent duplicate points do not matter.
    const simple = clipping.union([ring]), length = boundaryLength(ring);
    if (simple.length !== 1 || simple[0]!.length !== 1 ||
      Math.abs(boundaryLength(simple[0]![0]!) - length) > Number.EPSILON * 64 * ring.length * Math.max(1, length)) {
      throw new Error('Unsupported advisory ring topology');
    }
    if (rings.length) {
      // A hole belongs to its exterior, not to the world copy nearest an
      // arbitrary starting vertex. Bounds admit at most one containing copy;
      // the full area test also rejects excursions across a concave exterior.
      const [outerWest, outerEast] = longitudeBounds(rings[0]!);
      const first = Math.ceil((outerWest - west) / 360), last = Math.floor((outerEast - east) / 360);
      if (first !== last) throw new Error('Uncontained advisory hole');
      ring = ring.map(([lon, lat]): Pair => [lon + first * 360, lat]);
      if (clipping.difference([ring], [rings[0]!]).length ||
        rings.length > 1 && clipping.intersection([ring], rings.slice(1).map(hole => [hole])).length) {
        throw new Error('Invalid advisory hole topology');
      }
    }
    rings.push(ring);
  }
  return rings;
}
function splitPolygon(rings: Polygon): MultiPolygon {
  const xs = rings.flat().map(p => p[0]);
  const west = Math.min(...xs), east = Math.max(...xs);
  if (west >= -180 && east <= 180) return [rings];
  const parts: MultiPolygon = [];
  for (let world = Math.floor((west + 180) / 360); world <= Math.floor((east + 180) / 360); world++) {
    const left = world * 360 - 180, right = world * 360 + 180;
    const cut = clipping.intersection(rings, [[[left, -90], [right, -90], [right, 90], [left, 90], [left, -90]]]);
    for (const part of cut) parts.push(part.map(ring => ring.map(([lon, lat]): Pair =>
      [Math.max(-180, Math.min(180, lon - world * 360)), lat])));
  }
  return parts;
}
function splitLine(points: Pair[]): Pair[][] {
  const parts: Pair[][] = [];
  let current: Pair[] = [[wrap(points[0]![0]), points[0]![1]]];
  for (let i = 1; i < points.length; i++) {
    const a = current.at(-1)!, next = points[i]!, b: Pair = [wrap(next[0]), next[1]];
    if (Math.abs(b[0] - a[0]) > 180) {
      const longitude = b[0] + (b[0] > a[0] ? -360 : 360), edge = b[0] > a[0] ? -180 : 180;
      const latitude = a[1] + (b[1] - a[1]) * (edge - a[0]) / (longitude - a[0]);
      if (a[0] !== edge) current.push([edge, latitude]);
      if (current.length > 1) parts.push(current);
      current = [[-edge, latitude]];
    }
    if (current.at(-1)!.some((v, axis) => v !== b[axis])) current.push(b);
  }
  if (current.length > 1) parts.push(current);
  return parts;
}

/** Keep source coordinates separate from wire/rendering geometry. Unwrap each
 * path before splitting at the date line; modulo on individual vertices would
 * turn a local Alaska boundary into a polygon spanning most of the world.
 * Polygon clipping preserves holes and disconnected pieces of concave rings. */
export function prepareAdvisoryGeometry(value: unknown): {
  geometry: WeatherGeometry;
  outlineGeometry?: Extract<WeatherGeometry, { type: 'LineString' | 'MultiLineString' }>;
} {
  if (!isRecord(value) || !Array.isArray(value.coordinates)) throw new Error('Invalid advisory geometry');
  const budget = { points: 10_000 };
  let result: WeatherGeometry;
  let outlineGeometry: Extract<WeatherGeometry, { type: 'LineString' | 'MultiLineString' }> | undefined;
  if (value.type === 'Polygon' || value.type === 'MultiPolygon') {
    const source = value.type === 'Polygon' ? [value.coordinates] : value.coordinates;
    if (!source.length || source.length > 100) throw new Error('Advisory geometry exceeds its bound');
    const polygons = source.map(p => polygon(p, budget));
    const parts = polygons.flatMap(splitPolygon);
    result = parts.length === 1 ? { type: 'Polygon', coordinates: parts[0]! } : { type: 'MultiPolygon', coordinates: parts };
    if (JSON.stringify(result) !== JSON.stringify(value)) {
      // Derive fill and outline from the same validated, closed source rings.
      // Split the original edges separately: polygon clipping adds fill seams.
      const lines = polygons.flatMap(rings => rings.flatMap(splitLine));
      outlineGeometry = lines.length === 1 ? { type: 'LineString', coordinates: lines[0]! }
        : { type: 'MultiLineString', coordinates: lines };
      if (!isWeatherGeometry(outlineGeometry)) throw new Error('Invalid advisory outline');
    }
  } else if (value.type === 'LineString' || value.type === 'MultiLineString') {
    const source = value.type === 'LineString' ? [value.coordinates] : value.coordinates;
    if (!source.length || source.length > 100) throw new Error('Advisory geometry exceeds its bound');
    const parts = source.flatMap(p => splitLine(line(p, budget)));
    result = parts.length === 1 ? { type: 'LineString', coordinates: parts[0]! } : { type: 'MultiLineString', coordinates: parts };
  } else throw new Error('Unsupported advisory geometry');
  if (!isWeatherGeometry(result)) throw new Error('Invalid normalized advisory geometry');
  return { geometry: result, ...(outlineGeometry ? { outlineGeometry } : {}) };
}
