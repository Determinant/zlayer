import type { ElevationReader } from '../../core/terrain/elevation';
import type { Polygon } from 'polygon-clipping';
import { ElevationTilePool } from '../../core/terrain/elevation-pool';
import { nmPerWorldUnit, project, type Point } from '../../core/geo/route-corridor';
import { ARRIVAL_RESERVE_FT, FEET_PER_NM, TERRAIN_CLEARANCE_FT } from './airports';
import { insideViewport, inRouteCorridor, localRouteSegments, unwrapPoint, routeMask, type GlideViewport } from './coverage';
import { coveredRouteNm } from './landing-geometry';
import { GlideCalculator } from './calculator';
import { mergeFootprints, ownshipOutline } from './geometry';
import { emptyAreas, type GlideAirport, type GlideRange, type GlideRequest, type GlideResult } from './types';

type AirportFootprint = { airport: GlideAirport; polygon: Polygon; viewport: GlideViewport; incomplete: boolean; bytes: number };
type Resident = { calculator: GlideCalculator; reachNm: number; viewport: GlideViewport };

/** A stable origin-centered work window, independent of camera zoom/bearing.
 * Round demand to 4 NM and allow room for whole-cell sampling and viewport caps.
 * The calculator still masks acquisition to the requested glide disk. */
function originViewport(coordinate: Point, reachNm: number): GlideViewport {
  const [x, y] = project(coordinate), padded = reachNm + Math.max(2, reachNm * .1);
  let radius = padded / nmPerWorldUnit(y);
  for (let i = 0; i < 4; i++) radius = padded / Math.min(nmPerWorldUnit(Math.max(0, y - radius)), nmPerWorldUnit(Math.min(1, y + radius)));
  return [[x - radius, Math.max(0, y - radius)], [x + radius, Math.max(0, y - radius)],
    [x + radius, Math.min(1, y + radius)], [x - radius, Math.min(1, y + radius)]];
}

/** Completed airport coverage accumulates along the route as origins are visited.
 * Geometry and reusable DEM/profiles have independent bounded LRUs: evicting a
 * large terrain buffer never removes the corresponding already drawn footprint. */
