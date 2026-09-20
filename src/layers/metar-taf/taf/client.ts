import { isTafReport, type PointGeometry, type TafReport } from '@zlayer/contracts';
import { normalizeIdentifier } from '@zlayer/domain';
import { NEARBY_STATION_RADIUS_NM, nearbyStationBoxes, nearbyStations, stationDistance } from '../nearby-stations';

export const TAF_REFRESH_MS = 5 * 60_000;
const CACHE_KEY = 'zlayers.tafs.v1';
const MAX_CACHED_STATIONS = 200;
export type CachedTaf = { report?: TafReport; checkedAt?: number; missing?: boolean; error?: string };
type NearbyCheck = { checkedAt?: number; error?: string };
type Options = { fetch?: typeof fetch; storage?: Pick<Storage, 'getItem' | 'setItem'>; now?: () => number; timeoutMs?: number };

export class TafClient {
  readonly #stations = new Map<string, CachedTaf>();
  readonly #areas = new Map<string, NearbyCheck>();

  constructor(readonly endpoint: URL, readonly options: Options = {}) {
    try {
      const saved: unknown = JSON.parse(options.storage?.getItem(CACHE_KEY) ?? 'null');
      if (Array.isArray(saved)) {
        for (const report of saved.filter(isTafReport).slice(-MAX_CACHED_STATIONS)) {
          const id = normalizeIdentifier(report.icaoId);
          if (id) this.#stations.set(id, { report });
        }
      }
    } catch { /* Storage is optional; the session cache still works. */ }
  }

  get(stationId: string): CachedTaf | undefined {
    return this.#stations.get(normalizeIdentifier(stationId) ?? '');
  }

  nearby(point: PointGeometry['coordinates'], excludeStationId?: string) {
    return nearbyStations(point, [...this.#stations.values()].flatMap(entry => entry.report ? [entry.report] : []),
      (this.options.now ?? Date.now)()).filter(station => station.stationId !== excludeStationId);
  }

  nearbyStatus(point: PointGeometry['coordinates']): NearbyCheck | undefined {
    return this.#areas.get(nearbyStationBoxes(point).join(';'));
  }

  async refreshNearby(point: PointGeometry['coordinates'], signal: AbortSignal): Promise<void> {
    const boxes = nearbyStationBoxes(point);
    if (!boxes.length) return;
    signal.throwIfAborted();
    const key = boxes.join(';');
    const previous = this.#areas.get(key);
    const now = (this.options.now ?? Date.now)();
    if (previous?.checkedAt !== undefined && !previous.error && now - previous.checkedAt < TAF_REFRESH_MS) return;
    try {
      const reports = new Map<string, TafReport>();
      for (const box of boxes) {
        const url = new URL(this.endpoint);
        url.searchParams.delete('ids');
        url.searchParams.set('bbox', box);
        url.searchParams.set('format', 'json');
        for (const report of await this.#request(url, signal)) {
          const id = normalizeIdentifier(report.icaoId);
          if (!id || !/^[A-Z0-9]{4}$/.test(id) || stationDistance(point, report) > NEARBY_STATION_RADIUS_NM) continue;
          const current = reports.get(id);
          if (!current || newestFirst(report, current) < 0) reports.set(id, report);
        }
      }
      signal.throwIfAborted();
      // A successful empty result may mark old forecasts missing, but cannot erase them.
      const ids = new Set([...reports.keys(), ...[...this.#stations.entries()]
        .filter(([, entry]) => entry.report && stationDistance(point, entry.report) <= NEARBY_STATION_RADIUS_NM)
        .map(([id]) => id)]);
      for (const id of ids) this.#accept(id, reports.get(id));
      this.#areas.delete(key);
      this.#areas.set(key, { checkedAt: (this.options.now ?? Date.now)() });
      this.#save();
    } catch (error) {
      signal.throwIfAborted();
      this.#areas.set(key, { ...previous, error: error instanceof Error ? error.message : 'Unable to load nearby TAFs' });
    }
    while (this.#areas.size > MAX_CACHED_STATIONS) this.#areas.delete(this.#areas.keys().next().value!);
  }

  async refresh(stationId: string, signal: AbortSignal): Promise<void> {
    const id = normalizeIdentifier(stationId);
    if (!id || !/^[A-Z0-9]{4}$/.test(id)) return;
    signal.throwIfAborted();
    const previous = this.get(id);
    const now = (this.options.now ?? Date.now)();
    if (previous?.checkedAt !== undefined && !previous.error && now - previous.checkedAt < TAF_REFRESH_MS) return;
    const url = new URL(this.endpoint);
    url.searchParams.delete('bbox');
    url.searchParams.set('ids', id);
    url.searchParams.set('format', 'json');
    try {
      const body = await this.#request(url, signal);
      const received = body.filter(report => normalizeIdentifier(report.icaoId) === id).sort(newestFirst)[0];
      this.#accept(id, received);
      this.#save();
    } catch (error) {
      signal.throwIfAborted();
      this.#stations.set(id, { ...this.get(id), error: error instanceof Error ? error.message : 'Unable to load AWC TAFs' });
    }
  }

  async #request(url: URL, signal: AbortSignal): Promise<TafReport[]> {
    const response = await (this.options.fetch ?? fetch)(url, {
      cache: 'no-store', signal: AbortSignal.any([signal, AbortSignal.timeout(this.options.timeoutMs ?? 20_000)]),
    });
    if (!response.ok) {
      await response.body?.cancel();
      throw new Error(`AWC TAF: HTTP ${response.status}`);
    }
    const body: unknown = response.status === 204 ? [] : await response.json();
    if (!Array.isArray(body) || !body.every(isTafReport)) throw new Error('AWC TAF returned invalid data');
    signal.throwIfAborted();
    return body;
  }

  #accept(id: string, received: TafReport | undefined): void {
    const previous = this.get(id)?.report;
    const report = previous && (!received || newestFirst(previous, received) < 0) ? previous : received;
    this.#stations.delete(id);
    this.#stations.set(id, {
      ...(report ? { report } : {}), checkedAt: (this.options.now ?? Date.now)(), missing: !received || report !== received,
    });
  }

  #save(): void {
    while (this.#stations.size > MAX_CACHED_STATIONS) this.#stations.delete(this.#stations.keys().next().value!);
    try {
      // Revalidate restored forecasts rather than persisting a claim of freshness.
      this.options.storage?.setItem(CACHE_KEY, JSON.stringify([...this.#stations.values()].flatMap(entry => entry.report ? [entry.report] : [])));
    } catch { /* In-memory caching continues when storage is unavailable. */ }
  }
}

function newestFirst(a: TafReport, b: TafReport): number {
  return Date.parse(b.issueTime) - Date.parse(a.issueTime) ||
    (Date.parse(b.dbPopTime ?? b.issueTime) - Date.parse(a.dbPopTime ?? a.issueTime));
}

let sharedClient: TafClient | undefined;
export function getTafClient(): TafClient {
  if (sharedClient) return sharedClient;
  let storage: Storage | undefined;
  try { storage = window.localStorage; } catch { /* Optional browser storage. */ }
  const endpoint = import.meta.env?.VITE_ZLAYERS_TAF_URL?.trim() || '/weather/tafs.json';
  sharedClient = new TafClient(new URL(endpoint, window.location.origin), { ...(storage ? { storage } : {}) });
  return sharedClient;
}
