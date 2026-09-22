import { pluginStorage } from '../storage';
import type { MetarFeature, MetarFeatureCollection, PointGeometry } from '@zlayer/contracts';
import { isMetarFeatureCollection } from '@zlayer/contracts';
import { normalizeIdentifier, metarStationId as reportStationId, metarObservationTime as observationTime } from '@zlayer/domain';

import { METAR_LOOKBACK_HOURS, stationIdBatches } from './requests';
import { NEARBY_STATION_RADIUS_NM, nearbyStationBoxes, nearbyStations, stationDistance } from '../nearby-stations';

export { observationTime, reportStationId };

export const METAR_REFRESH_MS = 60_000;
const cacheSlot = pluginStorage.slot('metars', 'zlayers.metars.v1');
const MAX_CACHED_STATIONS = 5_000;
const MAX_CACHED_AREAS = 200;
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
          const id = reportStationId(report);
          if (id) this.#stations.set(id, { report });
        }
      }
    } catch {
      // Storage can be unavailable, full, or left over from an older version.
    }
  }

  snapshot(): MetarSnapshot {
    return {
      metars: {
        type: 'FeatureCollection',
        features: [...this.#stations.values()].flatMap(({ report }) => report ? [report] : []),
      },
      stations: new Map(this.#stations),
    };
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
      for (const bbox of boxes) {
        const collection = await this.#request({ bbox }, signal);
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
      for (const id of ids) this.#accept(id, reports.get(id));
      this.#areas.delete(key);
      this.#areas.set(key, { checkedAt: this.#now(), attemptedAt: this.#now() });
    } catch (error) {
      signal.throwIfAborted();
      this.#areas.set(key, { ...previous, attemptedAt: this.#now(),
        error: error instanceof Error ? error.message : 'Unable to load nearby METARs' });
    }
    while (this.#areas.size > MAX_CACHED_AREAS) this.#areas.delete(this.#areas.keys().next().value!);
    this.#save();
  }

  async refresh(
    stationIds: readonly string[],
    signal: AbortSignal,
    onUpdate: () => void = () => {},
  ): Promise<void> {
    const now = this.#now();
    const batches = stationIdBatches(stationIds.filter((id) => {
      const cached = this.#stations.get(normalizeIdentifier(id) ?? '');
      const attemptedAt = cached?.attemptedAt;
      return attemptedAt === undefined || now < attemptedAt || now - attemptedAt >= METAR_REFRESH_MS;
    }));
    let nextBatch = 0;
    const worker = async () => {
      while (nextBatch < batches.length) {
        signal.throwIfAborted();
        const batch = batches[nextBatch++]!;
        try {
          const collection = await this.#request({ ids: batch.join(',') }, signal);
          signal.throwIfAborted();
          const reports = new Map<string, MetarFeature>();
          for (const report of collection.features) {
            const id = reportStationId(report);
            if (id) reports.set(id, preferredReport(reports.get(id), report, this.#now())!);
          }
          for (const id of batch) this.#accept(id, reports.get(id));
        } catch (error) {
          signal.throwIfAborted();
          for (const id of batch) {
            this.#stations.set(id, {
              ...this.#stations.get(id),
              attemptedAt: this.#now(),
              error: error instanceof Error ? error.message : 'Unable to load AWC METARs',
            });
          }
        }
        this.#save();
        onUpdate();
      }
    };
    await Promise.all(Array.from({ length: Math.min(2, batches.length) }, worker));
  }

  async #request(query: { ids: string } | { bbox: string }, signal: AbortSignal): Promise<MetarFeatureCollection> {
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
        if (response.status === 204) return { type: 'FeatureCollection', features: [] };
        if (!response.ok) {
          await response.body?.cancel();
          throw new MetarHttpError(response.status);
        }
        const body: unknown = await response.json();
        if (!isMetarFeatureCollection(body)) throw new Error('AWC METAR returned invalid GeoJSON');
        return body;
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

  #accept(id: string, received: MetarFeature | undefined): void {
    const previous = this.get(id)?.report;
    const now = this.#now();
    const report = preferredReport(previous, received, now);
    this.#stations.delete(id);
    this.#stations.set(id, {
      ...(report ? { report } : {}), checkedAt: now, attemptedAt: now,
      missing: !received || report !== received,
    });
  }

  #save(): void {
    while (this.#stations.size > MAX_CACHED_STATIONS) {
      this.#stations.delete(this.#stations.keys().next().value!);
    }
    try {
      // Persist observations, but revalidate them on the next page load.
      cacheSlot.write(JSON.stringify(this.snapshot().metars), this.#options.storage);
    } catch {
      // In-memory caching continues when browser storage is unavailable.
    }
    for (const listener of this.#listeners) listener();
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
  const metarUrl = import.meta.env?.VITE_ZLAYERS_METAR_URL?.trim() || '/weather/metars.geojson';
  return new MetarClient(new URL(metarUrl, window.location.origin));
}
