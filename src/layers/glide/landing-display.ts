import clipping from 'polygon-clipping';
import type { Bounds } from '@zlayer/contracts';
import { project, type Point } from '../../core/geo/route-corridor';
import { JsonResponseError } from '../../core/data/errors';
import { boundsViewport, localRouteSegments, routeMask } from './coverage';
import { emptyLandings, landingBoundsOverlap, landingSourceKey, type LandingManifest, type LandingStatus } from './landing-data';
import { landingHeatFrame, landingHeatImage, type LandingHeat, type LandingHeatImage } from './landing-heat';
import { loadLandingHeat, loadLandingManifest, loadLandingShard } from './landing-loader';
import { createLandingWorker, type LandingQuery } from './landing-planner';
import { landingShards } from './landing-inventory';
import { landingCoverageMask, scopedLandingMask, scopeIntersects } from './landing-scope';
import { jsonIdentity } from '../../core/data/json-identity';
import type { LandingShard } from './landing-data';
import { emptyAreas } from './types';
import { createLandingRasterWorker, type LandingRasterResult } from './landing-raster';

export type LandingDisplayQuery = LandingQuery & { zoom: number };
export type LandingDisplayResult = LandingRasterResult & { heat?: LandingHeatImage | null; more: boolean };
const MAX_VISIBLE = 32, MAX_CACHED = 64;

