import { isRecord, type Bounds } from '@zlayer/contracts';
import type { Polygon } from 'polygon-clipping';
import { InvalidDataError } from '../../core/data/errors';
import { project, type Point } from '../../core/geo/route-corridor';

export type LandingShard = { id: string; file: string; sha256: string; bytes: number; rawBytes: number;
  bounds: Bounds; count: number; tiers: [number, number] };
export type LandingManifest = { schemaVersion: 4 | 5; builderVersion: number; generatedAt: string; inputSha256: string;
  status: 'experimental-candidates'; geometryMeaning: 'generalized-candidate-area';
  coverage: { id: string; bounds: Bounds }[]; shards: LandingShard[] };
export type LandingArea = { polygon: Polygon; tier: 1 | 2; flags: number };
export type LandingCollection = GeoJSON.FeatureCollection<GeoJSON.MultiPolygon, { tier: 1 | 2; flags: number }>;
export type LandingStatus = { state: 'idle' | 'route' | 'outside' | 'zoom' | 'loading' | 'ready' | 'partial' | 'unavailable' | 'error' | 'limited';
  count?: number; cultivated?: boolean; shrub?: boolean; canopyUncertain?: boolean; terrainFallback?: boolean; urban?: boolean; closeBuildings?: boolean; preferredLengthFt?: number; generatedAt?: string };
export const emptyLandings = (): LandingCollection => ({ type: 'FeatureCollection', features: [] });
const integer = (value: unknown, min: number, max: number): value is number =>
  typeof value === 'number' && Number.isSafeInteger(value) && value >= min && value <= max;
const digest = (value: unknown): value is string => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);
const bounds = (value: unknown): value is Bounds => Array.isArray(value) && value.length === 4 && value.every(Number.isFinite)
  && value[0] >= -180 && value[2] <= 180 && value[1] >= -80 && value[3] <= 80 && value[0] < value[2] && value[1] < value[3];

/** Reject older runway/unsimplified contracts rather than guessing their meaning. */
export function isLandingManifest(value: unknown): value is LandingManifest {
  if (!isRecord(value) || ![4, 5].includes(value.schemaVersion as number) || value.status !== 'experimental-candidates'
    || value.geometryMeaning !== 'generalized-candidate-area' || !integer(value.builderVersion, 1, 100000)
    || !digest(value.inputSha256) || typeof value.generatedAt !== 'string' || !Number.isFinite(Date.parse(value.generatedAt))
    || !Array.isArray(value.coverage) || !value.coverage.length || value.coverage.length > 10000
    || !Array.isArray(value.shards) || value.shards.length > 10000) return false;
  const ids = new Set<string>(), files = new Set<string>();
  if (!value.coverage.every(region => isRecord(region) && typeof region.id === 'string' && bounds(region.bounds))) return false;
  let bytes = 0;
  return value.shards.every(shard => {
    if (!isRecord(shard) || typeof shard.id !== 'string' || !shard.id || ids.has(shard.id)
      || !digest(shard.sha256) || shard.file !== `${shard.sha256}.glide.gz` || files.has(shard.file)
      || !bounds(shard.bounds) || !integer(shard.bytes, 1, 2 * 1024 * 1024)
      || !integer(shard.rawBytes, 1, 16 * 1024 * 1024) || !integer(shard.count, 1, 100000)
      || !Array.isArray(shard.tiers) || shard.tiers.length !== 2
      || !shard.tiers.every(count => integer(count, 0, shard.count as number))
      || shard.tiers[0]! + shard.tiers[1]! !== shard.count) return false;
    ids.add(shard.id); files.add(shard.file); bytes += shard.bytes;
    return bytes <= 64 * 1024 * 1024;
  });
}

/** Decode the supplied rings, never the internal straight-fit witness. */
export function decodeLandingAreas(value: unknown, shard: LandingShard, schemaVersion: 4 | 5 = 4): LandingArea[] {
  if (!Array.isArray(value) || value.length !== shard.count) throw new InvalidDataError('Invalid landing-area count');
  const tiers = [0, 0];
  const result = value.map(record => {
    if (!Array.isArray(record) || record.length !== 3 || !Array.isArray(record[0]) || record[0].length !== 8
      || !record[0].every(Number.isSafeInteger) || !Array.isArray(record[1]) || !record[1].length
      || !integer(record[2], 0, schemaVersion === 5 ? 127 : 15) || ((record[2] & 4) !== 0 && (record[2] & 2) === 0)
      || ((record[2] & 8) !== 0 && (record[2] & 6) !== 6)) throw new InvalidDataError('Invalid landing-area record');
    const [witness, rings, flags] = record, tier = witness[7] as 1 | 2;
    if (![1, 2].includes(tier) || (tier === 2 && (flags & 126) !== 0) || Math.abs(witness[0]) > 180e6 || Math.abs(witness[2]) > 180e6
      || Math.abs(witness[1]) > 80e6 || Math.abs(witness[3]) > 80e6
      || witness[4] <= 0 || witness[5] < (tier === 2 ? schemaVersion === 5 ? 2000 : 3000 : 1500) || witness[6] < -1000 || witness[6] > 10000) {
      throw new InvalidDataError('Invalid landing-area qualification');
    }
    const polygon: Polygon = rings.map((ring: unknown) => {
      if (!Array.isArray(ring) || ring.length < 6 || ring.length % 2 || !ring.every(Number.isSafeInteger)) {
        throw new InvalidDataError('Invalid landing-area ring');
      }
      let lon = 0, lat = 0;
      const points: Point[] = [];
      for (let i = 0; i < ring.length; i += 2) {
        lon += ring[i]; lat += ring[i + 1];
        const x = lon / 1e6, y = lat / 1e6;
        if (!Number.isSafeInteger(lon) || !Number.isSafeInteger(lat) || Math.abs(x) > 180 || Math.abs(y) > 80
          || x < shard.bounds[0] - 1e-6 || x > shard.bounds[2] + 1e-6 || y < shard.bounds[1] - 1e-6 || y > shard.bounds[3] + 1e-6) {
          throw new InvalidDataError('Landing-area geometry exceeds its bounds');
        }
        points.push(project([x, y]));
      }
      const origin = points[0]!;
      let area = 0;
      for (let i = 1; i + 1 < points.length; i++) {
        const a = points[i]!, b = points[i + 1]!;
        area += (a[0] - origin[0]) * (b[1] - origin[1]) - (a[1] - origin[1]) * (b[0] - origin[0]);
      }
      if (area === 0) throw new InvalidDataError('Empty landing-area ring');
      points.push([...origin]); return points;
    });
    tiers[tier - 1]!++;
    return { polygon, tier, flags };
  });
  if (tiers.some((count, i) => count !== shard.tiers[i])) throw new InvalidDataError('Landing-area tiers do not match the manifest');
  return result;
}

export function landingBoundsOverlap(a: Bounds, b: Bounds): boolean {
  const east = b[2] < b[0] ? b[2] + 360 : b[2];
  const shift = 360 * Math.round(((b[0] + east) - (a[0] + a[2])) / 720);
  return a[0] + shift <= east && a[2] + shift >= b[0] && a[1] <= b[3] && a[3] >= b[1];
}