export class GlidePlanner {
  #sourceKey = '';
  #pool = new ElevationTilePool();
  #footprintKey = '';
  #routeKey = '';
  #airports = new Map<string, AirportFootprint>();
  #residents = new Map<string, Resident>();
  #geometryBytes = 0;
  #coverage: Pick<GlideResult, 'planRevision' | 'areas' | 'airports' | 'incomplete'> = {
    planRevision: 0, areas: emptyAreas(), airports: [], incomplete: false,
  };
  #dirty = false;
  #ownship: GlideRange | null = null;
  #point: GlideRange | null = null;
  #pointRoute: { area: GlideRange['area']; routeKey: string; distance: number } | undefined;
  constructor(readonly read: ElevationReader, readonly limits = {
    airports: 512, geometryBytes: 8 * 1024 * 1024, residentBytes: 32 * 1024 * 1024,
  }) {}

  async calculate(request: GlideRequest, signal: AbortSignal): Promise<GlideResult> {
    signal.throwIfAborted();
    const sourceKey = JSON.stringify([request.sourceKey, request.base, request.tileUrl]);
    if (sourceKey !== this.#sourceKey) {
      this.#sourceKey = sourceKey; this.#footprintKey = ''; this.#residents.clear(); this.#pool.clear();
      this.#ownship = null; this.#point = null;
    }
    // A route selects and clips complete airport footprints; it is not an input
    // to their terrain calculation. Keep visited origins through route edits.
    const footprintKey = JSON.stringify([request.altitude, request.ratio, request.airportKey, request.airportsEnabled]);
    if (footprintKey !== this.#footprintKey) {
      this.#footprintKey = footprintKey; this.#airports.clear(); this.#geometryBytes = 0; this.#dirty = true;
    }
    const routeKey = JSON.stringify(request.segments);
    if (routeKey !== this.#routeKey) { this.#routeKey = routeKey; this.#dirty = true; }
    const work = { terrainSourceCells: 0, terrainCells: 0, profileCells: 0, profilesBuilt: 0, profilesReused: 0, planReused: true, footprintsReused: 0 };
    const calculateOrigin = async (id: string, coordinate: Point, airport?: Pick<GlideAirport, 'elevationFt'>) => {
      // Terrain profiles depend on position and sampled extent, not destination elevation.
      const identity = JSON.stringify([id, coordinate]);
      let resident = this.#residents.get(identity);
      const height = request.altitude - (airport ? airport.elevationFt + ARRIVAL_RESERVE_FT : TERRAIN_CLEARANCE_FT);
      const reachNm = Math.max(4, Math.ceil(Math.max(0, height) * request.ratio / FEET_PER_NM / 4) * 4);
      if (!resident) resident = { calculator: new GlideCalculator(this.read, this.#pool), reachNm, viewport: originViewport(coordinate, reachNm) };
      else if (resident.reachNm < reachNm) { resident.reachNm = reachNm; resident.viewport = originViewport(coordinate, reachNm); }
      if (id === 'point' || id === 'ownship') for (const key of this.#residents.keys()) if (key.startsWith(`["${id}",`) && key !== identity) this.#residents.delete(key);
      this.#residents.delete(identity); this.#residents.set(identity, resident);
      try {
        const result = await resident.calculator.calculate({ coordinate, viewport: resident.viewport,
          altitude: request.altitude, ratio: request.ratio, ...(airport ? { elevationFt: airport.elevationFt } : {}) }, signal);
        // Even warm tile/profile reads can finish entirely in microtasks. Yield
        // between origins so the worker can receive cancellation messages.
        await new Promise(resolve => setTimeout(resolve, 0));
        signal.throwIfAborted();
        for (const key of ['terrainCells', 'profileCells', 'profilesBuilt', 'profilesReused'] as const) work[key] += result.work[key];
        work.terrainSourceCells += result.work.terrainSourceCells ?? 0;
        return { ...result, viewport: resident.viewport };
      } finally {
        let bytes = [...this.#residents.values()].reduce((sum, entry) => sum + entry.calculator.byteLength, 0);
        for (const [key, entry] of this.#residents) {
          if (bytes <= this.limits.residentBytes) break;
          bytes -= entry.calculator.byteLength; this.#residents.delete(key);
        }
      }
    };
    const localSegments = localRouteSegments(request.segments, request.viewport);
    for (const airport of request.discover === false || request.airportsEnabled === false ? [] : request.airports) {
      signal.throwIfAborted();
      const point = unwrapPoint(airport.coordinate, request.viewport);
      if (!insideViewport(point, request.viewport) || !inRouteCorridor(point, localSegments) || request.altitude <= airport.elevationFt + ARRIVAL_RESERVE_FT) continue;
      const previous = this.#airports.get(airport.id);
      if (previous && JSON.stringify(previous.airport) === JSON.stringify(airport)) {
        this.#airports.delete(airport.id); this.#airports.set(airport.id, previous); work.footprintsReused++; continue;
      }
      const result = await calculateOrigin(`airport:${airport.id}`, airport.coordinate, airport);
      if (previous) this.#geometryBytes -= previous.bytes;
      const { polygon, incomplete } = result.footprint, viewport = result.viewport;
      const entry: AirportFootprint = { airport, polygon, viewport, incomplete,
        bytes: JSON.stringify([airport, polygon, viewport]).length * 2 };
      this.#airports.delete(airport.id); this.#airports.set(airport.id, entry);
      this.#geometryBytes += entry.bytes; this.#dirty = true;
      while (this.#airports.size > this.limits.airports || this.#geometryBytes > this.limits.geometryBytes) {
        const first = this.#airports.keys().next().value!;
        this.#geometryBytes -= this.#airports.get(first)!.bytes; this.#airports.delete(first);
      }
    }
    const range = async (id: 'ownship' | 'point', coordinate: Point | null | undefined, previous: GlideRange | null): Promise<GlideRange | null> => {
      if (!coordinate) return null;
      const elevationFt = id === 'point' ? request.pointElevationFt : undefined;
      const key = JSON.stringify([coordinate, request.altitude, request.ratio, elevationFt]);
      if (key === previous?.key) { work.footprintsReused++; return previous; }
      // Retain already drawn ranges off screen, but acquire a new independent origin
      // only when it first comes into view. A changed GPS fix never reuses an old ring.
      if (request.discover === false || !insideViewport(unwrapPoint(coordinate, request.viewport), request.viewport)) return null;
      const result = await calculateOrigin(id, coordinate, elevationFt === undefined ? undefined : { elevationFt });
      return { key, line: ownshipOutline(result.profile, result.footprint.radii, result.footprint.unknown),
        area: mergeFootprints([result.footprint.polygon]), incomplete: result.footprint.incomplete };
    };
    this.#ownship = await range('ownship', request.ownship, this.#ownship);
    this.#point = await range('point', request.point, this.#point);
    signal.throwIfAborted();
    if (this.#dirty) {
      const covered: AirportFootprint[] = [];
      const polygons = [...this.#airports.values()].flatMap(entry => {
        const segments = localRouteSegments(request.segments, entry.viewport);
        if (!inRouteCorridor(unwrapPoint(entry.airport.coordinate, entry.viewport), segments)) return [];
        covered.push(entry);
        return mergeFootprints([entry.polygon], routeMask(segments, entry.viewport)).features.flatMap(feature => feature.geometry.coordinates);
      })
        .map(polygon => polygon.map(ring => ring.map(point => project(point as Point))));
      this.#coverage = { planRevision: this.#coverage.planRevision + 1, areas: mergeFootprints(polygons),
        airports: covered.map(entry => entry.airport.feature), incomplete: covered.some(entry => entry.incomplete) };
      this.#dirty = false; work.planReused = false;
    }
    if (request.pointElevationFt !== undefined && this.#point) {
      if (this.#pointRoute?.area !== this.#point.area || this.#pointRoute.routeKey !== routeKey) {
        this.#pointRoute = { area: this.#point.area, routeKey, distance: coveredRouteNm(request.segments, this.#point.area) };
      }
    } else this.#pointRoute = undefined;
    return { ...this.#coverage, ownship: this.#ownship, point: this.#point,
      ...(this.#pointRoute ? { pointRouteNm: this.#pointRoute.distance } : {}), work };
  }
}
