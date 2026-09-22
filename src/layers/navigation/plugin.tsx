import { pluginStorage } from './storage';
import { navigationPreferences } from './preferences';
import type { GeoPointFeature, NavigationData } from '@zlayer/contracts';
import type { FixMapContext } from './fix-display';
import type { NavaidIdentification } from './identification-layer';
import { NavigationControls, type NavigationControlsInput } from './controls';
import { createLayerInput, selectLayerStore } from '../../core/layers/input';
import type { LayerPlugin } from '../../core/layers/plugin';
import { useLayerSnapshot } from '../../core/layers/use-snapshot';
import { bindMapLayer } from '../../core/map/contribution';

export function createNavigationPlugin() {
  const input = createLayerInput<NavigationControlsInput & {
    data: NavigationData; fixContext: FixMapContext;
    identification: NavaidIdentification | undefined; inspectedCoordinate: GeoPointFeature | undefined;
  }>();
  const controlsInput = selectLayerStore(input, state => state && ({ catalog: state.catalog, visibility: state.visibility,
    fixDisplay: state.fixDisplay, navigationData: state.navigationData, loadState: state.loadState,
    onFixDisplayChange: state.onFixDisplayChange, onVisibilityChange: state.onVisibilityChange }));
  function Controls() {
    const state = useLayerSnapshot(controlsInput);
    return state ? <NavigationControls {...state} /> : null;
  }
  return {
    storage: pluginStorage, preferences: navigationPreferences,
    definition: { id: 'navigation', title: 'Navigation' }, input,
    controls: [{ id: 'navigation', Component: Controls }],
    mapContribution: { id: 'navigation', async load() {
      const [{ createNavigationLayer, createWaypointInspectionLayer }, { createNavaidIdentificationLayer }] =
        await Promise.all([import('./map'), import('./identification-layer')]);
      return [bindMapLayer(createNavigationLayer(), input.select(({ data, visibility, fixContext }) => ({ data, visibility, ...fixContext }))),
        bindMapLayer(createWaypointInspectionLayer(), input.select(state => state.inspectedCoordinate)),
        bindMapLayer(createNavaidIdentificationLayer(), input.select(state => state.identification))];
    } },
  } satisfies LayerPlugin & { input: typeof input };
}
