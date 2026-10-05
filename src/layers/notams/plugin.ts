import type { LayerPlugin } from '../../core/layers/plugin';
import type { PluginExports } from '../../core/layers/bridge';
import type { NotamsApi } from './public';
import { createNotamsClient } from './client';
import { pluginStorage } from './storage';
import { createNotamMapPreviews } from './map-state';
import { combineLayerStores, createLayerStore } from '../../core/layers/store';
import { bindMapLayer } from '../../core/map/contribution';
import { createTfrClient } from './tfr-client';
import { createTfrDetails, createTfrStatus } from './tfr-ui';
import { selectedTfrAreas, type TfrAreaSelection } from './tfr-selection';

export function createNotamsPlugin() {
  const client = createNotamsClient();
  const tfrs = createTfrClient();
  const selection = createLayerStore<readonly TfrAreaSelection[]>([]);
  const clearSelection = () => selection.publish([]);
  let inspectAt: ((point: { x: number; y: number }) => TfrAreaSelection[]) | undefined;
  const previews = createNotamMapPreviews();
  const input = combineLayerStores(previews.state, client.state, (records, state) => ({ records, now: state.now }));
  const stop = () => { clearSelection(); previews.clear(); client.stop(); tfrs.stop(); };
  return {
    definition: { id: 'notams', title: 'NOTAMs' }, storage: pluginStorage,
    publicApi(scope) {
      client.start(); tfrs.start(); scope.add(stop);
      return { contextActions: scope.command(point => {
        const selected = inspectAt?.(point) ?? [];
        if (!selected.length) return [];
        return [{ id: 'notams:inspect-tfr', label: 'Inspect TFRs', select: scope.command(() => {
          if (inspectAt && selectedTfrAreas(tfrs.state.getSnapshot(), selected).length) selection.publish(selected);
        }) }];
      }), state: scope.store(client.state), charted: scope.store(previews.charted), retain: scope.command((query, online) => scope.add(client.retain(query, online))),
        previewChart: scope.command(() => {
          const preview = previews.open();
          return { update: scope.command(preview.update), release: scope.add(preview.release) };
        }),
        retry: scope.command(client.retry) };
    },
    mapContribution: { id: 'notams', async load() {
      const [{ createNotamChartLayer }, { createTfrMapLayer }] = await Promise.all([import('./map'), import('./tfr-map')]);
      const layer = createTfrMapLayer(), bound = bindMapLayer(layer, tfrs.state);
      return [{ ...bound,
        mount(map) { bound.mount(map); inspectAt = layer.inspectAt; },
        unmount() { if (inspectAt === layer.inspectAt) { inspectAt = undefined; clearSelection(); } bound.unmount(); },
      }, bindMapLayer(createNotamChartLayer(previews.show), input)];
    } },
    panels: [{ id: 'notams-tfr-details', title: 'TFR details', Component: createTfrDetails(tfrs.state, selection, clearSelection), close: clearSelection }],
    footer: [{ id: 'notams-tfr-status', Component: createTfrStatus(tfrs.state) }],
    dispose: stop,
  } satisfies LayerPlugin & PluginExports<NotamsApi>;
}
