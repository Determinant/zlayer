import { fetchJson } from '../../core/data/fetch-json';
import { InvalidDataError } from '../../core/data/errors';
import { DATA_CACHE, VERIFIED_SHA256_HEADER } from '../../core/storage/cache-names';
import { noteCacheAccess } from '../../core/storage/cache-access';
import { blobSha256, readArtifact, verifyBlob } from '../../core/storage/artifacts';
import { verificationReceipt } from '../../core/storage/verification-receipt';
import { DOWNLOAD_MEMORY_LIMIT, openFileCache, storedFileBlob } from '../../core/storage/download-file';
import { transferFile } from '../../core/storage/file-transfer';
import { isObstructionManifest, ObstructionIndex, OBSTRUCTION_INDEX_VERSION } from './data';
import { decompressObstructions, readObstructionFeatures } from './stream';
import type { ObstructionManifest } from './types';

const SOURCE_HEADER = 'x-zlayer-obstruction-source';

export async function parseObstructions(blob: Blob, manifest: ObstructionManifest): Promise<ObstructionIndex> {
  await verifyBlob(blob, { byteLength: manifest.dataset.bytes, sha256: manifest.dataset.sha256 }, 'Obstructions');
  return indexObstructions(blob, manifest);
}

async function indexObstructions(blob: Blob, manifest: ObstructionManifest): Promise<ObstructionIndex> {
  const index = new ObstructionIndex(manifest.dataset.count);
  await readObstructionFeatures(decompressObstructions(blob),
    manifest.dataset.uncompressedBytes, feature => index.add(feature));
  index.finish();
  return index;
}

export async function loadObstructions(manifestUrl: string): Promise<{ index: ObstructionIndex; sourceDate?: string }> {
  const manifest = await fetchJson(manifestUrl, isObstructionManifest, 'FAA obstructions', { revalidate: true });
  const url = new URL(manifest.dataset.path, manifestUrl).href;
  const snapshotUrl = new URL(url);
  snapshotUrl.searchParams.set('zlayer-obstruction-index', [OBSTRUCTION_INDEX_VERSION,
    manifest.dataset.bytes, manifest.dataset.uncompressedBytes, manifest.dataset.count].join('-'));
  const snapshotKey = snapshotUrl.href;
  const sourceIdentity = [manifest.dataset.sha256, manifest.dataset.bytes, manifest.dataset.uncompressedBytes, manifest.dataset.count].join(':');
  const cache = await openFileCache(DATA_CACHE).catch(() => undefined);
  await noteCacheAccess(DATA_CACHE, snapshotKey);
  const result = (index: ObstructionIndex) => ({ index,
    ...(manifest.source.lastModified ? { sourceDate: manifest.source.lastModified } : {}) });
  const snapshot = await readArtifact(cache, snapshotKey, async response => {
    const receipt = verificationReceipt(response.headers);
    if (response.status !== 200 || response.headers.get(SOURCE_HEADER) !== sourceIdentity || !receipt || receipt.byteLength > DOWNLOAD_MEMORY_LIMIT) {
      throw new InvalidDataError('Invalid obstruction index cache');
    }
    const blob = await storedFileBlob(response);
    await verifyBlob(blob, receipt, 'Obstruction index');
    return ObstructionIndex.restore(await blob.arrayBuffer(), manifest.dataset.count);
  });
  if (snapshot.state === 'ready') return result(snapshot.value);
  if (snapshot.state === 'invalid') await cache?.delete(snapshotKey).catch(() => {});
  const persist = async (index: ObstructionIndex) => {
    if (!cache || index.byteLength + 8 > DOWNLOAD_MEMORY_LIMIT) return;
    try {
      const blob = new Blob([index.snapshot()]);
      await cache.put(snapshotKey, new Response(blob, { headers: {
        'content-type': 'application/octet-stream', 'content-length': String(blob.size),
        [SOURCE_HEADER]: sourceIdentity,
        [VERIFIED_SHA256_HEADER]: await blobSha256(blob),
      } }));
      // Retain the legacy source if the replacement could not be committed.
      await cache.delete(url);
    } catch { /* Optional storage cannot prevent use of a validated index. */ }
  };
  // Migrate an existing full gzip cache without requiring a network download.
  await noteCacheAccess(DATA_CACHE, url);
  const saved = await readArtifact(cache, url, async response => {
    if (response.status !== 200) throw new InvalidDataError('Obstruction cache response is incomplete');
    const blob = await storedFileBlob(response);
    const verified = blob.size === manifest.dataset.bytes && verificationReceipt(response.headers,
      { byteLength: blob.size, sha256: manifest.dataset.sha256 });
    return verified ? indexObstructions(blob, manifest) : parseObstructions(blob, manifest);
  });
  if (saved.state === 'ready') {
    await persist(saved.value);
    return result(saved.value);
  }
  if (saved.state === 'invalid') await cache?.delete(url).catch(() => {});
  return transferFile({ url, label: 'Obstructions', byteLength: manifest.dataset.bytes }, async ({ blob }) => {
    const index = await parseObstructions(blob, manifest);
    await persist(index);
    return result(index);
  });
}
