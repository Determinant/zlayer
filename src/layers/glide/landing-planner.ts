import clipping, { type MultiPolygon, type Polygon } from 'polygon-clipping';
import type { Bounds } from '@zlayer/contracts';
import { JsonResponseError } from '../../core/data/errors';
import { unproject, type Segment } from '../../core/geo/route-corridor';
import { boundsViewport, localRouteSegments, routeMask } from './coverage';
import { emptyLandings, landingBoundsOverlap, type LandingArea, type LandingCollection,
  type LandingManifest, type LandingShard, type LandingStatus } from './landing-data';
import { loadLandingManifest, loadLandingShard } from './landing-loader';

export type LandingQuery = { id: number; manifestUrl: string; bounds: Bounds; segments: Segment[];
  discover: boolean; revalidate?: boolean; renderedKey?: string };
export type LandingResult = { status: LandingStatus; renderKey: string; collection?: LandingCollection };
export type LandingWorker = { query(request: LandingQuery): Promise<LandingResult>; cancel(id: number): void };
type Entry = { shard: LandingShard; areas: LandingArea[]; vertices: number; clipped?: [MultiPolygon, MultiPolygon]; flags?: [number, number] };
const MAX_SHARDS = 24, MAX_RAW_BYTES = 24 * 1024 * 1024, MAX_VERTICES = 300000;
const union = (polygons: Polygon[]): MultiPolygon => polygons.length ? clipping.union(polygons[0]!, ...polygons.slice(1)) : [];
function corridor(bounds: Bounds, segments: readonly Segment[]): MultiPolygon {
  const view = boundsViewport(bounds);
  return routeMask(localRouteSegments(segments, view), view);
}

/** Decoded and clipped geometry stays in this worker across camera movement.
 * Only missing visible, route-adjacent shards are acquired. */
