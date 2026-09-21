import { addProtocol, removeProtocol, type ErrorEvent, type Map as MapLibreMap } from 'maplibre-gl';
import type { RoutePlan } from '@zlayer/domain';
import { WorkerClient } from '../../core/data/worker-client';
import { removeLayerResources, type MapLayerModule } from '../../core/map/layer';
import { contourInterval, MIN_TERRAIN_ZOOM, terrainTileZoom } from './detail';
import { DEFAULT_ELEVATION_URL } from './elevation';
import { routeSegments, segmentsForTile, type Segment, type Tile } from './geometry';
import { installTerrain, syncTerrainLabels, syncTerrainContours, syncTerrainAltitude, TERRAIN_LAYERS, TERRAIN_SOURCES, TERRAIN_SOURCE } from './renderer';
import type { TerrainCoverage, TerrainStatus, TerrainWorker } from './types';
import { VIEWPORT_MIN_ZOOM } from './viewport';
import { TerrainVectorCache, type TerrainVectors } from './vector-cache';
import type { CatalogReadSource } from '../../workspace/read-context';
import { terrainSources, terrainSourceKey, packagesForTerrainTile } from './sources';
import { stitchTerrainContours } from './seams';

type TerrainInput = { routes: readonly RoutePlan[]; enabled: boolean; altitude?: number | null; catalog?: CatalogReadSource; coverage?: TerrainCoverage };
let nextProtocol = 0;

