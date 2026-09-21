import { useEffect, useEffectEvent, useState, type ComponentType, type ReactNode } from 'react';
import type { GeoPointFeature, PointGeometry } from '@zlayer/contracts';
import { featureIdent, preferredWeatherStationId } from '@zlayer/domain';
import { OnDemandRefresh } from '../../core/layers/on-demand-refresh';
import { hasCurrentReport, stationChoices, NEARBY_STATION_RADIUS_NM, type NearbyStation, type WeatherReport } from './nearby-stations';

type Point = PointGeometry['coordinates'];
type CachedReport<Report> = { report?: Report; checkedAt?: number; missing?: boolean; error?: string };
export type ReportViewProps<Report> = {
  entry: CachedReport<Report> | undefined; loading: boolean; online: boolean; now: number;
  source?: ReactNode; emptyMessage?: string | undefined;
};
type StationClient<Report extends WeatherReport> = {
  get(stationId: string): CachedReport<Report> | undefined;
  nearby(point: Point, excludeStationId?: string): NearbyStation<Report>[];
  nearbyStatus(point: Point): { checkedAt?: number; error?: string } | undefined;
  refreshNearby(point: Point, signal: AbortSignal): Promise<void>;
  subscribe?: (listener: () => void) => () => void;
};

/** Each mounted report owns its selection, refresh cadence and cleanup. */
export function StationWeather<Report extends WeatherReport>({ feature, client, active = true, name, intervalMs, refreshStation, View }: {
  feature: GeoPointFeature;
  client: StationClient<Report> | undefined;
  active?: boolean;
  name: 'METAR' | 'TAF';
  intervalMs: number;
  refreshStation: (stationId: string, signal: AbortSignal) => Promise<void> | undefined;
  View: ComponentType<ReportViewProps<Report>>;
}) {
  const id = preferredWeatherStationId(feature);
  const stationId = id && /^[A-Z0-9]{4}$/.test(id) ? id : undefined;
  const [longitude, latitude] = feature.geometry.coordinates;
  const read = () => ({
    own: stationId ? client?.get(stationId) : undefined,
    nearby: client?.nearby([longitude, latitude], stationId) ?? [],
    nearbyStatus: client?.nearbyStatus([longitude, latitude]),
  });
  const [data, setData] = useState(read);
  const [selectedId, setSelectedId] = useState<string>();
  // Offline or hidden cards may never start a request. The scheduler owns loading.
  const [loading, setLoading] = useState(false);
  const [online, setOnline] = useState(() => typeof navigator === 'undefined' || navigator.onLine);
  const [now, setNow] = useState(Date.now);
  const update = () => { setData(read()); setNow(Date.now()); };
  // Read the latest selection without restarting the product's refresh cadence.
  const onRefresh = useEffectEvent(async (signal: AbortSignal) => {
    if (!client) return;
    if (stationId) await refreshStation(stationId, signal);
    signal.throwIfAborted();
    update();
    if (selectedId || !hasCurrentReport(stationId ? client.get(stationId)?.report : undefined, Date.now())) {
      await client.refreshNearby([longitude, latitude], signal);
    }
  });
  useEffect(() => {
    if (!client || !active) return;
    // Reopening offline must also pick up cache changes made while stowed.
    update();
    const unsubscribe = client.subscribe?.(update);
    const refresh = new OnDemandRefresh({
      intervalMs, debounceMs: 0,
      refresh: (_ids, signal) => onRefresh(signal),
      onState(value) { setLoading(value); update(); },
      onError: update,
    });
    const demand = () => {
      setOnline(navigator.onLine);
      refresh.setDemand([stationId ?? `${longitude}:${latitude}`], navigator.onLine && document.visibilityState !== 'hidden');
    };
    demand();
    const timer = window.setInterval(update, 30_000);
    document.addEventListener('visibilitychange', demand);
    window.addEventListener('online', demand);
    window.addEventListener('offline', demand);
    return () => {
      unsubscribe?.();
      refresh.destroy();
      window.clearInterval(timer);
      document.removeEventListener('visibilitychange', demand);
      window.removeEventListener('online', demand);
      window.removeEventListener('offline', demand);
    };
  }, [client, active, intervalMs, stationId, longitude, latitude]);
  const ownCurrent = hasCurrentReport(data.own?.report, now);
  const choices = !ownCurrent || selectedId !== undefined ? stationChoices(data.own?.report, data.nearby, now) : [];
  const selected = choices.find(station => station.stationId === selectedId) ?? choices[0];
  const nearby = selected && selected.stationId !== stationId ? selected : undefined;
  const entry = nearby ? client?.get(nearby.stationId) : data.own;
  const error = !ownCurrent || nearby ? data.nearbyStatus?.error : undefined;
  const emptyMessage = !online ? `No saved nearby ${name} within ${NEARBY_STATION_RADIUS_NM} NM · Offline`
    : error ? `Nearby ${name} unavailable · Refresh failed`
    : data.nearbyStatus?.checkedAt !== undefined ? `No nearby ${name} within ${NEARBY_STATION_RADIUS_NM} NM.` : undefined;
  const description = name === 'METAR' ? 'Observation' : 'Forecast';
  const staleLabel = name === 'METAR' ? 'Stale' : 'Expired';
  const source = selected && <div className="weather-source">
    <label>{nearby ? `Nearby ${name}` : `${name} station`}
      <select aria-label={`${name} station`} value={selected.stationId} onChange={event => setSelectedId(event.target.value)}>
        {choices.map(station => <option key={station.stationId} value={station.stationId}>
          {station.stationId} · {station.distanceNm.toFixed(1)} NM {station.direction}
          {!hasCurrentReport(station.report, now) ? ` · ${staleLabel}` : ''}
        </option>)}
      </select>
    </label>
    <p>{nearby ? <>{description} for {selected.stationId} · {selected.distanceNm.toFixed(1)} NM {selected.direction} of {featureIdent(feature)}.</>
      : <>{description} for {selected.stationId}.</>}</p>
  </div>;
  return <View entry={error ? { ...entry, error } : entry} loading={loading} online={online} now={now}
    source={source} emptyMessage={emptyMessage} />;
}
