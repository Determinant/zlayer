import { isRecord, isProgsCoverageCatalog, progsCoverageImageSize, PROGS_COVERAGE_CATALOG_MAX_BYTES, PROGS_COVERAGE_MAX_BYTES,
  type ProgsCoverageCatalog, type ProgsCoverageFile } from '@zlayer/contracts';
import { requestJson } from '../../../core/data/fetch-json';
import { pluginStorage } from '../storage';
import { authenticatePreparedFile } from '../prepared-file';

export type ProgsCoverageState = { snapshot?: ProgsCoverageCatalog; loading: boolean; error?: string; restored?: boolean };
const files = pluginStorage.files('progs-coverage', { maxEntries: 32, maxBytes: 8 * PROGS_COVERAGE_MAX_BYTES,
  maxFileBytes: PROGS_COVERAGE_MAX_BYTES, maxUnusedMs: 48 * 3600_000 });

export class ProgsCoverageClient {
  private known = new Map<string, ArrayBuffer>();
  constructor(readonly baseUrl: string) {}
  restore(): ProgsCoverageState {
    try {
      const saved: unknown = JSON.parse(pluginStorage.slot('progs-coverage').read() ?? 'null');
      if (isRecord(saved) && saved.endpoint === this.baseUrl && isProgsCoverageCatalog(saved.snapshot) && saved.snapshot.frames.every(frame => frame.checkedAt <= Date.now() + 60_000)) {
        return { snapshot: saved.snapshot, loading: false, restored: true };
      }
    } catch { /* Optional catalog; individual files are authenticated on load. */ }
    return { loading: false };
  }
  private request(file: ProgsCoverageFile, signal: AbortSignal) {
    return { url: new URL(file.path, this.baseUrl).href, identity: file.sha256, byteLength: file.byteLength,
      signal, label: 'NDFD weather coverage', cacheOnly: !navigator.onLine,
      validate: async (bytes: ArrayBuffer) => {
        await authenticatePreparedFile(bytes, file.sha256);
        progsCoverageImageSize(new Uint8Array(bytes));
        return bytes;
      } };
  }
  async refresh(signal: AbortSignal, onReady?: (snapshot: ProgsCoverageCatalog) => void): Promise<ProgsCoverageCatalog> {
    const snapshot = await requestJson(new URL('coverage.json', this.baseUrl).href, isProgsCoverageCatalog,
      'NDFD weather coverage', { signal, maxBytes: PROGS_COVERAGE_CATALOG_MAX_BYTES });
    if (snapshot.frames.some(frame => frame.checkedAt > Date.now() + 60_000)) throw new Error('Future NDFD source check');
    const known = new Map<string, ArrayBuffer>();
    const required = new Set(snapshot.frames.flatMap(frame => frame.file ? [frame.file.sha256] : []));
    let published = false;
    const ready = (hash: string, bytes: ArrayBuffer) => {
      signal.throwIfAborted(); known.set(hash, bytes);
      if (!published && known.size === required.size) { published = true; this.known = known; onReady?.(snapshot); }
    };
    const receipts = await Promise.all(snapshot.frames.map(async frame => {
      if (!frame.file) return true;
      const file = frame.file, cached = this.known.get(file.sha256), request = this.request(file, signal);
      if (cached) {
        ready(file.sha256, cached);
        if (await files.has(request)) return true;
      }
      try {
        const result = await files.loadResult({ ...request, onReady: bytes => ready(file.sha256, bytes) });
        return result.saved;
      } catch (error) {
        signal.throwIfAborted();
        if (cached) return false;
        throw error;
      }
    }));
    signal.throwIfAborted(); this.known = known;
    if (receipts.every(Boolean)) {
      try { pluginStorage.slot('progs-coverage').write(JSON.stringify({ endpoint: this.baseUrl, snapshot })); }
      catch { /* Live rendering does not depend on optional persistence. */ }
    }
    return snapshot;
  }
  async load(file: ProgsCoverageFile, signal: AbortSignal): Promise<ArrayBuffer> {
    signal.throwIfAborted();
    return this.known.get(file.sha256) ?? files.load(this.request(file, signal));
  }
}
