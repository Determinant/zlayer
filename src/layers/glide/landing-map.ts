import type { Map as MapLibreMap, GeoJSONSource, ExpressionSpecification } from 'maplibre-gl';
import { WorkerClient } from '../../core/data/worker-client';
import { WEATHER_LAYER_ANCHOR, removeLayerResources, type MapLayerModule } from '../../core/map/layer';
import { chartRoot } from '../../workspace/catalog/feed';
import type { Segment } from '../../core/geo/route-corridor';
import { emptyLandings, type LandingStatus } from './landing-data';
import type { LandingWorker } from './landing-planner';

export type LandingInput = { enabled: boolean; segments: Segment[]; retry: number };
const SOURCE = 'glide-landing-areas', LAYERS = ['glide-landing-fill', 'glide-landing-trim', 'glide-landing-outline'];
const colors: ExpressionSpecification = ['match', ['get', 'tier'], 2, '#9bdf77', '#b7a4f3'];

export function createLandingLayer(onStatus: (status: LandingStatus) => void): MapLayerModule<LandingInput> {
  let map: MapLibreMap | undefined, client: WorkerClient<LandingWorker> | undefined;
  let input: LandingInput = { enabled: false, segments: [], retry: 0 }, routeKey = '', revision = 0, renderedKey: string | undefined;
  let running: { revision: number } | undefined, queued = false, revalidate = true, lastCheck = -Infinity;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let lastStatus: LandingStatus = { state: 'idle' };
  const status = (next: LandingStatus) => { lastStatus = next; onStatus(next); };
  const clear = () => { renderedKey = undefined; map?.getSource<GeoJSONSource>(SOURCE)?.setData(emptyLandings()); };
  const cancel = () => { revision++; const id = running?.revision; if (id !== undefined && client) void client.call(worker => worker.cancel(id)).catch(() => {}); };
  const release = () => { client?.dispose(); client = undefined; running = undefined; queued = false; renderedKey = undefined; };
  const query = async () => {
    timer = undefined;
    if (!map || !input.enabled || !input.segments.length || document.hidden || map.isMoving()) return;
    if (running) { queued = true; return; }
    const job = running = { revision }, bounds = map.getBounds();
    const width = bounds.getEast() - bounds.getWest(), height = bounds.getNorth() - bounds.getSouth();
    const discover = map.getZoom() >= 7 && width <= 45 && height <= 25;
    const check = revalidate || Date.now() < lastCheck || Date.now() - lastCheck >= 5 * 60_000;
    if (check && discover) { revalidate = false; lastCheck = Date.now(); }
    status({ ...lastStatus, state: discover ? 'loading' : 'zoom' });
    try {
      if (!client || client.retired) {
        client = new WorkerClient<LandingWorker>(new Worker(new URL('./landing.worker.ts', import.meta.url), { type: 'module' }), 'Landing areas unavailable');
        renderedKey = undefined;
      }
      const result = await client.call(worker => worker.query({ id: job.revision,
        manifestUrl: new URL(`${chartRoot()}/glide/manifest.json`, location.href).href,
        bounds: [bounds.getWest(), bounds.getSouth(), bounds.getEast(), bounds.getNorth()], segments: input.segments,
        discover, revalidate: check, ...(renderedKey === undefined ? {} : { renderedKey }),
      }));
      if (!map || job.revision !== revision) return;
      if (result.collection) map.getSource<GeoJSONSource>(SOURCE)?.setData(result.collection);
      renderedKey = result.renderKey; status(result.status);
    } catch {
      if (map && job.revision === revision) status({ ...lastStatus, state: 'error' });
    } finally {
      if (running === job) {
        running = undefined;
        if (queued) { queued = false; schedule(); }
      }
    }
  };
  const schedule = () => {
    clearTimeout(timer); timer = undefined;
    if (!map) return;
    if (!input.enabled || !input.segments.length) {
      clear(); release(); status({ state: input.enabled ? 'route' : 'idle' }); return;
    }
    if (document.hidden) return;
    if (running) { queued = true; return; }
    timer = setTimeout(() => { void query(); }, 150);
  };
  const moving = () => { clearTimeout(timer); timer = undefined; };
  const recover = () => { revalidate = true; cancel(); schedule(); };
  return {
    id: 'glide-landings', slot: 'weather',
    mount(target) {
      map = target;
      map.addSource(SOURCE, { type: 'geojson', data: emptyLandings(),
        attribution: 'Landing candidates: USGS, USDA Forest Service, FAA, <a href="https://docs.overturemaps.org/attribution/">Overture Maps</a>; <a href="https://www.openstreetmap.org/copyright">© OpenStreetMap contributors</a>' });
      const before = map.getLayer('glide-outline-trim') ? 'glide-outline-trim'
        : map.getLayer(WEATHER_LAYER_ANCHOR) ? WEATHER_LAYER_ANCHOR : undefined;
      map.addLayer({ id: LAYERS[0]!, type: 'fill', source: SOURCE,
        paint: { 'fill-color': colors, 'fill-opacity': 0.5, 'fill-antialias': false } }, before);
      map.addLayer({ id: LAYERS[1]!, type: 'line', source: SOURCE,
        paint: { 'line-color': '#242333', 'line-width': 3, 'line-opacity': 0.8 } }, before);
      map.addLayer({ id: LAYERS[2]!, type: 'line', source: SOURCE,
        paint: { 'line-color': colors, 'line-width': 1.5 } }, before);
      map.on('movestart', moving); map.on('moveend', schedule); map.on('resize', schedule);
      window.addEventListener('online', recover); document.addEventListener('visibilitychange', schedule);
      schedule();
    },
    update(next) {
      const nextKey = JSON.stringify(next.segments), changed = nextKey !== routeKey || next.enabled !== input.enabled;
      const retry = next.retry !== input.retry;
      input = next; routeKey = nextKey;
      if (!changed && !retry) return;
      cancel();
      if (changed) clear(); // A previous route must not survive a route edit or loss.
      if (retry) revalidate = true;
      schedule();
    },
    unmount() {
      cancel(); clearTimeout(timer); timer = undefined; release();
      window.removeEventListener('online', recover); document.removeEventListener('visibilitychange', schedule);
      if (map) {
        map.off('movestart', moving); map.off('moveend', schedule); map.off('resize', schedule);
        removeLayerResources(map, [...LAYERS].reverse(), [SOURCE]);
      }
      map = undefined; status({ state: 'idle' });
    },
  };
}
