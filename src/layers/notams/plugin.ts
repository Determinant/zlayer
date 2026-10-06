import type { LayerPlugin } from '../../core/layers/plugin';
import type { PluginExports } from '../../core/layers/bridge';
import type { NotamsApi } from './public';
import { createNotamsClient } from './client';
import { pluginStorage } from './storage';
import { createNotamMapPreviews } from './map-state';
import { combineLayerStores, createLayerStore, createLayerInput, selectLayerStore } from '../../core/layers/store';
import type { NavigationData } from '@zlayer/contracts';
import { createNotamAreaReferences } from './area-references';
import { bindMapLayer } from '../../core/map/contribution';
import { createTfrClient } from './tfr-client';
import { createTfrDetails, createTfrStatus } from './tfr-ui';
import { selectedTfrAreas, type TfrAreaSelection } from './tfr-selection';

export function createNotamsPlugin() {
  const input = createLayerInput<NavigationData>();
  let previous: NavigationData | undefined, resolve: ReturnType<typeof createNotamAreaReferences> | undefined;
  const references = selectLayerStore(input, data => {
    if (data !== previous) { previous = data; resolve = data ? createNotamAreaReferences(data) : undefined; }
    return resolve;
  });
  const client = createNotamsClient();
  const tfrs = createTfrClient();
  const selection = createLayerStore<readonly TfrAreaSelection[]>([]);
  const clearSelection = () => selection.publish([]);
  let inspectAt: ((point: { x: number; y: number }) => TfrAreaSelection[]) | undefined;
  const previews = createNotamMapPreviews();
  const content = combineLayerStores(previews.state, client.state, (records, state) => ({ records, now: state.now }));
  const highlighted = combineLayerStores(content, previews.highlighted, (content, highlighted) => ({ ...content, highlighted }));
  const mapInput = combineLayerStores(highlighted, references, (content, references) => ({ ...content, references }));
  const tfrInput = combineLayerStores(tfrs.state, previews.highlightedTfr, (state, highlighted) => ({ ...state, highlighted }));
  const stop = () => { clearSelection(); previews.clear(); client.stop(); tfrs.stop(); };
  return {
    definition: { id: 'notams', title: 'NOTAMs' }, storage: pluginStorage, input,
    publicApi(scope) {
      client.start(); tfrs.start(); scope.add(stop);
      return { contextActions: scope.command(point => {
        const selected = inspectAt?.(point) ?? [];
        if (!selected.length) return [];
        return [{ id: 'notams:inspect-tfr', label: 'Inspect TFRs', select: scope.command(() => {
          if (inspectAt && selectedTfrAreas(tfrs.state.getSnapshot(), selected).length) selection.publish(selected);
        }) }];
      }), state: scope.store(client.state), charted: scope.store(previews.charted), chartedTfrs: scope.store(previews.chartedTfrs), retain: scope.command((query, online) => scope.add(client.retain(query, online))),
        previewChart: scope.command(() => {
          const preview = previews.open();
          return { update: scope.command(preview.update), highlight: scope.command(preview.highlight), release: scope.add(preview.release) };
        }),
        retry: scope.command(client.retry) };
    },
    mapContribution: { id: 'notams', async load() {
      const [{ createNotamChartLayer }, { createTfrMapLayer }] = await Promise.all([import('./map'), import('./tfr-map')]);
      const layer = createTfrMapLayer(previews.showTfrs), bound = bindMapLayer(layer, tfrInput);
      return [{ ...bound,
        mount(map) { bound.mount(map); inspectAt = layer.inspectAt; },
        unmount() { if (inspectAt === layer.inspectAt) { inspectAt = undefined; clearSelection(); } bound.unmount(); },
      }, bindMapLayer(createNotamChartLayer(previews.show), mapInput)];
    } },
    panels: [{ id: 'notams-tfr-details', title: 'TFR details', Component: createTfrDetails(tfrs.state, selection, clearSelection), close: clearSelection }],
    footer: [{ id: 'notams-tfr-status', Component: createTfrStatus(tfrs.state) }],
    dispose: stop,
  } satisfies LayerPlugin & PluginExports<NotamsApi> & { input: typeof input };
}
