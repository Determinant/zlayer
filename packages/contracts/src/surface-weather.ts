import { isRecord, isSha256 } from './validation.js';

export const SURFACE_PRODUCTS = ['analysis', 'forecast'] as const;
/** Full AWC cardinal curves, including isobars across the seven-day horizon. */
export const SURFACE_MAX_BYTES = 8 * 1024 * 1024;
export const SURFACE_CATALOG_MAX_BYTES = 64 * 1024;
export const SURFACE_PROCESSING = 'wpc-cardinal-v2';
export type SurfaceProduct = typeof SURFACE_PRODUCTS[number];
export const SURFACE_BOUNDARIES = ['COLD', 'WARM', 'STNRY', 'OCFNT', 'TROF', 'DRYLINE', 'SQUALL'] as const;
export type SurfaceBoundary = typeof SURFACE_BOUNDARIES[number];
export type SurfacePhase = 'normal' | 'forming' | 'weakening';
type Point = { type: 'Point'; coordinates: [number, number] };
type Line = { type: 'LineString'; coordinates: [number, number][] } | { type: 'MultiLineString'; coordinates: [number, number][][] };
export type SurfaceFeature = { id: string; sourceProperties: Record<string, string | number> } & (
  | { kind: 'HIGH' | 'LOW' | 'TROPICAL_STORM' | 'HURRICANE'; geometry: Point }
  | { kind: 'LABEL'; text: string; geometry: Point }
  | { kind: 'ISOBAR'; geometry: Line }
  | { kind: SurfaceBoundary; phase: SurfacePhase; geometry: Line }
);
export type SurfaceFrame = {
  /** Prepared-file identity attached by the client, independent of source checks. */
  artifactHash?: string;
  validTime: number;
  /** NOAA chart reference cycle, not an issuance timestamp. */
  referenceTime: number;
  checkedAt: number;
  source: string;
  sourceHash: string;
  /** Complete original GeoJSON, including metadata and source qualifiers. */
  sourceDocument: string;
  features: SurfaceFeature[];
};
export type SurfaceSnapshot = {
  schemaVersion: 2;
  product: SurfaceProduct;
  checkedAt: number;
  source: string;
  sourceHash: string;
  sourceCatalog: string;
  frames: SurfaceFrame[];
};
/** Small freshness catalog; geometry lives in content-addressed chart files. */
export type SurfaceFile = Pick<SurfaceFrame, 'validTime' | 'referenceTime' | 'checkedAt' | 'source' | 'sourceHash'> & {
  path: string; sha256: string; byteLength: number; positions: number; documentLength: number;
};
export type SurfaceCatalog = Omit<SurfaceSnapshot, 'schemaVersion' | 'frames'> & { schemaVersion: 3; frames: SurfaceFile[] };
export type SurfaceArtifact = { schemaVersion: 1; processing: typeof SURFACE_PROCESSING; product: SurfaceProduct; frame: SurfaceFrame };

const instant = (v: unknown): v is number => typeof v === 'number' && Number.isSafeInteger(v) && v > 0 && v < 8.64e15;
const source = (v: unknown): v is string => typeof v === 'string' && v.length <= 2048 && /^https:\/\//.test(v);
const position = (v: unknown): v is [number, number] => Array.isArray(v) && v.length === 2 &&
  typeof v[0] === 'number' && Number.isFinite(v[0]) && Math.abs(v[0]) <= 180 &&
  typeof v[1] === 'number' && Number.isFinite(v[1]) && Math.abs(v[1]) <= 90;
