import { addProtocol, removeProtocol, type ErrorEvent, type Map as MapLibreMap } from 'maplibre-gl';
import type { RoutePlan } from '@zlayer/domain';
import { WorkerClient } from '../../core/data/worker-client';
import { createFrameTask } from '../../core/graphics/frame-task';
import { observeOfflineInventory } from '../../offline/inventory-events';
import { removeLayerResources, type MapLayerModule } from '../../core/map/layer';
import { contourInterval, MIN_TERRAIN_ZOOM, terrainTileZoom } from './detail';
import { DEFAULT_ELEVATION_URL } from './elevation';
import { routeSegments, segmentsForTile, type Segment, type Tile } from './geometry';
import { installTerrain, syncTerrainLabels, syncTerrainContours, syncTerrainCorridor, syncTerrainAltitude, TERRAIN_LAYERS, TERRAIN_SOURCES, TERRAIN_SOURCE } from './renderer';
import type { TerrainCoverage, TerrainStatus, TerrainWorker } from './types';
import { VIEWPORT_MIN_ZOOM } from './viewport';
import { TerrainVectorCache, type TerrainVectors } from './vector-cache';
import type { CatalogReadSource } from '../../workspace/read-context';
import { terrainSources, terrainSourceKey, packagesForTerrainTile } from './sources';
import { TerrainContourJob } from './contour-job';
import { TerrainCorridorJob } from './corridor-job';
import type { FeatureCollection } from 'geojson';
import { createSourceSubmission } from '../../core/map/source-submission';
import { TERRAIN_LABEL_SOURCE, TERRAIN_CONTOUR_SOURCE, TERRAIN_CORRIDOR_SOURCE } from './renderer';

type TerrainInput = { routes: readonly RoutePlan[]; enabled: boolean; altitude?: number | null; catalog?: CatalogReadSource; coverage?: TerrainCoverage };
let nextProtocol = 0;

