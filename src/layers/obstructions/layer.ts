import type { Map as MapLibreMap } from 'maplibre-gl';
import type { RoutePlan } from '@zlayer/domain';
import { WorkerClient } from '../../core/data/worker-client';
import { removeLayerResources, type MapLayerModule } from '../../core/map/layer';
import { chartRoot } from '../../workspace/catalog/feed';
import { routeSegments, type Segment } from '../terrain/geometry';
import { OBSTRUCTION_SOURCE, OBSTRUCTION_LAYER, obstructionMinHeight, OBSTRUCTION_ICONS } from './definitions';
import { emptyObstructions, installObstructions, syncObstructions } from './renderer';
import type { ObstructionCollection, ObstructionStatus, ObstructionWorker } from './types';

export type ObstructionInput = { enabled: boolean; routes: readonly RoutePlan[] };

export function createObstructionLayer(onStatus: (status: ObstructionStatus) => void = () => {}): MapLayerModule<ObstructionInput> {
  let map: MapLibreMap | undefined, client: WorkerClient<ObstructionWorker> | undefined;
  let input: ObstructionInput = { enabled: true, routes: [] }, segments: Segment[] = [], key = '', revision = 0;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let collection = emptyObstructions();
  const publish = (next: ObstructionCollection) => {
    collection = next;
    if (map) syncObstructions(map, next);
  };
  const release = () => { client?.dispose(); client = undefined; };
  const query = async () => {
    timer = undefined;
    if (!map || !input.enabled) return;
    const zoom = map.getZoom(), minHeightAglFt = obstructionMinHeight(zoom);
    if (minHeightAglFt === undefined && !segments.length) return;
    const context = { routeContext: segments.length > 0,
      ...(minHeightAglFt === undefined ? {} : { minHeightAglFt }) };
    const request = ++revision;
    onStatus({ state: 'loading', ...context });
    try {
      if (!client || client.retired) client = new WorkerClient<ObstructionWorker>(
        new Worker(new URL('./obstructions.worker.ts', import.meta.url), { type: 'module' }), 'Obstruction worker unavailable');
      const bounds = map.getBounds();
      const result = await client.call(remote => remote.query({
        manifestUrl: new URL(`${chartRoot()}/obstacles/manifest.json`, location.href).href,
        bounds: [bounds.getWest(), bounds.getSouth(), bounds.getEast(), bounds.getNorth()], segments, zoom,
      }));
      if (!map || request !== revision) return;
      publish(result.collection);
      onStatus({ state: 'ready', count: result.collection.features.length, ...context,
        ...(result.sourceDate ? { sourceDate: result.sourceDate } : {}) });
    } catch {
      if (map && request === revision) {
        publish(emptyObstructions()); onStatus({ state: 'error', ...context });
      }
    }
  };
  const refresh = () => {
    revision++; clearTimeout(timer); timer = undefined;
    if (!map) return;
    if (!input.enabled) {
      release(); publish(emptyObstructions()); onStatus({ state: 'idle' }); return;
    }
    const minHeightAglFt = obstructionMinHeight(map.getZoom());
    if (minHeightAglFt === undefined && !segments.length) {
      publish(emptyObstructions()); onStatus({ state: 'zoom' }); return;
    }
    onStatus({ state: 'loading', routeContext: segments.length > 0,
      ...(minHeightAglFt === undefined ? {} : { minHeightAglFt }) });
    timer = setTimeout(() => { void query(); }, 80);
  };
  return {
    id: 'obstructions', slot: 'navigation', foregroundLayerIds: [OBSTRUCTION_LAYER],
    mount(target) {
      map = target; installObstructions(map);
      map.on('moveend', refresh); map.on('resize', refresh);
      window.addEventListener('online', refresh); refresh();
    },
    update(next) {
      const nextSegments = next.enabled ? routeSegments(next.routes) : [];
      const nextKey = JSON.stringify(nextSegments);
      const changed = next.enabled !== input.enabled || nextKey !== key;
      input = next; segments = nextSegments; key = nextKey;
      if (changed) {
        if (map && next.enabled) {
          // Preserve height-eligible points while the new corridor loads. Remove
          // the old route contribution so zooming out cannot bring it back.
          const zoom = map.getZoom();
          const features = collection.features.filter(point => zoom >= point.properties.minZoom)
            .map(point => point.properties.routeOpacity === 0 ? point
              : { ...point, properties: { ...point.properties, routeOpacity: 0 } });
          if (features.length !== collection.features.length || features.some((point, index) => point !== collection.features[index])) {
            publish({ type: 'FeatureCollection', features });
          }
        }
        refresh();
      }
    },
    unmount() {
      revision++; clearTimeout(timer); timer = undefined; release();
      window.removeEventListener('online', refresh);
      if (map) {
        map.off('moveend', refresh); map.off('resize', refresh);
        removeLayerResources(map, [OBSTRUCTION_LAYER], [OBSTRUCTION_SOURCE]);
        for (const icon of OBSTRUCTION_ICONS) if (map.hasImage(icon)) map.removeImage(icon);
      }
      map = undefined; collection = emptyObstructions();
    },
  };
}
