import { fetchJson } from '../../core/data/fetch-json';
import { parseGzipJson } from '../../core/data/gzip-json';
import { verifyBlob } from '../../core/storage/artifacts';
import { createPluginStorage } from '../../core/storage/plugin-storage';
import { decodeLandingAreas, isLandingManifest, type LandingShard } from './landing-data';

const files = createPluginStorage('glide').files('landing-areas', {
  maxEntries: 64, maxBytes: 64 * 1024 * 1024, maxFileBytes: 2 * 1024 * 1024, maxUnusedMs: 30 * 86400000,
});
export const loadLandingManifest = (url: string, signal: AbortSignal) =>
  fetchJson(url, isLandingManifest, 'Landing areas', { policy: 'network-first', signal });
export function loadLandingShard(manifestUrl: string, shard: LandingShard, signal: AbortSignal, schemaVersion: 4 | 5 = 4) {
  return files.load({ url: new URL(shard.file, manifestUrl).href,
    identity: JSON.stringify([4, schemaVersion, shard.sha256, shard.bytes, shard.rawBytes, shard.count, shard.tiers, shard.bounds]),
    byteLength: shard.bytes, label: 'Landing areas', signal,
    async validate(bytes, signal) {
      const blob = new Blob([bytes]);
      await verifyBlob(blob, { byteLength: shard.bytes, sha256: shard.sha256 }, 'Landing areas');
      signal.throwIfAborted();
      const value = await parseGzipJson(new Response(blob), { bytes: shard.bytes, uncompressedBytes: shard.rawBytes });
      signal.throwIfAborted();
      return decodeLandingAreas(value, shard, schemaVersion);
    },
  });
}
