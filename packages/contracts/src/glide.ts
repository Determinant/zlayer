import type { Bounds } from './types.js';
import { isRecord, isSha256 } from './validation.js';

export const GLIDE_LIMITS = {
  releaseBytes: 5_000_000_000, archiveBytes: 2 * 1024 * 1024, directoryBytes: 256 * 1024,
  blockBytes: 256 * 1024, blockRawBytes: 1024 * 1024, vertices: 65_536, records: 4096, rings: 16_384,
  pageBytes: 512 * 1024, pageEntries: 512, oversizedBlockRawBytes: 8 * 1024 * 1024,
  oversizedBlockBytes: 1792 * 1024, oversizedVertices: 524_288, oversizedRings: 65_536,
} as const;
export type GlideArtifact = { file: string; bytes: number; sha256: string };
export type GlideKind = 'detail' | 'overview';
export type GlideBlock = { key: string; kind: GlideKind; bounds: Bounds; rawBytes: number; bytes: number; sha256: string;
  records: number; vertices: number; rings: number; tiers: [number, number]; schema: 8 | 9 | 0;
  tile: [number, number, number]; oversized?: true; offset: number };
export type GlideArchive = GlideArtifact & { kind: GlideKind; bounds: Bounds; blocks: GlideBlock[] };
export type GlidePage = GlideArtifact & { bounds: Bounds; entries: number; kind: GlideKind };
export type GlideIndex = { schemaVersion: 1; kind: GlideKind; archives: GlideArchive[] };
export type GlideCoverage = 'available' | 'partial' | 'unavailable';
export type GlideRegionReference = GlideArtifact & { id: string; bounds: Bounds[]; coverage: GlideCoverage; downloadBytes: number };
export type GlideRegion = { schemaVersion: 1; id: string; title: string; bounds: Bounds[];
  definitionSha256: string; sourceSha256: string; coverage: GlideCoverage; indexes: GlidePage[];
  files: GlideArtifact[]; filePages?: GlideArtifact[] };
export type GlideManifest = { product: 'glide-packages'; schemaVersion: 1; generatedAt: string; inputSha256: string;
  packagingSha256: string; source: { schemaVersion: 8 | 9; builderVersion: number; inputSha256: string;
    status: 'experimental-candidates'; geometryMeaning: 'generalized-candidate-area'; rules: Record<string, unknown> };
  provenance: GlideArtifact; coverage: GlideArtifact; indexes: GlidePage[]; regions: GlideRegionReference[];
  overview: { projection: 'EPSG:3857'; tileSize: 256; samplesPerAxis: 4; minZoom: 0; maxZoom: 10 | 11;
    encoding: 'uint8-preferred-best-effort-prepared'; densityMeaning: 'sampled-ground-area-fraction'; version: 1 };
  limits: typeof GLIDE_LIMITS; totalBytes: number; records: number; detailDigest: string };
/** The complete accepted root lives in the shared, immutable catalog snapshot. */
export type GlideSource = GlideManifest & { root: string };
const L = GLIDE_LIMITS;
const integer = (v: unknown, min: number, max: number): v is number => typeof v === 'number' && Number.isSafeInteger(v) && v >= min && v <= max;
export const isGlideBounds = (v: unknown): v is Bounds => Array.isArray(v) && v.length === 4 && v.every(Number.isFinite)
  && v[0] >= -180 && v[2] <= 180 && v[1] >= -85.05112878 && v[3] <= 85.05112878 && v[0] < v[2] && v[1] < v[3];
