import clipping, { type Polygon, type MultiPolygon, type Pair } from 'polygon-clipping';
import { isRecord, isWeatherGeometry, type WeatherGeometry } from '@zlayer/contracts';
import { wrapLongitude, longitudeNear, dateLineCrossing } from './geographic';

/** Expected interpretation limits qualify one member. Unexpected failures must
 * fail preparation, not falsely identify a source feature as malformed. */
export class AdvisoryGeometryError extends Error {}
export class AdvisoryGeometryProcessingError extends Error {
  constructor(cause: unknown) { super('Advisory geometry processing failed', { cause }); }
}

function line(value: unknown, budget: { points: number }): Pair[] {
  if (!Array.isArray(value) || value.length < 2 || value.length > budget.points) throw new AdvisoryGeometryError('Invalid advisory line or coordinate limit');
  budget.points -= value.length;
  const points: Pair[] = [];
  for (const p of value) {
    if (!Array.isArray(p) || p.length !== 2 || !p.every(n => typeof n === 'number' && Number.isFinite(n)) ||
      Math.abs(p[0]) > 540 || Math.abs(p[1]) > 90) throw new AdvisoryGeometryError('Invalid advisory coordinate');
    const previous = points.at(-1)?.[0] ?? wrapLongitude(p[0]);
    const lon = longitudeNear(p[0], previous);
    if (Math.abs(lon - previous) >= 180) throw new AdvisoryGeometryError('Ambiguous advisory edge');
    points.push([lon, p[1]]);
  }
  // Validate each source component before flattening split parts. Otherwise an
  // empty line can disappear beside a valid sibling and claim complete coverage.
  if (!points.some(point => !same(point, points[0]!))) throw new AdvisoryGeometryError('Advisory path has no distinct positions');
  return points;
}
const longitudeBounds = (ring: Pair[]) => [Math.min(...ring.map(p => p[0])), Math.max(...ring.map(p => p[0]))] as const;
const same = (a: Pair, b: Pair) => a[0] === b[0] && a[1] === b[1];
function boundaryTurns(ring: Pair[]): Pair[] {
  const points = ring.slice(0, -1).filter((point, i) => !i || !same(point, ring[i - 1]!));
  if (points.length > 1 && same(points[0]!, points.at(-1)!)) points.pop();
  return points.filter((b, i) => {
    const a = points[(i + points.length - 1) % points.length]!, c = points[(i + 1) % points.length]!;
    const ux = b[0] - a[0], uy = b[1] - a[1], vx = c[0] - b[0], vy = c[1] - b[1];
    // Only a forward, exactly collinear vertex is redundant. Reversals carry
    // topology even when their length falls below a perimeter-error tolerance.
    return ux * vy - uy * vx !== 0 || ux * vx + uy * vy <= 0;
  });
}
function sameBoundary(source: Pair[], canonical: Pair[]): boolean {
  const before = boundaryTurns(source), after = boundaryTurns(canonical);
  if (before.length < 3 || before.length !== after.length) return false;
  const start = after.findIndex(point => same(point, before[0]!));
  return start >= 0 && [1, -1].some(direction => before.every((point, i) =>
    same(point, after[(start + direction * i + after.length) % after.length]!)));
}
/** Bounded diagnostic only, never an acceptance/repair rule. Near-collinear
 * arithmetic stays unclassified; the complete boundary check remains decisive. */
