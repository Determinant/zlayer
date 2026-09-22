import { pluginStorage } from './storage';
import { metarPreferences } from './preferences';
import type { FeatureCollectionResponse } from '@zlayer/contracts';
import type { CatalogReadSource } from '../../workspace/read-context';
import { createMetarLayer } from './metar/layer';
import { WeatherControls } from './controls';
import { FlightCategoryLegend } from './metar/legend';
import { createLayerInput, selectLayerStore } from '../../core/layers/input';
import type { LayerPlugin } from '../../core/layers/plugin';
import { useLayerSnapshot } from '../../core/layers/use-snapshot';
import { bindMapLayer } from '../../core/map/contribution';

export function createMetarPlugin() {
  const layer = createMetarLayer();
  const input = createLayerInput<{ airports: FeatureCollectionResponse | undefined; enabled: boolean;
    airportsVisible: boolean; catalog: CatalogReadSource; onToggle(): void }>();
  const controlsInput = selectLayerStore(input, state => state && ({ catalog: state.catalog, enabled: state.enabled, onToggle: state.onToggle }));
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
    storage: pluginStorage, preferences: metarPreferences,
    ...layer, input,
    controls: [{ id: 'metar', Component: Controls }], overlays: [{ id: 'flight-categories', Component: Legend }],
    mapContribution: { id: 'metar', async load() {
      return [bindMapLayer(layer.map, input.select(({ airports, enabled, airportsVisible }) => ({ airports, enabled, airportsVisible })))];
    } },
  } satisfies LayerPlugin & typeof layer & { input: typeof input };
}