export const glideContains = (a: Bounds, b: Bounds) => b[0] >= a[0] - 1e-6 && b[1] >= a[1] - 1e-6 && b[2] <= a[2] + 1e-6 && b[3] <= a[3] + 1e-6;
const kind = (v: unknown): v is GlideKind => v === 'detail' || v === 'overview';
const coverage = (v: unknown): v is GlideCoverage => v === 'available' || v === 'partial' || v === 'unavailable';
const rectangles = (v: unknown): v is Bounds[] => Array.isArray(v) && v.length > 0 && v.length <= 100 && v.every(isGlideBounds);
const unique = (values: { file: string }[]) => new Set(values.map(v => v.file)).size === values.length;
export function isGlideArtifact(v: unknown, folders = ['detail', 'overview', 'indexes', 'coverage', 'provenance', 'regions', 'dependencies']): v is GlideArtifact & Record<string, unknown> {
  return isRecord(v) && isSha256(v.sha256) && integer(v.bytes, 1, L.releaseBytes - 1) && folders.some(folder =>
    v.file === `${folder}/${v.sha256}.${folder === 'detail' ? 'gld' : folder === 'overview' ? 'glo' : 'json'}`);
}
export function isGlidePage(v: unknown): v is GlidePage {
  return isRecord(v) && isGlideArtifact(v, ['indexes']) && v.bytes <= L.pageBytes && isGlideBounds(v.bounds)
    && integer(v.entries, 1, L.pageEntries) && kind(v.kind);
}
export function isGlideBlock(v: unknown): v is GlideBlock {
  if (!isRecord(v)) return false;
  const large = v.oversized === true;
  return typeof v.key === 'string' && v.key.length > 0 && v.key.length <= 200 && kind(v.kind) && isGlideBounds(v.bounds)
    && isSha256(v.sha256) && (v.oversized === undefined || large) && (!large || v.kind === 'detail' && v.records === 1)
    && integer(v.bytes, 1, large ? L.oversizedBlockBytes : L.blockBytes) && integer(v.rawBytes, 1, large ? L.oversizedBlockRawBytes : L.blockRawBytes)
    && Array.isArray(v.tile) && v.tile.length === 3 && integer(v.tile[0], 0, 16) && v.tile.slice(1).every(n => integer(n, 0, 2 ** Number((v.tile as unknown[])[0]) - 1))
    && integer(v.records, 0, L.records) && integer(v.vertices, 0, large ? L.oversizedVertices : L.vertices)
    && integer(v.rings, 0, large ? L.oversizedRings : L.rings) && integer(v.offset, 0, L.archiveBytes)
    && Array.isArray(v.tiers) && v.tiers.length === 2 && v.tiers.every(n => integer(n, 0, Number(v.records))) && v.tiers[0]! + v.tiers[1]! === v.records
    && (v.kind === 'detail' ? (v.schema === 8 || v.schema === 9) && v.records > 0 && v.vertices > 0 && v.rings > 0
      : v.schema === 0 && v.records === 0 && v.vertices === 0 && v.rings === 0 && v.rawBytes === 256 * 256 * 3);
}
export function glideTileBounds([z, x, y]: [number, number, number]): Bounds {
  const n = 2 ** z, latitude = (v: number) => Math.atan(Math.sinh(Math.PI * (1 - 2 * v / n))) * 180 / Math.PI;
  return [x / n * 360 - 180, latitude(y + 1), (x + 1) / n * 360 - 180, latitude(y)];
}
export function isGlideArchive(v: unknown): v is GlideArchive {
  if (!isRecord(v) || !kind(v.kind) || !isGlideArtifact(v, [v.kind]) || v.bytes > L.archiveBytes || !isGlideBounds(v.bounds)
    || !Array.isArray(v.blocks) || !v.blocks.length || v.blocks.length > L.pageEntries) return false;
  const keys = new Set<string>(); let end = 0;
  for (const [i, b] of v.blocks.entries()) {
    if (!isGlideBlock(b) || b.kind !== v.kind || !glideContains(v.bounds, b.bounds) || keys.has(b.key)
      || (i === 0 ? b.offset < 17 || b.offset > 16 + L.directoryBytes : b.offset !== end)
      || b.kind === 'overview' && glideTileBounds(b.tile).some((n, i) => Math.abs(n - b.bounds[i]!) > 1e-9)) return false;
    keys.add(b.key); end = b.offset + b.bytes;
  }
  return end === v.bytes;
}
export function isGlideIndex(v: unknown, page?: GlidePage): v is GlideIndex {
  return isRecord(v) && v.schemaVersion === 1 && kind(v.kind) && Array.isArray(v.archives) && v.archives.length > 0
    && v.archives.length <= L.pageEntries && (!page || v.kind === page.kind && v.archives.length === page.entries)
    && v.archives.every(a => isGlideArchive(a) && a.kind === v.kind && (!page || glideContains(page.bounds, a.bounds))) && unique(v.archives);
}
export function isGlideDependencies(v: unknown): v is { schemaVersion: 1; files: GlideArtifact[] } {
  return isRecord(v) && v.schemaVersion === 1 && Array.isArray(v.files) && v.files.length > 0 && v.files.length <= L.pageEntries
    && v.files.every(f => isGlideArtifact(f, ['detail', 'overview', 'indexes', 'coverage', 'provenance'])) && unique(v.files);
}
export function isGlideRegion(v: unknown): v is GlideRegion {
  return isRecord(v) && v.schemaVersion === 1 && typeof v.id === 'string' && v.id.length > 0 && typeof v.title === 'string'
    && rectangles(v.bounds) && isSha256(v.definitionSha256) && isSha256(v.sourceSha256) && coverage(v.coverage)
    && Array.isArray(v.indexes) && v.indexes.length <= 10000 && v.indexes.every(isGlidePage) && unique(v.indexes)
    && Array.isArray(v.files) && v.files.length <= L.pageEntries && v.files.every(f => isGlideArtifact(f, ['detail', 'overview', 'indexes', 'coverage', 'provenance'])) && unique(v.files)
    && (v.filePages === undefined || Array.isArray(v.filePages) && v.filePages.length > 0 && v.filePages.length <= 10000
      && !v.files.length && v.filePages.every(f => isGlideArtifact(f, ['dependencies']) && f.bytes <= L.pageBytes) && unique(v.filePages));
}
export function isGlideManifest(v: unknown): v is GlideManifest {
  if (!isRecord(v) || v.product !== 'glide-packages' || v.schemaVersion !== 1 || !isSha256(v.inputSha256)
    || !isSha256(v.packagingSha256) || !isSha256(v.detailDigest) || !integer(v.totalBytes, 1, L.releaseBytes - 1)
    || !integer(v.records, 0, 1_000_000_000) || typeof v.generatedAt !== 'string' || !Number.isFinite(Date.parse(v.generatedAt))
    || !isRecord(v.source) || !(v.source.schemaVersion === 8 || v.source.schemaVersion === 9) || !integer(v.source.builderVersion, 1, 100000)
    || !isSha256(v.source.inputSha256) || !isRecord(v.source.rules) || v.source.status !== 'experimental-candidates'
    || v.source.geometryMeaning !== 'generalized-candidate-area' || !isGlideArtifact(v.provenance, ['provenance'])
    || !isGlideArtifact(v.coverage, ['coverage']) || !Array.isArray(v.indexes) || v.indexes.length > 10000
    || !v.indexes.every(isGlidePage) || !unique(v.indexes) || !Array.isArray(v.regions) || v.regions.length > 10000
    || !isRecord(v.overview) || v.overview.projection !== 'EPSG:3857' || v.overview.tileSize !== 256 || v.overview.samplesPerAxis !== 4
    || v.overview.minZoom !== 0 || !(v.overview.maxZoom === 10 || v.overview.maxZoom === 11) || v.overview.encoding !== 'uint8-preferred-best-effort-prepared'
    || v.overview.densityMeaning !== 'sampled-ground-area-fraction' || v.overview.version !== 1
    || !isRecord(v.limits) || Object.entries(L).some(([key, n]) => (v.limits as Record<string, unknown>)[key] !== n)) return false;
  const ids = new Set<string>();
  return v.regions.every(r => {
    if (!isRecord(r) || !isGlideArtifact(r, ['regions']) || r.bytes > L.pageBytes || typeof r.id !== 'string' || !r.id || ids.has(r.id)
      || !rectangles(r.bounds) || !coverage(r.coverage) || !integer(r.downloadBytes, r.bytes, L.releaseBytes - 1)) return false;
    ids.add(r.id); return true;
  });
}
export function glideArtifactUrl(root: string, artifact: GlideArtifact): string {
  const url = new URL(artifact.file, `${root.replace(/\/$/, '')}/`);
  url.searchParams.set('sha256', artifact.sha256); url.searchParams.set('bytes', String(artifact.bytes));
  return url.href;
}
