import type { Map as MapLibreMap } from 'maplibre-gl';
import type { RoutePlan } from '@zlayer/domain';
import type { Bounds } from '@zlayer/contracts';
import { WorkerClient } from '../../core/data/worker-client';
import { removeLayerResources, type MapLayerModule } from '../../core/map/layer';
import { chartRoot } from '../../workspace/catalog/feed';
import { routeSegments, type Segment } from '../../core/geo/route-corridor';
import { OBSTRUCTION_SOURCE, OBSTRUCTION_LAYER, obstructionMinHeight, OBSTRUCTION_ICONS } from './definitions';
import { emptyObstructions, installObstructions, syncObstructions } from './renderer';
import { paddedObstructionBounds, obstructionBoundsContain, obstructionCountInView } from './coverage';
import type { ObstructionCollection, ObstructionStatus, ObstructionWorker } from './types';

export type ObstructionInput = { enabled: boolean; routes: readonly RoutePlan[] };
type Coverage = { bounds: Bounds; zoom: number; sourceDate?: string };

function covers(coverage: Coverage | undefined, view: Coverage, padding: number): boolean {
  return !!coverage && Math.floor(coverage.zoom) === Math.floor(view.zoom) &&
    obstructionBoundsContain(coverage.bounds, paddedObstructionBounds(view.bounds, padding));
}

export function createObstructionLayer(onStatus: (status: ObstructionStatus) => void = () => {}): MapLayerModule<ObstructionInput> {
  let map: MapLibreMap | undefined, client: WorkerClient<ObstructionWorker> | undefined;
  let input: ObstructionInput = { enabled: true, routes: [] }, segments: Segment[] = [], key = '', revision = 0;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let running: (Coverage & { revision: number }) | undefined, queryAgain = false;
  let coverage: Coverage | undefined;
  let previousStatus = '';
  let collection = emptyObstructions();
  const view = (): Coverage => {
    const bounds = map!.getBounds();
    return { bounds: [bounds.getWest(), bounds.getSouth(), bounds.getEast(), bounds.getNorth()], zoom: map!.getZoom() };
  };
  const context = (zoom: number) => {
    const minHeightAglFt = obstructionMinHeight(zoom);
    return { routeContext: segments.length > 0, ...(minHeightAglFt === undefined ? {} : { minHeightAglFt }) };
  };
  const status = (next: ObstructionStatus) => {
    const key = JSON.stringify(next);
    if (key !== previousStatus) { previousStatus = key; onStatus(next); }
  };
  const ready = (current: Coverage) => status({ state: 'ready', ...context(current.zoom),
    count: obstructionCountInView(collection, current.bounds, current.zoom),
    ...(coverage?.sourceDate ? { sourceDate: coverage.sourceDate } : {}) });
  const publish = (next: ObstructionCollection) => {
    collection = next;
    if (map) syncObstructions(map, next);
  };
  const release = () => { client?.dispose(); client = undefined; running = undefined; queryAgain = false; };
  const query = async (): Promise<void> => {
    timer = undefined;
    if (!map || !input.enabled) return;
    const zoom = map.getZoom(), minHeightAglFt = obstructionMinHeight(zoom);
    if (minHeightAglFt === undefined && !segments.length) return;
    // During the initial national load, rapid map/route changes must not queue
    // a separate GeoJSON allocation and worker transfer for every obsolete view.
    if (running) { queryAgain = true; return; }
    // Half a viewport on each side; refill when only a quarter remains. The
    // outer margin lets nearby points render while a replacement query runs.
    const job = running = { bounds: paddedObstructionBounds(view().bounds, 0.5), zoom, revision };
    status({ state: 'loading', ...context(zoom) });
    try {
      if (!client || client.retired) client = new WorkerClient<ObstructionWorker>(
        new Worker(new URL('./obstructions.worker.ts', import.meta.url), { type: 'module' }), 'Obstruction worker unavailable');
      const result = await client.call(remote => remote.query({
        manifestUrl: new URL(`${chartRoot()}/obstacles/manifest.json`, location.href).href,
        bounds: job.bounds, segments, zoom,
      }));
      if (!map || job.revision !== revision) return;
      const current = view();
      if (!covers(job, current, 0) || (covers(coverage, current, 0.25) && !covers(job, current, 0.25))) {
        queryAgain = true; return;
      }
      coverage = { ...job, ...(result.sourceDate ? { sourceDate: result.sourceDate } : {}) };
      publish(result.collection);
      ready(current);
      queryAgain = !covers(coverage, current, 0.25);
    } catch {
      if (map && job.revision === revision) {
        const current = view();
        if (covers(coverage, current, 0.25)) {
          // A pan can return to its warm buffer while a now-unneeded refill
          // fails. That failure must not erase valid points already in view.
          queryAgain = false; ready(current);
        } else if (covers(job, current, 0)) {
          coverage = undefined; queryAgain = false;
          publish(emptyObstructions()); status({ state: 'error', ...context(map.getZoom()) });
        } else queryAgain = true;
      }
    } finally {
      if (running === job) {
        running = undefined;
        if (queryAgain) {
          queryAgain = false;
          clearTimeout(timer); timer = undefined;
          refreshView(true);
        }
      }
    }
  };
  const refreshView = (report = false): void => {
    if (!map) return;
    if (!input.enabled) {
      clearTimeout(timer); timer = undefined; coverage = undefined;
      release();
      if (collection.features.length) publish(emptyObstructions());
      status({ state: 'idle' }); return;
    }
    const current = view(), minHeightAglFt = obstructionMinHeight(current.zoom);
    if (minHeightAglFt === undefined && !segments.length) {
      clearTimeout(timer); timer = undefined; coverage = undefined; queryAgain = false;
      if (collection.features.length) publish(emptyObstructions());
      status({ state: 'zoom' }); return;
    }
    if (covers(coverage, current, 0.25)) {
      clearTimeout(timer); timer = undefined; queryAgain = false;
      if (report) ready(current);
      return;
    }
    status({ state: 'loading', ...context(current.zoom) });
    if (running) {
      queryAgain = running.revision !== revision || !covers(running, current, 0.25);
      return;
    }
    // Throttle instead of restarting the delay on every move: continuous pans
    // must be able to fill their next buffer before moveend.
    if (timer === undefined) timer = setTimeout(() => { void query(); }, 80);
  };
  const moving = () => refreshView();
  const moved = () => refreshView(true);
  const refresh = () => {
    revision++; coverage = undefined; clearTimeout(timer); timer = undefined;
    refreshView(true);
  };
  return {
    id: 'obstructions', slot: 'navigation', foregroundLayerIds: [OBSTRUCTION_LAYER],
    mount(target) {
      map = target; installObstructions(map);
      map.on('move', moving); map.on('moveend', moved); map.on('resize', moved);
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
        map.off('move', moving); map.off('moveend', moved); map.off('resize', moved);
        removeLayerResources(map, [OBSTRUCTION_LAYER], [OBSTRUCTION_SOURCE]);
        for (const icon of OBSTRUCTION_ICONS) if (map.hasImage(icon)) map.removeImage(icon);
      }
      map = undefined; coverage = undefined; collection = emptyObstructions();
    },
  };
}
