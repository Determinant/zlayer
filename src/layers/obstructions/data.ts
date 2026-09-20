import { isRecord, type Bounds } from '@zlayer/contracts';
import { InvalidDataError } from '../../core/data/errors';
import { project, segmentsForTile, corridorDistance, corridorOpacity, type Segment } from '../terrain/geometry';
import { obstructionIcon, obstructionMinZoom, OBSTRUCTION_MIN_ZOOM, OBSTRUCTION_ICONS } from './definitions';
import type { ObstructionCollection, ObstructionFeature, ObstructionManifest } from './types';

const integer = (value: unknown, min: number, max: number): value is number =>
  typeof value === 'number' && Number.isSafeInteger(value) && value >= min && value <= max;
const date = (value: unknown): value is string => typeof value === 'string' && Number.isFinite(Date.parse(value));

export function isObstructionManifest(value: unknown): value is ObstructionManifest {
  if (!isRecord(value) || value.schemaVersion !== 1 || value.horizontalDatum !== 'WGS84'
    || !date(value.generatedAt) || !isRecord(value.source) || typeof value.source.name !== 'string'
    || (value.source.lastModified !== undefined && !date(value.source.lastModified)) || !isRecord(value.dataset)) return false;
  const data = value.dataset;
  return typeof data.sha256 === 'string' && /^[a-f0-9]{64}$/.test(data.sha256)
    && data.path === `obstacles-${data.sha256}.geojson.gz` && data.format === 'geojson' && data.compression === 'gzip'
    && integer(data.bytes, 1, 250_000_000) && integer(data.uncompressedBytes, 1, 1_500_000_000)
    && integer(data.count, 1, 5_000_000);
}

export function isObstructionFeature(value: unknown): value is ObstructionFeature {
  if (!isRecord(value) || value.type !== 'Feature' || typeof value.id !== 'string' || !/^[A-Z0-9]{2}-[A-Z0-9]{6}$/.test(value.id)
    || !isRecord(value.geometry) || value.geometry.type !== 'Point' || !isRecord(value.properties)) return false;
  const point = value.geometry.coordinates, p = value.properties;
  return Array.isArray(point) && point.length === 2
    && typeof point[0] === 'number' && Number.isFinite(point[0]) && Math.abs(point[0]) <= 180
    && typeof point[1] === 'number' && Number.isFinite(point[1]) && Math.abs(point[1]) <= 90
    && integer(p.heightAglFt, 0, 99999) && integer(p.elevationMslFt, -99999, 99999) && integer(p.quantity, 1, 9)
    && typeof p.verified === 'boolean' && typeof p.structureType === 'string' && !!p.structureType.trim()
    && typeof p.lightingCode === 'string' && /^[RDHMSFCWLNU]$/.test(p.lightingCode);
}

const INDEX_ZOOM = 7, GRID = 2 ** INDEX_ZOOM;

/** Compact national index stays in the worker. Only eligible viewport points
 * cross to the map, so MapLibre never tiles the 656k-record source. */
