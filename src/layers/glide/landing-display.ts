import type { Point } from '../../core/geo/route-corridor';
import { JsonResponseError } from '../../core/data/errors';
import { emptyLandings, landingBoundsOverlap, landingSourceKey, type LandingManifest, type LandingStatus } from './landing-data';
import type { LandingHeatUpdate } from './landing-heat-tiles';
import { createLandingOverview } from './landing-overview';
import { invalidateLandingInventory } from './landing-inventory';
import { loadLandingHeat, loadLandingManifest, loadLandingShard } from './landing-loader';
import { createLandingWorker, type LandingQuery } from './landing-planner';
import { jsonIdentity } from '../../core/data/json-identity';
import { emptyAreas } from './types';
import { createLandingRasterWorker, type LandingRasterResult } from './landing-raster';

export type LandingDisplayQuery = LandingQuery & { zoom: number; heatTiles?: string[] };
export type LandingDisplayResult = LandingRasterResult & {
  heat?: LandingHeatUpdate[] | null; more: boolean; detailPending?: boolean; refreshed: boolean;
};
/** Progressive acquisition; route browsing prepares density assets without
 * retaining candidate polygon records. Detail has its own lifetime and budget. */
export function createLandingDisplayWorker(loadManifest = loadLandingManifest, loadHeat = loadLandingHeat, loadDetail = loadLandingShard) {
  let manifest: LandingManifest | undefined, source = '', identity = '', sourcesKey = '';
  let lastAttempt = -Infinity, manifestFailure: 'unavailable' | 'error' | undefined;
  let job: { id: number; controller: AbortController } | undefined;
  const overview = createLandingOverview(loadHeat);
  const details = createLandingWorker(loadManifest, loadDetail), raster = createLandingRasterWorker(loadDetail);
  let rasterMode = false, detailRevalidate = false;
  return {
    inspect: async (coordinate: Point) => rasterMode ? raster.inspect(coordinate) : details.inspect(coordinate),
    cancel(id: number) { if (job?.id === id) job.controller.abort(); details.cancel(id); raster.cancel(id); },
    async query(request: LandingDisplayQuery): Promise<LandingDisplayResult> {
      const task = { id: request.id, controller: new AbortController() }; job = task;
      const signal = task.controller.signal, ranges = request.ranges ?? emptyAreas();
      let refreshed = false;
      try {
        const nextSources = request.sources ? jsonIdentity(request.sources) : '';
        if (source !== request.manifestUrl || nextSources !== sourcesKey) {
          sourcesKey = nextSources; rasterMode = false; raster.reset(); detailRevalidate = false;
          source = request.manifestUrl; manifest = undefined; identity = ''; overview.reset(); lastAttempt = -Infinity; manifestFailure = undefined;
        }
        if (!request.segments.length && !ranges.features.length) {
          rasterMode = false; raster.reset();
          await details.query({ ...request, ranges }, manifest);
          return { collection: emptyLandings(), heat: null, raster: null, status: { state: 'route' }, renderKey: '', more: false, refreshed };
        }
        if (request.discover && (!manifest || request.revalidate) && (request.revalidate || !manifestFailure || Date.now() < lastAttempt || Date.now() - lastAttempt >= 60_000)) {
          lastAttempt = Date.now();
          try {
            const next = await loadManifest(source, signal, request.sources); signal.throwIfAborted();
            const key = landingSourceKey(source, next);
            if (key !== identity) { rasterMode = false; raster.reset(); overview.reset(); }
            manifest = next; identity = key; manifestFailure = undefined;
            refreshed = true;
            if (request.revalidate) { invalidateLandingInventory(next); overview.retry(); detailRevalidate = true; }
          } catch (error) {
            signal.throwIfAborted();
            manifestFailure = error instanceof JsonResponseError && error.status === 404 ? 'unavailable' : 'error';
          }
        }
        if (!manifest) return { collection: emptyLandings(), heat: null, raster: null, status: { state: request.discover ? manifestFailure ?? 'error' : 'zoom' }, renderKey: '', more: false, refreshed };
        const heat = await overview.query(request, manifest, signal);
        const previous = request.renderedKey?.split('/');
        const retained = new Set(request.heatTiles);
        const heatChanged = previous?.[0] !== heat.revision || request.heatTiles !== undefined && heat.tiles.some(tile => !retained.has(tile.key));
        const reply = (detail?: LandingRasterResult): LandingDisplayResult => {
          const more = !detail || !!detail.more || heat.more;
          const flags = heat.flags;
          const detailStatus = detail?.status ?? { state: 'loading' };
          const incomplete = heat.incomplete || !!manifestFailure
            || !!ranges.features.length && (['error', 'partial', 'unavailable'].includes(detailStatus.state)
              || heat.routeVisible && detailStatus.state === 'outside');
          const outside = !ranges.features.length ? heat.outside : !heat.routeVisible && detailStatus.state === 'outside';
          const state: LandingStatus['state'] = !request.discover ? 'zoom' : more ? 'loading' : incomplete ? 'partial'
            : heat.limited || detailStatus.state === 'limited' ? 'limited' : outside ? 'outside' : heat.partial ? 'partial' : 'ready';
          return { ...detail, ...(heatChanged ? { heat: heat.tiles.map(tile => retained.has(tile.key) ? { key: tile.key } : tile) } : {}),
            renderKey: `${heat.revision}/${detail?.renderKey ?? previous?.[1] ?? ''}`, more, refreshed,
            ...(!detail ? { detailPending: true } : {}),
            status: { ...detailStatus, sourceKey: identity, state, generatedAt: manifest!.generatedAt, densityCells: heat.shadedCells,
              detail: !!ranges.features.length, loadedFiles: heat.loadedFiles, totalFiles: heat.totalFiles,
              cultivated: !!(flags & 1) || !!detailStatus.cultivated, shrub: !!(flags & 2) || !!detailStatus.shrub,
              canopyUncertain: !!(flags & 8) || !!detailStatus.canopyUncertain, terrainFallback: !!(flags & 16) || !!detailStatus.terrainFallback,
              urban: !!(flags & 32) || !!detailStatus.urban, closeBuildings: !!(flags & 64) || !!detailStatus.closeBuildings,
              mixedOpen: !!(flags & 128) || !!detailStatus.mixedOpen, constrained: !!(flags & 256) || !!detailStatus.constrained,
              obstacleUncertain: !!(flags & 512) || !!detailStatus.obstacleUncertain, coverUncertain: !!(flags & 1024) || !!detailStatus.coverUncertain,
              shrubEvidenceMissing: !!detailStatus.shrubEvidenceMissing || manifest!.coverage.some(region => region.shrubEvidenceMissing && landingBoundsOverlap(region.bounds, request.bounds)),
              preferredLengthFt: manifest!.schemaVersion === 4 ? 3000 : 2000 } };
        };
        // Return ready imagery before acquiring/unioning detailed polygons. The
        // map acknowledges heat separately and immediately schedules the next
        // batch; detail starts once that imagery has reached the map.
        if (ranges.features.length && heat.tiles.length && heatChanged) return reply();
        const { renderedKey: _renderedKey, ...detailRequest } = request;
        // Once a range needs raster detail, that renderer owns frame changes.
        // Camera zoom must not destroy its completed inputs or restart vector work.
        if (!ranges.features.length) { rasterMode = false; raster.reset(); }
        const query = { ...detailRequest, ranges, revalidate: detailRevalidate, ...(previous?.[1] ? { renderedKey: previous[1] } : {}) };
        let detail: LandingRasterResult;
        if (rasterMode) detail = await raster.query(query, manifest);
        else {
          detail = { ...await details.query(query, manifest), raster: null };
          if (request.discover && ranges.features.length && detail.limited) {
            // Release the retained vector geometry before starting the bounded image.
            await details.query({ ...query, ranges: emptyAreas() }, manifest);
            rasterMode = true; detail = await raster.query(query, manifest);
          }
        }
        signal.throwIfAborted();
        detailRevalidate = false;
        return reply(detail);
      } finally { if (job === task) job = undefined; }
    },
  };
}
export type LandingDisplayWorker = ReturnType<typeof createLandingDisplayWorker>;