function crossingDetail(ring: Pair[]): string {
  const side = (a: Pair, b: Pair, c: Pair) => {
    const left = (b[0] - a[0]) * (c[1] - a[1]), right = (b[1] - a[1]) * (c[0] - a[0]);
    const value = left - right;
    return Math.abs(value) > 8 * Number.EPSILON * (Math.abs(left) + Math.abs(right)) ? Math.sign(value) : 0;
  };
  let remaining = 50_000;
  for (let i = 0; i < ring.length - 1; i++) for (let j = i + 2; j < ring.length - 1; j++) {
    if (--remaining < 0) return '';
    const a = ring[i]!, b = ring[i + 1]!, c = ring[j]!, d = ring[j + 1]!;
    if (side(a, b, c) * side(a, b, d) < 0 && side(c, d, a) * side(c, d, b) < 0) {
      return `: crossing edges ${i + 1} and ${j + 1}`;
    }
  }
  return '';
}
function polygon(value: unknown, budget: { points: number }): Polygon {
  if (!Array.isArray(value) || !value.length || value.length > 100) throw new AdvisoryGeometryError('Invalid advisory polygon');
  const rings: Polygon = [];
  for (const raw of value) {
    let ring = line(raw, budget);
    const first = ring[0]!, last = ring.at(-1)!;
    // AWC polygons can omit the repeated first coordinate. Complete only that
    // declared boundary, with the same edge and size limits as supplied edges.
    // Topology validation below still rejects crossings, retracing and no area.
    if (first[0] !== last[0] || first[1] !== last[1]) {
      if (Math.abs(first[0] - last[0]) >= 180 || budget.points < 1) throw new AdvisoryGeometryError('Invalid advisory closing edge or coordinate limit');
      budget.points--;
      ring.push([...first]);
    }
    const [west, east] = longitudeBounds(ring);
    if (ring.length < 4 || ring[0]![0] !== ring.at(-1)![0] || ring[0]![1] !== ring.at(-1)![1] ||
      east - west >= 360) throw new AdvisoryGeometryError('Invalid advisory ring');
    // Clipping must not silently repair a crossing, retraced or empty ring.
    // Canonicalization must preserve the complete cyclic sequence of turns.
    // Comparing perimeter alone could hide a short retraced edge or repair.
    // Winding, forward collinear vertices and adjacent duplicates do not matter.
    const simple = clipping.union([ring]);
    if (simple.length !== 1 || simple[0]!.length !== 1 || !sameBoundary(ring, simple[0]![0]!)) {
      throw new AdvisoryGeometryError('Unsupported advisory ring topology' + crossingDetail(ring));
    }
    if (rings.length) {
      // A hole belongs to its exterior, not to the world copy nearest an
      // arbitrary starting vertex. Bounds admit at most one containing copy;
      // the full area test also rejects excursions across a concave exterior.
      const [outerWest, outerEast] = longitudeBounds(rings[0]!);
      const first = Math.ceil((outerWest - west) / 360), last = Math.floor((outerEast - east) / 360);
      if (first !== last) throw new AdvisoryGeometryError('Uncontained advisory hole');
      ring = ring.map(([lon, lat]): Pair => [lon + first * 360, lat]);
      if (clipping.difference([ring], [rings[0]!]).length ||
        rings.length > 1 && clipping.intersection([ring], rings.slice(1).map(hole => [hole])).length) {
        throw new AdvisoryGeometryError('Invalid advisory hole topology');
      }
    }
    rings.push(ring);
  }
  // Individually simple, contained rings can still erase the exterior or share
  // an edge. Validate their combined topology without adopting repaired output.
  if (rings.length > 1) {
    const whole = clipping.union(rings);
    if (whole.length !== 1 || whole[0]!.length !== rings.length ||
      !sameBoundary(rings[0]!, whole[0]![0]!) ||
      !rings.slice(1).every(hole => whole[0]!.slice(1).some(candidate => sameBoundary(hole, candidate)))) {
      throw new AdvisoryGeometryError('Invalid advisory polygon topology');
    }
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
  let current: Pair[] = [[wrapLongitude(points[0]![0]), points[0]![1]]];
  for (let i = 1; i < points.length; i++) {
    const a = current.at(-1)!, next = points[i]!, b: Pair = [wrapLongitude(next[0]), next[1]];
    const crossing = dateLineCrossing(a, b);
    if (crossing) {
      if (a[0] !== crossing.leaving[0]) current.push(crossing.leaving);
      if (current.length > 1) parts.push(current);
      current = [crossing.entering];
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
  if (!isRecord(value) || !Array.isArray(value.coordinates)) throw new AdvisoryGeometryError('Invalid advisory geometry');
  const budget = { points: 10_000 };
  let result: WeatherGeometry;
  let outlineGeometry: Extract<WeatherGeometry, { type: 'LineString' | 'MultiLineString' }> | undefined;
  if (value.type === 'Polygon' || value.type === 'MultiPolygon') {
    const source = value.type === 'Polygon' ? [value.coordinates] : value.coordinates;
    if (!source.length || source.length > 100) throw new AdvisoryGeometryError('Advisory geometry exceeds its bound');
    const polygons = source.map(p => polygon(p, budget));
    const parts = polygons.flatMap(splitPolygon);
    result = parts.length === 1 ? { type: 'Polygon', coordinates: parts[0]! } : { type: 'MultiPolygon', coordinates: parts };
    if (JSON.stringify(result) !== JSON.stringify(value)) {
      // Derive fill and outline from the same validated, closed source rings.
      // Split the original edges separately: polygon clipping adds fill seams.
      const lines = polygons.flatMap(rings => rings.flatMap(splitLine));
      outlineGeometry = lines.length === 1 ? { type: 'LineString', coordinates: lines[0]! }
        : { type: 'MultiLineString', coordinates: lines };
      if (!isWeatherGeometry(outlineGeometry)) throw new AdvisoryGeometryError('Unsupported advisory outline or output limit');
    }
  } else if (value.type === 'LineString' || value.type === 'MultiLineString') {
    const source = value.type === 'LineString' ? [value.coordinates] : value.coordinates;
    if (!source.length || source.length > 100) throw new AdvisoryGeometryError('Advisory geometry exceeds its bound');
    const parts = source.flatMap(p => splitLine(line(p, budget)));
    result = parts.length === 1 ? { type: 'LineString', coordinates: parts[0]! } : { type: 'MultiLineString', coordinates: parts };
  } else throw new AdvisoryGeometryError('Unsupported advisory geometry');
  if (!isWeatherGeometry(result)) throw new AdvisoryGeometryError('Unsupported normalized advisory geometry or output limit');
  return { geometry: result, ...(outlineGeometry ? { outlineGeometry } : {}) };
}
