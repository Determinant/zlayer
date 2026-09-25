import { isRadarMotionCatalog, isRadarMotionSnapshot, RADAR_MOTION_MAX_BYTES,
  type RadarMotionCatalog, type RadarMotionFile, type RadarMotionSnapshot } from '@zlayer/contracts';
import { requestJson } from '../../../core/data/fetch-json';
import { pluginStorage } from '../storage';
import { preparedJson } from '../prepared-file';

export type RadarMotionState = { snapshot?: RadarMotionCatalog; loading: boolean; error?: string };
const files = pluginStorage.files('radar-motion', { maxEntries: 24, maxBytes: 16 * 1024 * 1024, maxFileBytes: RADAR_MOTION_MAX_BYTES, maxUnusedMs: 3600_000 });
export class RadarMotionClient {
  constructor(readonly baseUrl: string) {}
  restore(): RadarMotionState {
    try {
      const saved = JSON.parse(pluginStorage.slot('radar-motion').read() ?? 'null');
      if (saved?.endpoint === this.baseUrl && isRadarMotionCatalog(saved.snapshot) && saved.snapshot.checkedAt <= Date.now() + 60_000) return { snapshot: saved.snapshot, loading: false };
    } catch { /* Optional catalog. Artifact integrity is checked independently. */ }
    return { loading: false };
  }
  async refresh(signal: AbortSignal): Promise<RadarMotionCatalog> {
    const snapshot = await requestJson(new URL('motion/latest.json', this.baseUrl).href, isRadarMotionCatalog, 'NOAA storm motion', { signal, maxBytes: 32 * 1024 });
    if (snapshot.checkedAt > Date.now() + 60_000) throw new Error('Future storm motion source check');
    signal.throwIfAborted();
    try { pluginStorage.slot('radar-motion').write(JSON.stringify({ endpoint: this.baseUrl, snapshot })); }
    catch { /* Optional catalog persistence cannot discard a valid live response. */ }
    return snapshot;
  }
  load(file: RadarMotionFile, signal: AbortSignal, onReady?: (value: RadarMotionSnapshot) => void): Promise<RadarMotionSnapshot> {
    return files.load({ url: new URL(file.path, this.baseUrl).href, identity: file.sha256, byteLength: file.byteLength,
      signal, label: 'Storm motion', cacheOnly: !navigator.onLine, ...(onReady ? { onReady } : {}),
      validate: async bytes => {
        const value = await preparedJson(bytes, file.sha256);
        if (!isRadarMotionSnapshot(value) || value.scans.some(s => s.observedAt > file.availableAt + 60_000)) throw new Error('Storm motion identity mismatch');
        return value;
      },
    });
  }
}
