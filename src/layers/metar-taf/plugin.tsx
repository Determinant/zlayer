import type { MetarApi } from './public';
import type { NavigationApi } from '../navigation/public';
import type { PluginExports } from '../../core/layers/bridge';
import { createLayerStore } from '../../core/layers/store';
import { pluginStorage } from './storage';
import { metarPreferences } from './preferences';
import type { FeatureCollectionResponse } from '@zlayer/contracts';
import type { CatalogReadSource } from '../../workspace/read-context';
import { createMetarLayer } from './metar/layer';
import { WeatherControls } from './controls';
import { FlightCategoryLegend } from './metar/legend';
import { createLayerInput, selectLayerStore, combineLayerStores } from '../../core/layers/input';
import type { LayerPlugin } from '../../core/layers/plugin';
import { useLayerSnapshot } from '../../core/layers/use-snapshot';
import { bindMapLayer } from '../../core/map/contribution';
import type { ReportStatus, ReportStatusListener } from './station-weather';

export function createMetarPlugin() {
  const layer = createMetarLayer();
  const reportStatus = createLayerStore<Partial<Record<'METAR' | 'TAF', ReportStatus>>>({});
  const setReportStatus: ReportStatusListener = (name, status) => {
    const previous = reportStatus.getSnapshot();
    if (previous[name] === status) return;
    const next = { ...previous };
    if (status) next[name] = status; else delete next[name];
    reportStatus.publish(next);
  };
  const input = createLayerInput<{ enabled: boolean; catalog: CatalogReadSource; onToggle(): void }>();
  const empty = { data: undefined as FeatureCollectionResponse | undefined, visible: false };
  const airports = createLayerStore(empty);
  const mapInput = combineLayerStores(input, airports, (state, airports) => ({
    enabled: state?.enabled ?? false, airports: airports.data, airportsVisible: airports.visible,
  }));
  const controlsInput = selectLayerStore(input, state => state && ({ enabled: state.enabled, onToggle: state.onToggle }));
  const legendInput = selectLayerStore(input, state => state?.enabled);
  const weatherStatus = selectLayerStore(layer, snapshot => ({ ...snapshot.state, observedAt: snapshot.state.observedAt, weatherAirportCount: snapshot.weatherAirportCount }));
  const legendStatus = selectLayerStore(layer, snapshot => ({ observedAt: snapshot.state.observedAt, weatherAirportCount: snapshot.weatherAirportCount }));
  function Controls() {
    const state = useLayerSnapshot(controlsInput), snapshot = useLayerSnapshot(weatherStatus);
    return state ? <WeatherControls {...state} {...snapshot} /> : null;
  }
  function Legend() {
    const enabled = useLayerSnapshot(legendInput), snapshot = useLayerSnapshot(legendStatus);
    return enabled && snapshot.weatherAirportCount > 0 ? <FlightCategoryLegend observedAt={snapshot.observedAt} /> : null;
  }
  return {
    publicApi: scope => ({ reports: scope.store(layer) }),
    connect(bridge, scope) {
      scope.add(() => airports.publish(empty));
      bridge.watch('navigation', (api, connection) => {
        if (api) connection.observe(api.airports, airports.publish);
        else airports.publish(empty);
      });
    },
    storage: pluginStorage, preferences: metarPreferences,
    ...layer, input, reportStatus, setReportStatus,
    controls: [{ id: 'metar', section: { id: 'awc-weather', title: 'AWC Weather' }, Component: Controls }], overlays: [{ id: 'flight-categories', Component: Legend }],
    mapContribution: { id: 'metar', async load() {
      return [bindMapLayer(layer.map, mapInput)];
    } },
  } satisfies LayerPlugin & PluginExports<MetarApi, { navigation: NavigationApi }> & {
    input: typeof input; reportStatus: typeof reportStatus; setReportStatus: ReportStatusListener;
  };
}