export function createTerrainLayer(onStatus: (status: TerrainStatus) => void = () => {}): MapLayerModule<TerrainInput> {
  const protocol = `route-terrain-${nextProtocol++}`;
  let map: MapLibreMap | undefined;
  let client: WorkerClient<TerrainWorker> | undefined;
  let input: TerrainInput = { routes: [], enabled: true };
  let segments: Segment[] = [];
  let sources = terrainSources(undefined);
  let sourceKey = terrainSourceKey(sources, location.href);
  let key = '', revision = 0, nextRequest = 0;
  let interval: 500 | 1000 = 1000;
  let pending = 0;
  let previousStatus = '';
  const active = new Map<AbortController, string>();
  const recovering = new Map<string, AbortController>();
  const failedTiles = new Set<string>();
  const tiles = new TerrainVectorCache();
  let coverage = new Map<string, Tile>();
  let coverageKey = '';
  let published: TerrainVectors[] | undefined;
  let vectorTimer: ReturnType<typeof setTimeout> | undefined;
  let colorFrame: number | undefined;
  let appliedAltitude: number | null | undefined, appliedInterval: number | undefined;
  const tileUrl = import.meta.env?.VITE_ZLAYERS_TERRAIN_TILE_URL?.trim() || DEFAULT_ELEVATION_URL;
  const url = () => `${protocol}://tiles/${revision}/{z}/{x}/{y}`;
  const mode = () => input.coverage ?? 'route';
  const minimumZoom = () => mode() === 'viewport' ? VIEWPORT_MIN_ZOOM : MIN_TERRAIN_ZOOM;
  const enabled = () => input.enabled && (mode() === 'viewport' || segments.length > 0);
  const coveredTiles = () => !map || !enabled() || map.getZoom() < minimumZoom() ? [] : map.coveringTiles({
    tileSize: 512, minzoom: minimumZoom(), maxzoom: 13, roundZoom: true,
  }).map(({ canonical: { z, x, y } }) => ({ z, x, y }));
  // A failure at another location or zoom must not mark the current view incomplete.
  // Retain it until recovery so returning to an unresolved gap still warns.
  const hasVisibleFailure = () => [...coverage.keys()].some(key => failedTiles.has(key));
  const hasMissingVectors = () => mode() === 'route' && [...coverage.keys()].some(key => !tiles.has(key));
  const syncColors = () => {
    if (!map) return;
    const altitude = input.altitude ?? null;
    if (altitude === appliedAltitude && interval === appliedInterval) return;
    // Coalesce slider events to at most one palette/layout update per frame.
    if (colorFrame === undefined) colorFrame = requestAnimationFrame(() => {
      colorFrame = undefined;
      if (!map) return;
      appliedAltitude = input.altitude ?? null; appliedInterval = interval;
      syncTerrainAltitude(map, appliedAltitude, interval, mode());
    });
  };
  const syncVectors = () => {
    if (!map || mode() === 'viewport') return;
    const visible = tiles.visible();
    // Fractional zoom only changes GPU stroke widths. Do not reserialize/re-tile
    // identical geometry, including when an obsolete zoom's tile finishes loading.
    if (published?.length === visible.length && visible.every((tile, index) => tile === published![index])) return;
    published = visible;
    syncTerrainLabels(map, visible.flatMap(tile => tile.labels));
    syncTerrainContours(map, stitchTerrainContours(visible.flatMap(tile => tile.lines), visible.flatMap(tile => tile.borders ?? []), segments));
  };
  const status = () => {
    const sourceLoading = TERRAIN_SOURCES.some(source => map?.getSource(source) && !map.isSourceLoaded(source));
    const state: TerrainStatus['state'] = !enabled() ? 'idle'
      : (map?.getZoom() ?? 0) < minimumZoom() ? 'zoom' : hasVisibleFailure() ? 'error'
        : pending || vectorTimer || sourceLoading || hasMissingVectors() ? 'loading' : 'ready';
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
    syncColors();
    status();
  };
  const refresh = () => {
    const nextSegments = input.enabled && mode() === 'route' ? routeSegments(input.routes) : [];
    // Tile zoom selects its own display detail. Keeping this identity independent
    // of zoom lets MapLibre reuse overview/detail tiles on repeat zoom gestures.
    const nextKey = JSON.stringify([mode(), input.enabled, nextSegments]);
    if (nextKey !== key) {
      key = nextKey; revision++; cancel(); segments = nextSegments;
      if (!enabled()) { client?.dispose(); client = undefined; }
      clearTimeout(vectorTimer); vectorTimer = undefined;
      pending = 0; failedTiles.clear(); tiles.clear(); coverage.clear(); coverageKey = ''; published = undefined;
      if (map) {
        // setTiles retains expired raster textures while replacements load. Drop
        // those textures so a previous route's corridor is never shown as current.
        removeLayerResources(map, TERRAIN_LAYERS, TERRAIN_SOURCES);
        installTerrain(map, url(), mode(), segments);
        appliedAltitude = undefined; appliedInterval = undefined;
        for (const id of TERRAIN_LAYERS) if (map.getLayer(id)) map.setLayoutProperty(id, 'visibility', enabled() ? 'visible' : 'none');
      }
    }
    refreshView();
  };
  const retry = () => { if (hasVisibleFailure()) { key = ''; refresh(); } };

  const renderTile = async (tile: Tile, controller: AbortController): Promise<{ data: ImageBitmap | null }> => {
    const requestedMode = mode();
    const nearby = requestedMode === 'viewport' ? [] : segmentsForTile(tile, segments);
    if (requestedMode === 'route' && !nearby.length) return { data: null };
    const generation = revision, id = nextRequest++, tileKey = `${tile.z}/${tile.x}/${tile.y}`;
    let worker: WorkerClient<TerrainWorker> | undefined;
    const abort = () => { if (worker) void worker.call(remote => remote.cancel(id)).catch(() => {}); };
    controller.signal.throwIfAborted();
    controller.signal.addEventListener('abort', abort, { once: true });
    active.set(controller, tileKey); pending++; status();
    try {
      if (!client || client.retired) client = new WorkerClient<TerrainWorker>(
        new Worker(new URL('./terrain.worker.ts', import.meta.url), { type: 'module' }), 'Terrain worker unavailable');
      worker = client;
      const packages = packagesForTerrainTile(sources, tile, location.href);
      const result = await worker.call(remote => remote.render({ id, tile, segments: nearby, tileUrl, packages, coverage: requestedMode }));
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
      map.on('resize', refreshView);
      map.on('sourcedata', status);
      // Failed requests finish loading via an error event, not sourcedata.
      map.on('error', sourceError);
      map.on('render', recoverVectors);
      window.addEventListener('online', retry);
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
      revision++; cancel(); client?.dispose(); client = undefined;
      clearTimeout(vectorTimer); vectorTimer = undefined; tiles.clear(); coverage.clear(); coverageKey = ''; published = undefined;
      if (colorFrame !== undefined) cancelAnimationFrame(colorFrame);
      colorFrame = undefined; appliedAltitude = undefined; appliedInterval = undefined;
      window.removeEventListener('online', retry);
      if (map) {
        map.off('move', refreshView); map.off('zoomend', refreshView); map.off('moveend', refreshView); map.off('resize', refreshView); map.off('sourcedata', status);
        map.off('error', sourceError);
        map.off('render', recoverVectors);
        removeLayerResources(map, TERRAIN_LAYERS, TERRAIN_SOURCES);
      }
      removeProtocol(protocol); map = undefined; key = ''; pending = 0; failedTiles.clear();
    },
  };
}
