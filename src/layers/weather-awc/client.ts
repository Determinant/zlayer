import { isRecord, isAwcAdvisorySnapshot, type AwcAdvisoryProduct, type AwcAdvisorySnapshot } from '@zlayer/contracts';
import { requestJson } from '../../core/data/fetch-json';
import { noaaAdvisoryUrl } from './advisory-endpoints';
import { pluginStorage } from './storage';

export type AdvisoryState = { snapshot?: AwcAdvisorySnapshot; checkedAt?: number; error?: string; loading: boolean };
export const ADVISORY_REFRESH_MS = 5 * 60_000;

/** Whole successful snapshots replace their family, including an empty result.
 * Failures retain data without pretending a successful check occurred. */
export class AdvisoryClient {
  constructor(readonly baseUrl: string, private readonly gateway = false) {}

  restore(product: AwcAdvisoryProduct): AdvisoryState {
    try {
      const saved: unknown = JSON.parse(pluginStorage.slot(product).read() ?? 'null');
      // Preserve known AWC/NOAA snapshots for offline use while changing transport;
      // restore still cannot claim a successful check through the new source.
      const compatible = isRecord(saved) && (saved.endpoint === this.baseUrl || this.gateway &&
        (['/weather/awc/', '/weather/awc/snapshots/'].some(path => saved.endpoint === new URL(path, this.baseUrl).href) ||
          product !== 'gairmet' && saved.endpoint === noaaAdvisoryUrl(product)));
      if (isRecord(saved) && compatible && isAwcAdvisorySnapshot(saved.snapshot) && saved.snapshot.product === product) {
        return { snapshot: saved.snapshot, loading: false };
      }
    } catch { /* Cached data is optional. */ }
    return { loading: false };
  }

  async refresh(product: AwcAdvisoryProduct, signal: AbortSignal, now = Date.now()): Promise<AwcAdvisorySnapshot> {
    const snapshot = await requestJson(new URL(`${product}.json`, this.baseUrl).href, isAwcAdvisorySnapshot, 'AWC advisories', { signal });
    if (snapshot.product !== product || snapshot.checkedAt > now + 60_000) throw new Error('Weather feed has an invalid product or future source timestamp');
    signal.throwIfAborted();
    try { pluginStorage.slot(product).write(JSON.stringify({ endpoint: this.baseUrl, snapshot })); }
    catch { /* Quota/denied storage cannot discard a usable live snapshot. */ }
    return snapshot;
  }
}
