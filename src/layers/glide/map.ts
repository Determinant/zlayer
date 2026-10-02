import type { Map as MapLibreMap, GeoJSONSource } from 'maplibre-gl';
import type { FeatureCollectionResponse } from '@zlayer/contracts';
import { WorkerClient } from '../../core/data/worker-client';
import { withAbort } from '../../core/data/abort';
import { WEATHER_LAYER_ANCHOR, removeLayerResources, type MapLayerModule } from '../../core/map/layer';
import { observeOfflineInventory } from '../../offline/inventory-events';
import { routingCatalog, type CatalogReadSource } from '../../workspace/read-context';
import { regionalNavigationLayers, fetchNavigationResult, navigationRequestKey } from '../navigation/api';
import { terrainSources, terrainSourceKey, DEFAULT_ELEVATION_URL, TERRAIN_ATTRIBUTION } from '../terrain/data';
import { visibleGlideAirports } from './airports';
import { insideViewport, localRouteSegments, unwrapPoint, viewportBounds, type GlideViewport } from './coverage';
import { project, type Point, type Segment } from '../../core/geo/route-corridor';
import { distanceMeters } from '../../core/gps/position';
import { createRangeAnimation } from './range-animation';
import { emptyLines, emptyAreas, type GlideStatus, type GlideWorker, type GlideResult, type GlideRange } from './types';