export function createTerrainLayer(onStatus: (status: TerrainStatus) => void = () => {}): MapLayerModule<TerrainInput> {
  const protocol = `route-terrain-${nextProtocol++}`;
  let map: MapLibreMap | undefined;
  let client: WorkerClient<TerrainWorker> | undefined;
  let workerError: unknown;
  let stopObservingInventory: (() => void) | undefined;
  let input: TerrainInput = { routes: [], enabled: true };
  let segments: Segment[] = [];
  let sources = terrainSources(undefined);
  let sourceKey = terrainSourceKey(sources, location.href);
  let key = '', revision = 0, nextRequest = 0;
  let interval: 500 | 1000 = 1000;
  let pending = 0;
  let corridorKey = '';
  const corridor = new TerrainCorridorJob(segments => worker().call(remote => remote.corridor(segments)),
    () => { syncCorridor(); status(); });
  let previousStatus = '';
  const active = new Map<AbortController, string>();
  const recovering = new Map<string, AbortController>();
  const failedTiles = new Set<string>();
  const tiles = new TerrainVectorCache();
  let coverage = new Map<string, Tile>();
  let coverageKey = '';
  let published: TerrainVectors[] | undefined;
  const contours = new TerrainContourJob(() => status());
  let vectorTimer: ReturnType<typeof setTimeout> | undefined;
  let appliedAltitude: number | null | undefined, appliedInterval: number | undefined;
  type VectorSource = { submission: ReturnType<typeof createSourceSubmission>; data?: FeatureCollection;
    timer?: ReturnType<typeof setTimeout> | undefined; retried: boolean; failed: boolean };
  const vectorSources = new Map<string, VectorSource>();
  const vectorVisibility = (source: string, visible: boolean) => {
    const value = visible && enabled() ? 'visible' : 'none';
    for (const id of TERRAIN_LAYERS) if (map?.getLayer(id)?.source === source && map.getLayoutProperty(id, 'visibility') !== value) {
      map.setLayoutProperty(id, 'visibility', value);
    }
  };
  const submit = (id: string, data: FeatureCollection, retry = false) => {
    const source = vectorSources.get(id);
    if (!source) return;
    source.data = data;
    if (!retry) { source.retried = false; clearTimeout(source.timer); source.timer = undefined; }
    if (!data.features.length) vectorVisibility(id, false);
    const version = source.submission.begin();
    void source.submission.submit(version, data).then(accepted => {
      if (accepted) {
        vectorVisibility(id, data.features.length > 0);
        if (source.failed) { source.failed = false; status(); }
      }
    }).catch(error => source.submission.reject(version, error));
  };
  const disposeVectorSources = () => {
    for (const source of vectorSources.values()) { clearTimeout(source.timer); source.submission.destroy(); }
    vectorSources.clear();
  };
  const installVectorSources = () => {
    if (!map || mode() !== 'route') return;
    for (const id of [TERRAIN_LABEL_SOURCE, TERRAIN_CONTOUR_SOURCE, TERRAIN_CORRIDOR_SOURCE]) {
      const source: VectorSource = { retried: false, failed: false, submission: createSourceSubmission(map, id, () => {
        source.failed = true; vectorVisibility(id, false); status();
        if (!source.retried && source.data) {
          source.retried = true;
          source.timer = setTimeout(() => { source.timer = undefined; if (source.data) submit(id, source.data, true); }, 100);
        }
      }) };
      vectorSources.set(id, source);
    }
    const source = vectorSources.get(TERRAIN_CORRIDOR_SOURCE)!;
    const cached = corridor.data(corridorKey);
    if (cached) { source.data = cached; source.submission.begin(); }
  };
  const retryVectorSources = () => {
    for (const [id, source] of vectorSources) if (source.submission.failed && source.timer === undefined && source.data) submit(id, source.data, true);
  };
  const tileUrl = import.meta.env?.VITE_ZLAYERS_TERRAIN_TILE_URL?.trim() || DEFAULT_ELEVATION_URL;
  const url = () => `${protocol}://tiles/${revision}/{z}/{x}/{y}`;
  const mode = () => input.coverage ?? 'route';
  const minimumZoom = () => mode() === 'viewport' ? VIEWPORT_MIN_ZOOM : MIN_TERRAIN_ZOOM;
  const enabled = () => input.enabled && (mode() === 'viewport' || segments.length > 0);
  const needsCorridor = () => enabled() && mode() === 'route' && !corridor.data(corridorKey);
  const worker = () => {
    if (workerError) throw workerError;
    try {
      if (!client || client.retired) client = new WorkerClient<TerrainWorker>(
        new Worker(new URL('./terrain.worker.ts', import.meta.url), { type: 'module' }), 'Terrain worker unavailable');
      return client;
    } catch (error) { workerError = error; throw error; }
  };
  const coveredTiles = () => !map || !enabled() || map.getZoom() < minimumZoom() ? [] : map.coveringTiles({
    tileSize: 512, minzoom: minimumZoom(), maxzoom: 13, roundZoom: true,
  }).map(({ canonical: { z, x, y } }) => ({ z, x, y }));
  // A failure at another location or zoom must not mark the current view incomplete.
  // Retain it until recovery so returning to an unresolved gap still warns.
  const hasVisibleFailure = () => [...coverage.keys()].some(key => failedTiles.has(key));
  const hasMissingVectors = () => mode() === 'route' && [...coverage.keys()].some(key => !tiles.has(key));
  const colors = createFrameTask(() => {
    if (!map) return;
    appliedAltitude = input.altitude ?? null; appliedInterval = interval;
    syncTerrainAltitude(map, appliedAltitude, interval, mode());
  });
  const syncColors = () => {
    if (!map) return;
    const altitude = input.altitude ?? null;
    if (altitude === appliedAltitude && interval === appliedInterval) return;
    // Coalesce slider events to at most one palette/layout update per frame.
    colors.schedule();
  };
  const syncVectors = () => {
    if (!map || mode() === 'viewport') return;
    const visible = tiles.visible();
    // Fractional zoom only changes GPU stroke widths. Do not reserialize/re-tile
    // identical geometry, including when an obsolete zoom's tile finishes loading.
    if (published?.length === visible.length && visible.every((tile, index) => tile === published![index])) return;
    published = visible;
    syncTerrainLabels(map, visible.flatMap(tile => tile.labels), submit);
    contours.request(visible, segments, lines => {
      if (map) syncTerrainContours(map, lines, submit);
    });
  };
  const status = () => {
    const sourceLoading = TERRAIN_SOURCES.some(source => map?.getSource(source) && !map.isSourceLoaded(source));
    const state: TerrainStatus['state'] = !enabled() ? 'idle'
      : (map?.getZoom() ?? 0) < minimumZoom() ? 'zoom' : hasVisibleFailure() || corridor.failed || contours.failed || [...vectorSources.values()].some(source => source.failed) ? 'error'
        : pending || vectorTimer || contours.pending || sourceLoading || hasMissingVectors() || needsCorridor() ? 'loading' : 'ready';
    const overview = terrainTileZoom(map?.getZoom() ?? 0) < 10;
    const next = JSON.stringify([state, interval, overview, mode()]);
    if (next !== previousStatus) { previousStatus = next; onStatus({ state, interval, overview, coverage: mode() }); }
  };
  const sourceError = (event: ErrorEvent & { sourceId?: string }) => {
    status();
    // Raster errors mark a tile complete without emitting sourcedata. Ensure a
    // final frame observes that completion, even if every visible request failed.
    if (event.sourceId === TERRAIN_SOURCE) map?.triggerRepaint();
  };
  const cancel = () => { for (const controller of active.keys()) controller.abort(); active.clear(); recovering.clear(); };
  const syncCorridor = () => {
    if (!map || !needsCorridor() || map.getZoom() < minimumZoom()) return;
    const key = corridorKey;
    corridor.request(key, segments, () => key === corridorKey && !!map && enabled() && mode() === 'route',
      data => syncTerrainCorridor(map!, data, submit));
  };
  const refreshView = () => {
    const next = new Map(coveredTiles().map(tile => [`${tile.z}/${tile.x}/${tile.y}`, tile]));
    const nextKey = [...next.keys()].sort().join(',');
    if (nextKey !== coverageKey) {
      coverageKey = nextKey;
      // Only route-intersecting tiles can contribute vectors. Compute that
      // subset only when tile coverage changes, not on every pixel of a pan.
      if (mode() === 'route') for (const [key, tile] of next) if (!segmentsForTile(tile, segments).length) next.delete(key);
      coverage = next;
      tiles.setVisible(coverage.keys());
      for (const [key, controller] of recovering) if (!coverage.has(key)) controller.abort();
      syncVectors();
    }
    interval = contourInterval(terrainTileZoom(map?.getZoom() ?? 9));
    syncCorridor();
    syncColors();
    status();
  };
  const refresh = () => {
    const nextSegments = input.enabled && mode() === 'route' ? routeSegments(input.routes) : [];
    // Tile zoom selects its own display detail. Keeping this identity independent
    // of zoom lets MapLibre reuse overview/detail tiles on repeat zoom gestures.
    const nextCorridorKey = JSON.stringify(nextSegments);
    const nextKey = `${mode()}/${input.enabled}/${nextCorridorKey}`;
    if (nextKey !== key) {
      key = nextKey; revision++; cancel(); contours.clear(); segments = nextSegments;
      corridorKey = nextCorridorKey; corridor.resetFailure(); workerError = undefined;
      if (!enabled()) { corridor.cancel(); client?.dispose(); client = undefined; }
      clearTimeout(vectorTimer); vectorTimer = undefined;
      pending = 0; failedTiles.clear(); tiles.clear(); coverage.clear(); coverageKey = ''; published = undefined;
      if (map) {
        // setTiles retains expired raster textures while replacements load. Drop
        // those textures so a previous route's corridor is never shown as current.
        disposeVectorSources();
        removeLayerResources(map, TERRAIN_LAYERS, TERRAIN_SOURCES);
        installVectorSources();
        installTerrain(map, url(), mode(), corridor.data(corridorKey));
        appliedAltitude = undefined; appliedInterval = undefined;
        for (const id of TERRAIN_LAYERS) if (map.getLayer(id)) map.setLayoutProperty(id, 'visibility', enabled() ? 'visible' : 'none');
      }
    }
    refreshView();
  };
  // Repair also invalidates incomplete tiles outside the current view, so they
  // cannot reappear from MapLibre's raster cache after a later pan.
  const retry = () => {
    retryVectorSources();
    if (contours.failed) { published = undefined; syncVectors(); }
    if (failedTiles.size) { key = ''; refresh(); }
    else if (corridor.failed) { corridor.resetFailure(); workerError = undefined; refreshView(); }
  };

  const renderTile = async (tile: Tile, controller: AbortController): Promise<{ data: ImageBitmap | null }> => {
    const requestedMode = mode();
    const nearby = requestedMode === 'viewport' ? [] : segmentsForTile(tile, segments);
    if (requestedMode === 'route' && !nearby.length) return { data: null };
    const generation = revision, id = nextRequest++, tileKey = `${tile.z}/${tile.x}/${tile.y}`;
    let target: WorkerClient<TerrainWorker> | undefined;
    const abort = () => { if (target) void target.call(remote => remote.cancel(id)).catch(() => {}); };
    controller.signal.throwIfAborted();
    controller.signal.addEventListener('abort', abort, { once: true });
    active.set(controller, tileKey); pending++; status();
    try {
      target = worker();
      const packages = packagesForTerrainTile(sources, tile, location.href);
      const result = await target.call(remote => remote.render({ id, tile, segments: nearby, tileUrl, packages, coverage: requestedMode }));
      if (controller.signal.aborted || generation !== revision || !map) {
        result.data?.close(); return { data: null };
      }
      if (result.incomplete) failedTiles.add(tileKey); else failedTiles.delete(tileKey);
      if (requestedMode === 'viewport') return { data: result.data };
      tiles.put(tileKey, { labels: result.labels, lines: result.lines, borders: result.borders ?? [] });
      if (!vectorTimer) vectorTimer = setTimeout(() => {
        vectorTimer = undefined;
        syncVectors();
        status();
      }, 100);
      return { data: result.data };
    } catch (error) {
      if (!controller.signal.aborted && generation === revision) { failedTiles.add(tileKey); throw error; }
      return { data: null };
    } finally {
      controller.signal.removeEventListener('abort', abort); active.delete(controller);
      if (generation === revision) { pending--; status(); }
    }
  };

  const recoverVectors = () => {
    // `render` follows MapLibre's raster-demand update. Inside `move`, the
    // previous view can still report loaded and cause duplicate cold-tile work.
    if (!map || !hasMissingVectors() || !map.getSource(TERRAIN_SOURCE) || !map.isSourceLoaded(TERRAIN_SOURCE)) return;
    for (const [key, tile] of coverage) {
      if (recovering.size >= 4) break;
      if (tiles.has(key) || failedTiles.has(key) || recovering.has(key) || [...active.values()].includes(key)) continue;
      const controller = new AbortController();
      recovering.set(key, controller);
      void renderTile(tile, controller).then(result => result.data?.close()).catch(() => {
        // renderTile records the failure; do not spin on an unavailable tile.
      }).finally(() => {
        if (recovering.get(key) !== controller) return;
        recovering.delete(key);
        // Recheck on a frame, after raster demand has caught up with any pan.
        map?.triggerRepaint();
      });
    }
  };

  return {
    id: 'terrain', slot: 'terrain',
    foregroundLayerIds: [TERRAIN_LAYERS[2]!],
    mount(target) {
      map = target;
      addProtocol(protocol, async ({ url: requestUrl }, controller) => {
        const [version, z, x, y] = new URL(requestUrl).pathname.split('/').filter(Boolean).map(Number);
        if (version !== revision || !enabled() || z === undefined || x === undefined || y === undefined) return { data: null };
        return renderTile({ z, x, y }, controller);
      });
      map.on('move', refreshView);
      map.on('zoomend', refreshView);
      map.on('moveend', refreshView);
      map.on('moveend', retryVectorSources);
      map.on('resize', refreshView);
      map.on('sourcedata', status);
      // Failed requests finish loading via an error event, not sourcedata.
      map.on('error', sourceError);
      map.on('render', recoverVectors);
      window.addEventListener('online', retry);
      stopObservingInventory = observeOfflineInventory(retry);
      key = ''; refresh();
    },
    update(next) {
      let sourceChanged = false;
      if (next.catalog !== input.catalog) {
        sources = terrainSources(next.catalog);
        const nextSourceKey = terrainSourceKey(sources, location.href);
        sourceChanged = nextSourceKey !== sourceKey;
        sourceKey = nextSourceKey;
        if (sourceChanged) key = '';
      }
      const geometryChanged = sourceChanged || next.coverage !== input.coverage || next.enabled !== input.enabled || next.routes.length !== input.routes.length
        || next.routes.some((route, index) => route !== input.routes[index]);
      input = next;
      if (geometryChanged) refresh(); else syncColors();
    },
    unmount() {
      disposeVectorSources();
      corridor.clear(); contours.clear(); corridorKey = ''; workerError = undefined;
      revision++; cancel(); client?.dispose(); client = undefined;
      clearTimeout(vectorTimer); vectorTimer = undefined; tiles.clear(); coverage.clear(); coverageKey = ''; published = undefined;
      colors.cancel(); appliedAltitude = undefined; appliedInterval = undefined;
      window.removeEventListener('online', retry);
      stopObservingInventory?.(); stopObservingInventory = undefined;
      if (map) {
        map.off('move', refreshView); map.off('zoomend', refreshView); map.off('moveend', refreshView); map.off('resize', refreshView); map.off('sourcedata', status);
        map.off('error', sourceError);
        map.off('moveend', retryVectorSources);
        map.off('render', recoverVectors);
        removeLayerResources(map, TERRAIN_LAYERS, TERRAIN_SOURCES);
      }
      removeProtocol(protocol); map = undefined; key = ''; pending = 0; failedTiles.clear();
    },
  };
}
