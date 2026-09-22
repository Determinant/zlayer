import type { RoutesApi } from '../routes/public';
import type { PluginExports } from '../../core/layers/bridge';
import { createLayerStore } from '../../core/layers/store';
import { pluginStorage } from './storage';
import { emptyRoutePlan } from '@zlayer/domain';
import { createAhrsLayer, type AhrsGpsSource } from './layer';
import { AhrsPanel } from './panel';
import { createLayerInput, combineLayerStores } from '../../core/layers/input';
import type { LayerPlugin } from '../../core/layers/plugin';
import { useLayerSnapshot } from '../../core/layers/use-snapshot';

export function createAhrsPlugin(gps: AhrsGpsSource) {
  const layer = createAhrsLayer(gps);
  const input = createLayerInput<{ revision: string }>();
  const empty = emptyRoutePlan(), route = createLayerStore(empty);
  const panelInput = combineLayerStores(input, route, (state, route) => state && ({ ...state, route }));
  function Panel() {
    const state = useLayerSnapshot(panelInput);
    return state ? <AhrsPanel layer={layer} {...state} /> : null;
  }
  return {
    publicApi: () => ({}),
    connect(bridge, scope) {
      scope.add(() => route.publish(empty));
      bridge.watch('routes', (api, connection) => {
        if (api) connection.observe(api.plan, route.publish);
        else route.publish(empty);
      });
    },
    ...layer, input, storage: pluginStorage,
    panels: [{ id: 'ahrs', title: 'AHRS toolbox', Component: Panel }],
    dispose: layer.stop,
  } satisfies LayerPlugin & PluginExports<object, { routes: RoutesApi }> & { input: typeof input };
}
