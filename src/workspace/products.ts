import { PluginRegistry } from '../core/layers/bridge';
import { createLayerInput } from '../core/layers/input';
import type { MapSelectionInput } from '../core/map/selection';
import type { WorkspacePluginApis } from './plugin-apis';
import { createMetarPlugin } from '../layers/metar-taf/plugin';
import { createPlatesLayer } from '../layers/plates';
import { createOwnshipPlugin } from '../layers/ownship/plugin';
import { createAhrsPlugin } from '../layers/ahrs/plugin';
import { createRulerPlugin } from '../layers/ruler/plugin';
import { createTerrainPlugin } from '../layers/terrain/plugin';
import { createObstructionsPlugin } from '../layers/obstructions/plugin';
import { createChartsPlugin } from '../layers/charts/plugin';
import { createNavigationPlugin } from '../layers/navigation/plugin';
import { createRoutesPlugin } from '../layers/routes/plugin';
import { createWeatherAwcPlugin } from '../layers/weather-awc/plugin';
import { layerPlugins } from '../core/layers/plugin';
import type { MapContribution } from '../core/map/contribution';
import { createGpsService } from '../core/gps/service';

// App retains these controllers in state. Fast Refresh would otherwise keep
// instances and map callbacks from the previous modules after a code change.
if (import.meta.hot) {
  import.meta.hot.accept(() => window.location.reload());
}

/** Explicit typed composition. Feature lifetimes outlive map and panel attachments. */
export function createWorkspaceLayers() {
  const charts = createChartsPlugin();
  const terrain = createTerrainPlugin();
  const obstructions = createObstructionsPlugin();
  const navigation = createNavigationPlugin();
  const metar = createMetarPlugin();
  const weatherAwc = createWeatherAwcPlugin();
  const plates = createPlatesLayer();
  const gps = createGpsService();
  const ownship = createOwnshipPlugin(gps);
  const ahrs = createAhrsPlugin(gps);
  const ruler = createRulerPlugin();
  const routes = createRoutesPlugin();
  const registry = new PluginRegistry<WorkspacePluginApis>();
  const selectionInput = createLayerInput<MapSelectionInput>();
  const selectionContribution: MapContribution = { id: 'workspace-selection', async load(context) {
    const { createSelectionContribution } = await import('./map/selection');
    return [createSelectionContribution(selectionInput, scope => registry.forScope(scope), context)];
  } };
  const plugins = layerPlugins([
    { ...charts, communication: registry.registration('charts', { publicApi: () => ({}) }) },
    { ...terrain, communication: registry.registration('terrain', terrain) },
    { ...plates, communication: registry.registration('plates', plates) },
    { ...obstructions, communication: registry.registration('obstructions', obstructions) },
    { ...navigation, communication: registry.registration('navigation', navigation) },
    { ...metar, communication: registry.registration('metar', metar) },
    { ...weatherAwc, communication: registry.registration('weather-awc', weatherAwc) },
    { ...routes, communication: registry.registration('routes', routes) },
    { ...ruler, communication: registry.registration('ruler', ruler) },
    { ...ownship, communication: registry.registration('ownship', { publicApi: () => ({}) }) },
    { ...ahrs, communication: registry.registration('ahrs', ahrs) },
  ] as const);
  return { charts, terrain, obstructions, navigation, metar, weatherAwc, plates, gps, ownship, ahrs, ruler, routes, plugins, registry, selectionInput, selectionContribution };
}
