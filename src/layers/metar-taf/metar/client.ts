import { pluginStorage } from '../storage';
import type { MetarFeature, MetarFeatureCollection, PointGeometry } from '@zlayer/contracts';
import { isMetarFeatureCollection } from '@zlayer/contracts';
import { normalizeIdentifier, metarStationId as reportStationId, metarObservationTime as observationTime } from '@zlayer/domain';

import { METAR_LOOKBACK_HOURS, stationIdBatches } from './requests';
import { NEARBY_STATION_RADIUS_NM, nearbyStationBoxes, nearbyStations, stationDistance } from '../nearby-stations';

import { withAbort } from '../../../core/data/abort';
import { createTaskLimiter } from '../../../core/data/task-limiter';
import { weatherCheckedAt } from '../../../core/data/request-json';

export { observationTime, reportStationId };

export const METAR_REFRESH_MS = 60_000;
const cacheSlot = pluginStorage.slot('metars', 'zlayers.metars.v1');
const MAX_CACHED_STATIONS = 5_000;
const MAX_CACHED_AREAS = 200;
type StationRequest = { controller: AbortController; users: number; done: Promise<void> };
type NearbyCheck = { checkedAt?: number; attemptedAt?: number; error?: string };

export type CachedMetar = {
  report?: MetarFeature;
  checkedAt?: number;
  attemptedAt?: number;
  missing?: boolean;
  error?: string;
};

export type MetarSnapshot = {
  metars: MetarFeatureCollection;
  stations: ReadonlyMap<string, CachedMetar>;
};

type ClientOptions = {
  fetch?: typeof fetch;
  storage?: Pick<Storage, 'getItem' | 'setItem'>;
  now?: () => number;
  timeoutMs?: number;
  retryDelayMs?: number;
};

/** Keeps each station's latest report independently of the current viewport. */
export class MetarClient {
  readonly #stations = new Map<string, CachedMetar>();
  readonly #reports = new Map<string, MetarFeature>();
  readonly #pending = new Map<string, StationRequest>();
  readonly #run = createTaskLimiter(2);
  #metars: MetarFeatureCollection | undefined;
  #snapshot: MetarSnapshot | undefined;
  #dirty = false;
  readonly #areas = new Map<string, NearbyCheck>();
  readonly #listeners = new Set<() => void>();
  readonly #endpoint: URL;
  readonly #options: ClientOptions;

