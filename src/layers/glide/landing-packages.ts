import { GLIDE_LIMITS as L, glideArtifactUrl, isGlideArchive, isGlideBlock, isGlideIndex, isRecord, isSha256,
  type GlideArtifact, type GlideArchive, type GlideBlock, type GlidePage } from '@zlayer/contracts';
import { WholeFileCache } from '../../core/storage/archive-cache';
import { CHART_CACHE } from '../../core/storage/cache-names';
import { noteCacheAccess } from '../../core/storage/cache-access';
import { verificationReceipt } from '../../core/storage/verification-receipt';
import { openFileCache, storedFileBlob } from '../../core/storage/download-file';
import { discardResponseBody } from '../../core/storage/response';
import { verifyBlob } from '../../core/storage/artifacts';
import { boundedBlobStream } from '../../core/storage/blob-stream';
import { withAbort } from '../../core/data/abort';
import { InvalidDataError, ResourceError } from '../../core/data/errors';
import { decodeLandingAreas, type LandingShard } from './landing-data';
import type { LandingHeat } from './landing-heat';

export type LandingPackage = { root: string; archive: GlideArchive; block: GlideBlock };
const archives = new WholeFileCache(undefined, 6);
const indexes = new Map<string, Promise<ReturnType<typeof parseIndex>>>();
function parseIndex(value: unknown, page: GlidePage) {
  if (!isGlideIndex(value, page)) throw new InvalidDataError('Invalid glide index');
  return value;
}

/** Shared with regional saves. A warm parse never substitutes for a durable receipt. */
export async function readGlideArtifact(root: string, artifact: GlideArtifact, signal: AbortSignal, cacheOnly = false): Promise<Blob> {
  const url = glideArtifactUrl(root, artifact), cache = await openFileCache(CHART_CACHE);
  signal.throwIfAborted();
  if (cacheOnly) {
    const response = await cache.match(url);
    try {
      if (response?.status !== 200 || !verificationReceipt(response.headers, { byteLength: artifact.bytes, sha256: artifact.sha256 })) {
        throw new ResourceError('storage', 'Saved glide metadata is missing. Repair this region when online.');
      }
      const blob = await storedFileBlob(response);
      if (blob.size !== artifact.bytes) throw new InvalidDataError('Glide artifact size mismatch');
      signal.throwIfAborted(); return blob;
    } finally { discardResponseBody(response); }
  }
  void noteCacheAccess(CHART_CACHE, url);
  return (await withAbort(archives.ensureStored(cache, new Request(url)), signal)).blob;
}
export async function readGlideJson(root: string, artifact: GlideArtifact, signal: AbortSignal, cacheOnly = false): Promise<unknown> {
  if (artifact.bytes > L.archiveBytes) throw new InvalidDataError('Glide metadata exceeds the reader budget');
  const blob = await readGlideArtifact(root, artifact, signal, cacheOnly);
  const result: unknown = JSON.parse(await withAbort(blob.text(), signal));
  signal.throwIfAborted(); return result;
}
export async function readGlideIndex(root: string, page: GlidePage, signal: AbortSignal, cacheOnly = false) {
  const blob = await readGlideArtifact(root, page, signal, cacheOnly), key = glideArtifactUrl(root, page);
  let pending = indexes.get(key);
  if (pending) indexes.delete(key);
  else {
    const loading = pending = blob.text().then(text => parseIndex(JSON.parse(text), page));
    void loading.catch(() => { if (indexes.get(key) === loading) indexes.delete(key); });
  }
  indexes.set(key, pending);
  while (indexes.size > 8) indexes.delete(indexes.keys().next().value!);
  const index = await withAbort(pending, signal);
  // The same file can be referenced with conflicting metadata in a malformed root.
  return parseIndex(index, page);
}

