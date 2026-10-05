import { isRecord, isGlideBounds, type Bounds, type GlideKind, type GlideIndex, type GlidePage, type GlideSource } from '@zlayer/contracts';
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

type ShardInventory = { shards: LandingShard[]; limited: boolean; failed?: boolean };
type ScopedPages = { source: GlideSource; scope: LandingScope; scopeKey: string; indexes: GlidePage[] };
type ScopedPage = Omit<ScopedPages, 'indexes'> & { page: GlidePage };
type SourceInventory = { sources: ScopedPages[]; failed: boolean };
type PageInventory = { pages: (ScopedPage & { index: GlideIndex })[]; limited: boolean; failed: boolean };
type Memo<T> = { key: string; pending: Promise<T>; signal?: AbortSignal };
type InventoryCache = {
  regions: Map<string, Memo<SourceInventory>>;
  pages: Map<string, Memo<PageInventory>>;
  queries: Map<GlideKind, { metadata: PageInventory; key: string; value: ShardInventory }>;
};
const inventories = new WeakMap<LandingManifest, InventoryCache>();
const MAX_PAGES = 32;

/** Live browsing reuse is not evidence of a saved offline dependency closure.
 * Explicit refresh retries failed metadata; a new manifest owns a new cache. */
export function invalidateLandingInventory(manifest: LandingManifest) { inventories.delete(manifest); }
function memo<T>(cache: Map<string, Memo<T>>, slot: string, key: string, load: () => Promise<T>, signal: AbortSignal): Promise<T> {
  const cached = cache.get(slot);
  if (cached?.key === key && !cached.signal?.aborted) return withAbort(cached.pending, signal);
  const entry: Memo<T> = { key, pending: load(), signal };
  cache.set(slot, entry);
  // A canceled owner cannot supply a later query's in-flight read. Completed
  // metadata survives cancellation of the request that originally acquired it.
  void entry.pending.then(() => { delete entry.signal; }, () => { if (cache.get(slot) === entry) cache.delete(slot); });
  return withAbort(entry.pending, signal);
}

/** Retain one regional selection and one set of index pages per kind. Metadata
 * identities, rather than exact camera coordinates or overview zoom, own reads. */
async function sourcePages(manifest: LandingManifest, bounds: Bounds, cache: InventoryCache, signal: AbortSignal) {
  const selected = (manifest.packages ?? []).flatMap((packageSource, slot) => {
    if (!scopeIntersects(bounds, packageSource.scope)) return [];
    return [{ ...packageSource, slot, regions: packageSource.regions?.filter(region =>
      region.bounds.some(b => landingBoundsOverlap(b, bounds))) }];
  });
  const key = JSON.stringify(selected.map(({ slot, regions }) => [slot, regions?.map(region => region.file)]));
  return memo(cache.regions, 'selection', key, async () => {
    const sources: ScopedPages[] = [];
    let failed = false;
    for (const { source, scope, regions } of selected) {
      let indexes = source.indexes;
      if (regions) {
        const local = new Map<string, GlidePage>();
        for (const region of regions) {
          try { for (const page of (await readGlideRegion(source, region, signal)).indexes) local.set(page.file, page); }
          catch { signal.throwIfAborted(); failed = true; }
        }
        indexes = [...local.values()];
      }
      sources.push({ source, scope, scopeKey: jsonIdentity(scope), indexes });
    }
    return { sources, failed };
  }, signal);
}
async function readPages(pages: ScopedPage[], limited: boolean, failed: boolean, signal: AbortSignal): Promise<PageInventory> {
  const loaded: PageInventory['pages'] = [];
  for (const entry of pages) {
    try {
      const { source, page } = entry, index = await readGlideIndex(source.root, page, signal);
      if (index.archives.some(a => a.blocks.some(b => b.kind === 'detail' ? b.schema !== source.source.schemaVersion
        : b.tile[0] > source.overview.maxZoom))) throw new InvalidDataError('Glide block schema/zoom disagrees with source');
      loaded.push({ ...entry, index });
    } catch { signal.throwIfAborted(); failed = true; }
  }
  return { pages: loaded, limited, failed };
}

/** Only intersecting pages are read. Overview inventories retain every block at
 * the requested level in those pages; the overview owner selects exact demand.
 * Detail still selects by polygon bounds, never by ownership tile coordinates. */
export async function landingShards(manifest: LandingManifest, kind: GlideKind, bounds: Bounds, zoom: number, signal: AbortSignal): Promise<ShardInventory> {
  signal.throwIfAborted();
  let cache = inventories.get(manifest);
  if (!cache) { cache = { regions: new Map(), pages: new Map(), queries: new Map() }; inventories.set(manifest, cache); }
  const available = await sourcePages(manifest, bounds, cache, signal);
  const pages = available.sources.flatMap(({ indexes, ...source }) => indexes.filter(page =>
    page.kind === kind && landingBoundsOverlap(page.bounds, bounds)).map(page => ({ ...source, page })));
  const limited = pages.length > MAX_PAGES, selected = pages.slice(0, MAX_PAGES);
  const pageKey = JSON.stringify([available.failed, limited, selected.map(({ source, scopeKey, page }) =>
    [source.root, source.inputSha256, source.source.schemaVersion, source.overview.maxZoom, scopeKey, page])]);
  const metadata = await memo(cache.pages, kind, pageKey, () => readPages(selected, limited, available.failed, signal), signal);
  const key = JSON.stringify(kind === 'overview' ? metadata.pages.map(({ source }) => Math.min(zoom, source.overview.maxZoom)) : bounds);
  const cached = cache.queries.get(kind);
  if (cached?.metadata === metadata && cached.key === key) return cached.value;
  const shards = new Map(manifest.shards.map(shard => [shard.file, shard]));
  for (const { source, scope, scopeKey, index } of metadata.pages) {
    for (const archive of index.archives) if (kind === 'overview' || landingBoundsOverlap(archive.bounds, bounds)) {
      for (const block of archive.blocks) {
        if (kind === 'overview' ? block.tile[0] !== Math.min(zoom, source.overview.maxZoom) : !landingBoundsOverlap(block.bounds, bounds)) continue;
        if (!scopeIntersects(block.bounds, scope)) continue;
        const file = `${source.root}/${archive.file}#${block.key}:${scopeKey}`;
        shards.set(file, { id: file, file, sha256: block.sha256, bytes: block.bytes, rawBytes: block.rawBytes,
          bounds: block.bounds, count: block.records, tiers: block.tiers, scope,
          package: { root: source.root, archive, block } });
      }
    }
  }
  const value = { shards: [...shards.values()], limited: metadata.limited, failed: metadata.failed };
  cache.queries.set(kind, { metadata, key, value });
  return value;
}