  constructor(endpoint: URL, options: ClientOptions = {}) {
    this.#endpoint = endpoint;
    this.#options = options;
    try {
      const saved: unknown = JSON.parse(cacheSlot.read(options.storage) ?? 'null');
      if (isMetarFeatureCollection(saved)) {
        for (const report of saved.features.slice(-MAX_CACHED_STATIONS)) {
          // Discard the retired adapter's raw-less sensor records, not coded weather.
          if (report.properties.source === 'NWS' && report.properties.sourceVersion !== 1) continue;
          const id = reportStationId(report);
          if (id) { this.#stations.set(id, { report }); this.#reports.set(id, report); }
        }
      }
    } catch {
      // Storage can be unavailable, full, or left over from an older version.
    }
  }

  snapshot(): MetarSnapshot {
    this.#metars ??= { type: 'FeatureCollection', features: [...this.#reports.values()] };
    return this.#snapshot ??= { metars: this.#metars, stations: new Map(this.#stations) };
  }

  get(stationId: string): CachedMetar | undefined {
    return this.#stations.get(normalizeIdentifier(stationId) ?? '');
  }

  subscribe = (listener: () => void): (() => void) => {
    this.#listeners.add(listener);
    return () => { this.#listeners.delete(listener); };
  };

  nearby(point: PointGeometry['coordinates'], excludeStationId?: string) {
    return nearbyStations(point, this.snapshot().metars.features, this.#now())
      .filter(station => station.stationId !== excludeStationId);
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
    const age = previous?.attemptedAt === undefined ? undefined : this.#now() - previous.attemptedAt;
    if (age !== undefined && age >= 0 && age < METAR_REFRESH_MS) return;
    try {
      const reports = new Map<string, MetarFeature>();
      let checkedAt = this.#now();
      for (const bbox of boxes) {
        const { collection, checkedAt: sourceCheckedAt } = await this.#request({ bbox }, signal);
        checkedAt = Math.min(checkedAt, sourceCheckedAt);
        for (const report of collection.features) {
          const id = reportStationId(report);
          const distance = stationDistance(point, report);
          if (!id || !/^[A-Z0-9]{4}$/.test(id) || !Number.isFinite(distance) || distance > NEARBY_STATION_RADIUS_NM) continue;
          reports.set(id, preferredReport(reports.get(id), report, this.#now())!);
        }
      }
      signal.throwIfAborted();
      const ids = new Set([...reports.keys(), ...[...this.#stations.entries()]
        .filter(([, entry]) => entry.report && stationDistance(point, entry.report) <= NEARBY_STATION_RADIUS_NM)
        .map(([id]) => id)]);
      for (const id of ids) this.#accept(id, reports.get(id), checkedAt);
      this.#areas.delete(key);
      this.#areas.set(key, { checkedAt, attemptedAt: this.#now() });
    } catch (error) {
      signal.throwIfAborted();
      this.#areas.set(key, { ...previous, attemptedAt: this.#now(),
        error: error instanceof Error ? error.message : 'Unable to load nearby METARs' });
    }
    while (this.#areas.size > MAX_CACHED_AREAS) this.#areas.delete(this.#areas.keys().next().value!);
    this.#publish();
    this.#persist();
  }

  async refresh(
    stationIds: readonly string[],
    signal: AbortSignal,
    onUpdate: () => void = () => {},
  ): Promise<void> {
    signal.throwIfAborted();
    const now = this.#now(), requests = new Set<StationRequest>();
    const ids = stationIdBatches(stationIds).flat().filter(id => {
      const pending = this.#pending.get(id);
      if (pending && !pending.controller.signal.aborted) { requests.add(pending); return false; }
      const attemptedAt = this.#stations.get(id)?.attemptedAt;
      return attemptedAt === undefined || now < attemptedAt || now - attemptedAt >= METAR_REFRESH_MS;
    });
    for (const batch of stationIdBatches(ids)) {
      const controller = new AbortController();
      const request: StationRequest = { controller, users: 0, done: Promise.resolve() };
      for (const id of batch) this.#pending.set(id, request);
      request.done = this.#run(controller.signal, () => this.#refreshBatch(batch, controller.signal)).finally(() => {
        for (const id of batch) if (this.#pending.get(id) === request) this.#pending.delete(id);
      });
      requests.add(request);
    }
    try {
      await Promise.all([...requests].map(async request => {
        request.users++;
        let released = false;
        const release = () => {
          if (released) return;
          released = true;
          if (--request.users === 0) request.controller.abort();
        };
        signal.addEventListener('abort', release, { once: true });
        try { await withAbort(request.done, signal); onUpdate(); }
        finally { signal.removeEventListener('abort', release); release(); }
      }));
    } finally { this.#persist(); }
  }

  async #refreshBatch(batch: string[], signal: AbortSignal): Promise<void> {
    try {
      const { collection, checkedAt } = await this.#request({ ids: batch.join(',') }, signal);
      signal.throwIfAborted();
      const reports = new Map<string, MetarFeature>();
      for (const report of collection.features) {
        const id = reportStationId(report);
        if (id) reports.set(id, preferredReport(reports.get(id), report, this.#now())!);
      }
      for (const id of batch) this.#accept(id, reports.get(id), checkedAt);
    } catch (error) {
      signal.throwIfAborted();
      for (const id of batch) this.#stations.set(id, {
        ...this.#stations.get(id), attemptedAt: this.#now(),
        error: error instanceof Error ? error.message : 'Unable to load AWC METARs',
      });
    }
    // Freshness reaches consumers per batch; durable reports flush once per refresh.
    this.#publish();
  }

  async #request(query: { ids: string } | { bbox: string }, signal: AbortSignal): Promise<{ collection: MetarFeatureCollection; checkedAt: number }> {
    const url = new URL(this.#endpoint);
    url.searchParams.delete('ids');
    url.searchParams.delete('bbox');
    for (const [key, value] of Object.entries(query)) url.searchParams.set(key, value);
    url.searchParams.set('format', 'geojson');
    url.searchParams.set('hours', String(METAR_LOOKBACK_HOURS));
    for (let attempt = 0; ; attempt++) {
      signal.throwIfAborted();
      try {
        const response = await (this.#options.fetch ?? fetch)(url, {
          signal: AbortSignal.any([signal, AbortSignal.timeout(this.#options.timeoutMs ?? 20_000)]),
          cache: 'no-store',
        });
        if (response.status === 204) return { collection: { type: 'FeatureCollection', features: [] },
          checkedAt: weatherCheckedAt(response, this.#now()) };
        if (!response.ok) {
          await response.body?.cancel();
          throw new MetarHttpError(response.status);
        }
        const body: unknown = await response.json();
        if (!isMetarFeatureCollection(body)) throw new Error('AWC METAR returned invalid GeoJSON');
        return { collection: body, checkedAt: weatherCheckedAt(response, this.#now()) };
      } catch (error) {
        signal.throwIfAborted();
        const retryable = error instanceof TypeError ||
          (error instanceof DOMException && error.name === 'TimeoutError') ||
          (error instanceof MetarHttpError && (error.status === 408 || error.status >= 500));
        if (attempt >= 1 || !retryable) throw error;
        await abortableDelay(this.#options.retryDelayMs ?? 1_000, signal);
      }
    }
  }

  #now(): number {
    return (this.#options.now ?? Date.now)();
  }

  #accept(id: string, received: MetarFeature | undefined, checkedAt: number): void {
    const saved = this.get(id), previous = saved?.report;
    const now = this.#now();
    // A shared cache hit must not replace a newer successful source check.
    if (saved?.checkedAt !== undefined && saved.checkedAt <= now && saved.checkedAt > checkedAt &&
      (!received || previous && observationTime(previous) <= now && observationTime(received) <= observationTime(previous))) return;
    const preferred = preferredReport(previous, received, now);
    // Preserve content identity across successful checks, including same-time corrections.
    const report = preferred === previous ? previous
      : previous && preferred && JSON.stringify(previous) === JSON.stringify(preferred) ? previous : preferred;
    if (report && report !== previous) {
      this.#reports.set(id, report); this.#metars = undefined; this.#dirty = true;
    }
    this.#stations.delete(id);
    this.#stations.set(id, {
      ...(report ? { report } : {}), checkedAt, attemptedAt: now,
      missing: !received || preferred !== received,
    });
  }

  #publish(): void {
    while (this.#stations.size > MAX_CACHED_STATIONS) {
      const id = this.#stations.keys().next().value!;
      this.#stations.delete(id);
      if (this.#reports.delete(id)) { this.#metars = undefined; this.#dirty = true; }
    }
    this.#snapshot = undefined;
    for (const listener of this.#listeners) listener();
  }

  #persist(): void {
    if (!this.#dirty) return;
    try {
      // Persist only changed reports, never transient checks or failures.
      cacheSlot.write(JSON.stringify(this.snapshot().metars), this.#options.storage);
      this.#dirty = false;
    } catch { /* In-memory caching continues when browser storage is unavailable. */ }
  }
}

/** Prefer usable timestamps before chronological order, both within a response
 * and against saved data. A future report must not permanently outrank valid data. */
function preferredReport(previous: MetarFeature | undefined, received: MetarFeature | undefined,
  now: number): MetarFeature | undefined {
  if (!previous || !received) return received ?? previous;
  const oldTime = observationTime(previous), newTime = observationTime(received);
  if ((oldTime > now) !== (newTime > now)) return oldTime > now ? received : previous;
  return newTime >= oldTime ? received : previous;
}

class MetarHttpError extends Error {
  constructor(readonly status: number) {
    super(`AWC METAR: HTTP ${status}`);
  }
}

function abortableDelay(milliseconds: number, signal: AbortSignal): Promise<void> {
  signal.throwIfAborted();
  return new Promise((resolve, reject) => {
    const abort = () => {
      clearTimeout(timer);
      reject(signal.reason);
    };
    const timer = setTimeout(() => {
      signal.removeEventListener('abort', abort);
      resolve();
    }, milliseconds);
    signal.addEventListener('abort', abort, { once: true });
  });
}

export function createMetarClient(): MetarClient {
  const metarUrl = import.meta.env?.VITE_ZLAYERS_METAR_URL?.trim() || '/api/weather/metars.geojson';
  return new MetarClient(new URL(metarUrl, window.location.origin));
}
