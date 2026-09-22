import { createRulerLayer } from './layer';
import { RulerTool } from './controls';
import { createLayerInput } from '../../core/layers/input';
import type { LayerPlugin } from '../../core/layers/plugin';
import { useLayerSnapshot } from '../../core/layers/use-snapshot';

export function createRulerPlugin() {
  const layer = createRulerLayer();
  const input = createLayerInput<{ revision: string }>();
  function Overlay() {
    const state = useLayerSnapshot(input);
    return state ? <RulerTool layer={layer} revision={state.revision} /> : null;
  }
  return {
    ...layer, input,
    overlays: [{ id: 'ruler', Component: Overlay }],
    mapContribution: { id: 'ruler', async load(context) {
      const { createRulerMapLayer } = await import('./map');
      return [createRulerMapLayer(layer, context.occupiedRects)];
    } },
    dispose: layer.close,
  } satisfies LayerPlugin & typeof layer & { input: typeof input };
}
