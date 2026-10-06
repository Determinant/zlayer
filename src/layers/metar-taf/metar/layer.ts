import type { Map as MapLibreMap, MapSourceDataEvent, MapLibreEvent } from 'maplibre-gl';
import type { FeatureCollectionResponse, GeoPointFeature } from '@zlayer/contracts';
import { isAirportFeature, latestMetarObservation, mergeMetarsIntoAirports, metarStationId, setFlightCategoryDisplay } from '@zlayer/domain';

import type { LayerDefinition } from '../../../core/layers/plugin';
import { type MapLayerModule, removeLayerResources } from '../../../core/map/layer';
import { createLayerStore } from '../../../core/layers/store';
import { createMetarClient, METAR_REFRESH_MS, type MetarClient, type MetarSnapshot } from './client';
import { installMetarLayers, METAR_LAYER_IDS, METAR_FOCUS_LAYER_IDS, METAR_SOURCE_ID, syncMetarMap } from './renderer';
import { focusedLayerId } from '../../../core/map/focus';
import { metarReportSummary } from './summary';
import { OnDemandRefresh } from '../../../core/layers/on-demand-refresh';
import { visibleMetarStationIds } from './visible-stations';
import { hasCurrentReport } from '../nearby-stations';
import { createSourceSubmission } from '../../../core/map/source-submission';
import { withMapLabelKeys } from '../../../core/map/label';

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
  let following = false;
  let displayTimer: ReturnType<typeof setTimeout> | undefined;
  let display: { input: MetarInput; reports: MetarSnapshot['metars']['features']; currentStations: ReadonlySet<string> } | undefined;
  let submission: ReturnType<typeof createSourceSubmission> | undefined;
  let retryTimer: ReturnType<typeof setTimeout> | undefined, retried = false;
  // Suppression survives repeat callbacks until the current nonempty upload is accepted.
  let suppressed = true;
  const store = createLayerStore<MetarLayerSnapshot>({
    ...cache, state: { status: 'idle' }, visibleStationIds: [], weatherAirportCount: 0,
  });
  const canRefresh = () => input.enabled && input.airportsVisible &&
    (!map?.isMoving() || following) && document.visibilityState !== 'hidden' && navigator.onLine;

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
  const currentStationIds = () => {
    const now = Date.now();
    return new Set(cache.metars.features.flatMap(report => {
      const id = metarStationId(report);
      return input.enabled && id && hasCurrentReport(report, now) ? [id] : [];
    }));
  };
  const mapData = (currentStations: ReadonlySet<string>) => {
    // Only weather-bearing airport features enter this source. Static navigation
    // never changes when observations refresh; both sources retain FAA identities.
    const joined = mergeMetarsIntoAirports(input.airports ?? emptyAirports, cache.metars, { weatherOnly: true });
    return setFlightCategoryDisplay(joined, input.enabled, currentStations);
  };
  const render = () => {
    clearTimeout(displayTimer);
    displayTimer = undefined;
    if (!map) return;
    if (!input.airportsVisible) {
      syncMetarMap(map, undefined, false);
      return;
    }
    const reports = cache.metars.features;
    const currentStations = currentStationIds();
    const unchanged = display && display.input.airports === input.airports && display.input.enabled === input.enabled &&
      reports.length === display.reports.length && reports.every((report, index) => report === display!.reports[index]) &&
      currentStations.size === display.currentStations.size && [...currentStations].every(id => display!.currentStations.has(id));
    const active = submission;
    if (!unchanged && active) {
      retried = false; clearTimeout(retryTimer); retryTimer = undefined;
    }
    if (active && (!unchanged || active.failed)) {
      const version = active.begin();
      const data = mapData(currentStations);
      if (!data.features.length || !input.enabled) { suppressed = true; syncMetarMap(map, undefined, false); }
      void active.submit(version, withMapLabelKeys(data)).then(accepted => {
        if (accepted && map) {
          suppressed = !data.features.length;
          syncMetarMap(map, undefined, input.airportsVisible && !suppressed);
        }
      }).catch(error => active.reject(version, error));
    } else syncMetarMap(map, undefined, input.airportsVisible && !suppressed);
    // Keep identities and freshness, not a second joined GeoJSON collection.
    display = { input, reports, currentStations };
    // Observation age changes without cache updates, including while offline.
    if (input.enabled && reports.length && document.visibilityState !== 'hidden') {
      displayTimer = setTimeout(render, 30_000);
    }
  };
  const demand = () => {
    refresh?.setDemand(scope, canRefresh());
    publish();
  };
  const environmentChanged = () => { render(); demand(); };
  const invalidateScope = () => { scopeDirty = true; };
  const sourceChanged = (event: MapSourceDataEvent) => {
    if (event.sourceId === 'nav-airports' || event.sourceId === METAR_SOURCE_ID) invalidateScope();
  };
  // Automatic follow retains demand for the last settled scope; manual movement
  // pauses acquisition without hiding the last settled view's legend on every
  // GPS follow animation. Reconcile the displayed scope once movement settles.
  const moving = (event: MapLibreEvent & { gpsCamera?: boolean }) => {
    following = event.gpsCamera === true;
    invalidateScope(); demand();
  };
  const rendered = () => {
    if (!map || map.isMoving() || !scopeDirty) return;
    scopeDirty = false;
    // Keep scope current even with refresh disabled, including late-loading tiles.
    const ids = input.airportsVisible ? visibleMetarStationIds(map) : [];
    if (ids.join(',') !== scope.join(',')) {
      scope = ids;
      demand();
    } else {
      // Resume even when the camera still shows exactly the same stations.
      refresh?.setDemand(scope, canRefresh());
    }
  };

  const layer: MapLayerModule<MetarInput> = {
    id: 'metar', slot: 'weather', overlayLayerIds: METAR_LAYER_IDS, focusedLayerIds: METAR_FOCUS_LAYER_IDS,
    interactiveLayerIds: ['airports-weather-points', 'airports-weather-labels', focusedLayerId('airports-weather-points')],
    mount(target) {
      map = target;
      following = false;
      scopeDirty = true;
      retried = false;
      cache = client.snapshot();
      submission = createSourceSubmission(map, METAR_SOURCE_ID, () => {
        suppressed = true;
        if (map) syncMetarMap(map, undefined, false);
        if (!retried) {
          retried = true;
          retryTimer = setTimeout(() => { retryTimer = undefined; render(); }, 100);
        }
      });
      // Observe the initial addSource load without uploading the same join twice.
      submission.begin();
      const currentStations = currentStationIds();
      const initial = mapData(currentStations);
      suppressed = !initial.features.length;
      installMetarLayers(map, initial);
      display = { input, reports: cache.metars.features, currentStations };
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
      document.addEventListener('visibilitychange', environmentChanged);
      window.addEventListener('online', environmentChanged);
      window.addEventListener('offline', environmentChanged);
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
      clearTimeout(retryTimer); retryTimer = undefined;
      submission?.destroy(); submission = undefined;
      suppressed = true;
      unsubscribe?.();
      unsubscribe = undefined;
      refresh?.destroy();
      refresh = undefined;
      clearTimeout(displayTimer);
      displayTimer = undefined;
      document.removeEventListener('visibilitychange', environmentChanged);
      window.removeEventListener('online', environmentChanged);
      window.removeEventListener('offline', environmentChanged);
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
      input = { airports: undefined, enabled: false, airportsVisible: false };
      scope = [];
      loading = false;
      publish();
    },
  };
  return {
    definition: { id: 'metar', title: 'METAR/TAF' } satisfies LayerDefinition,
    client, map: layer, getSnapshot: store.getSnapshot, subscribe: store.subscribe,
  };
}

export function featureWithMetar(feature: GeoPointFeature, snapshot: MetarSnapshot): GeoPointFeature {
  if (!isAirportFeature(feature)) return feature;
  return mergeMetarsIntoAirports({ ...emptyAirports, features: [feature] }, snapshot.metars).features[0]!;
}
