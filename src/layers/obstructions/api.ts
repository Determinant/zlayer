import { fetchJson } from '../../core/data/fetch-json';
import { InvalidDataError } from '../../core/data/errors';
import { DATA_CACHE, VERIFIED_SHA256_HEADER } from '../../core/storage/cache-names';
import { noteCacheAccess } from '../../core/storage/cache-access';
import { readArtifact, verifyBlob } from '../../core/storage/artifacts';
import { verificationReceipt } from '../../core/storage/verification-receipt';
import { discardResponseBody } from '../../core/storage/response';
import { isObstructionManifest, ObstructionIndex } from './data';
import { decompressObstructions, readObstructionFeatures } from './stream';
import type { ObstructionManifest } from './types';

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
  const cache = await globalThis.caches?.open(DATA_CACHE).catch(() => undefined);
  await noteCacheAccess(DATA_CACHE, url);
  const result = (index: ObstructionIndex) => ({ index,
    ...(manifest.source.lastModified ? { sourceDate: manifest.source.lastModified } : {}) });
  const saved = await readArtifact(cache, url, async response => {
    if (response.status !== 200) throw new InvalidDataError('Obstruction cache response is incomplete');
    const blob = await response.blob();
    const verified = blob.size === manifest.dataset.bytes && verificationReceipt(response.headers,
      { byteLength: blob.size, sha256: manifest.dataset.sha256 });
    return { blob, verified, index: await (verified ? indexObstructions(blob, manifest) : parseObstructions(blob, manifest)) };
  });
  const persist = (blob: Blob) => cache?.put(url, new Response(blob, { headers: {
    'content-type': 'application/gzip', 'content-length': String(blob.size),
    [VERIFIED_SHA256_HEADER]: manifest.dataset.sha256,
  } })).catch(() => {});
  if (saved.state === 'ready') {
    if (!saved.value.verified) await persist(saved.value.blob);
    return result(saved.value.index);
  }
  if (saved.state === 'invalid') await cache?.delete(url).catch(() => {});
  const response = await fetch(url, { cache: 'no-store', signal: AbortSignal.timeout(120_000) });
  if (!response.ok || !response.body) {
    discardResponseBody(response);
    throw new Error(`FAA obstructions unavailable (${response.status})`);
  }
  let received = 0;
  const limited = response.body.pipeThrough(new TransformStream<Uint8Array, Uint8Array>({ transform(chunk, controller) {
    received += chunk.byteLength;
    if (received > manifest.dataset.bytes) throw new InvalidDataError('Obstructions exceed the published size');
    controller.enqueue(chunk);
  } }));
  const blob = await new Response(limited).blob();
  const index = await parseObstructions(blob, manifest);
  await persist(blob);
  return result(index);
}