export type GlideMapInput = { enabled?: boolean; ratio?: number; altitude?: number; catalog?: CatalogReadSource; retry: number; segments?: Segment[]; ownship?: Point | null; point?: Point | null };
const AREA = 'glide-areas', AIRPORTS = 'glide-airports', OWN = 'glide-ownship', OWN_AREA = 'glide-ownship-area';
const POINT = 'glide-point-range', POINT_AREA = 'glide-point-area', PIN = 'glide-point';
const RANGE_SOURCES = { ownship: [OWN, OWN_AREA], point: [POINT, POINT_AREA] } as const;
type RangeName = keyof typeof RANGE_SOURCES;
const samePoint = (a: Point | null | undefined, b: Point | null | undefined) => a?.[0] === b?.[0] && a?.[1] === b?.[1];
// Keep the terrain origin stable through GPS drift, well below a planning cell.
const ORIGIN_DEADBAND_METERS = 25;
const RETAIN_RANGE_METERS = 185.2; // 0.1 NM, only while a nearby replacement loads
function rangeStatus(current: Point | null | undefined, requested: Point | null, visible: boolean, result: GlideRange | null | undefined): GlideStatus['point'] {
  if (!current) return undefined;
  if (!samePoint(current, requested)) return 'loading';
  if (result?.incomplete) return 'partial';
  if (!visible) return 'outside';
  return result ? 'ready' : 'zoom';
}
const AIRPORT_COLOR = '#ffc875', AIRPORT_DARK = '#332510', FLIGHT_COLOR = '#53e4c6', FLIGHT_DARK = '#102d2a';
const LAYERS = ['glide-fill', 'glide-outline-trim', 'glide-outline', 'glide-airport-points', 'glide-airport-labels', 'glide-ownship-fill', 'glide-ownship-trim', 'glide-ownship-ring', 'glide-point-fill', 'glide-point-trim', 'glide-point-ring', 'glide-point-pin', 'glide-point-label'];
export function createGlideLayer(onStatus: (status: GlideStatus) => void): MapLayerModule<GlideMapInput> & { coordinateAt(point: { x: number; y: number }): Point | undefined } {
  let map: MapLibreMap | undefined, input: GlideMapInput = { retry: 0 }, generation = 0;
  let client: WorkerClient<GlideWorker> | undefined;
  let running: { id: number; controller: AbortController } | undefined, queued = false;
  let followingGps = false;
  let timer: ReturnType<typeof setTimeout> | undefined, stopInventory: (() => void) | undefined;
  let airportData: { key: string; collection: FeatureCollectionResponse; partial: boolean } | undefined;
  let lastStatus: GlideStatus = { state: 'idle' };
  let rangeInputKey = '', airportInputKey = '', routeInputKey = '';
  let publishedPlanRevision: number | undefined;
  // Recovery is a property of acquired data, not the transient loading/zoom UI.
  let recoveryNeeded = false;
  const publishedRanges = new Map<RangeName, { key: string; origin: Point }>();
  let pinKey: string | undefined;
  let sources = terrainSources(undefined), sourceKey = '';
  const status = (next: GlideStatus) => { lastStatus = next; onStatus(next); };
  const source = (id: string) => map?.getSource<GeoJSONSource>(id);
  const ownshipAnimation = createRangeAnimation(async range => {
    await Promise.all([source(OWN)?.setData(range.line), source(OWN_AREA)?.setData(range.area)]);
  });
  const onScreen = (point: Point) => {
    if (!map) return false;
    const center = map.getCenter(), canvas = map.getCanvas();
    const pixel = map.project([point[0] + 360 * Math.round((center.lng - point[0]) / 360), point[1]]);
    return pixel.x >= 0 && pixel.x <= canvas.clientWidth && pixel.y >= 0 && pixel.y <= canvas.clientHeight;
  };
  const nearbyOwnship = (origin: Point | null | undefined) => !!origin && !!input.ownship
    && distanceMeters(origin, input.ownship) <= RETAIN_RANGE_METERS && onScreen(input.ownship);
  const clearRange = (name: RangeName) => {
    if (name === 'ownship') ownshipAnimation.reset();
    publishedRanges.delete(name);
    const [line, area] = RANGE_SOURCES[name];
    source(line)?.setData(emptyLines()); source(area)?.setData(emptyAreas());
  };
  const showPin = () => {
    const point = input.enabled ? input.point : null, key = JSON.stringify(point ?? null);
    if (key === pinKey) return;
    pinKey = key;
    source(PIN)?.setData({ type: 'FeatureCollection', features: point ? [{
      type: 'Feature', properties: {}, geometry: { type: 'Point', coordinates: point },
    }] : [] });
  };
  const clearAirports = () => {
    publishedPlanRevision = undefined;
    source(AREA)?.setData(emptyAreas()); source(AIRPORTS)?.setData({ type: 'FeatureCollection', features: [] });
  };
  const clear = () => {
    clearAirports(); clearRange('ownship'); clearRange('point'); pinKey = undefined;
    source(PIN)?.setData({ type: 'FeatureCollection', features: [] });
  };
  const publish = (result: GlideResult, origins: { ownship: Point | null; point: Point | null }) => {
    for (const name of ['ownship', 'point'] as const) {
      const range = result[name], [line, area] = RANGE_SOURCES[name];
      const origin = origins[name];
      if (!range || !origin || publishedRanges.get(name)?.key === range.key
        || !(samePoint(origin, input[name]) || name === 'ownship' && nearbyOwnship(origin))) continue;
      if (name === 'ownship') ownshipAnimation.set(range, origin, !document.hidden
        && (!map?.isMoving() || followingGps) && !matchMedia('(prefers-reduced-motion: reduce)').matches);
      else { source(line)?.setData(range.line); source(area)?.setData(range.area); }
      publishedRanges.set(name, { key: range.key, origin });
    }
    if (result.planRevision !== publishedPlanRevision) {
      source(AREA)?.setData(result.areas);
      source(AIRPORTS)?.setData({ type: 'FeatureCollection', features: result.airports });
      publishedPlanRevision = result.planRevision;
    }
  };
  const cancel = () => {
    generation++; clearTimeout(timer); timer = undefined; queued = false;
    if (running) {
      // The worker may retain incomplete origins even when cancellation keeps
      // their result from reaching this view. Inventory repair must reach them.
      recoveryNeeded = true;
      running.controller.abort();
      const id = running.id;
      if (client) void client.call(remote => remote.cancel(id)).catch(() => {});
    }
  };
  const release = () => { running?.controller.abort(); client?.dispose(); client = undefined; running = undefined; };
  const schedule = () => {
    cancel();
    if (!map || !input.enabled || !input.catalog) { clear(); release(); recoveryNeeded = false; status({ state: 'idle' }); return; }
    showPin();
    if (document.hidden) { ownshipAnimation.finish(); return; }
    status({ ...lastStatus, state: map.getZoom() < 7 ? 'zoom' : 'loading' });
    timer = setTimeout(() => { timer = undefined; void calculate(); }, 180);
  };
  async function calculate() {
    if (!map || !input.enabled || !input.catalog || document.hidden || map.isMoving() && !followingGps) return;
    if (running !== undefined) { queued = true; return; }
    const id = generation, catalog = input.catalog, ratio = input.ratio!, altitude = input.altitude!;
    const job = { id, controller: new AbortController() };
    running = job;
    try {
      const canvas = map.getCanvas(), center = project([map.getCenter().lng, map.getCenter().lat]);
      const viewport: GlideViewport = [[0, 0], [canvas.clientWidth, 0], [canvas.clientWidth, canvas.clientHeight], [0, canvas.clientHeight]]
        .map(pixel => {
          const coordinate = map!.unproject(pixel as Point), point = project([coordinate.lng, coordinate.lat]);
          point[0] += Math.round(center[0] - point[0]); return point;
        });
      if (!viewport.flat().every(Number.isFinite) || !insideViewport(center, viewport)) { status({ ...lastStatus, state: 'zoom' }); return; }
      const bounds = viewportBounds(viewport), segments = input.segments ?? [], localSegments = localRouteSegments(segments, viewport);
      let discover = map.getZoom() >= 7 && bounds[2] - bounds[0] <= 45 && bounds[3] - bounds[1] <= 25;
      const ownship = input.ownship ?? null, point = input.point ?? null;
      const shipVisible = !!ownship && insideViewport(unwrapPoint(ownship, viewport), viewport);
      const pointVisible = !!point && insideViewport(unwrapPoint(point, viewport), viewport);
      let airports: ReturnType<typeof visibleGlideAirports> = [], airportPartial = false;
      if (discover && localSegments.length) {
        const layer = regionalNavigationLayers(catalog).find(layer => layer.id === 'airports');
        if (layer) {
          const key = navigationRequestKey(layer, routingCatalog(catalog).revision, catalog.charts, catalog);
          if (airportData?.key !== key) {
            // Leave shared acquisition running for other consumers, but release
            // this generation's wait immediately when its demand is obsolete.
            const result = await withAbort(fetchNavigationResult(layer, routingCatalog(catalog).revision, catalog.charts, catalog), job.controller.signal);
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
      if (airports.length > 160) discover = false;
      recoveryNeeded ||= airportPartial;
      let result: GlideResult | undefined;
      if (client || discover && (airports.length || shipVisible || pointVisible)) {
        if (!client || client.retired) {
          client = new WorkerClient<GlideWorker>(new Worker(new URL('./glide.worker.ts', import.meta.url), { type: 'module' }), 'Glide calculation unavailable');
          publishedPlanRevision = undefined; publishedRanges.clear();
        }
        // Even an overview can reclip known footprints to an edited route. The
        // discovery gate forbids terrain acquisition, not reconciliation.
        result = await client.call(remote => remote.calculate({ id, discover, airports, altitude, ratio, viewport, segments, ownship, point, sources,
          sourceKey, airportKey: airportInputKey, base: location.href,
          tileUrl: import.meta.env.VITE_ZLAYERS_TERRAIN_TILE_URL?.trim() || DEFAULT_ELEVATION_URL }));
        if (id !== generation || !map) return;
        publish(result, { ownship, point });
        recoveryNeeded ||= result.incomplete || !!result.ownship?.incomplete || !!result.point?.incomplete;
      }
      status({ state: !discover ? 'zoom' : result?.incomplete || airportPartial ? 'partial' : 'ready', airports: result?.airports.length ?? 0, route: !!segments.length,
        ownship: rangeStatus(input.ownship, ownship, shipVisible, result?.ownship) ?? 'unavailable',
        point: rangeStatus(input.point, point, pointVisible, result?.point) });
      if (!samePoint(ownship, input.ownship) || !samePoint(point, input.point)) queued = true;
    } catch {
      if (id === generation && map) { recoveryNeeded = true; status({ ...lastStatus, state: 'error' }); }
    } finally {
      if (running === job) {
        running = undefined;
        if (queued) { queued = false; clearTimeout(timer); timer = undefined; void calculate(); }
      }
    }
  }
  const recover = () => {
    airportData = undefined; recoveryNeeded = false; release(); clear(); status({ state: 'idle' }); schedule();
  };
  const inventory = () => { if (recoveryNeeded || running) recover(); };
  // Camera motion invalidates pending discovery, not completed origin coverage.
  // The worker retains and unions visited airport footprints along the route.
  const moving = (event: { type: string; gpsCamera?: boolean }) => {
    followingGps = event.gpsCamera === true;
    if (followingGps) return;
    ownshipAnimation.finish();
    cancel(); if (input.enabled) status({ ...lastStatus, state: 'loading' });
  };
  const moved = (event: { type: string; gpsCamera?: boolean }) => {
    followingGps = false;
    if (!event.gpsCamera) { schedule(); return; }
    // Following the aircraft does not invalidate camera-independent terrain work.
    // Reconcile discovery afterward without discarding an in-flight result.
    if (running) queued = true;
    else if (timer === undefined && input.enabled) timer = setTimeout(() => { timer = undefined; void calculate(); }, 180);
  };
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
      map.on('movestart', moving); map.on('moveend', moved); map.on('resize', schedule);
      window.addEventListener('online', recover); document.addEventListener('visibilitychange', schedule);
      stopInventory = observeOfflineInventory(inventory); clear(); schedule();
    },
    update(next) {
      if (next.ownship && input.ownship && distanceMeters(next.ownship, input.ownship) < ORIGIN_DEADBAND_METERS) {
        next = { ...next, ownship: input.ownship };
      }
      let airportKey = airportInputKey;
      if (next.catalog !== input.catalog) {
        sources = terrainSources(next.catalog);
        sourceKey = terrainSourceKey(sources, globalThis.location?.href ?? 'http://localhost/');
        airportKey = JSON.stringify(next.catalog ? regionalNavigationLayers(next.catalog).filter(l => l.id === 'airports')
          .map(l => navigationRequestKey(l, routingCatalog(next.catalog!).revision, next.catalog!.charts, next.catalog)) : []);
      }
      const rangeKey = JSON.stringify([next.ratio, next.altitude, sourceKey]), routeKey = JSON.stringify(next.segments ?? []);
      const rangesChanged = rangeKey !== rangeInputKey, airportsChanged = airportKey !== airportInputKey;
      const routeChanged = routeKey !== routeInputKey, enabledChanged = next.enabled !== input.enabled;
      const retryChanged = next.retry !== input.retry;
      const shipChanged = !samePoint(next.ownship, input.ownship), pointChanged = !samePoint(next.point, input.point);
      input = next; rangeInputKey = rangeKey; airportInputKey = airportKey; routeInputKey = routeKey;
      if (!input.enabled && !enabledChanged) return;
      if (retryChanged) { recover(); return; }
      const planningChanged = rangesChanged || airportsChanged || routeChanged || enabledChanged;
      if (!planningChanged && !shipChanged && !pointChanged) return;
      if (rangesChanged || enabledChanged) { clear(); status({ state: 'idle' }); }
      else {
        if (airportsChanged || routeChanged && !next.segments?.length) clearAirports();
        if (shipChanged && !nearbyOwnship(publishedRanges.get('ownship')?.origin)) clearRange('ownship');
        if (pointChanged) clearRange('point');
      }
      if (airportsChanged) airportData = undefined;
      if (map && input.enabled && (shipChanged || pointChanged)) status({ ...lastStatus,
        ...(shipChanged ? { ownship: input.ownship ? 'loading' as const : 'unavailable' as const } : {}),
        ...(pointChanged ? { point: input.point ? 'loading' as const : undefined } : {}) });
      if (planningChanged) schedule();
      else if (map && input.enabled) {
        // Coalesce origin changes without canceling airport preparation or
        // continually restarting a debounce on high-rate location feeds.
        if (pointChanged) showPin();
        if (timer === undefined) timer = setTimeout(() => { timer = undefined; void calculate(); }, 250);
      }
    },
    unmount() {
      ownshipAnimation.reset();
      cancel(); release(); airportData = undefined; recoveryNeeded = false;
      stopInventory?.(); stopInventory = undefined;
      window.removeEventListener('online', recover); document.removeEventListener('visibilitychange', schedule);
      if (map) { map.off('movestart', moving); map.off('moveend', moved); map.off('resize', schedule); removeLayerResources(map, [...LAYERS].reverse(), [AREA, AIRPORTS, OWN, OWN_AREA, POINT, POINT_AREA, PIN]); }
      followingGps = false;
      map = undefined; status({ state: 'idle' });
    },
  };
}
