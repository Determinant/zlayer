import clipping, { type Polygon } from 'polygon-clipping';
import type { Bounds } from '@zlayer/contracts';
import { project, type Point } from '../../core/geo/route-corridor';
import { JsonResponseError } from '../../core/data/errors';
import { boundsViewport, localRouteSegments, routeMask } from './coverage';
import { emptyLandings, landingBoundsOverlap, landingSourceKey, type LandingManifest, type LandingStatus } from './landing-data';
import { landingHeatFrame, landingHeatImage, type LandingHeat, type LandingHeatImage } from './landing-heat';
import { loadLandingHeat, loadLandingManifest, loadLandingShard } from './landing-loader';
import { createLandingWorker, type LandingQuery, type LandingResult } from './landing-planner';
import { emptyAreas } from './types';

export type LandingDisplayQuery = LandingQuery & { zoom: number };
export type LandingDisplayResult = LandingResult & { heat?: LandingHeatImage | null; more: boolean };
const MAX_VISIBLE = 32, MAX_CACHED = 64;

/** Progressive, two-file acquisition; route browsing retains only compact density grids. */
export function createLandingDisplayWorker(loadManifest = loadLandingManifest, loadHeat = loadLandingHeat, loadDetail = loadLandingShard) {
  let manifest: LandingManifest | undefined, source = '', identity = '', heatKey = '', heatRevision = 0;
  let lastHeat: LandingHeatImage | null = null, lastAttempt = -Infinity, manifestFailure: 'unavailable' | 'error' | undefined;
  let job: { id: number; controller: AbortController } | undefined;
  const grids = new Map<string, LandingHeat>(), failed = new Set<string>();
  const details = createLandingWorker(loadManifest, loadDetail);
  return {
    inspect: details.inspect,
    cancel(id: number) { if (job?.id === id) job.controller.abort(); details.cancel(id); },
    async query(request: LandingDisplayQuery): Promise<LandingDisplayResult> {
      const task = { id: request.id, controller: new AbortController() }; job = task;
      const signal = task.controller.signal, ranges = request.ranges ?? emptyAreas();
      try {
        if (source !== request.manifestUrl) {
          source = request.manifestUrl; manifest = undefined; identity = ''; grids.clear(); failed.clear(); heatKey = ''; lastAttempt = -Infinity; manifestFailure = undefined;
        }
        if (!request.segments.length && !ranges.features.length) {
          await details.query({ ...request, ranges }, manifest);
          return { collection: emptyLandings(), heat: null, status: { state: 'route' }, renderKey: '', more: false };
        }
        if (request.discover && (!manifest || request.revalidate) && (request.revalidate || !manifestFailure || Date.now() - lastAttempt >= 60_000)) {
          lastAttempt = Date.now();
          try {
            const next = await loadManifest(source, signal); signal.throwIfAborted();
            const key = landingSourceKey(source, next);
            if (key !== identity) { grids.clear(); failed.clear(); heatKey = ''; }
            manifest = next; identity = key; manifestFailure = undefined;
            if (request.revalidate) failed.clear();
          } catch (error) {
            signal.throwIfAborted();
            manifestFailure = error instanceof JsonResponseError && error.status === 404 ? 'unavailable' : 'error';
          }
        }
        if (!manifest) return { collection: emptyLandings(), heat: null, status: { state: request.discover ? manifestFailure ?? 'error' : 'zoom' }, renderKey: '', more: false };
        const east = request.bounds[2] < request.bounds[0] ? request.bounds[2] + 360 : request.bounds[2];
        const view: Bounds = [request.bounds[0], request.bounds[1], east, request.bounds[3]];
        const viewport = boundsViewport(view), segments = localRouteSegments(request.segments, viewport), mask = routeMask(segments, viewport);
        const center = project([(view[0] + view[2]) / 2, (view[1] + view[3]) / 2]);
        const visible = manifest.shards.flatMap(shard => {
          if (!mask.length || !landingBoundsOverlap(shard.bounds, request.bounds)) return [];
          const box = boundsViewport(shard.bounds), shift = Math.round(center[0] - (box[0]![0] + box[2]![0]) / 2);
          const ring = box.map(([x, y]) => [x + shift, y] as Point); ring.push(ring[0]!);
          if (!clipping.intersection(mask, [ring]).length) return [];
          return [{ shard, distance: Math.hypot((ring[0]![0] + ring[2]![0]) / 2 - center[0], (ring[0]![1] + ring[2]![1]) / 2 - center[1]) }];
        }).sort((a, b) => a.distance - b.distance || a.shard.id.localeCompare(b.shard.id));
        const wanted = visible.slice(0, MAX_VISIBLE).map(({ shard }) => shard), wantedFiles = new Set(wanted.map(shard => shard.file));
        const pending = request.discover ? wanted.filter(shard => !grids.has(shard.file) && !failed.has(shard.file)) : [];
        // Each result reaches the map before the next pair starts, keeping cold views responsive.
        const results = await Promise.allSettled(pending.slice(0, 2).map(async shard => {
          const heat = await loadHeat(source, shard, signal, manifest!.schemaVersion); signal.throwIfAborted();
          grids.set(shard.file, heat);
        }));
        signal.throwIfAborted();
        results.forEach((result, i) => { if (result.status === 'rejected') failed.add(pending[i]!.file); });
        for (const shard of wanted) {
          const grid = grids.get(shard.file);
          if (grid) { grids.delete(shard.file); grids.set(shard.file, grid); }
        }
        for (const [key] of grids) {
          if (grids.size <= MAX_CACHED) break;
          if (!wantedFiles.has(key)) grids.delete(key);
        }
        const available = wanted.filter(shard => grids.has(shard.file));
        const nextHeat = JSON.stringify([landingHeatFrame(request.bounds, request.zoom), request.segments, available.map(shard => shard.file)]);
        if (nextHeat !== heatKey) {
          lastHeat = segments.length ? landingHeatImage(available.map(shard => grids.get(shard.file)!), request.bounds, request.zoom, segments) : null;
          heatKey = nextHeat; heatRevision++;
        }
        const previous = request.renderedKey?.split('/');
        const { renderedKey: _renderedKey, ...detailRequest } = request;
        const detail = await details.query({ ...detailRequest, ranges, ...(previous?.[1] ? { renderedKey: previous[1] } : {}) }, manifest);
        signal.throwIfAborted();
        const more = request.discover && wanted.some(shard => !grids.has(shard.file) && !failed.has(shard.file));
        const flags = available.reduce((flags, shard) => flags | grids.get(shard.file)!.flags, 0);
        const covered = manifest.coverage.flatMap(({ bounds: [west, south, east, north] }) => {
          if (south > view[3] || north < view[1]) return [];
          // A wide preparation region can cover both longitude copies at the date line.
          const polygons: Polygon[] = [];
          for (let copy = Math.ceil((view[0] - east) / 360); copy <= Math.floor((view[2] - west) / 360); copy++) {
            const ring = boundsViewport([west + copy * 360, south, east + copy * 360, north]);
            polygons.push([[...ring, ring[0]!]]);
          }
          return polygons;
        });
        const coverage = covered.length ? clipping.union(covered[0]!, ...covered.slice(1)) : [];
        const routeOutside = mask.length > 0 && (!coverage.length || !clipping.intersection(mask, coverage).length);
        const routePartial = mask.length > 0 && (!coverage.length || !!clipping.difference(mask, coverage).length);
        const incomplete = !!manifestFailure || wanted.some(shard => failed.has(shard.file))
          || !!ranges.features.length && (['error', 'partial', 'unavailable'].includes(detail.status.state)
            || !!mask.length && detail.status.state === 'outside');
        const outside = !ranges.features.length ? routeOutside || !mask.length : !mask.length && detail.status.state === 'outside';
        const state: LandingStatus['state'] = !request.discover ? 'zoom' : more ? 'loading' : incomplete ? 'partial'
          : visible.length > MAX_VISIBLE || detail.status.state === 'limited' ? 'limited' : outside ? 'outside' : routePartial ? 'partial' : 'ready';
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