const line = (v: unknown): v is [number, number][] => Array.isArray(v) && v.length >= 2 && v.length <= 5000 && v.every(position);
function feature(v: unknown): v is SurfaceFeature {
  if (!isRecord(v) || typeof v.id !== 'string' || !v.id || v.id.length > 160 || !isRecord(v.geometry) ||
    !isRecord(v.sourceProperties) || Object.keys(v.sourceProperties).length > 24 ||
    !Object.values(v.sourceProperties).every(p => typeof p === 'string' && p.length <= 1024 || typeof p === 'number' && Number.isFinite(p))) return false;
  if (['HIGH', 'LOW', 'HURRICANE', 'TROPICAL_STORM', 'LABEL'].includes(String(v.kind))) return v.geometry.type === 'Point' && position(v.geometry.coordinates) &&
    (v.kind !== 'LABEL' || typeof v.text === 'string' && v.text.length > 0 && v.text.length <= 1024);
  return (v.kind === 'ISOBAR' || SURFACE_BOUNDARIES.some(kind => kind === v.kind) && ['normal', 'forming', 'weakening'].includes(String(v.phase))) &&
    (v.geometry.type === 'LineString' ? line(v.geometry.coordinates)
      : v.geometry.type === 'MultiLineString' && Array.isArray(v.geometry.coordinates) && v.geometry.coordinates.length <= 20 &&
        v.geometry.coordinates.length > 0 && v.geometry.coordinates.every(line));
}
export function isSurfaceSnapshot(v: unknown): v is SurfaceSnapshot {
  if (!isRecord(v) || v.schemaVersion !== 2 || !SURFACE_PRODUCTS.some(p => p === v.product) || !instant(v.checkedAt) ||
    !source(v.source) || !isSha256(v.sourceHash) || typeof v.sourceCatalog !== 'string' || !v.sourceCatalog || v.sourceCatalog.length > 16 * 1024 ||
    !Array.isArray(v.frames) || v.frames.length < 1 || v.frames.length > 32 || v.product === 'analysis' && v.frames.length !== 1) return false;
  const checkedAt = v.checkedAt;
  let previous = 0, total = 0, documents = 0;
  return v.frames.every((f: unknown) => {
    if (!isRecord(f) || !instant(f.validTime) || !instant(f.referenceTime) || !instant(f.checkedAt) || f.checkedAt < checkedAt ||
      f.referenceTime > f.checkedAt + 60_000 || f.validTime <= previous || f.validTime % 3600_000 !== 0 || f.referenceTime % 3600_000 !== 0 ||
      f.validTime < f.referenceTime || f.validTime > f.referenceTime + 168 * 3600_000 ||
      (v.product === 'analysis' ? f.validTime !== f.referenceTime : f.validTime === f.referenceTime) ||
      !source(f.source) || !isSha256(f.sourceHash) || f.artifactHash !== undefined && !isSha256(f.artifactHash) ||
      typeof f.sourceDocument !== 'string' || !f.sourceDocument || f.sourceDocument.length > 512 * 1024 ||
      !Array.isArray(f.features) || !f.features.length || f.features.length > 2500 || !f.features.every(feature) ||
      new Set(f.features.map(f => f.id)).size !== f.features.length) return false;
    documents += f.sourceDocument.length;
    total += f.features.reduce((sum, f) => sum + (f.geometry.type === 'Point' ? 1 : f.geometry.type === 'LineString'
      ? f.geometry.coordinates.length : f.geometry.coordinates.reduce((n, line) => n + line.length, 0)), 0);
    previous = f.validTime;
    return total <= 400_000 && documents <= 3 * 1024 * 1024;
  });
}

export function isSurfaceCatalog(v: unknown): v is SurfaceCatalog {
  if (!isRecord(v) || v.schemaVersion !== 3 || !SURFACE_PRODUCTS.some(p => p === v.product) || !instant(v.checkedAt) ||
    !source(v.source) || !isSha256(v.sourceHash) || typeof v.sourceCatalog !== 'string' || !v.sourceCatalog || v.sourceCatalog.length > 16 * 1024 ||
    !Array.isArray(v.frames) || !v.frames.length || v.frames.length > 32 || v.product === 'analysis' && v.frames.length !== 1) return false;
  const checkedAt = v.checkedAt;
  let previous = 0, bytes = 0, positions = 0, documents = 0;
  return v.frames.every((f: unknown) => {
    if (!isRecord(f) || !instant(f.validTime) || !instant(f.referenceTime) || !instant(f.checkedAt) || f.checkedAt < checkedAt ||
      f.referenceTime > f.checkedAt + 60_000 || f.validTime <= previous || f.validTime % 3600_000 !== 0 || f.referenceTime % 3600_000 !== 0 ||
      f.validTime < f.referenceTime || f.validTime > f.referenceTime + 168 * 3600_000 ||
      (v.product === 'analysis' ? f.validTime !== f.referenceTime : f.validTime === f.referenceTime) ||
      !source(f.source) || !isSha256(f.sourceHash) || !isSha256(f.sha256) || f.path !== `${v.product}/${f.sha256}.json` ||
      typeof f.byteLength !== 'number' || !Number.isSafeInteger(f.byteLength) || f.byteLength <= 0 ||
      typeof f.positions !== 'number' || !Number.isSafeInteger(f.positions) || f.positions <= 0 ||
      typeof f.documentLength !== 'number' || !Number.isSafeInteger(f.documentLength) || f.documentLength <= 0 || f.documentLength > 512 * 1024) return false;
    previous = f.validTime; bytes += f.byteLength; positions += f.positions; documents += f.documentLength;
    return bytes <= SURFACE_MAX_BYTES && positions <= 400_000 && documents <= 3 * 1024 * 1024;
  });
}

export const surfacePositions = (frame: SurfaceFrame) => frame.features.reduce((sum, f) => sum + (f.geometry.type === 'Point' ? 1
  : f.geometry.type === 'LineString' ? f.geometry.coordinates.length : f.geometry.coordinates.reduce((n, line) => n + line.length, 0)), 0);

export function isSurfaceArtifact(v: unknown): v is SurfaceArtifact {
  if (!isRecord(v) || v.schemaVersion !== 1 || v.processing !== SURFACE_PROCESSING || !isRecord(v.frame)) return false;
  return isSurfaceSnapshot({ schemaVersion: 2, product: v.product, checkedAt: v.frame.checkedAt,
    source: v.frame.source, sourceHash: v.frame.sourceHash, sourceCatalog: 'Chart artifact', frames: [v.frame] });
}