export function createLandingWorker(loadManifest = loadLandingManifest, loadShard = loadLandingShard): LandingWorker {
  let manifest: LandingManifest | undefined, manifestKey = '', url = '', routeKey = '', shapeKey = '', renderKey = 0;
  let collection = emptyLandings(), count = 0, cultivated = false, shrub = false, canopyUncertain = false, terrainFallback = false, urban = false, closeBuildings = false;
  let job: { id: number; controller: AbortController } | undefined;
  let manifestFailure: LandingStatus['state'] | undefined, lastAttempt = -Infinity;
  const entries = new Map<string, Entry>(), oversized = new Set<string>();
  const render = (segments: Segment[]) => {
    const key = JSON.stringify([url, manifestKey, routeKey, [...entries.keys()].sort()]);
    if (key === shapeKey) return;
    const polygons: [Polygon[], Polygon[]] = [[], []], flags = [0, 0];
    for (const entry of entries.values()) {
      if (!entry.clipped) {
        const mask = corridor(entry.shard.bounds, segments);
        entry.clipped = [[], []]; entry.flags = [0, 0];
        if (mask.length) for (const area of entry.areas) {
          const clipped = clipping.intersection(area.polygon, mask);
          if (clipped.length) {
            entry.clipped[area.tier - 1]!.push(...clipped);
            entry.flags[area.tier - 1]! |= area.flags;
          }
        }
      }
      for (const tier of [0, 1]) { polygons[tier]!.push(...entry.clipped[tier]!); flags[tier]! |= entry.flags![tier]!; }
    }
    const preferred = union(polygons[1]), fallback = union(polygons[0]);
    const tiers = [preferred.length && fallback.length ? clipping.difference(fallback, preferred) : fallback, preferred];
    collection = { type: 'FeatureCollection', features: tiers.flatMap((coordinates, index) => coordinates.length ? [{
      type: 'Feature' as const, properties: { tier: (index + 1) as 1 | 2, flags: flags[index]! },
      geometry: { type: 'MultiPolygon' as const, coordinates: coordinates.map(polygon => polygon.map(ring => ring.map(point => unproject(point)))) },
    }] : []) };
    count = tiers.reduce((sum, tier) => sum + tier.length, 0);
    cultivated = collection.features.some(feature => !!(feature.properties.flags & 1));
    shrub = collection.features.some(feature => !!(feature.properties.flags & 2));
    canopyUncertain = collection.features.some(feature => !!(feature.properties.flags & 8));
    terrainFallback = collection.features.some(feature => !!(feature.properties.flags & 16));
    urban = collection.features.some(feature => !!(feature.properties.flags & 32));
    closeBuildings = collection.features.some(feature => !!(feature.properties.flags & 64));
    shapeKey = key; renderKey++;
  };
  return {
    cancel(id) { if (job?.id === id) job.controller.abort(); },
    async query(request) {
      const task = { id: request.id, controller: new AbortController() }; job = task;
      const signal = task.controller.signal;
      const reply = (state: LandingStatus['state']): LandingResult => ({
        status: { state, count, cultivated, shrub, canopyUncertain, terrainFallback, urban, closeBuildings,
          preferredLengthFt: manifest?.schemaVersion === 4 ? 3000 : 2000, ...(manifest ? { generatedAt: manifest.generatedAt } : {}) },
        renderKey: String(renderKey), ...(request.renderedKey !== String(renderKey) ? { collection } : {}),
      });
      try {
        if (url !== request.manifestUrl) {
          url = request.manifestUrl; manifest = undefined; manifestKey = ''; entries.clear(); oversized.clear(); shapeKey = '';
          manifestFailure = undefined; lastAttempt = -Infinity;
        }
        const nextRoute = JSON.stringify(request.segments);
        if (routeKey !== nextRoute) {
          routeKey = nextRoute;
          for (const entry of entries.values()) { delete entry.clipped; delete entry.flags; }
        }
        if (!request.segments.length) { entries.clear(); render([]); return reply('route'); }
        if (request.discover && (!manifest || request.revalidate)) {
          const now = Date.now(), age = now - lastAttempt;
          if (request.revalidate || !manifestFailure || age < 0 || age >= 60_000) {
            lastAttempt = now;
            try {
              const next = await loadManifest(url, signal);
              signal.throwIfAborted();
              const nextKey = JSON.stringify([next.schemaVersion, next.inputSha256, next.shards, next.coverage]);
              if (manifestKey !== nextKey) {
                entries.clear(); oversized.clear(); shapeKey = '';
              }
              manifest = next; manifestKey = nextKey; manifestFailure = undefined;
            } catch (error) {
              signal.throwIfAborted();
              manifestFailure = error instanceof JsonResponseError && error.status === 404 ? 'unavailable' : 'error';
            }
          }
        }
        if (!manifest) { render(request.segments); return reply(request.discover ? manifestFailure ?? 'error' : 'zoom'); }
        const east = request.bounds[2] < request.bounds[0] ? request.bounds[2] + 360 : request.bounds[2];
        const shift = 360 * Math.floor(((request.bounds[0] + east) / 2 + 180) / 360);
        const view: Bounds = [request.bounds[0] - shift, request.bounds[1], east - shift, request.bounds[3]];
        const visible = request.discover ? manifest.shards.filter(shard => {
          if (!landingBoundsOverlap(shard.bounds, view)) return false;
          const mask = corridor(shard.bounds, request.segments);
          return mask.length > 0;
        }) : [];
        const wanted = new Set(visible.map(shard => shard.file));
        let failed = false, limited = visible.length > MAX_SHARDS
          || visible.reduce((sum, shard) => sum + shard.rawBytes, 0) > MAX_RAW_BYTES;
        const fits = (extra: Entry) => entries.size < MAX_SHARDS
          && [...entries.values()].reduce((n, entry) => n + entry.shard.rawBytes, extra.shard.rawBytes) <= MAX_RAW_BYTES
          && [...entries.values()].reduce((n, entry) => n + entry.vertices, extra.vertices) <= MAX_VERTICES;
        for (const shard of limited ? [] : visible) {
          signal.throwIfAborted();
          const prior = entries.get(shard.file);
          if (prior) { entries.delete(shard.file); entries.set(shard.file, prior); continue; }
          if (oversized.has(shard.file)) { limited = true; continue; }
          try {
            const areas = await loadShard(url, shard, signal, manifest.schemaVersion);
            signal.throwIfAborted();
            const entry: Entry = { shard, areas, vertices: areas.reduce((n, area) => n + area.polygon.reduce((m, ring) => m + ring.length, 0), 0) };
            if (entry.vertices > MAX_VERTICES) { oversized.add(shard.file); limited = true; continue; }
            // Evict only off-view entries; never silently drop another requested shard.
            for (const [key] of entries) {
              if (fits(entry)) break;
              if (!wanted.has(key)) entries.delete(key);
            }
            if (!fits(entry)) { limited = true; continue; }
            entries.set(shard.file, entry);
          } catch {
            signal.throwIfAborted(); failed = true;
          }
        }
        render(request.segments);
        if (!request.discover) return reply('zoom');
        if (manifestFailure) return reply(count ? 'partial' : manifestFailure);
        if (failed) return reply('partial');
        if (limited) return reply('limited');
        const visibleRoute = corridor(view, request.segments);
        if (!visibleRoute.length) return reply('outside');
        // Coverage describes selected preparation bounds, not proof every source pixel was known.
        const covered = manifest.coverage.flatMap(({ bounds: [west, south, east, north] }) => {
          if (south > view[3] || north < view[1]) return [];
          // Compare in the route's longitude copy. Wide coverage can intersect
          // both sides of the date line, so retain every overlapping copy.
          const first = Math.ceil((view[0] - east) / 360), last = Math.floor((view[2] - west) / 360);
          const polygons: Polygon[] = [];
          for (let copy = first; copy <= last; copy++) {
            const ring = boundsViewport([west + copy * 360, south, east + copy * 360, north]);
            polygons.push([[...ring, ring[0]!]]);
          }
          return polygons;
        });
        const coverage = union(covered);
        if (!coverage.length || !clipping.intersection(visibleRoute, coverage).length) return reply('outside');
        return reply(clipping.difference(visibleRoute, coverage).length ? 'partial' : 'ready');
      } finally { if (job === task) job = undefined; }
    },
  };
}
