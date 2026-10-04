import { fetchJson } from '../../core/data/fetch-json';
import { parseGzipJson } from '../../core/data/gzip-json';
import { verifyBlob } from '../../core/storage/artifacts';
import { createPluginStorage } from '../../core/storage/plugin-storage';
import { decodeLandingAreas, type LandingShard, type LandingManifest } from './landing-data';
import { createTaskLimiter } from '../../core/data/task-limiter';
import { prepareLandingHeat, encodeLandingHeat, decodeLandingHeat } from './landing-heat';

import { isLandingFeed } from './landing-feed';
import { packagedLandingManifest } from './landing-inventory';
import { loadGlideDetail, loadGlideOverview } from './landing-packages';
import type { LandingSources } from './landing-sources';

const acquire = createTaskLimiter(2);
const shading = createPluginStorage('glide').files('landing-shading', {
  maxEntries: 128, maxBytes: 16 * 1024 * 1024, maxFileBytes: 512 * 512 + 48, maxUnusedMs: 30 * 86400000,
});

const files = createPluginStorage('glide').files('landing-areas', {
  maxEntries: 64, maxBytes: 64 * 1024 * 1024, maxFileBytes: 2 * 1024 * 1024, maxUnusedMs: 30 * 86400000,
});
export async function loadLandingManifest(url: string, signal: AbortSignal, sources?: LandingSources): Promise<LandingManifest> {
  let legacy: LandingManifest | undefined;
  if (!sources || sources.legacyScope) {
    try {
      const value = await fetchJson(url, isLandingFeed, 'Landing areas', { policy: 'network-first', signal });
      if ('product' in value) {
        const scope = sources?.legacyScope ?? { exclude: [] };
        sources = { packages: [...(sources?.packages ?? []), { source: { ...value, root: new URL('.', url).href.replace(/\/$/, '') }, scope }] };
      } else legacy = value;
    } catch (error) { signal.throwIfAborted(); if (!sources?.packages.length) throw error; }
  }
  if (!sources?.packages.length && legacy) return legacy;
  return packagedLandingManifest(sources!, legacy, signal);
}
export function loadLandingShard(manifestUrl: string, shard: LandingShard, signal: AbortSignal, schemaVersion: 4 | 5 | 6 | 7 | 8 | 9 = 4) {
  if (shard.package) return acquire(signal, () => loadGlideDetail(shard, signal));
  schemaVersion = shard.recordSchema ?? schemaVersion;
  return files.load({ url: new URL(shard.file, manifestUrl).href,
    identity: JSON.stringify([4, schemaVersion, shard.sha256, shard.bytes, shard.rawBytes, shard.count, shard.tiers, shard.bounds]),
    byteLength: shard.bytes, label: 'Landing areas', signal, run: acquire,
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

/** Published numeric tiles, or cached client summaries for legacy feeds. */
export function loadLandingHeat(manifestUrl: string, shard: LandingShard, signal: AbortSignal, schemaVersion: 4 | 5 | 6 | 7 | 8 | 9) {
  if (shard.package) return acquire(signal, () => loadGlideOverview(shard, signal));
  schemaVersion = shard.recordSchema ?? schemaVersion;
  return shading.derive({ url: new URL(shard.file, manifestUrl).href,
    identity: JSON.stringify([1, schemaVersion, shard]), label: 'Landing shading', signal,
    async create(signal) {
      const areas = await loadLandingShard(manifestUrl, shard, signal, schemaVersion);
      signal.throwIfAborted();
      return encodeLandingHeat(prepareLandingHeat(areas, shard));
    },
    async validate(bytes) { return decodeLandingHeat(bytes); },
  });
}
