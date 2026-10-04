import { isRecord, isGlideBounds, type Bounds, type GlideKind } from '@zlayer/contracts';
import { withAbort } from '../../core/data/abort';
import { jsonIdentity } from '../../core/data/json-identity';
import { InvalidDataError } from '../../core/data/errors';
import { landingBoundsOverlap, type LandingManifest, type LandingShard } from './landing-data';
import { readGlideIndex, readGlideJson } from './landing-packages';
import { readGlideRegion } from './landing-regions';
import { scopeIntersects } from './landing-scope';
import type { LandingSources, LandingScope } from './landing-sources';

export async function packagedLandingManifest(sources: LandingSources, legacy: LandingManifest | undefined, signal: AbortSignal): Promise<LandingManifest> {
  const first = sources.packages[0]?.source;
  if (!first && !legacy) throw new InvalidDataError('No supported glide source');
  const coverage = legacy?.coverage.map(region => ({ ...region, ...(sources.legacyScope ? { scope: sources.legacyScope } : {}) })) ?? [];
  const unavailableScopes: LandingScope[] = sources.legacyScope && !legacy ? [sources.legacyScope] : [];
  for (const { source, scope } of sources.packages) {
    try {
      const value = await readGlideJson(source.root, source.coverage, signal);
      if (!isRecord(value) || value.schemaVersion !== 1 || value.meaning !== 'source-region-coverage-not-per-pixel-assessment'
        || !Array.isArray(value.regions) || value.regions.length > 10000 || !value.regions.every(r => isRecord(r)
          && typeof r.id === 'string' && isGlideBounds(r.bounds) && (r.shrubEvidenceMissing === undefined || typeof r.shrubEvidenceMissing === 'boolean'))) {
        throw new InvalidDataError('Invalid glide coverage');
      }
      coverage.push(...(value.regions as LandingManifest['coverage']).map(region => ({ ...region, scope })));
    } catch { signal.throwIfAborted(); unavailableScopes.push(scope); }
  }
  return { schemaVersion: first?.source.schemaVersion ?? legacy!.schemaVersion,
    builderVersion: first?.source.builderVersion ?? legacy!.builderVersion,
    generatedAt: first?.generatedAt ?? legacy!.generatedAt, inputSha256: jsonIdentity(sources),
    status: 'experimental-candidates', geometryMeaning: 'generalized-candidate-area', coverage,
    shards: legacy?.shards.map(shard => ({ ...shard, recordSchema: legacy.schemaVersion, scope: sources.legacyScope })) ?? [],
    packages: sources.packages, unavailableScopes };
}

/** Only intersecting metadata is read; polygon ownership tiles never clip selection bounds. */
type ShardInventory = { shards: LandingShard[]; limited: boolean; failed?: boolean };
const inventories = new WeakMap<LandingManifest, Map<GlideKind, { key: string; pending: Promise<ShardInventory> }>>();
export function landingShards(manifest: LandingManifest, kind: GlideKind, bounds: Bounds, zoom: number, signal: AbortSignal): Promise<ShardInventory> {
  signal.throwIfAborted();
  const key = JSON.stringify([bounds, zoom]);
  let cache = inventories.get(manifest);
  if (!cache) { cache = new Map(); inventories.set(manifest, cache); }
  const cached = cache.get(kind);
  if (cached?.key === key) return withAbort(cached.pending, signal);
  const pending = discoverLandingShards(manifest, kind, bounds, zoom, signal), entry = { key, pending };
  cache.set(kind, entry);
  void pending.catch(() => { if (cache.get(kind) === entry) cache.delete(kind); });
  return withAbort(pending, signal);
}
async function discoverLandingShards(manifest: LandingManifest, kind: GlideKind, bounds: Bounds, zoom: number,
  signal: AbortSignal): Promise<ShardInventory> {
  const shards = new Map(manifest.shards.map(shard => [shard.file, shard])), pages = [];
  let failed = false;
  for (const { source, scope, regions } of manifest.packages ?? []) {
    if (!scopeIntersects(bounds, scope)) continue;
    const scopeKey = jsonIdentity(scope);
    let indexes = source.indexes;
    if (regions) {
      const local = new Map<string, typeof source.indexes[number]>();
      for (const region of regions) if (region.bounds.some(b => landingBoundsOverlap(b, bounds))) {
        try { for (const page of (await readGlideRegion(source, region, signal)).indexes) local.set(page.file, page); }
        catch { signal.throwIfAborted(); failed = true; }
      }
      indexes = [...local.values()];
    }
    for (const page of indexes) if (page.kind === kind && landingBoundsOverlap(page.bounds, bounds)) {
      pages.push({ source, scope, scopeKey, page });
    }
  }
  // Metadata is bounded independently of resident polygon/detail budgets.
  const MAX_PAGES = 32;
  for (const { source, scope, scopeKey, page } of pages.slice(0, MAX_PAGES)) {
    let index;
    try {
      index = await readGlideIndex(source.root, page, signal);
      if (index.archives.some(a => a.blocks.some(b => b.kind === 'detail' ? b.schema !== source.source.schemaVersion
        : b.tile[0] > source.overview.maxZoom))) throw new InvalidDataError('Glide block schema/zoom disagrees with source');
    } catch { signal.throwIfAborted(); failed = true; continue; }
    for (const archive of index.archives) if (landingBoundsOverlap(archive.bounds, bounds)) {
      for (const block of archive.blocks) {
        if (kind === 'overview' && block.tile[0] !== Math.min(zoom, source.overview.maxZoom)) continue;
        if (!landingBoundsOverlap(block.bounds, bounds) || !scopeIntersects(block.bounds, scope)) continue;
        const file = `${source.root}/${archive.file}#${block.key}:${scopeKey}`;
        shards.set(file, { id: file, file, sha256: block.sha256, bytes: block.bytes, rawBytes: block.rawBytes,
          bounds: block.bounds, count: block.records, tiers: block.tiers, scope,
          package: { root: source.root, archive, block } });
      }
    }
  }
  return { shards: [...shards.values()], limited: pages.length > MAX_PAGES, failed };
}
