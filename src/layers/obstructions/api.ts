import { fetchJson } from '../../core/data/fetch-json';
import { InvalidDataError } from '../../core/data/errors';
import { DATA_CACHE } from '../../core/storage/cache-names';
import { verifyBlob } from '../../core/storage/artifacts';
import { verificationReceipt } from '../../core/storage/verification-receipt';
import { DOWNLOAD_MEMORY_LIMIT, storedFileBlob } from '../../core/storage/download-file';
import { createPluginStorage } from '../../core/storage/plugin-storage';
import { pluginFileKey, readDerivedArtifact } from '../../core/storage/plugin-file-cache';
import { transferFile } from '../../core/storage/file-transfer';
import { checkObstructionAllocation, isObstructionManifest, ObstructionIndex, OBSTRUCTION_INDEX_VERSION,
  OBSTRUCTION_MAX_RECORDS, OBSTRUCTION_MAX_SOURCE_RECORDS } from './data';
import { decompressObstructions, readObstructionFeatures } from './stream';
import type { ObstructionManifest } from './types';

const SOURCE_HEADER = 'x-zlayer-obstruction-source';
const indices = createPluginStorage('obstructions').files('indices', {
  maxEntries: 4, maxBytes: 4 * DOWNLOAD_MEMORY_LIMIT, maxFileBytes: DOWNLOAD_MEMORY_LIMIT, maxUnusedMs: 14 * 86400000,
});

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

export type LoadedObstructions = { index: ObstructionIndex; identity: string; sourceDate?: string };

export async function loadObstructions(manifestUrl: string, previous?: LoadedObstructions): Promise<LoadedObstructions> {
  const manifest = await fetchJson(manifestUrl, isObstructionManifest, 'FAA obstructions', { policy: 'network-first' });
  const url = new URL(manifest.dataset.path, manifestUrl).href;
  const published = manifest.index;
  checkObstructionAllocation(published?.count ?? manifest.dataset.count,
    published ? OBSTRUCTION_MAX_RECORDS : OBSTRUCTION_MAX_SOURCE_RECORDS);
  const snapshotUrl = new URL(url);
  snapshotUrl.searchParams.set('zlayer-obstruction-index', [OBSTRUCTION_INDEX_VERSION,
    manifest.dataset.bytes, manifest.dataset.uncompressedBytes, manifest.dataset.count].join('-'));
  const snapshotKey = snapshotUrl.href;
  const sourceIdentity = [manifest.dataset.sha256, manifest.dataset.bytes, manifest.dataset.uncompressedBytes, manifest.dataset.count].join(':');
  const indexIdentity = `${OBSTRUCTION_INDEX_VERSION}:${sourceIdentity}`;
  const publishedIdentity = published ? { byteLength: published.bytes, sha256: published.sha256 } : undefined;
  const artifactIdentity = published ? `:${JSON.stringify([published.version, published.sha256,
    published.bytes, published.count, published.source.lastModified])}` : '';
  const identity = `${url}:${indexIdentity}${artifactIdentity}`;
  const sourceDate = manifest.source.lastModified;
  if (previous?.identity === identity) return { index: previous.index, identity, ...(sourceDate ? { sourceDate } : {}) };
  const signal = new AbortController().signal;
  let fresh: { bytes: ArrayBuffer; index: ObstructionIndex } | undefined;
  const snapshot = async (index: ObstructionIndex) => {
    const bytes = index.snapshot();
    if (publishedIdentity) await verifyBlob(new Blob([bytes]), publishedIdentity, 'Obstruction index');
    fresh = { bytes, index };
    return fresh.bytes;
  };
  const index = await indices.derive({ url, identity: `${indexIdentity}${artifactIdentity}`,
    label: 'Obstruction index', signal,
    legacy: [...(publishedIdentity ? [{ cache: indices.cacheName, key: pluginFileKey({ url, identity: indexIdentity }),
      async convert(response: Response, signal: AbortSignal) {
        // Old clients ignore manifest.index and save the same binary under the
        // source-only identity. Authenticate it before adopting the new key.
        const bytes = await readDerivedArtifact(response, publishedIdentity.byteLength, signal);
        await verifyBlob(new Blob([bytes]), publishedIdentity, 'Obstruction index');
        return bytes;
      } }] : []), { cache: DATA_CACHE, key: snapshotKey, async convert(response) {
      const receipt = verificationReceipt(response.headers);
      if (response.status !== 200 || response.headers.get(SOURCE_HEADER) !== sourceIdentity || !receipt || receipt.byteLength > DOWNLOAD_MEMORY_LIMIT) {
        throw new InvalidDataError('Invalid obstruction index cache');
      }
      const blob = await storedFileBlob(response);
      await verifyBlob(blob, receipt, 'Obstruction index');
      if (publishedIdentity) await verifyBlob(blob, publishedIdentity, 'Obstruction index');
      return blob.arrayBuffer();
    } }, { cache: DATA_CACHE, key: url, async convert(response) {
      if (response.status !== 200) throw new InvalidDataError('Obstruction cache response is incomplete');
      checkObstructionAllocation(manifest.dataset.count, OBSTRUCTION_MAX_SOURCE_RECORDS);
      // Always authenticate legacy source bytes before migrating them.
      return snapshot(await parseObstructions(await storedFileBlob(response), manifest));
    } }],
    create: signal => published
      ? transferFile({ url: new URL(published.path, manifestUrl).href, label: 'Obstruction index', byteLength: published.bytes, signal },
        async ({ blob }) => {
          await verifyBlob(blob, publishedIdentity!, 'Obstruction index');
          return blob.arrayBuffer();
        })
      : transferFile({ url, label: 'Obstructions', byteLength: manifest.dataset.bytes, signal },
        async ({ blob }) => snapshot(await parseObstructions(blob, manifest))),
    async validate(bytes) {
      const index = fresh?.bytes === bytes ? fresh.index : ObstructionIndex.restore(bytes, manifest.dataset.count);
      if (published && index.size !== published.count) throw new InvalidDataError('Obstruction index count does not match the manifest');
      return index;
    },
  });
  return { index, identity, ...(sourceDate ? { sourceDate } : {}) };
}
