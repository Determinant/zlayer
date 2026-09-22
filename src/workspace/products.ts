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
import { layerPlugins, type LayerPlugin } from '../core/layers/plugin';
import type { MapContribution } from '../core/map/contribution';
import { createGpsService } from '../core/gps/service';

/** Explicit typed composition. Feature lifetimes outlive map and panel attachments. */
export function createWorkspaceLayers() {
  const charts = createChartsPlugin();
  const terrain = createTerrainPlugin();
  const obstructions = createObstructionsPlugin();
  const navigation = createNavigationPlugin();
  const metar = createMetarPlugin();
  const plates = createPlatesLayer();
  const gps = createGpsService();
  const ownship = createOwnshipPlugin(gps);
  const ahrs = createAhrsPlugin(gps);
  const ruler = createRulerPlugin();
  const routes = createRoutesPlugin();
  const selectionDependencies = { activeTool: ruler, contextAction: plates.contextAction, editing: routes.editing };
  const selectionContribution: MapContribution = { id: 'workspace-selection', async load(context) {
    const { createSelectionContribution } = await import('./map/selection');
    return [createSelectionContribution(routes.input, selectionDependencies, context)];
  } };
  const plugins: readonly LayerPlugin[] = layerPlugins([charts, terrain, plates, obstructions, navigation, metar, routes, ruler, ownship, ahrs]);
  return { charts, terrain, obstructions, navigation, metar, plates, gps, ownship, ahrs, ruler, routes, plugins, selectionContribution };
}
