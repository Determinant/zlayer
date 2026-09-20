import { addProtocol, removeProtocol, type Map as MapLibreMap } from 'maplibre-gl';
import type { RoutePlan } from '@zlayer/domain';
import { WorkerClient } from '../../core/data/worker-client';
import { removeLayerResources, type MapLayerModule } from '../../core/map/layer';
import type { TerrainLabel } from './contours';
import type { TerrainIsoline } from './isolines';
import { contourInterval, MIN_TERRAIN_ZOOM, terrainTileZoom } from './detail';
import { DEFAULT_ELEVATION_URL } from './elevation';
import { routeSegments, segmentsForTile, type Segment } from './geometry';
import { installTerrain, syncTerrainLabels, syncTerrainContours, syncTerrainAltitude, TERRAIN_LAYERS, TERRAIN_SOURCES } from './renderer';
import type { TerrainStatus, TerrainWorker } from './types';

type TerrainInput = { routes: readonly RoutePlan[]; enabled: boolean; altitude?: number | null };
let nextProtocol = 0;

export function createTerrainLayer(onStatus: (status: TerrainStatus) => void = () => {}): MapLayerModule<TerrainInput> {
  const protocol = `route-terrain-${nextProtocol++}`;
  let map: MapLibreMap | undefined;
  let client: WorkerClient<TerrainWorker> | undefined;
  let input: TerrainInput = { routes: [], enabled: true };
  let segments: Segment[] = [];
  let key = '', revision = 0, nextRequest = 0;
  let interval: 500 | 1000 = 1000;
  let pending = 0;
  let previousStatus = '';
  const active = new Set<AbortController>();
  const failedTiles = new Set<string>();
  const tiles = new Map<string, { labels: TerrainLabel[]; lines: TerrainIsoline[] }>();
  let published: { labels: TerrainLabel[]; lines: TerrainIsoline[] }[] | undefined;
  let vectorTimer: ReturnType<typeof setTimeout> | undefined;
  let colorFrame: number | undefined;
  let appliedAltitude: number | null | undefined, appliedInterval: number | undefined;
  const tileUrl = import.meta.env?.VITE_ZLAYERS_TERRAIN_TILE_URL?.trim() || DEFAULT_ELEVATION_URL;
  const url = () => `${protocol}://tiles/${revision}/{z}/{x}/{y}`;
  const coveredTileKeys = () => !map || map.getZoom() < MIN_TERRAIN_ZOOM ? [] : map.coveringTiles({
    tileSize: 512, minzoom: MIN_TERRAIN_ZOOM, maxzoom: 13, roundZoom: true,
  }).map(({ canonical: { z, x, y } }) => `${z}/${x}/${y}`);
  // A failure at another location or zoom must not mark the current view incomplete.
  // Retain it until recovery so returning to an unresolved gap still warns.
  const hasVisibleFailure = () => failedTiles.size > 0 && coveredTileKeys().some(key => failedTiles.has(key));
  const syncColors = () => {
    if (!map) return;
    const altitude = input.altitude ?? null;
    if (altitude === appliedAltitude && interval === appliedInterval) return;
    // Coalesce slider events to at most one palette/layout update per frame.
    if (colorFrame === undefined) colorFrame = requestAnimationFrame(() => {
      colorFrame = undefined;
      if (!map) return;
      appliedAltitude = input.altitude ?? null; appliedInterval = interval;
      syncTerrainAltitude(map, appliedAltitude, interval);
    });
  };
  const syncVectors = () => {
    if (!map) return;
    const coverage = new Set(coveredTileKeys());
    const visible = [...tiles.entries()].filter(([key]) => coverage.has(key)).map(([, value]) => value);
    // Fractional zoom only changes GPU stroke widths. Do not reserialize/re-tile
    // identical geometry, including when an obsolete zoom's tile finishes loading.
    if (published?.length === visible.length && visible.every((tile, index) => tile === published![index])) return;
    published = visible;
    syncTerrainLabels(map, visible.flatMap(tile => tile.labels));
    syncTerrainContours(map, visible.flatMap(tile => tile.lines));
  };
  const status = () => {
    const sourceLoading = TERRAIN_SOURCES.some(source => map?.getSource(source) && !map.isSourceLoaded(source));
    const state: TerrainStatus['state'] = !input.enabled || !segments.length ? 'idle'
      : (map?.getZoom() ?? 0) < MIN_TERRAIN_ZOOM ? 'zoom' : hasVisibleFailure() ? 'error' : pending || vectorTimer || sourceLoading ? 'loading' : 'ready';
    const overview = terrainTileZoom(map?.getZoom() ?? 0) < 10;
    const next = JSON.stringify([state, interval, overview]);
    if (next !== previousStatus) { previousStatus = next; onStatus({ state, interval, overview }); }
  };
  const cancel = () => { for (const controller of active) controller.abort(); active.clear(); };
  const refreshView = () => {
    interval = contourInterval(terrainTileZoom(map?.getZoom() ?? 9));
    syncVectors();
    syncColors();
    status();
  };
  const refresh = () => {
    const nextSegments = input.enabled ? routeSegments(input.routes) : [];
    // Tile zoom selects its own display detail. Keeping this identity independent
    // of zoom lets MapLibre reuse overview/detail tiles on repeat zoom gestures.
    const nextKey = JSON.stringify(nextSegments);
    if (nextKey !== key) {
      key = nextKey; revision++; cancel(); segments = nextSegments;
      if (!segments.length) { client?.dispose(); client = undefined; }
      clearTimeout(vectorTimer); vectorTimer = undefined;
      pending = 0; failedTiles.clear(); tiles.clear(); published = undefined;
      if (map) {
        // setTiles retains expired raster textures while replacements load. Drop
        // those textures so a previous route's corridor is never shown as current.
        removeLayerResources(map, TERRAIN_LAYERS, TERRAIN_SOURCES);
        installTerrain(map, url());
        appliedAltitude = undefined; appliedInterval = undefined;
        for (const id of TERRAIN_LAYERS) if (map.getLayer(id)) map.setLayoutProperty(id, 'visibility', segments.length ? 'visible' : 'none');
      }
    }
    refreshView();
  };
  const retry = () => { if (hasVisibleFailure()) { key = ''; refresh(); } };

  return {
    id: 'terrain', slot: 'terrain',
    foregroundLayerIds: [TERRAIN_LAYERS[2]!],
    mount(target) {
      map = target;
      addProtocol(protocol, async ({ url: requestUrl }, controller) => {
        const [version, z, x, y] = new URL(requestUrl).pathname.split('/').filter(Boolean).map(Number);
        if (version !== revision || !segments.length || z === undefined || x === undefined || y === undefined) return { data: null };
        const nearby = segmentsForTile({ z, x, y }, segments);
        if (!nearby.length) return { data: null };
        const generation = revision, id = nextRequest++, tileKey = `${z}/${x}/${y}`;
        if (!client || client.retired) client = new WorkerClient<TerrainWorker>(
          new Worker(new URL('./terrain.worker.ts', import.meta.url), { type: 'module' }), 'Terrain worker unavailable');
        const worker = client;
        const abort = () => { void worker.call(remote => remote.cancel(id)).catch(() => {}); };
        controller.signal.throwIfAborted();
        controller.signal.addEventListener('abort', abort, { once: true });
        active.add(controller); pending++; status();
        try {
          const result = await worker.call(remote => remote.render({ id, tile: { z, x, y }, segments: nearby, tileUrl }));
          if (controller.signal.aborted || generation !== revision || !map) {
            result.data?.close(); return { data: null };
          }
          if (result.incomplete) failedTiles.add(tileKey); else failedTiles.delete(tileKey);
          tiles.set(tileKey, { labels: result.labels, lines: result.lines });
          while (tiles.size > 128) tiles.delete(tiles.keys().next().value!);
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
      });
      map.on('zoomend', refreshView);
      map.on('moveend', refreshView);
      map.on('resize', refreshView);
      map.on('sourcedata', status);
      // Failed requests finish loading via an error event, not sourcedata.
      map.on('error', status);
      window.addEventListener('online', retry);
      key = ''; refresh();
    },
    update(next) {
      const geometryChanged = next.enabled !== input.enabled || next.routes.length !== input.routes.length
        || next.routes.some((route, index) => route !== input.routes[index]);
      input = next;
      if (geometryChanged) refresh(); else syncColors();
    },
    unmount() {
      revision++; cancel(); client?.dispose(); client = undefined;
      clearTimeout(vectorTimer); vectorTimer = undefined; tiles.clear(); published = undefined;
      if (colorFrame !== undefined) cancelAnimationFrame(colorFrame);
      colorFrame = undefined; appliedAltitude = undefined; appliedInterval = undefined;
      window.removeEventListener('online', retry);
      if (map) {
        map.off('zoomend', refreshView); map.off('moveend', refreshView); map.off('resize', refreshView); map.off('sourcedata', status);
        map.off('error', status);
        removeLayerResources(map, TERRAIN_LAYERS, TERRAIN_SOURCES);
      }
      removeProtocol(protocol); map = undefined; key = ''; pending = 0; failedTiles.clear();
    },
  };
}
