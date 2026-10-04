import type { Map as MapLibreMap, ImageSource, ExpressionSpecification } from 'maplibre-gl';
import type { FeatureCollection } from 'geojson';
import { createSourceSubmission } from '../../core/map/source-submission';
import { WorkerClient } from '../../core/data/worker-client';
import { WEATHER_LAYER_ANCHOR, removeLayerResources, type MapLayerModule } from '../../core/map/layer';
import { jsonIdentity } from '../../core/data/json-identity';
import { landingSources } from './landing-sources';
import type { CatalogReadSource } from '../../workspace/read-context';
import { observeOfflineInventory } from '../../offline/inventory-events';
import { chartRoot } from '../../workspace/catalog/feed';
import { project, type Segment, type Point } from '../../core/geo/route-corridor';
import { emptyLandings, type LandingStatus, type LandingSelection } from './landing-data';
import type { LandingDisplayWorker } from './landing-display';
import { emptyAreas, type GlideAreas } from './types';
import type { LandingHeatImage } from './landing-heat';

export type LandingInput = { catalog?: CatalogReadSource | undefined; enabled: boolean; segments: Segment[]; ranges: GlideAreas; retry: number };
const HEAT = 'glide-landing-shading', RASTER = 'glide-landing-detail-image';
const SOURCE = 'glide-landing-areas', LAYERS = ['glide-landing-fill', 'glide-landing-trim', 'glide-landing-outline'];
const colors: ExpressionSpecification = ['match', ['get', 'tier'], 2, '#53e52d', '#a23bff'];

