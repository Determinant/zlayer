import { createRulerLayer } from './layer';
import { RulerTool } from './controls';
import type { RulerApi } from './public';
import type { PluginExports } from '../../core/layers/bridge';
import { createLayerInput, selectLayerStore } from '../../core/layers/input';
import type { LayerPlugin } from '../../core/layers/plugin';
import { useLayerSnapshot } from '../../core/layers/use-snapshot';

export function createRulerPlugin() {
  const layer = createRulerLayer();
  const input = createLayerInput<{ revision: string }>();
  function Overlay() {
    const state = useLayerSnapshot(input);
    return state ? <RulerTool layer={layer} revision={state.revision} /> : null;
  }
  const active = selectLayerStore(layer, state => state.active);
  return {
    publicApi: scope => ({ active: scope.store(active) }),
    ...layer, input,
    overlays: [{ id: 'ruler', Component: Overlay }],
    mapContribution: { id: 'ruler', async load(context) {
      const { createRulerMapLayer } = await import('./map');
      return [createRulerMapLayer(layer, context.occupiedRects)];
    } },
    dispose: layer.close,
  } satisfies LayerPlugin & PluginExports<RulerApi> & { input: typeof input };
}
