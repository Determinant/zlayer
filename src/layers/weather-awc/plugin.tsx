import { ProgsCoverageClient } from './progs/coverage-client';
import type { LayerPlugin } from '../../core/layers/plugin';
import type { PluginExports } from '../../core/layers/bridge';
import { createLayerInput } from '../../core/layers/input';
import { useLayerSnapshot } from '../../core/layers/use-snapshot';
import { GridClient } from './grids/client';
import { AdvisoryClient } from './client';
import { RadarClient } from './radar/client';
import { RadarMotionClient } from './radar/motion-client';
import { ProgsClient } from './progs/client';
import { createWeatherController, type WeatherAwcInput } from './controller';
import { WeatherControls, WeatherDetails, WeatherToolbox } from './controls';
import { weatherAwcPreferences } from './preferences';
import { pluginStorage } from './storage';
import type { WeatherAwcApi } from './public';

export function createWeatherAwcPlugin() {
  const endpoint = import.meta.env?.VITE_ZLAYERS_AWC_FEED_URL?.trim();
  const origin = typeof location === 'undefined' ? 'http://localhost' : location.origin;
  const client = new AdvisoryClient(new URL(endpoint || '/api/weather/advisories/', origin).href.replace(/\/?$/, '/'), !endpoint);
  const gridEndpoint = import.meta.env?.VITE_ZLAYERS_AWC_GRID_URL?.trim();
  const progsEndpoint = import.meta.env?.VITE_ZLAYERS_PROGS_FEED_URL?.trim();
  const radarEndpoint = import.meta.env?.VITE_ZLAYERS_RADAR_FEED_URL?.trim();
  const controller = createWeatherController({ advisories: client,
    grids: new GridClient(new URL(gridEndpoint || '/api/weather/grids/', origin).href.replace(/\/?$/, '/'), !gridEndpoint),
    coverage: new ProgsCoverageClient(new URL(progsEndpoint || '/api/weather/progs/', origin).href.replace(/\/?$/, '/')),
    progs: new ProgsClient(new URL(progsEndpoint || '/api/weather/progs/', origin).href.replace(/\/?$/, '/')),
    radar: new RadarClient(new URL(radarEndpoint || '/api/weather/radar/', origin).href.replace(/\/?$/, '/')),
    motion: new RadarMotionClient(new URL(radarEndpoint || '/api/weather/radar/', origin).href.replace(/\/?$/, '/')) });
  const input = createLayerInput<WeatherAwcInput & { revision?: string }>();
  function Details() {
    const state = useLayerSnapshot(input);
    return <WeatherDetails controller={controller} revision={state?.revision} />;
  }
  return {
    definition: { id: 'weather-awc', title: 'AWC Weather' },
    storage: pluginStorage, preferences: weatherAwcPreferences, input, controller,
    publicApi: scope => ({ contextActions: scope.command(point => controller.contextActions(point)
      .map(action => ({ ...action, select: scope.command(action.select) }))) }),
    connect(_bridge, scope) { scope.observe(input, value => { if (value) controller.configure(value); }); },
    controls: [{ id: 'weather-awc', section: { id: 'awc-weather', title: 'AWC Weather' }, Component: () => <WeatherControls controller={controller} /> }],
    panels: [
      { id: 'weather-awc', title: 'AWC Weather toolbox', Component: () => <WeatherToolbox controller={controller} /> },
      { id: 'weather-awc-details', title: 'Weather advisory details', Component: Details, close: controller.clearSelection },
    ],
    mapContribution: { id: 'weather-awc', async load() {
      const { createWeatherMap } = await import('./map');
      return [createWeatherMap(controller)];
    } },
    dispose: controller.detach,
  } satisfies LayerPlugin & PluginExports<WeatherAwcApi> & { input: typeof input; controller: typeof controller };
}