export function createLandingLayer(onStatus: (status: LandingStatus) => void): MapLayerModule<LandingInput> & { inspectAt(point: { x: number; y: number }): (() => Promise<LandingSelection | null>) | undefined } {
  let map: MapLibreMap | undefined, client: WorkerClient<LandingDisplayWorker> | undefined;
  let input: LandingInput = { enabled: false, segments: [], ranges: emptyAreas(), retry: 0 }, routeKey = '', rangeKey = '', revision = 0, renderedKey: string | undefined;
  let followingGps = false;
  let detailImage: LandingHeatImage | null = null;
  let running: { revision: number } | undefined, queued = false, revalidate = true, lastCheck = -Infinity;
  let timer: ReturnType<typeof setTimeout> | undefined, stopInventory: (() => void) | undefined;
  let sources = landingSources(undefined, "http://localhost/"), sourceIdentity = "";
  let lastStatus: LandingStatus = { state: 'idle' };
  const status = (next: LandingStatus) => { lastStatus = next; onStatus(next); };
  let submission: ReturnType<typeof createSourceSubmission> | undefined;
  let collection: FeatureCollection = emptyLandings(), retried = false;
  let retryTimer: ReturnType<typeof setTimeout> | undefined;
  let pendingKey: { key: string; revision: number; status: LandingStatus } | undefined;
  const vectorVisibility = (visible: boolean) => {
    const value = visible ? 'visible' : 'none';
    for (const id of LAYERS) if (map?.getLayer(id) && map.getLayoutProperty(id, 'visibility') !== value) map.setLayoutProperty(id, 'visibility', value);
  };
  const renderCollection = async (data: FeatureCollection, retry = false) => {
    collection = data;
    if (!retry) { retried = false; pendingKey = undefined; clearTimeout(retryTimer); retryTimer = undefined; }
    if (!data.features.length) vectorVisibility(false);
    const active = submission;
    if (!active) return false;
    const version = active.begin();
    try {
      const accepted = await active.submit(version, data);
      if (accepted) {
        vectorVisibility(data.features.length > 0);
        if (retry && pendingKey?.revision === revision) {
          renderedKey = pendingKey.key; status(pendingKey.status); pendingKey = undefined;
        }
      }
      return accepted;
    } catch (error) { active.reject(version, error); return false; }
  };
  const clearDetail = () => {
    renderedKey = `${renderedKey?.split('/')[0] ?? ''}/`;
    void renderCollection(emptyLandings());
    detailImage = null;
    if (map?.getLayer(RASTER)) map.setLayoutProperty(RASTER, 'visibility', 'none');
  };
  const clearHeat = () => {
    renderedKey = `/${renderedKey?.split('/')[1] ?? ''}`;
    if (map?.getLayer(HEAT)) map.setLayoutProperty(HEAT, 'visibility', 'none');
  };
  const clear = () => { clearDetail(); clearHeat(); };
  const hasTarget = () => input.segments.length > 0 || input.ranges.features.length > 0;
  const cancel = () => { revision++; const id = running?.revision; if (id !== undefined && client) void client.call(worker => worker.cancel(id)).catch(() => {}); };
  const release = () => { detailImage = null; client?.dispose(); client = undefined; running = undefined; queued = false; renderedKey = undefined; };
  const query = async () => {
    timer = undefined;
    if (!map || !input.enabled || !hasTarget() || document.hidden || map.isMoving() && !followingGps) return;
    if (running) { queued = true; return; }
    const job = running = { revision }, bounds = map.getBounds(), zoom = map.getZoom();
    const width = bounds.getEast() - bounds.getWest(), height = bounds.getNorth() - bounds.getSouth();
    const discover = map.getZoom() >= 7 && width <= 45 && height <= 25;
    const check = revalidate || Date.now() < lastCheck || Date.now() - lastCheck >= 5 * 60_000;
    if (check && discover) { revalidate = false; lastCheck = Date.now(); }
    status({ ...lastStatus, state: discover ? 'loading' : 'zoom' });
    try {
      if (!client || client.retired) {
        client = new WorkerClient<LandingDisplayWorker>(new Worker(new URL('./landing.worker.ts', import.meta.url), { type: 'module' }), 'Landing areas unavailable');
        renderedKey = undefined;
      }
      const result = await client.call(worker => worker.query({ id: job.revision,
        sources, manifestUrl: new URL(`${chartRoot()}/glide/manifest.json`, location.href).href,
        bounds: [bounds.getWest(), bounds.getSouth(), bounds.getEast(), bounds.getNorth()], segments: input.segments, ranges: input.ranges, zoom,
        discover, revalidate: check, ...(renderedKey === undefined ? {} : { renderedKey }),
      }));
      if (!map || job.revision !== revision) return;
      const submitted = result.collection ? renderCollection(result.collection) : undefined;
      // Retain the receipt before awaiting MapLibre: an error event can schedule
      // a successful retry while the original upload promise is still pending.
      const receipt = pendingKey = { key: result.renderKey, revision, status: result.status };
      if (result.raster !== undefined) {
        detailImage = result.raster;
        if (detailImage) {
          const [west, south, east, north] = detailImage.bounds;
          const pixels = new ImageData(new Uint8ClampedArray(detailImage.rgba), detailImage.width, detailImage.height);
          detailImage.rgba = pixels.data; // Share the upload pixels with hit testing.
          map.getSource<ImageSource>(RASTER)?.updateImage({ image: pixels,
            coordinates: [[west, north], [east, north], [east, south], [west, south]] });
        }
        map.setLayoutProperty(RASTER, 'visibility', detailImage?.shadedCells ? 'visible' : 'none');
      }
      if (result.heat !== undefined) {
        const heat = result.heat;
        if (heat) {
          const [west, south, east, north] = heat.bounds;
          map.getSource<ImageSource>(HEAT)?.updateImage({ image: new ImageData(new Uint8ClampedArray(heat.rgba), heat.width, heat.height),
            coordinates: [[west, north], [east, north], [east, south], [west, south]] });
        }
        map.setLayoutProperty(HEAT, 'visibility', heat?.shadedCells ? 'visible' : 'none');
      }
      const accepted = submitted ? await submitted : !submission?.failed;
      if (!map || job.revision !== revision) return;
      if (accepted) { renderedKey = result.renderKey; status(result.status); pendingKey = undefined; }
      else if (pendingKey === receipt) {
        status({ ...result.status, state: 'error' });
      }
      if (result.more) queued = true;
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
    if (!map) return;
    if (!input.enabled || !hasTarget()) {
      clearTimeout(timer); timer = undefined;
      clear(); release(); status({ state: input.enabled ? 'route' : 'idle' }); return;
    }
    if (document.hidden) return;
    if (running) { queued = true; return; }
    if (timer === undefined) timer = setTimeout(() => { void query(); }, 150);
  };
  const moving = (event: { type: string; gpsCamera?: boolean }) => {
    followingGps = event.gpsCamera === true;
    if (followingGps) return;
    clearTimeout(timer); timer = undefined; queued = false; cancel();
  };
  const moved = () => { followingGps = false; if (submission?.failed && retryTimer === undefined) void renderCollection(collection, true); schedule(); };
  const visibility = () => { if (document.hidden) moving({ type: 'visibilitychange' }); else schedule(); };
  const recover = () => { revalidate = true; cancel(); schedule(); };
  return {
    id: 'glide-landings', slot: 'weather',
    inspectAt(point) {
      if (!map || !client || !input.enabled || !hasTarget()) return;
      const coordinate = map.unproject([point.x, point.y]);
      if (detailImage) {
        const [w, s, e, n] = detailImage.bounds, nw = project([w, n]), se = project([e, s]);
        const local = project([coordinate.lng, coordinate.lat]); local[0] += Math.round((nw[0] + se[0]) / 2 - local[0]);
        const x = Math.floor((local[0] - nw[0]) / (se[0] - nw[0]) * detailImage.width);
        const y = Math.floor((local[1] - nw[1]) / (se[1] - nw[1]) * detailImage.height);
        if (x < 0 || y < 0 || x >= detailImage.width || y >= detailImage.height || !detailImage.rgba[(y * detailImage.width + x) * 4 + 3]) return;
      } else if (!map.queryRenderedFeatures([point.x, point.y], { layers: [LAYERS[0]!] }).length) return;
      const active = client, current = revision, sourceKey = lastStatus.sourceKey;
      return async () => {
        let site: LandingSelection | null;
        try { site = await active.call(worker => worker.inspect([coordinate.lng, coordinate.lat] as Point)); }
        catch (error) {
          // Teardown or newer demand can reject a still-pending worker call.
          if (active !== client || current !== revision) return null;
          throw error;
        }
        return active === client && current === revision && site?.sourceKey === sourceKey ? site : null;
      };
    },
    mount(target) {
      map = target;
      for (const id of [HEAT, RASTER]) map.addSource(id, { type: 'image', coordinates: [[0, 1], [1, 1], [1, 0], [0, 0]] });
      // MapLibre simplifies geometry at each tile zoom; close views retain the original boundaries.
      map.addSource(SOURCE, { type: 'geojson', data: emptyLandings(), maxzoom: 16, tolerance: 0.75,
        attribution: 'Landing candidates: USGS, USDA Forest Service, FAA, <a href="https://docs.overturemaps.org/attribution/">Overture Maps</a>; <a href="https://www.openstreetmap.org/copyright">© OpenStreetMap contributors</a>' });
      const before = map.getLayer('glide-outline-trim') ? 'glide-outline-trim'
        : map.getLayer(WEATHER_LAYER_ANCHOR) ? WEATHER_LAYER_ANCHOR : undefined;
      for (const id of [HEAT, RASTER]) map.addLayer({ id, type: 'raster', source: id, layout: { visibility: 'none' },
        paint: { 'raster-opacity': 1, 'raster-fade-duration': 0, 'raster-resampling': 'nearest' } }, before);
      map.addLayer({ id: LAYERS[0]!, type: 'fill', source: SOURCE,
        paint: { 'fill-color': colors, 'fill-opacity': 0.62, 'fill-antialias': false } }, before);
      map.addLayer({ id: LAYERS[1]!, type: 'line', source: SOURCE,
        paint: { 'line-color': '#242333', 'line-width': 1.5, 'line-opacity': 0.75 } }, before);
      map.addLayer({ id: LAYERS[2]!, type: 'line', source: SOURCE,
        paint: { 'line-color': colors, 'line-width': 0.75 } }, before);
      submission = createSourceSubmission(map, SOURCE, () => {
        if (!pendingKey && renderedKey !== undefined) pendingKey = { key: renderedKey, revision, status: lastStatus };
        renderedKey = undefined; vectorVisibility(false);
        if (input.enabled) status({ ...lastStatus, state: 'error' });
        if (!retried) {
          retried = true;
          retryTimer = setTimeout(() => { retryTimer = undefined; void renderCollection(collection, true); }, 100);
        }
      });
      map.on('movestart', moving); map.on('moveend', moved); map.on('resize', schedule);
      window.addEventListener('online', recover); document.addEventListener('visibilitychange', visibility);
      stopInventory = observeOfflineInventory(recover);
      schedule();
    },
    update(next) {
      const nextRoute = JSON.stringify(next.segments), nextRanges = JSON.stringify(next.ranges);
      const routeChanged = nextRoute !== routeKey, rangeChanged = nextRanges !== rangeKey, toggle = next.enabled !== input.enabled;
      const retry = next.retry !== input.retry;
      let sourceChanged = false;
      if (next.catalog !== input.catalog) {
        const nextSources = landingSources(next.catalog, globalThis.location?.href ?? 'http://localhost/');
        const key = nextSources ? jsonIdentity(nextSources) : '';
        sourceChanged = key !== sourceIdentity; sourceIdentity = key; sources = nextSources;
      }
      input = next; routeKey = nextRoute; rangeKey = nextRanges;
      if (!routeChanged && !rangeChanged && !toggle && !retry && !sourceChanged) return;
      // Moving ranges invalidate publication, but let shared file acquisition finish.
      // The queued query clips those cached records to the latest range. Removing
      // all ranges, manual route changes and teardown still cancel obsolete demand.
      if (sourceChanged || routeChanged || toggle || retry || !next.ranges.features.length) cancel();
      else revision++;
      if (sourceChanged || rangeChanged || toggle) clearDetail();
      if (sourceChanged || routeChanged || toggle) clearHeat();
      if (retry || sourceChanged) revalidate = true;
      if (sourceChanged && lastStatus.sourceKey) status({ state: 'loading', sourceKey: `pending:${sourceIdentity}` });
      schedule();
    },
    unmount() {
      clearTimeout(retryTimer); retryTimer = undefined;
      submission?.destroy(); submission = undefined; pendingKey = undefined; collection = emptyLandings();
      cancel(); clearTimeout(timer); timer = undefined; release();
      stopInventory?.(); stopInventory = undefined;
      window.removeEventListener('online', recover); document.removeEventListener('visibilitychange', visibility);
      if (map) {
        map.off('movestart', moving); map.off('moveend', moved); map.off('resize', schedule);
        removeLayerResources(map, [...LAYERS].reverse().concat(RASTER, HEAT), [SOURCE, RASTER, HEAT]);
      }
      followingGps = false; map = undefined; status({ state: 'idle' });
    },
  };
}
