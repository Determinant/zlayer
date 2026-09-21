import type { Map as MapLibreMap, MapSourceDataEvent } from 'maplibre-gl';
import type { FeatureCollectionResponse, GeoPointFeature } from '@zlayer/contracts';
import { isAirportFeature, latestMetarObservation, mergeMetarsIntoAirports, setFlightCategoryDisplay } from '@zlayer/domain';

import type { ProductLayer } from '../../../core/layers/product';
import { type MapLayerModule, removeLayerResources } from '../../../core/map/layer';
import { createLayerStore } from '../../../core/layers/store';
import { createMetarClient, METAR_REFRESH_MS, type MetarClient, type MetarSnapshot } from './client';
import { installMetarLayers, METAR_LAYER_IDS, METAR_SOURCE_ID, syncMetarMap } from './renderer';
import { metarReportSummary } from './summary';
import { OnDemandRefresh } from '../../../core/layers/on-demand-refresh';
import { visibleMetarStationIds } from './visible-stations';

export type MetarLoadState = {
  status: 'idle' | 'loading' | 'current' | 'stale' | 'error';
  observedAt?: string;
  message?: string;
};
export type MetarLayerSnapshot = MetarSnapshot & {
  state: MetarLoadState;
  visibleStationIds: readonly string[];
  weatherAirportCount: number;
};
type MetarInput = {
  airports: FeatureCollectionResponse | undefined;
  enabled: boolean;
  airportsVisible: boolean;
};
const emptyAirports: FeatureCollectionResponse = {
  type: 'FeatureCollection', features: [],
  meta: { revision: '', layer: 'airports', returned: 0, truncated: false },
};

