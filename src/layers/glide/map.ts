import type { Map as MapLibreMap, GeoJSONSource } from 'maplibre-gl';
import type { FeatureCollectionResponse } from '@zlayer/contracts';
import { WorkerClient } from '../../core/data/worker-client';
import { WEATHER_LAYER_ANCHOR, removeLayerResources, type MapLayerModule } from '../../core/map/layer';
import { observeOfflineInventory } from '../../offline/inventory-events';
import { routingCatalog, type CatalogReadSource } from '../../workspace/read-context';
import { regionalNavigationLayers, fetchNavigationResult, navigationRequestKey } from '../navigation/api';
import { terrainSources, terrainSourceKey, DEFAULT_ELEVATION_URL, TERRAIN_ATTRIBUTION } from '../terrain/data';
import { visibleGlideAirports } from './airports';
import { insideViewport, localRouteSegments, unwrapPoint, viewportBounds, type GlideViewport } from './coverage';
import { project, type Point, type Segment } from '../../core/geo/route-corridor';
import { emptyLines, emptyAreas, type GlideStatus, type GlideWorker, type GlideResult } from './types';

export type GlideMapInput = { enabled?: boolean; ratio?: number; altitude?: number; catalog?: CatalogReadSource; retry: number; segments?: Segment[]; ownship?: Point | null; point?: Point | null };
const AREA = 'glide-areas', AIRPORTS = 'glide-airports', OWN = 'glide-ownship', OWN_AREA = 'glide-ownship-area';
const POINT = 'glide-point-range', POINT_AREA = 'glide-point-area', PIN = 'glide-point';
const AIRPORT_COLOR = '#ffc875', AIRPORT_DARK = '#332510', FLIGHT_COLOR = '#53e4c6', FLIGHT_DARK = '#102d2a';
const LAYERS = ['glide-fill', 'glide-outline-trim', 'glide-outline', 'glide-airport-points', 'glide-airport-labels', 'glide-ownship-fill', 'glide-ownship-trim', 'glide-ownship-ring', 'glide-point-fill', 'glide-point-trim', 'glide-point-ring', 'glide-point-pin', 'glide-point-label'];
export function createGlideLayer(onStatus: (status: GlideStatus) => void): MapLayerModule<GlideMapInput> & { coordinateAt(point: { x: number; y: number }): Point | undefined } {
  let map: MapLibreMap | undefined, input: GlideMapInput = { retry: 0 }, inputKey = '', generation = 0;
  let client: WorkerClient<GlideWorker> | undefined, running: number | undefined, queued = false;
  let timer: ReturnType<typeof setTimeout> | undefined, stopInventory: (() => void) | undefined;
  let airportData: { key: string; collection: FeatureCollectionResponse; partial: boolean } | undefined;
  let lastStatus: GlideStatus = { state: 'idle' };
  let planInputKey = '', planPublished = false, publishedPlanRevision: number | undefined;
  let shipPublished = false, pointPublished = false, pinKey: string | undefined;
  let sources = terrainSources(undefined), sourceKey = '', catalogKeys: string[] = [];
  const status = (next: GlideStatus) => { lastStatus = next; onStatus(next); };
  const source = (id: string) => map?.getSource<GeoJSONSource>(id);
  const clearOwnship = () => { shipPublished = false; source(OWN)?.setData(emptyLines()); source(OWN_AREA)?.setData(emptyAreas()); };
  const clearPoint = () => { pointPublished = false; source(POINT)?.setData(emptyLines()); source(POINT_AREA)?.setData(emptyAreas()); };
  const showPin = () => {
    const point = input.enabled ? input.point : null, key = JSON.stringify(point ?? null);
    if (key === pinKey) return;
    pinKey = key;
    source(PIN)?.setData({ type: 'FeatureCollection', features: point ? [{
      type: 'Feature', properties: {}, geometry: { type: 'Point', coordinates: point },
    }] : [] });
  };
  const clear = () => {
    planPublished = false; pinKey = undefined; clearOwnship(); clearPoint();
    source(PIN)?.setData({ type: 'FeatureCollection', features: [] });
    source(AREA)?.setData(emptyAreas()); source(AIRPORTS)?.setData({ type: 'FeatureCollection', features: [] });
  };
  const publish = (result: GlideResult, shipKey: string, pointKey: string) => {
    if (!shipPublished && result.ownshipCalculated && shipKey === JSON.stringify(input.ownship ?? null)) {
      source(OWN)?.setData(result.ownship); source(OWN_AREA)?.setData(result.ownshipArea); shipPublished = true;
    }
    if (!pointPublished && result.pointCalculated && pointKey === JSON.stringify(input.point ?? null)) {
      source(POINT)?.setData(result.point); source(POINT_AREA)?.setData(result.pointArea); pointPublished = true;
    }
    if (result.planRevision !== publishedPlanRevision || !result.work.planReused || !planPublished) {
      source(AREA)?.setData(result.areas);
      source(AIRPORTS)?.setData({ type: 'FeatureCollection', features: result.airports });
      planPublished = true; publishedPlanRevision = result.planRevision;
    }
  };
  const cancel = () => {
    generation++; clearTimeout(timer); timer = undefined; queued = false;
    if (client && running !== undefined) { const id = running; void client.call(remote => remote.cancel(id)).catch(() => {}); }
  };
  const release = () => { client?.dispose(); client = undefined; running = undefined; };
  const schedule = (preserveGeometry = false) => {
    cancel();
    if (!map || !input.enabled || !input.catalog) { clear(); release(); status({ state: 'idle' }); return; }
    if (!preserveGeometry) clear();
    showPin();
    if (map.getZoom() < 7) { status({ ...lastStatus, state: 'zoom' }); return; }
    if (document.hidden) return;
    status(preserveGeometry ? { ...lastStatus, state: 'loading' } : { state: 'loading' });
    timer = setTimeout(() => { timer = undefined; void calculate(); }, 180);
  };
  async function calculate() {
    if (!map || !input.enabled || !input.catalog || document.hidden || map.getZoom() < 7 || map.isMoving()) return;
    if (running !== undefined) { queued = true; return; }
    const id = generation, catalog = input.catalog, ratio = input.ratio!, altitude = input.altitude!;
    running = id;
    try {
      const canvas = map.getCanvas(), center = project([map.getCenter().lng, map.getCenter().lat]);
      const viewport: GlideViewport = [[0, 0], [canvas.clientWidth, 0], [canvas.clientWidth, canvas.clientHeight], [0, canvas.clientHeight]]
        .map(pixel => {
          const coordinate = map!.unproject(pixel as Point), point = project([coordinate.lng, coordinate.lat]);
          point[0] += Math.round(center[0] - point[0]); return point;
        });
      if (!viewport.flat().every(Number.isFinite) || !insideViewport(center, viewport)) { status({ ...lastStatus, state: 'zoom' }); return; }
      const bounds = viewportBounds(viewport), segments = input.segments ?? [], localSegments = localRouteSegments(segments, viewport);
      const shipKey = JSON.stringify(input.ownship ?? null), pointKey = JSON.stringify(input.point ?? null);
      const pointVisible = !!input.point && insideViewport(unwrapPoint(input.point, viewport), viewport);
      const point = input.point ?? null;
      const pointState = input.point ? pointVisible ? 'ready' as const : 'outside' as const : undefined;
      const shipVisible = !!input.ownship && insideViewport(unwrapPoint(input.ownship, viewport), viewport);
      const ownship = input.ownship ?? null;
      const ownshipState = shipVisible ? 'ready' as const : ownship ? 'outside' as const : 'unavailable' as const;
      let airports: ReturnType<typeof visibleGlideAirports> = [], airportPartial = false;
      if (localSegments.length) {
        const layer = regionalNavigationLayers(catalog).find(layer => layer.id === 'airports');
        if (layer) {
          const key = navigationRequestKey(layer, routingCatalog(catalog).revision, catalog.charts, catalog);
          if (airportData?.key !== key) {
            const result = await fetchNavigationResult(layer, routingCatalog(catalog).revision, catalog.charts, catalog);
            if (id !== generation || !map) return;
            if (result.collection) airportData = { key, collection: result.collection, partial: result.issues.length > 0 };
            else airportPartial = true;
          }
          if (airportData?.key === key) {
            airports = visibleGlideAirports(airportData.collection.features, viewport, localSegments, altitude, ratio);
            airportPartial ||= airportData.partial;
          }
        } else airportPartial = true;
      }
      const tooLarge = airports.length > 160 || bounds[2] - bounds[0] > 45 || bounds[3] - bounds[1] > 25;
      if (tooLarge) { status({ ...lastStatus, state: 'zoom', route: !!segments.length, ownship: ownshipState, point: pointState }); return; }
      if (!client && !airports.length && !shipVisible && !pointVisible) {
        status({ state: airportPartial ? 'partial' : 'ready', airports: 0, route: !!segments.length, ownship: ownshipState, point: pointState }); return;
      }
      if (!client || client.retired) client = new WorkerClient<GlideWorker>(new Worker(new URL('./glide.worker.ts', import.meta.url), { type: 'module' }), 'Glide calculation unavailable');
      const base = location.href;
      const result = await client.call(remote => remote.calculate({ id, airports, altitude, ratio, viewport, segments, ownship, point, sources,
        sourceKey, airportKey: JSON.stringify(catalogKeys), base,
        tileUrl: import.meta.env.VITE_ZLAYERS_TERRAIN_TILE_URL?.trim() || DEFAULT_ELEVATION_URL }));
      if (id !== generation || !map) return;
      publish(result, shipKey, pointKey);
      const currentPoint = pointKey === JSON.stringify(input.point ?? null);
      const currentShip = shipKey === JSON.stringify(input.ownship ?? null);
      status({ state: result.incomplete || airportPartial ? 'partial' : 'ready', airports: result.airports.length, route: !!segments.length,
        ownship: currentShip ? result.ownshipIncomplete ? 'partial' : ownshipState : input.ownship ? 'loading' : 'unavailable',
        point: currentPoint ? result.pointIncomplete ? 'partial' : pointState : input.point ? 'loading' : undefined });
      if (!currentShip || !currentPoint) queued = true;
    } catch {
      if (id === generation && map) status({ ...lastStatus, state: 'error' });
    } finally {
      if (running === id) {
        running = undefined;
        if (queued) { queued = false; clearTimeout(timer); timer = undefined; void calculate(); }
      }
    }
  }
  const recover = () => { airportData = undefined; release(); schedule(); };
  const inventory = () => { if (['error', 'partial'].includes(lastStatus.state) || lastStatus.ownship === 'partial' || lastStatus.point === 'partial') recover(); };
  // Camera motion invalidates pending discovery, not completed origin coverage.
  // The worker retains and unions visited airport footprints along the route.
  const moving = () => { cancel(); if (input.enabled) status({ ...lastStatus, state: 'loading' }); };
  const viewportChanged = () => schedule(true);
  const visibilityChanged = () => schedule(true);
  return { id: 'glide', slot: 'weather',
    coordinateAt(point) {
      if (!map || !Number.isFinite(point.x) || !Number.isFinite(point.y)) return;
      const canvas = map.getCanvas();
      if (point.x < 0 || point.y < 0 || point.x > canvas.clientWidth || point.y > canvas.clientHeight) return;
      const { lng, lat } = map.unproject([point.x, point.y]);
      if (Number.isFinite(lng) && Number.isFinite(lat) && Math.abs(lat) <= 85.051129) return [((lng + 180) % 360 + 360) % 360 - 180, lat];
      return undefined;
    },
    mount(target) {
      map = target;
      map.addSource(AREA, { type: 'geojson', data: emptyAreas(), attribution: TERRAIN_ATTRIBUTION });
      map.addSource(OWN, { type: 'geojson', data: emptyLines() });
      map.addSource(POINT, { type: 'geojson', data: emptyLines() });
      for (const id of [OWN_AREA, POINT_AREA]) map.addSource(id, { type: 'geojson', data: emptyAreas() });
      map.addSource(PIN, { type: 'geojson', data: { type: 'FeatureCollection', features: [] } });
      map.addSource(AIRPORTS, { type: 'geojson', data: { type: 'FeatureCollection', features: [] } });
      const before = map.getLayer(WEATHER_LAYER_ANCHOR) ? WEATHER_LAYER_ANCHOR : undefined;
      map.addLayer({ id: LAYERS[0]!, type: 'fill', source: AREA, paint: { 'fill-color': AIRPORT_COLOR, 'fill-opacity': 0.32, 'fill-antialias': false } }, before);
      for (const [id, source] of [['glide-ownship-fill', OWN_AREA], ['glide-point-fill', POINT_AREA]]) {
        map.addLayer({ id: id!, type: 'fill', source: source!, paint: { 'fill-color': FLIGHT_COLOR, 'fill-opacity': 0.24, 'fill-antialias': false } }, before);
      }
      map.addLayer({ id: LAYERS[1]!, type: 'line', source: AREA, paint: { 'line-color': AIRPORT_DARK, 'line-width': 4, 'line-opacity': 0.85 } }, before);
      map.addLayer({ id: LAYERS[2]!, type: 'line', source: AREA, paint: { 'line-color': AIRPORT_COLOR, 'line-width': 2 } }, before);
      map.addLayer({ id: LAYERS[3]!, type: 'circle', source: AIRPORTS, paint: { 'circle-radius': 3, 'circle-color': AIRPORT_COLOR, 'circle-stroke-color': AIRPORT_DARK, 'circle-stroke-width': 1 } }, before);
      map.addLayer({ id: LAYERS[4]!, type: 'symbol', source: AIRPORTS, layout: { 'text-field': ['coalesce', ['get', 'icaoId'], ['get', 'faaId'], ['get', 'ident'], ''],
        'text-font': ['Noto Sans Bold'], 'text-size': 11, 'text-offset': [0, 1.1] }, paint: { 'text-color': AIRPORT_COLOR, 'text-halo-color': AIRPORT_DARK, 'text-halo-width': 1 } }, before);
      for (const [id, src, dashed] of [['ownship', OWN, false], ['point', POINT, true]] as const) {
        map.addLayer({ id: `glide-${id}-trim`, type: 'line', source: src, paint: { 'line-color': FLIGHT_DARK, 'line-width': 4.5 } }, before);
        map.addLayer({ id: `glide-${id}-ring`, type: 'line', source: src, paint: { 'line-color': FLIGHT_COLOR, 'line-width': 2.5,
          ...(dashed ? { 'line-dasharray': [4, 2] } : {}) } }, before);
      }
      map.addLayer({ id: 'glide-point-pin', type: 'circle', source: PIN, paint: { 'circle-radius': 6, 'circle-color': '#ffffff', 'circle-stroke-color': FLIGHT_DARK, 'circle-stroke-width': 3 } }, before);
      map.addLayer({ id: 'glide-point-label', type: 'symbol', source: PIN,
        layout: { 'text-field': 'Glide from here', 'text-font': ['Noto Sans Bold'], 'text-size': 12, 'text-anchor': 'top', 'text-offset': [0, 1] },
        paint: { 'text-color': FLIGHT_COLOR, 'text-halo-color': FLIGHT_DARK, 'text-halo-width': 2 } }, before);
      map.on('movestart', moving); map.on('moveend', viewportChanged); map.on('resize', viewportChanged);
      window.addEventListener('online', recover); document.addEventListener('visibilitychange', visibilityChanged);
      stopInventory = observeOfflineInventory(inventory); schedule();
    },
    update(next) {
      if (next.catalog !== input.catalog) {
        sources = terrainSources(next.catalog);
        sourceKey = terrainSourceKey(sources, globalThis.location?.href ?? 'http://localhost/');
        catalogKeys = next.catalog ? regionalNavigationLayers(next.catalog).filter(l => l.id === 'airports')
          .map(l => navigationRequestKey(l, routingCatalog(next.catalog!).revision, next.catalog!.charts, next.catalog)) : [];
      }
      const planKey = JSON.stringify([next.enabled, next.ratio, next.altitude, next.retry, catalogKeys, sourceKey, next.segments ?? []]);
      const key = JSON.stringify([planKey, next.ownship ?? null, next.point ?? null]);
      const shipChanged = JSON.stringify(next.ownship ?? null) !== JSON.stringify(input.ownship ?? null);
      const pointChanged = JSON.stringify(next.point ?? null) !== JSON.stringify(input.point ?? null);
      if (next.retry !== input.retry) { airportData = undefined; release(); }
      input = next;
      if (key !== inputKey) {
        const onlyOrigins = planKey === planInputKey;
        inputKey = key; planInputKey = planKey;
        if (!onlyOrigins) schedule();
        else if (map && input.enabled) {
          // Coalesce origin changes without canceling airport preparation or
          // continually restarting a debounce on high-rate location feeds.
          if (shipChanged) { clearOwnship(); status({ ...lastStatus, ownship: input.ownship ? 'loading' : 'unavailable' }); }
          if (pointChanged) { clearPoint(); showPin(); status({ ...lastStatus, point: input.point ? 'loading' : undefined }); }
          if (timer === undefined) timer = setTimeout(() => { timer = undefined; void calculate(); }, 250);
        }
      }
    },
    unmount() {
      cancel(); release(); airportData = undefined;
      stopInventory?.(); stopInventory = undefined;
      window.removeEventListener('online', recover); document.removeEventListener('visibilitychange', visibilityChanged);
      if (map) { map.off('movestart', moving); map.off('moveend', viewportChanged); map.off('resize', viewportChanged); removeLayerResources(map, [...LAYERS].reverse(), [AREA, AIRPORTS, OWN, OWN_AREA, POINT, POINT_AREA, PIN]); }
      map = undefined; status({ state: 'idle' });
    },
  };
}
