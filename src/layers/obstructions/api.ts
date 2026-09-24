import { fetchJson } from '../../core/data/fetch-json';
import { InvalidDataError } from '../../core/data/errors';
import { DATA_CACHE } from '../../core/storage/cache-names';
import { verifyBlob } from '../../core/storage/artifacts';
import { verificationReceipt } from '../../core/storage/verification-receipt';
import { DOWNLOAD_MEMORY_LIMIT, storedFileBlob } from '../../core/storage/download-file';
import { createPluginStorage } from '../../core/storage/plugin-storage';
import { transferFile } from '../../core/storage/file-transfer';
import { isObstructionManifest, ObstructionIndex, OBSTRUCTION_INDEX_VERSION } from './data';
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

export async function loadObstructions(manifestUrl: string): Promise<{ index: ObstructionIndex; sourceDate?: string }> {
  const manifest = await fetchJson(manifestUrl, isObstructionManifest, 'FAA obstructions', { revalidate: true });
  const url = new URL(manifest.dataset.path, manifestUrl).href;
  const snapshotUrl = new URL(url);
  snapshotUrl.searchParams.set('zlayer-obstruction-index', [OBSTRUCTION_INDEX_VERSION,
    manifest.dataset.bytes, manifest.dataset.uncompressedBytes, manifest.dataset.count].join('-'));
  const snapshotKey = snapshotUrl.href;
  const sourceIdentity = [manifest.dataset.sha256, manifest.dataset.bytes, manifest.dataset.uncompressedBytes, manifest.dataset.count].join(':');
  const signal = new AbortController().signal;
  let fresh: { bytes: ArrayBuffer; index: ObstructionIndex } | undefined;
  const snapshot = (index: ObstructionIndex) => {
    if (index.byteLength + 8 > DOWNLOAD_MEMORY_LIMIT) return { value: index };
    fresh = { bytes: index.snapshot(), index };
    return fresh.bytes;
  };
  const index = await indices.derive({ url, identity: `${OBSTRUCTION_INDEX_VERSION}:${sourceIdentity}`,
    label: 'Obstruction index', signal,
    legacy: [{ cache: DATA_CACHE, key: snapshotKey, async convert(response) {
      const receipt = verificationReceipt(response.headers);
      if (response.status !== 200 || response.headers.get(SOURCE_HEADER) !== sourceIdentity || !receipt || receipt.byteLength > DOWNLOAD_MEMORY_LIMIT) {
        throw new InvalidDataError('Invalid obstruction index cache');
      }
      const blob = await storedFileBlob(response);
      await verifyBlob(blob, receipt, 'Obstruction index');
      return blob.arrayBuffer();
    } }, { cache: DATA_CACHE, key: url, async convert(response) {
      if (response.status !== 200) throw new InvalidDataError('Obstruction cache response is incomplete');
      // Always authenticate legacy source bytes before migrating them.
      return snapshot(await parseObstructions(await storedFileBlob(response), manifest));
    } }],
    create: signal => transferFile({ url, label: 'Obstructions', byteLength: manifest.dataset.bytes, signal },
      async ({ blob }) => snapshot(await parseObstructions(blob, manifest))),
    async validate(bytes) {
      return fresh?.bytes === bytes ? fresh.index : ObstructionIndex.restore(bytes, manifest.dataset.count);
    },
  });
  return { index, ...(manifest.source.lastModified ? { sourceDate: manifest.source.lastModified } : {}) };
}
