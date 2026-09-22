import { pluginStorage } from './storage';
import { chartPreferences } from './preferences';
import type { ChartLayerInput } from './layer';
import type { ComponentProps } from 'react';
import { createLayerInput, selectLayerStore } from '../../core/layers/input';
import type { LayerPlugin } from '../../core/layers/plugin';
import { useLayerSnapshot } from '../../core/layers/use-snapshot';
import { ToolPanel } from '../../core/ui/tool-panel';
import { bindMapLayer } from '../../core/map/contribution';
import { ChartControls } from './controls';
import { ChartMenuFooter } from './menu-footer';
import { ChartStatus, type ChartStatusInput } from './status';

export function createChartsPlugin() {
  const input = createLayerInput<ChartLayerInput & ChartStatusInput &
    Pick<ComponentProps<typeof ChartControls>, 'onBaseChange' | 'onOverlayChange'>>();
  const controlsInput = selectLayerStore(input, state => state && ({ charts: state.catalog.charts,
    selection: state.chartSelection, onBaseChange: state.onBaseChange, onOverlayChange: state.onOverlayChange }));
  const footerInput = selectLayerStore(input, state => state && ({ catalog: state.catalog, chartSelection: state.chartSelection }));
  const statusInput = selectLayerStore(input, state => state && ({ chartSelection: state.chartSelection,
    chartCacheState: state.chartCacheState, activeChartTitle: state.activeChartTitle, activeChartCount: state.activeChartCount,
    savedEditions: state.savedEditions, savedEditionDetails: state.savedEditionDetails, routingRevision: state.routingRevision }));
  function Controls() {
    const state = useLayerSnapshot(controlsInput);
    return state ? <ChartControls {...state} /> : null;
  }
  function Footer() {
    const state = useLayerSnapshot(footerInput);
    return state ? <ChartMenuFooter {...state} /> : null;
  }
  function Panel() {
    const state = useLayerSnapshot(statusInput);
    return state ? <ToolPanel className="map-edge-charts" icon={<><path d="m3 5 6-2 6 2 6-2v16l-6 2-6-2-6 2Z" /><path d="M9 3v16M15 5v16" /></>}>
      <ChartStatus {...state} />
    </ToolPanel> : null;
  }
  return {
    storage: pluginStorage, preferences: chartPreferences,
    definition: { id: 'charts', title: 'Charts' }, input,
    controls: [{ id: 'charts', Component: Controls }],
    footer: [{ id: 'chart-stack', Component: Footer }],
    panels: [{ id: 'charts', title: 'chart status', Component: Panel }],
    mapContribution: { id: 'charts', async load(context) {
      const { createChartMapLayers } = await import('./map');
      context.signal.throwIfAborted();
      return createChartMapLayers(input.require().catalog).map(layer =>
        bindMapLayer(layer, input.select(({ catalog, selection }) => ({ catalog, selection }))));
    } },
  } satisfies LayerPlugin & { input: typeof input; footer: { id: string; Component: typeof Footer }[] };
}