export class ObstructionIndex {
  #count = 0;
  readonly #ids: Float64Array;
  readonly #seen = new Set<number>();
  readonly #coordinates: Float64Array;
  readonly #heights: Int32Array;
  readonly #elevations: Int32Array;
  readonly #symbols: Uint8Array;
  readonly #verified: Uint8Array;
  readonly #cells = new Map<number, number[]>();
  constructor(readonly expectedCount: number) {
    this.#ids = new Float64Array(expectedCount);
    this.#symbols = new Uint8Array(expectedCount);
    this.#coordinates = new Float64Array(expectedCount * 2);
    this.#heights = new Int32Array(expectedCount);
    this.#elevations = new Int32Array(expectedCount);
    this.#verified = new Uint8Array(expectedCount);
  }
  add(value: unknown): void {
    if (!isObstructionFeature(value) || this.#count >= this.expectedCount) {
      throw new InvalidDataError('Invalid or duplicate obstruction record');
    }
    // Eight base-36 digits fit exactly in a double. Avoid retaining hundreds of
    // thousands of JS strings/objects after streaming the national dataset.
    const id = parseInt(value.id.replace('-', ''), 36);
    if (this.#seen.has(id)) throw new InvalidDataError('Duplicate obstruction record');
    const index = this.#count++, [lon, lat] = value.geometry.coordinates as [number, number], p = value.properties;
    this.#ids[index] = id; this.#seen.add(id);
    this.#coordinates[index * 2] = lon; this.#coordinates[index * 2 + 1] = lat;
    this.#heights[index] = p.heightAglFt; this.#elevations[index] = p.elevationMslFt;
    this.#verified[index] = p.verified ? 1 : 0;
    this.#symbols[index] = OBSTRUCTION_ICONS.indexOf(obstructionIcon(p.heightAglFt, p.quantity, p.lightingCode, p.structureType));
    const [x, y] = project([lon === 180 ? -180 : lon, lat]);
    const key = Math.max(0, Math.min(GRID - 1, Math.floor(y * GRID))) * GRID + Math.floor(x * GRID);
    const cell = this.#cells.get(key) ?? [];
    cell.push(index); this.#cells.set(key, cell);
  }
  finish(): void {
    if (this.#count !== this.expectedCount) throw new InvalidDataError('Obstruction count does not match the manifest');
    this.#seen.clear();
  }
  query(bounds: Bounds, segments: readonly Segment[], zoom: number): ObstructionCollection {
    const collection: ObstructionCollection = { type: 'FeatureCollection', features: [] };
    if (!Number.isFinite(zoom) || (!segments.length && zoom < OBSTRUCTION_MIN_ZOOM)) return collection;
    const [west, south, rawEast, north] = bounds;
    const east = rawEast < west ? rawEast + 360 : rawEast;
    const [left, top] = project([west, north]), [right, bottom] = project([east, south]);
    const found = new Set<number>();
    for (let y = Math.max(0, Math.floor(top * GRID)); y <= Math.min(GRID - 1, Math.floor(bottom * GRID)); y++) {
      for (let x = Math.floor(left * GRID); x <= Math.min(Math.floor(right * GRID), Math.floor(left * GRID) + GRID); x++) {
        const cell = this.#cells.get(y * GRID + ((x % GRID) + GRID) % GRID);
        if (!cell) continue;
        const nearby = segmentsForTile({ x, y, z: INDEX_ZOOM }, segments);
        if (!nearby.length && zoom < OBSTRUCTION_MIN_ZOOM) continue;
        for (const index of cell) {
          if (found.has(index)) continue;
          const height = this.#heights[index]!, minZoom = obstructionMinZoom(height);
          if (minZoom === undefined || (zoom < minZoom && !nearby.length)) continue;
          const lon = this.#coordinates[index * 2]!, lat = this.#coordinates[index * 2 + 1]!;
          const point = project([lon === 180 ? -180 : lon, lat]);
          point[0] += Math.floor(x / GRID);
          if (point[0] < left || point[0] > right || point[1] < top || point[1] > bottom) continue;
          const routeOpacity = corridorOpacity(corridorDistance(point, nearby));
          // The route adds context at wider zooms; it never clips or fades an
          // obstruction that is already eligible by its AGL zoom threshold.
          if (zoom < minZoom && routeOpacity <= 0) continue;
          found.add(index);
          const elevation = this.#elevations[index]!;
          const id = this.#ids[index]!.toString(36).toUpperCase().padStart(8, '0');
          collection.features.push({ type: 'Feature', id: `${id.slice(0, 2)}-${id.slice(2)}`, geometry: { type: 'Point', coordinates: [lon, lat] },
            properties: { oas: `${id.slice(0, 2)}-${id.slice(2)}`, icon: OBSTRUCTION_ICONS[this.#symbols[index]!]!, routeOpacity, elevationMslFt: elevation,
              heightAglFt: height, minZoom,
              label: `${elevation}${this.#verified[index] ? '' : ' UC'}\n(${height})` } });
        }
      }
    }
    return collection;
  }
}
