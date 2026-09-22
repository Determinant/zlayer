import { pluginStorage } from './storage';
import { terrainPreferences } from './preferences';
import type { RoutePlan } from '@zlayer/domain';
import type { CatalogReadSource } from '../../workspace/read-context';
import { createLayerInput, selectLayerStore } from '../../core/layers/input';
import type { LayerPlugin } from '../../core/layers/plugin';
import { createLayerStore } from '../../core/layers/store';
import { useLayerSnapshot } from '../../core/layers/use-snapshot';
import { ToolPanel } from '../../core/ui/tool-panel';
import { bindMapLayer } from '../../core/map/contribution';
import { TerrainControls, TerrainLegend } from './controls';
import type { TerrainCoverage, TerrainStatus } from './types';

export type TerrainPluginInput = {
  enabled: boolean; routes: readonly RoutePlan[]; catalog: CatalogReadSource;
  altitude: number | null; coverage: TerrainCoverage;
  onToggle(): void; onAltitudeChange(value: number | null): void; onCoverageChange(value: TerrainCoverage): void;
};

export function createTerrainPlugin() {
  const input = createLayerInput<TerrainPluginInput>();
  const status = createLayerStore<TerrainStatus>({ state: 'idle', interval: 1000 });
  const controlsInput = selectLayerStore(input, state => state && ({ enabled: state.enabled, coverage: state.coverage,
    onToggle: state.onToggle, onCoverageChange: state.onCoverageChange }));
  const panelInput = selectLayerStore(input, state => state && ({ enabled: state.enabled, altitude: state.altitude,
    coverage: state.coverage, onToggle: state.onToggle, onAltitudeChange: state.onAltitudeChange, onCoverageChange: state.onCoverageChange }));
  function Controls() {
    const state = useLayerSnapshot(controlsInput), current = useLayerSnapshot(status);
    return state ? <TerrainControls {...state} status={current} /> : null;
  }
  function Panel() {
    const state = useLayerSnapshot(panelInput), current = useLayerSnapshot(status);
    return state ? <ToolPanel className="map-edge-terrain" icon={<><path d="m2 20 7-14 5 9 3-5 5 10ZM6 12l3 2 3-2" /></>}>
      <TerrainLegend {...state} status={current} />
    </ToolPanel> : null;
  }
  return {
    storage: pluginStorage, preferences: terrainPreferences,
    definition: { id: 'terrain', title: 'Terrain' }, input, status,
    controls: [{ id: 'terrain', Component: Controls }],
    panels: [{ id: 'terrain', title: 'terrain toolbox', Component: Panel }],
    mapContribution: { id: 'terrain', async load() {
      const { createTerrainLayer } = await import('./map');
      return [bindMapLayer(createTerrainLayer(status.publish),
        input.select(({ enabled, routes, catalog, altitude, coverage }) => ({ enabled, routes, catalog, altitude, coverage })))];
    } },
  } satisfies LayerPlugin & { input: typeof input; status: typeof status };
}
