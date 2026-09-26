import { isRecord, isSha256, isSurfaceSnapshot, isSurfaceCatalog, isSurfaceArtifact, surfacePositions, SURFACE_MAX_BYTES, SURFACE_CATALOG_MAX_BYTES, type SurfaceProduct, type SurfaceSnapshot, type SurfaceCatalog, type SurfaceArtifact, type SurfaceFrame } from '@zlayer/contracts';
import { requestJson } from '../../../core/data/fetch-json';
import { pluginStorage } from '../storage';
import { preparedJson } from '../prepared-file';

export type SurfaceState = { snapshot?: SurfaceSnapshot; checkedAt?: number; error?: string; loading: boolean };
const legacyFiles = Object.fromEntries((['analysis', 'forecast'] as const).map(product => [product, pluginStorage.files(`progs-${product}`, {
  maxEntries: 2, maxBytes: 2 * SURFACE_MAX_BYTES, maxFileBytes: SURFACE_MAX_BYTES, maxUnusedMs: 48 * 3600_000,
})])) as Record<SurfaceProduct, ReturnType<typeof pluginStorage.files>>;

const charts = pluginStorage.files('progs-charts', {
  maxEntries: 64, maxBytes: 4 * SURFACE_MAX_BYTES, maxFileBytes: SURFACE_MAX_BYTES, maxUnusedMs: 48 * 3600_000,
});

