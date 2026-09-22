import { pluginStorage } from './storage';
import { ownshipPreferences } from './preferences';
import { createOwnshipLayer } from './layer';
import { OwnshipStatus } from './controls';
import { createLayerInput } from '../../core/layers/input';
import type { LayerPlugin } from '../../core/layers/plugin';
import { useLayerSnapshot } from '../../core/layers/use-snapshot';
import { ToolPanel } from '../../core/ui/tool-panel';
import { bindMapLayer } from '../../core/map/contribution';
import type { GpsService } from '../../core/gps/service';

export function createOwnshipPlugin(gps: GpsService) {
  const layer = createOwnshipLayer(gps);
  const input = createLayerInput<{ enabled: boolean; onToggle(): void }>();
  function Panel() {
    const state = useLayerSnapshot(input);
    if (!state) return null;
    return <ToolPanel className="map-edge-gps" icon={<><circle cx="12" cy="12" r="6" />
      <path d="M12 2v4m0 12v4M2 12h4m12 0h4" /><circle cx="12" cy="12" r="1" /></>}>
      <OwnshipStatus layer={layer} {...state} />
    </ToolPanel>;
  }
  return {
    storage: pluginStorage, preferences: ownshipPreferences,
    ...layer, input,
    panels: [{ id: 'gps', title: 'GPS status', Component: Panel }],
    mapContribution: { id: 'ownship', async load(context) {
      // Only restored GPS state suppresses the first recenter. An off/on action
      // during loading is an explicit request, even if GPS started enabled.
      let preserveInitialView = context.preserveView && input.require().enabled;
      const stop = input.subscribe(() => { if (!input.require().enabled) preserveInitialView = false; });
      context.signal.addEventListener('abort', stop, { once: true });
      try {
        const { createOwnshipMapLayer } = await import('./map');
        context.signal.throwIfAborted();
        return [bindMapLayer(createOwnshipMapLayer(layer, preserveInitialView),
          input.select(({ enabled }) => ({ enabled })))];
      } finally {
        stop();
        context.signal.removeEventListener('abort', stop);
      }
    } },
    dispose: () => layer.detach(),
  } satisfies LayerPlugin & typeof layer & { input: typeof input };
}
