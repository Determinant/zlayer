import type { ObstructionApi } from './public';
import type { RoutePlan } from '@zlayer/domain';
import type { RoutesApi } from '../routes/public';
import type { PluginExports } from '../../core/layers/bridge';
import { pluginStorage } from './storage';
import { obstructionPreferences } from './preferences';
import { createLayerInput, selectLayerStore, combineLayerStores } from '../../core/layers/input';
import type { LayerPlugin } from '../../core/layers/plugin';
import { createLayerStore } from '../../core/layers/store';
import { useLayerSnapshot } from '../../core/layers/use-snapshot';
import { bindMapLayer } from '../../core/map/contribution';
import { ObstructionControls } from './controls';
import type { ObstructionInput } from './layer';
import type { ObstructionStatus } from './types';

export function createObstructionsPlugin() {
  const input = createLayerInput<Omit<ObstructionInput, 'routes'> & { onToggle(): void }>();
  const noRoutes: readonly RoutePlan[] = [];
  const routes = createLayerStore(noRoutes);
  const mapInput = combineLayerStores(input, routes, (state = input.require(), routes) => ({ enabled: state.enabled, routes }));
  const status = createLayerStore<ObstructionStatus>({ state: 'idle' });
  const controlsInput = selectLayerStore(input, state => state && ({ enabled: state.enabled, onToggle: state.onToggle }));
  function Controls() {
    const state = useLayerSnapshot(controlsInput), current = useLayerSnapshot(status);
    return state ? <ObstructionControls enabled={state.enabled} onToggle={state.onToggle} status={current} /> : null;
  }
  return {
    publicApi: scope => ({ status: scope.store(status) }),
    connect(bridge, scope) {
      scope.add(() => routes.publish(noRoutes));
      bridge.watch('routes', (api, connection) => {
        if (api) connection.observe(api.displayedRoutes, routes.publish);
        else routes.publish(noRoutes);
      });
    },
    storage: pluginStorage, preferences: obstructionPreferences,
    definition: { id: 'obstructions', title: 'Obstructions' }, input, status,
    controls: [{ id: 'obstructions', Component: Controls }],
    mapContribution: { id: 'obstructions', async load() {
      const { createObstructionLayer } = await import('./map');
      return [bindMapLayer(createObstructionLayer(status.publish), mapInput)];
    } },
  } satisfies LayerPlugin & PluginExports<ObstructionApi, { routes: RoutesApi }> & { input: typeof input; status: typeof status };
}