export class ProgsClient {
  private known = new Map<SurfaceProduct, Map<string, SurfaceArtifact>>();
  constructor(readonly baseUrl: string) {}
  private artifact(product: SurfaceProduct, sourceHash: string, checkedAt: number, signal: AbortSignal) {
    return { url: new URL(`${product}.json`, this.baseUrl).href, identity: JSON.stringify([2, product, sourceHash, checkedAt]),
      retention: { group: 'progs' },
      label: 'WPC surface weather', signal,
      validate: async (bytes: ArrayBuffer): Promise<SurfaceSnapshot> => {
        const value: unknown = JSON.parse(new TextDecoder().decode(bytes));
        if (!isSurfaceSnapshot(value) || value.product !== product || value.sourceHash !== sourceHash || value.checkedAt !== checkedAt) {
          throw new Error('Invalid saved surface chart identity');
        }
        return value;
      },
    };
  }
  async restore(product: SurfaceProduct, signal: AbortSignal): Promise<SurfaceState> {
    try {
      signal.throwIfAborted();
      const saved: unknown = JSON.parse(pluginStorage.slot(`progs-${product}`).read() ?? 'null');
      if (isRecord(saved) && saved.endpoint === this.baseUrl) {
        if (saved.version === 3 && isSurfaceCatalog(saved.catalog) && saved.catalog.product === product) {
          return { snapshot: await this.loadCatalog(saved.catalog, signal, true), loading: false };
        }
        // Keep existing inline snapshots usable offline until a successful refresh.
        if (isSurfaceSnapshot(saved.snapshot) && saved.snapshot.product === product) return { snapshot: saved.snapshot, loading: false };
        if (saved.version === 1 && isSha256(saved.sourceHash) && typeof saved.checkedAt === 'number' && Number.isSafeInteger(saved.checkedAt) && saved.checkedAt > 0) {
          const snapshot = await legacyFiles[product].derive({ ...this.artifact(product, saved.sourceHash, saved.checkedAt, signal),
            cacheOnly: true, create: async () => { throw new Error('Offline surface chart is not saved'); } });
          signal.throwIfAborted();
          return { snapshot, loading: false };
        }
      }
    } catch { signal.throwIfAborted(); /* Optional offline snapshot. */ }
    return { loading: false };
  }
  private async loadCatalog(catalog: SurfaceCatalog, signal: AbortSignal, cacheOnly: boolean,
    onReady?: (snapshot: SurfaceSnapshot) => void): Promise<SurfaceSnapshot> {
    const previous = this.known.get(catalog.product), artifacts = new Map<string, SurfaceArtifact>();
    const frames = new Map<string, SurfaceFrame>();
    let snapshot: SurfaceSnapshot | undefined;
    const validateIdentity = (file: SurfaceCatalog['frames'][number], artifact: SurfaceArtifact) => {
      const frame = artifact.frame;
      if (artifact.product !== catalog.product || frame.source !== file.source || frame.sourceHash !== file.sourceHash ||
        frame.validTime !== file.validTime || frame.referenceTime !== file.referenceTime || frame.checkedAt > file.checkedAt ||
        frame.sourceDocument.length !== file.documentLength || surfacePositions(frame) !== file.positions) throw new Error('Surface chart identity mismatch');
    };
    const ready = (file: SurfaceCatalog['frames'][number], artifact: SurfaceArtifact) => {
      signal.throwIfAborted(); validateIdentity(file, artifact);
      const frame = artifact.frame;
      artifacts.set(file.sha256, artifact);
      frames.set(file.sha256, { ...frame, checkedAt: file.checkedAt, artifactHash: file.sha256 });
      if (!snapshot && frames.size === catalog.frames.length) {
        snapshot = { ...catalog, schemaVersion: 2, frames: catalog.frames.map(f => frames.get(f.sha256)!) };
        // Artifact guards validated geometry once; the catalog bounds the whole family.
        onReady?.(snapshot);
      }
    };
    const results = await Promise.all(catalog.frames.map(async file => {
      const cached = previous?.get(file.sha256);
      if (cached) {
        ready(file, cached);
        // Other weather caches can evict a chart while its decoded data remains
        // live. Check the file again before keeping the offline catalog pointer.
        if (await charts.has({ url: new URL(file.path, this.baseUrl).href, identity: file.sha256, byteLength: file.byteLength, signal,
          retention: { group: 'progs' } })) return true;
      }
      const result = await charts.loadResult({ url: new URL(file.path, this.baseUrl).href, identity: file.sha256,
        retention: { group: 'progs' },
        byteLength: file.byteLength, signal, cacheOnly, label: 'WPC surface chart',
        validate: async bytes => {
          const value = await preparedJson(bytes, file.sha256);
          if (!isSurfaceArtifact(value)) throw new Error('Invalid surface chart artifact');
          // Validate the complete catalog/file identity before saving or publishing.
          validateIdentity(file, value);
          return value;
        },
        onReady: value => ready(file, value),
      }).catch(error => {
        signal.throwIfAborted();
        // Re-saving an evicted chart is optional when its authenticated data is
        // still live. A missing chart needed by this family remains an error.
        if (cached) return { value: cached, saved: false };
        throw error;
      });
      return result.saved;
    }));
    signal.throwIfAborted();
    if (!snapshot) throw new Error('Incomplete surface chart family');
    const saved = results.every(Boolean);
    if (!cacheOnly || !this.known.has(catalog.product)) this.known.set(catalog.product, artifacts);
    if (!cacheOnly && saved) {
      try { pluginStorage.slot(`progs-${catalog.product}`).write(JSON.stringify({ version: 3, endpoint: this.baseUrl, catalog })); }
      catch { /* Already usable charts do not depend on optional catalog storage. */ }
    }
    return snapshot;
  }
  async refresh(product: SurfaceProduct, signal: AbortSignal, now = Date.now(), onReady?: (snapshot: SurfaceSnapshot) => void): Promise<SurfaceSnapshot> {
    const catalog = await requestJson(new URL(`${product}.json`, this.baseUrl).href, isSurfaceCatalog, 'WPC surface weather', { signal, maxBytes: SURFACE_CATALOG_MAX_BYTES });
    if (catalog.product !== product || catalog.checkedAt > now + 60_000 || catalog.frames.some(file => file.checkedAt > now + 60_000)) {
      throw new Error('Invalid surface product or future source check');
    }
    return this.loadCatalog(catalog, signal, false, onReady);
  }
}