export function createMetarLayer(client: MetarClient = createMetarClient()) {
  let map: MapLibreMap | undefined;
  let input: MetarInput = { airports: undefined, enabled: true, airportsVisible: true };
  let cache = client.snapshot();
  let scope: string[] = [];
  let loading = false;
  let refresh: OnDemandRefresh | undefined;
  let unsubscribe: (() => void) | undefined;
  let scopeDirty = true;
  let display: { input: MetarInput; reports: MetarSnapshot['metars']['features'] } | undefined;
  const store = createLayerStore<MetarLayerSnapshot>({
    ...cache, state: { status: 'idle' }, visibleStationIds: [], weatherAirportCount: 0,
  });
  const canRefresh = () => input.enabled && input.airportsVisible &&
    document.visibilityState !== 'hidden' && navigator.onLine;

  const publish = () => {
    const entries = scope.map(id => cache.stations.get(id));
    const reports = entries.flatMap(entry => entry?.report ? [entry.report] : []);
    const observedAt = latestMetarObservation({ type: 'FeatureCollection', features: reports });
    const error = entries.find(entry => entry?.error)?.error;
    const stale = !navigator.onLine || entries.some(entry => !entry ||
      entry.error || entry.checkedAt === undefined || metarReportSummary(entry).cached);
    const status = !input.enabled || !input.airportsVisible || scope.length === 0 ? 'idle'
      : loading && !reports.length ? 'loading'
      : error && !reports.length ? 'error' : stale ? 'stale' : 'current';
    store.publish({
      ...cache, visibleStationIds: scope, weatherAirportCount: reports.length,
      state: { status, ...(observedAt ? { observedAt } : {}), ...(error ? { message: error } : {}) },
    });
  };
  const mapData = () => {
    // Only weather-bearing airport features enter this source. Static navigation
    // never changes when observations refresh; both sources retain FAA identities.
    const joined = mergeMetarsIntoAirports(input.airports ?? emptyAirports, cache.metars, { weatherOnly: true });
    return setFlightCategoryDisplay(joined, input.enabled);
  };
  const render = () => {
    if (!map) return;
    const reports = cache.metars.features;
    const unchanged = display && display.input.airports === input.airports && display.input.enabled === input.enabled &&
      reports.length === display.reports.length && reports.every((report, index) => report === display!.reports[index]);
    syncMetarMap(map, unchanged ? undefined : mapData(), input.airportsVisible);
    // Keep only input identities; MapLibre owns the rendered GeoJSON copy.
    display = { input, reports };
  };
  const demand = () => {
    refresh?.setDemand(scope, canRefresh());
    publish();
  };
  const setScope = (ids: string[]) => {
    if (ids.join(',') === scope.join(',')) return;
    scope = ids;
    demand();
  };
  const invalidateScope = () => { scopeDirty = true; };
  const sourceChanged = (event: MapSourceDataEvent) => {
    if (event.sourceId === 'nav-airports' || event.sourceId === METAR_SOURCE_ID) invalidateScope();
  };
  const moving = () => { invalidateScope(); setScope([]); };
  const rendered = () => {
    if (!map || map.isMoving() || !scopeDirty) return;
    scopeDirty = false;
    // Keep scope current even with refresh disabled, including late-loading tiles.
    setScope(input.airportsVisible ? visibleMetarStationIds(map) : []);
  };

  const layer: MapLayerModule<MetarInput> = {
    id: 'metar', slot: 'weather', interactiveLayerIds: ['airports-weather-points'],
    mount(target) {
      map = target;
      scopeDirty = true;
      cache = client.snapshot();
      installMetarLayers(map, mapData());
      display = { input, reports: cache.metars.features };
      unsubscribe = client.subscribe(() => {
        cache = client.snapshot();
        render();
        publish();
      });
      refresh = new OnDemandRefresh({
        intervalMs: METAR_REFRESH_MS,
        refresh: (ids, signal) => client.refresh(ids, signal),
        onState(value) { loading = value; publish(); },
        onError(error) {
          store.publish({ ...store.getSnapshot(), state: {
            status: 'error', message: error instanceof Error ? error.message : 'METAR refresh failed',
          } });
        },
      });
      map.on('movestart', moving);
      map.on('moveend', invalidateScope);
      map.on('resize', invalidateScope);
      map.on('sourcedata', sourceChanged);
      map.on('styledata', invalidateScope);
      map.on('render', rendered);
      document.addEventListener('visibilitychange', demand);
      window.addEventListener('online', demand);
      window.addEventListener('offline', demand);
      render();
      rendered();
    },
    update(next) {
      const changed = input.airports !== next.airports || input.enabled !== next.enabled ||
        input.airportsVisible !== next.airportsVisible;
      input = next;
      if (changed) {
        invalidateScope();
        render();
        if (!input.airportsVisible) scope = [];
        demand();
      }
    },
    unmount() {
      unsubscribe?.();
      unsubscribe = undefined;
      refresh?.destroy();
      refresh = undefined;
      document.removeEventListener('visibilitychange', demand);
      window.removeEventListener('online', demand);
      window.removeEventListener('offline', demand);
      if (map) {
        map.off('movestart', moving);
        map.off('moveend', invalidateScope);
        map.off('resize', invalidateScope);
        map.off('sourcedata', sourceChanged);
        map.off('styledata', invalidateScope);
        map.off('render', rendered);
        removeLayerResources(map, METAR_LAYER_IDS, [METAR_SOURCE_ID]);
      }
      map = undefined;
      display = undefined;
      scope = [];
      loading = false;
      publish();
    },
  };
  return {
    definition: { id: 'metar', title: 'METAR information' } satisfies ProductLayer['definition'],
    client, map: layer, getSnapshot: store.getSnapshot, subscribe: store.subscribe,
  };
}

export function featureWithMetar(feature: GeoPointFeature, snapshot: MetarSnapshot): GeoPointFeature {
  if (!isAirportFeature(feature)) return feature;
  return mergeMetarsIntoAirports({ ...emptyAirports, features: [feature] }, snapshot.metars).features[0]!;
}