/** Progressive, two-file acquisition; route browsing retains only compact density grids. */
export function createLandingDisplayWorker(loadManifest = loadLandingManifest, loadHeat = loadLandingHeat, loadDetail = loadLandingShard) {
  let manifest: LandingManifest | undefined, source = '', identity = '', heatKey = '', heatRevision = 0, sourcesKey = '';
  let lastHeat: LandingHeatImage | null = null, lastAttempt = -Infinity, manifestFailure: 'unavailable' | 'error' | undefined;
  let job: { id: number; controller: AbortController } | undefined;
  const grids = new Map<string, LandingHeat>(), knownHeat = new Map<string, LandingShard>(), failed = new Set<string>();
  const details = createLandingWorker(loadManifest, loadDetail), raster = createLandingRasterWorker(loadDetail);
  let rasterMode = false, detailZoom = -Infinity;
  return {
    inspect: async (coordinate: Point) => rasterMode ? raster.inspect(coordinate) : details.inspect(coordinate),
    cancel(id: number) { if (job?.id === id) job.controller.abort(); details.cancel(id); raster.cancel(id); },
    async query(request: LandingDisplayQuery): Promise<LandingDisplayResult> {
      const task = { id: request.id, controller: new AbortController() }; job = task;
      const signal = task.controller.signal, ranges = request.ranges ?? emptyAreas();
      try {
        const nextSources = request.sources ? jsonIdentity(request.sources) : '';
        if (source !== request.manifestUrl || nextSources !== sourcesKey) {
          sourcesKey = nextSources; rasterMode = false; raster.reset();
          source = request.manifestUrl; manifest = undefined; identity = ''; grids.clear(); knownHeat.clear(); failed.clear(); heatKey = ''; lastAttempt = -Infinity; manifestFailure = undefined;
        }
        if (!request.segments.length && !ranges.features.length) {
          rasterMode = false; raster.reset();
          await details.query({ ...request, ranges }, manifest);
          return { collection: emptyLandings(), heat: null, raster: null, status: { state: 'route' }, renderKey: '', more: false };
        }
        if (request.discover && (!manifest || request.revalidate) && (request.revalidate || !manifestFailure || Date.now() - lastAttempt >= 60_000)) {
          lastAttempt = Date.now();
          try {
            const next = await loadManifest(source, signal, request.sources); signal.throwIfAborted();
            const key = landingSourceKey(source, next);
            if (key !== identity) { rasterMode = false; raster.reset(); grids.clear(); knownHeat.clear(); failed.clear(); heatKey = ''; }
            manifest = next; identity = key; manifestFailure = undefined;
            if (request.revalidate) failed.clear();
          } catch (error) {
            signal.throwIfAborted();
            manifestFailure = error instanceof JsonResponseError && error.status === 404 ? 'unavailable' : 'error';
          }
        }
        if (!manifest) return { collection: emptyLandings(), heat: null, raster: null, status: { state: request.discover ? manifestFailure ?? 'error' : 'zoom' }, renderKey: '', more: false };
        const east = request.bounds[2] < request.bounds[0] ? request.bounds[2] + 360 : request.bounds[2];
        const view: Bounds = [request.bounds[0], request.bounds[1], east, request.bounds[3]];
        const viewport = boundsViewport(view), segments = localRouteSegments(request.segments, viewport), mask = routeMask(segments, viewport);
        const center = project([(view[0] + view[2]) / 2, (view[1] + view[3]) / 2]);
        let inventory: Awaited<ReturnType<typeof landingShards>> = { shards: [], limited: false }, indexFailed = false;
        if (request.discover && mask.length) {
          const frame = landingHeatFrame(request.bounds, request.zoom), zoom = Math.max(0, Math.floor(Math.log2(1 / (256 * frame.step))));
          try { inventory = await landingShards(manifest, 'overview', request.bounds, zoom, signal); }
          catch { signal.throwIfAborted(); indexFailed = true; }
        } else if (!request.discover) inventory.shards = manifest.packages ? [...knownHeat.values()] : manifest.shards;
        const visible = inventory.shards.flatMap(shard => {
          if (!mask.length || !landingBoundsOverlap(shard.bounds, request.bounds)) return [];
          const box = boundsViewport(shard.bounds), shift = Math.round(center[0] - (box[0]![0] + box[2]![0]) / 2);
          const ring = box.map(([x, y]) => [x + shift, y] as Point); ring.push(ring[0]!);
          if (!scopedLandingMask(clipping.intersection(mask, [ring]), shard.scope).length) return [];
          return [{ shard, distance: Math.hypot((ring[0]![0] + ring[2]![0]) / 2 - center[0], (ring[0]![1] + ring[2]![1]) / 2 - center[1]) }];
        }).sort((a, b) => a.distance - b.distance || a.shard.id.localeCompare(b.shard.id));
        const wanted = visible.slice(0, MAX_VISIBLE).map(({ shard }) => shard), wantedFiles = new Set(wanted.map(shard => shard.file));
        const pending = request.discover ? wanted.filter(shard => !grids.has(shard.file) && !failed.has(shard.file)) : [];
        // Each result reaches the map before the next pair starts, keeping cold views responsive.
        const results = await Promise.allSettled(pending.slice(0, 2).map(async shard => {
          const heat = await loadHeat(source, shard, signal, manifest!.schemaVersion); signal.throwIfAborted();
          grids.set(shard.file, { ...heat, scope: shard.scope }); knownHeat.set(shard.file, shard);
        }));
        signal.throwIfAborted();
        results.forEach((result, i) => { if (result.status === 'rejected') failed.add(pending[i]!.file); });
        for (const shard of wanted) {
          const grid = grids.get(shard.file);
          if (grid) { grids.delete(shard.file); grids.set(shard.file, grid); }
        }
        for (const [key] of grids) {
          if (grids.size <= MAX_CACHED) break;
          if (!wantedFiles.has(key)) { grids.delete(key); knownHeat.delete(key); }
        }
        const available = wanted.filter(shard => grids.has(shard.file));
        const nextHeat = JSON.stringify([landingHeatFrame(request.bounds, request.zoom), request.segments, available.map(shard => shard.file)]);
        if (nextHeat !== heatKey) {
          lastHeat = segments.length ? landingHeatImage(available.map(shard => grids.get(shard.file)!), request.bounds, request.zoom, segments) : null;
          heatKey = nextHeat; heatRevision++;
        }
        const previous = request.renderedKey?.split('/');
        const { renderedKey: _renderedKey, ...detailRequest } = request;
        if (!ranges.features.length || Math.floor(request.zoom) !== detailZoom) { rasterMode = false; raster.reset(); }
        detailZoom = Math.floor(request.zoom);
        const query = { ...detailRequest, ranges, ...(previous?.[1] ? { renderedKey: previous[1] } : {}) };
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
        const more = !!detail.more || request.discover && wanted.some(shard => !grids.has(shard.file) && !failed.has(shard.file));
        const flags = available.reduce((flags, shard) => flags | grids.get(shard.file)!.flags, 0);
        const coverage = landingCoverageMask(manifest, view);
        const routeOutside = mask.length > 0 && (!coverage.length || !clipping.intersection(mask, coverage).length);
        const routePartial = mask.length > 0 && (!coverage.length || !!clipping.difference(mask, coverage).length);
        const incomplete = indexFailed || !!inventory.failed || !!manifest.unavailableScopes?.some(scope => scopeIntersects(request.bounds, scope)) || !!manifestFailure || wanted.some(shard => failed.has(shard.file))
          || !!ranges.features.length && (['error', 'partial', 'unavailable'].includes(detail.status.state)
            || !!mask.length && detail.status.state === 'outside');
        const outside = !ranges.features.length ? routeOutside || !mask.length : !mask.length && detail.status.state === 'outside';
        const state: LandingStatus['state'] = !request.discover ? 'zoom' : more ? 'loading' : incomplete ? 'partial'
          : inventory.limited || visible.length > MAX_VISIBLE || detail.status.state === 'limited' ? 'limited' : outside ? 'outside' : routePartial ? 'partial' : 'ready';
        return { ...detail, ...(previous?.[0] !== String(heatRevision) ? { heat: lastHeat } : {}),
          renderKey: `${heatRevision}/${detail.renderKey}`, more,
          status: { ...detail.status, state, generatedAt: manifest.generatedAt, densityCells: lastHeat?.shadedCells ?? 0,
            detail: !!ranges.features.length, loadedFiles: available.length, totalFiles: wanted.length,
            cultivated: !!(flags & 1) || !!detail.status.cultivated, shrub: !!(flags & 2) || !!detail.status.shrub,
            canopyUncertain: !!(flags & 8) || !!detail.status.canopyUncertain, terrainFallback: !!(flags & 16) || !!detail.status.terrainFallback,
            urban: !!(flags & 32) || !!detail.status.urban, closeBuildings: !!(flags & 64) || !!detail.status.closeBuildings,
            mixedOpen: !!(flags & 128) || !!detail.status.mixedOpen, constrained: !!(flags & 256) || !!detail.status.constrained,
            obstacleUncertain: !!(flags & 512) || !!detail.status.obstacleUncertain, coverUncertain: !!(flags & 1024) || !!detail.status.coverUncertain,
            shrubEvidenceMissing: !!detail.status.shrubEvidenceMissing || manifest.coverage.some(region => region.shrubEvidenceMissing && landingBoundsOverlap(region.bounds, request.bounds)),
            preferredLengthFt: manifest.schemaVersion === 4 ? 3000 : 2000 } };
      } finally { if (job === task) job = undefined; }
    },
  };
}
export type LandingDisplayWorker = ReturnType<typeof createLandingDisplayWorker>;
