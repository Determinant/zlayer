import { pluginStorage } from './storage';
import type { RoutePlan } from '@zlayer/domain';
import { createAhrsLayer, type AhrsGpsSource } from './layer';
import { AhrsPanel } from './panel';
import { createLayerInput } from '../../core/layers/input';
import type { LayerPlugin } from '../../core/layers/plugin';
import { useLayerSnapshot } from '../../core/layers/use-snapshot';

export function createAhrsPlugin(gps: AhrsGpsSource) {
  const layer = createAhrsLayer(gps);
  const input = createLayerInput<{ route: RoutePlan; revision: string }>();
  function Panel() {
    const state = useLayerSnapshot(input);
    return state ? <AhrsPanel layer={layer} {...state} /> : null;
  }
  return {
    ...layer, input, storage: pluginStorage,
    panels: [{ id: 'ahrs', title: 'AHRS toolbox', Component: Panel }],
    dispose: layer.stop,
  } satisfies LayerPlugin & typeof layer & { input: typeof input };
}
