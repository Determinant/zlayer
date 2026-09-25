import { isRadarCatalog, isRadarContours, RADAR_MAX_BYTES, type RadarCatalog, type RadarFile, type RadarContours } from '@zlayer/contracts';
import { requestJson } from '../../../core/data/fetch-json';
import { pluginStorage } from '../storage';
import { preparedJson } from '../prepared-file';
import { createTaskLimiter } from '../../../core/data/task-limiter';

export type RadarState = { snapshot?: RadarCatalog; loading: boolean; error?: string };
const files = pluginStorage.files('radar', { maxEntries: 24, maxBytes: 64 * 1024 * 1024, maxFileBytes: RADAR_MAX_BYTES, maxUnusedMs: 3600_000 });
const readContours = createTaskLimiter(2);
export class RadarClient {
  constructor(readonly baseUrl: string) {}
  restore(): RadarState {
    try {
      const saved = JSON.parse(pluginStorage.slot('radar').read() ?? 'null');
      if (saved?.endpoint === this.baseUrl && isRadarCatalog(saved.snapshot)) return { snapshot: saved.snapshot, loading: false };
    } catch { /* Optional last catalog; every scan still requires its saved file. */ }
    return { loading: false };
  }
  async refresh(signal: AbortSignal): Promise<RadarCatalog> {
    const snapshot = await requestJson(new URL('latest.json', this.baseUrl).href, isRadarCatalog, 'NOAA radar', { signal, maxBytes: 1024 * 1024 });
    if (snapshot.checkedAt > Date.now() + 60_000) throw new Error('Future radar source check');
    signal.throwIfAborted();
    try { pluginStorage.slot('radar').write(JSON.stringify({ endpoint: this.baseUrl, snapshot })); }
    catch { /* Optional catalog persistence cannot discard a valid live response. */ }
    return snapshot;
  }
  async load(file: RadarFile, signal: AbortSignal, onReady?: (value: RadarContours) => void): Promise<RadarContours> {
    return files.load({ url: new URL(file.path, this.baseUrl).href, identity: file.sha256, byteLength: file.byteLength,
      signal, label: 'Radar contours', cacheOnly: !navigator.onLine, run: readContours, ...(onReady ? { onReady } : {}),
      validate: async bytes => {
        const value = await preparedJson(bytes, file.sha256);
        if (!isRadarContours(value) || value.site !== file.site || value.observedAt !== file.observedAt || value.source !== file.source || value.sourceHash !== file.sourceHash ||
          JSON.stringify(value.bounds) !== JSON.stringify(file.bounds)) throw new Error('Radar scan identity mismatch');
        return value;
      },
    });
  }
}
