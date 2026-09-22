import { pluginStorage } from './storage';
import { obstructionPreferences } from './preferences';
import { createLayerInput, selectLayerStore } from '../../core/layers/input';
import type { LayerPlugin } from '../../core/layers/plugin';
import { createLayerStore } from '../../core/layers/store';
import { useLayerSnapshot } from '../../core/layers/use-snapshot';
import { bindMapLayer } from '../../core/map/contribution';
import { ObstructionControls } from './controls';
import type { ObstructionInput } from './layer';
import type { ObstructionStatus } from './types';

export function createObstructionsPlugin() {
  const input = createLayerInput<ObstructionInput & { onToggle(): void }>();
  const status = createLayerStore<ObstructionStatus>({ state: 'idle' });
  const controlsInput = selectLayerStore(input, state => state && ({ enabled: state.enabled, onToggle: state.onToggle }));
  function Controls() {
    const state = useLayerSnapshot(controlsInput), current = useLayerSnapshot(status);
    return state ? <ObstructionControls enabled={state.enabled} onToggle={state.onToggle} status={current} /> : null;
  }
  return {
    storage: pluginStorage, preferences: obstructionPreferences,
    definition: { id: 'obstructions', title: 'Obstructions' }, input, status,
    controls: [{ id: 'obstructions', Component: Controls }],
    mapContribution: { id: 'obstructions', async load() {
      const { createObstructionLayer } = await import('./map');
      return [bindMapLayer(createObstructionLayer(status.publish), input.select(({ enabled, routes }) => ({ enabled, routes })))];
    } },
  } satisfies LayerPlugin & { input: typeof input; status: typeof status };
}
