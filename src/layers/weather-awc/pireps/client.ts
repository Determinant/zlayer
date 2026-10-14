import { isRecord, isSha256, isPirepPayload, PIREP_MAX_AGE_MS, PIREP_MAX_BYTES, type PirepPayload, type PirepSnapshot } from '@zlayer/contracts';
import { requestJson } from '../../../core/data/request-json';
import { pluginStorage } from '../storage';
import { preparedJson } from '../prepared-file';
import type { PirepLocations } from './locations';
import { decodePirepSource } from './decode';

export type PirepState = { snapshot?: PirepSnapshot; loading: boolean; error?: string; restored?: boolean; resolved?: PirepLocations | undefined };
const files = pluginStorage.files('pireps', {
  maxEntries: 2, maxBytes: 2 * PIREP_MAX_BYTES, maxFileBytes: PIREP_MAX_BYTES, maxUnusedMs: PIREP_MAX_AGE_MS,
});
export class PirepClient {
  private latest = 0;
  private live = false;
  constructor(readonly url: string) {}
  private artifact(sha256: string, checkedAt: number, signal: AbortSignal) {
    return { url: this.url, identity: sha256, retention: { group: 'pireps' }, label: 'PIREPs', signal,
      validate: async (bytes: ArrayBuffer): Promise<PirepPayload> => {
        const value = await preparedJson(bytes, sha256);
        if (!isPirepPayload(value) || value.checkedAt !== checkedAt) throw new Error('Invalid saved PIREP identity');
        return value;
      },
    };
  }
  async restore(signal: AbortSignal): Promise<PirepState> {
    try {
      signal.throwIfAborted();
      const saved: unknown = JSON.parse(pluginStorage.slot('pireps').read() ?? 'null');
      if (isRecord(saved) && saved.endpoint === this.url) {
        let source: PirepPayload | undefined;
        if (saved.version === 1 && isSha256(saved.sha256) && typeof saved.checkedAt === 'number' &&
          Number.isSafeInteger(saved.checkedAt) && saved.checkedAt > 0 && saved.checkedAt <= Date.now() + 30_000) {
          source = await files.derive({ ...this.artifact(saved.sha256, saved.checkedAt, signal), cacheOnly: true,
            create: async () => { throw new Error('PIREPs are not saved'); } });
        } else if (isPirepPayload(saved.snapshot)) source = saved.snapshot; // Previous inline format.
        signal.throwIfAborted();
        // A delayed disk read cannot displace a live response or its source clock.
        if (!this.live && source && source.checkedAt <= Date.now() + 30_000) {
          const snapshot = decodePirepSource(source);
          this.latest = source.checkedAt;
          return { snapshot, loading: false, restored: true };
        }
      }
    } catch { signal.throwIfAborted(); /* Optional saved snapshot. */ }
    return { loading: false };
  }
  async refresh(signal: AbortSignal, onReady?: (snapshot: PirepSnapshot) => void) {
    const source = await requestJson(this.url, isPirepPayload, 'PIREPs', { signal, maxBytes: PIREP_MAX_BYTES });
    const now = Date.now();
    if (source.checkedAt > now + 30_000) throw new Error('PIREPs have a future source timestamp');
    // A clock correction can invalidate a previously accepted source timestamp.
    if (this.latest <= now + 30_000 && source.checkedAt < this.latest) throw new Error('PIREPs returned an older source publication');
    signal.throwIfAborted();
    const snapshot = decodePirepSource(source);
    this.latest = snapshot.checkedAt; this.live = true;
    onReady?.(snapshot);
    try {
      const bytes = new TextEncoder().encode(JSON.stringify(source)).buffer;
      const sha256 = [...new Uint8Array(await crypto.subtle.digest('SHA-256', bytes))].map(n => n.toString(16).padStart(2, '0')).join('');
      const result = await files.deriveResult({ ...this.artifact(sha256, snapshot.checkedAt, signal), create: async () => bytes });
      signal.throwIfAborted();
      if (result.saved) pluginStorage.slot('pireps').write(JSON.stringify({ version: 1, endpoint: this.url, checkedAt: snapshot.checkedAt, sha256 }));
    } catch { signal.throwIfAborted(); /* Storage failure cannot discard live reports. */ }
    return snapshot;
  }
}
