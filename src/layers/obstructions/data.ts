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

function columns(capacity: number) {
  return { ids: new Float64Array(capacity), coordinates: new Float64Array(capacity * 2),
    heights: new Int32Array(capacity), elevations: new Int32Array(capacity),
    symbols: new Uint8Array(capacity), verified: new Uint8Array(capacity) };
}

/** Compact national index stays in the worker. Only eligible viewport points
 * cross to the map, so MapLibre never tiles the 656k-record source. */
export class ObstructionIndex {
  #count = 0;
  #size = 0;
  #sourceIds: Float64Array | undefined;
  #data = columns(0);
  readonly #cells = new Map<number, number[]>();
  constructor(readonly expectedCount: number) {
    // Validate uniqueness for the entire export, including filtered records.
    // Sorting packed IDs at finish avoids a national-size JS Set during loading.
    this.#sourceIds = new Float64Array(expectedCount);
  }
  get size(): number { return this.#size; }
  /** Typed storage only; excludes the small spatial grid's JS arrays. */
  get byteLength(): number {
    return Object.values(this.#data).reduce((sum, values) => sum + values.byteLength, this.#sourceIds?.byteLength ?? 0);
  }
  #resize(capacity: number): void {
    const next = columns(capacity);
    for (const key of Object.keys(next) as (keyof typeof next)[]) {
      next[key].set(this.#data[key].subarray(0, next[key].length));
    }
    this.#data = next;
  }
  add(value: unknown): void {
    if (!this.#sourceIds || !isObstructionFeature(value) || this.#count >= this.expectedCount) {
      throw new InvalidDataError('Invalid or duplicate obstruction record');
    }
    // Eight base-36 digits fit exactly in a double. Avoid retaining hundreds of
    // thousands of JS strings/objects after streaming the national dataset.
    const id = parseInt(value.id.replace('-', ''), 36);
    this.#sourceIds[this.#count++] = id;
    const [lon, lat] = value.geometry.coordinates as [number, number], p = value.properties;
    // The route and every zoom tier share this floor. Validate first, then drop
    // records that can never be displayed before allocating/indexing their data.
    if (obstructionMinZoom(p.heightAglFt) === undefined) return;
    if (this.#size === this.#data.ids.length) this.#resize(Math.min(this.expectedCount, Math.max(1024, this.#size * 2)));
    const index = this.#size++, data = this.#data;
    data.ids[index] = id;
    data.coordinates[index * 2] = lon; data.coordinates[index * 2 + 1] = lat;
    data.heights[index] = p.heightAglFt; data.elevations[index] = p.elevationMslFt;
    data.verified[index] = p.verified ? 1 : 0;
    data.symbols[index] = OBSTRUCTION_ICONS.indexOf(obstructionIcon(p.heightAglFt, p.quantity, p.lightingCode, p.structureType));
    const [x, y] = project([lon === 180 ? -180 : lon, lat]);
    const key = Math.max(0, Math.min(GRID - 1, Math.floor(y * GRID))) * GRID + Math.floor(x * GRID);
    const cell = this.#cells.get(key) ?? [];
    cell.push(index); this.#cells.set(key, cell);
  }
  finish(): void {
    if (this.#count !== this.expectedCount) throw new InvalidDataError('Obstruction count does not match the manifest');
    if (!this.#sourceIds) return;
    this.#sourceIds.sort();
    for (let i = 1; i < this.#sourceIds.length; i++) {
      if (this.#sourceIds[i] === this.#sourceIds[i - 1]) throw new InvalidDataError('Duplicate obstruction record');
    }
    this.#sourceIds = undefined;
    if (this.#data.ids.length !== this.#size) this.#resize(this.#size);
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
          const height = this.#data.heights[index]!, minZoom = obstructionMinZoom(height);
          if (minZoom === undefined || (zoom < minZoom && !nearby.length)) continue;
          const lon = this.#data.coordinates[index * 2]!, lat = this.#data.coordinates[index * 2 + 1]!;
          const point = project([lon === 180 ? -180 : lon, lat]);
          point[0] += Math.floor(x / GRID);
          if (point[0] < left || point[0] > right || point[1] < top || point[1] > bottom) continue;
          const routeOpacity = corridorOpacity(corridorDistance(point, nearby));
          // The route adds context at wider zooms; it never clips or fades an
          // obstruction that is already eligible by its AGL zoom threshold.
          if (zoom < minZoom && routeOpacity <= 0) continue;
          found.add(index);
          const elevation = this.#data.elevations[index]!;
          const id = this.#data.ids[index]!.toString(36).toUpperCase().padStart(8, '0');
          collection.features.push({ type: 'Feature', id: `${id.slice(0, 2)}-${id.slice(2)}`, geometry: { type: 'Point', coordinates: [lon, lat] },
            properties: { oas: `${id.slice(0, 2)}-${id.slice(2)}`, icon: OBSTRUCTION_ICONS[this.#data.symbols[index]!]!, routeOpacity, elevationMslFt: elevation,
              heightAglFt: height, minZoom,
              label: `${elevation}${this.#data.verified[index] ? '' : ' UC'}\n(${height})` } });
        }
      }
    }
    return collection;
  }
}