export async function readGlideBlock(blob: Blob, archive: GlideArchive, block: GlideBlock, signal: AbortSignal): Promise<Uint8Array> {
  if (!isGlideArchive(archive) || blob.size !== archive.bytes) throw new InvalidDataError('Invalid glide archive');
  const prefix = new Uint8Array(await blob.slice(0, 16).arrayBuffer());
  const view = new DataView(prefix.buffer), length = view.getUint32(8, true), start = 16 + length;
  if (new TextDecoder().decode(prefix.subarray(0, 8)) !== 'GLIDEP01' || view.getUint32(12, true) !== 0
    || !length || length > L.directoryBytes || start >= blob.size) throw new InvalidDataError('Invalid glide archive header');
  const directory: unknown = JSON.parse(await blob.slice(16, start).text());
  if (!Array.isArray(directory) || directory.length !== archive.blocks.length) throw new InvalidDataError('Invalid glide archive directory');
  const entries = directory.map(entry => {
    if (!isGlideBlock(entry)) throw new InvalidDataError('Invalid glide directory block');
    return { ...entry, offset: entry.offset + start };
  });
  if (!isGlideArchive({ ...archive, blocks: entries }) || entries.some((entry, i) =>
    Object.keys(archive.blocks[i]!).some(key => JSON.stringify(entry[key as keyof GlideBlock]) !== JSON.stringify(archive.blocks[i]![key as keyof GlideBlock])))
    || !entries.some(entry => entry.key === block.key && Object.keys(entry).every(key =>
      JSON.stringify(entry[key as keyof GlideBlock]) === JSON.stringify(block[key as keyof GlideBlock])))) {
    throw new InvalidDataError('Glide directory disagrees with its index');
  }
  signal.throwIfAborted();
  const compressed = blob.slice(block.offset, block.offset + block.bytes);
  await verifyBlob(compressed, { byteLength: block.bytes, sha256: block.sha256 }, 'Glide block');
  let received = 0;
  const raw = await new Response(boundedBlobStream(compressed).pipeThrough(new DecompressionStream('gzip'))
    .pipeThrough(new TransformStream<Uint8Array, Uint8Array>({
      transform(chunk, controller) {
        signal.throwIfAborted(); received += chunk.byteLength;
        if (received > block.rawBytes) throw new InvalidDataError('Glide block exceeds its published size');
        controller.enqueue(chunk);
      },
      flush() { if (received !== block.rawBytes) throw new InvalidDataError('Glide block size mismatch'); },
    }), { signal })).arrayBuffer();
  signal.throwIfAborted(); return new Uint8Array(raw);
}
export function decodeGlideDetail(raw: Uint8Array, shard: LandingShard) {
  const block = shard.package!.block;
  if (block.schema === 0 || block.kind !== 'detail') throw new InvalidDataError('Expected glide detail');
  const value: unknown = JSON.parse(new TextDecoder().decode(raw));
  if (!isRecord(value) || !isSha256(value.source) || !Array.isArray(value.indices) || value.indices.length !== block.records
    || value.indices.some(n => !Number.isSafeInteger(n) || n < 0 || n >= 100000) || new Set(value.indices).size !== value.indices.length) {
    throw new InvalidDataError('Invalid glide record identities');
  }
  const areas = decodeLandingAreas(value.areas, shard, block.schema);
  const rings = areas.reduce((n, area) => n + area.polygon.length, 0);
  const vertices = areas.reduce((n, area) => n + area.polygon.reduce((n, ring) => n + ring.length - 1, 0), 0);
  if (rings !== block.rings || vertices !== block.vertices) throw new InvalidDataError('Glide complexity mismatch');
  return areas.map((area, i) => ({ ...area, id: `${value.source}:${(value.indices as number[])[i]}` }));
}
export function decodeGlideOverview(raw: Uint8Array, block: GlideBlock): LandingHeat {
  if (block.kind !== 'overview' || raw.length !== 256 * 256 * 3) throw new InvalidDataError('Invalid glide overview');
  for (let i = 0; i < raw.length; i += 3) if (raw[i]! + raw[i + 1]! > raw[i + 2]!) throw new InvalidDataError('Invalid glide density fractions');
  const [z, x, y] = block.tile, n = 2 ** z;
  return { extent: [x / n, y / n, (x + 1) / n, (y + 1) / n], width: 256, height: 256, cells: raw, flags: 0, density: true };
}
export async function loadGlideDetail(shard: LandingShard, signal: AbortSignal) {
  const { root, archive, block } = shard.package!;
  return decodeGlideDetail(await readGlideBlock(await readGlideArtifact(root, archive, signal), archive, block, signal), shard);
}
export async function loadGlideOverview(shard: LandingShard, signal: AbortSignal) {
  const { root, archive, block } = shard.package!;
  return decodeGlideOverview(await readGlideBlock(await readGlideArtifact(root, archive, signal), archive, block, signal), block);
}
