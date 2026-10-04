import clipping, { type MultiPolygon, type Polygon } from 'polygon-clipping';
import type { Bounds } from '@zlayer/contracts';
import { JsonResponseError } from '../../core/data/errors';
import { project, unproject, type Point, type Segment } from '../../core/geo/route-corridor';
import { containsPoint, landingPriority, polygonBounds, prepareLandingMask } from './landing-geometry';
import { boundsViewport, localRouteSegments, routeMask } from './coverage';
import { emptyLandings, landingBoundsOverlap, landingSourceKey, type LandingArea, type LandingCollection,
  type LandingManifest, type LandingShard, type LandingStatus, type LandingSelection } from './landing-data';
import { loadLandingManifest, loadLandingShard } from './landing-loader';
import { landingShards } from './landing-inventory';
import { landingCoverageMask, scopedLandingMask, scopeIntersects } from './landing-scope';
import type { LandingSources } from './landing-sources';
import type { GlideAreas } from './types';

export type LandingQuery = { id: number; sources?: LandingSources | undefined; manifestUrl: string; bounds: Bounds; segments: Segment[];
  discover: boolean; revalidate?: boolean; renderedKey?: string; ranges?: GlideAreas };
export type LandingResult = { limited?: boolean; status: LandingStatus; renderKey: string; collection?: LandingCollection };
export type LandingWorker = {
  /** The display worker supplies its accepted manifest so detail cannot retain another edition. */
  query(request: LandingQuery, currentManifest?: LandingManifest): Promise<LandingResult>;
  cancel(id: number): void;
  inspect(coordinate: Point): LandingSelection | null;
};
type Entry = { shard: LandingShard; areas: LandingArea[]; vertices: number;
  selection?: { key: string; limited: boolean; remaining: Bounds[] };
  clipped?: [MultiPolygon, MultiPolygon]; flags?: [number, number] };
const MAX_SHARDS = 24, MAX_RAW_BYTES = 24 * 1024 * 1024, MAX_VERTICES = 300000;
const union = (polygons: Polygon[]): MultiPolygon => polygons.length ? clipping.union(polygons[0]!, ...polygons.slice(1)) : [];
function corridor(bounds: Bounds, segments: readonly Segment[]): MultiPolygon {
  const view = boundsViewport(bounds);
  return routeMask(localRouteSegments(segments, view), view);
}

function localBounds(bounds: Bounds, view: Bounds): Bounds {
  const shift = 360 * Math.round((view[0] + view[2] - bounds[0] - bounds[2]) / 720);
  return [bounds[0] + shift, bounds[1], bounds[2] + shift, bounds[3]];
}

function overlapsView([west, south, east, north]: Bounds, view: Bounds, center: Point): boolean {
  const shift = Math.round((west + east) / 2 - center[0]);
  return east >= view[0] + shift && west <= view[2] + shift && north >= view[1] && south <= view[3];
}

/** Prefer whole visible polygons, then retain previously visited ones within the
 * same budget. Bounds of omitted records avoid decoding on unrelated camera moves. */
function selectAreas(areas: LandingArea[], mask: MultiPolygon, center: Point, budget: number, priority: (bounds: Bounds) => number, retained: LandingArea[] = []) {
  const bounds = polygonBounds(mask);
  const copies = new Map([[0, prepareLandingMask(mask)]]);
  const records = areas.map(area => ({ area, bounds: polygonBounds([area.polygon]),
    vertices: area.polygon.reduce((sum, ring) => sum + ring.length, 0) }));
  const candidates = records.flatMap(record => {
    const { area, bounds: areaBounds, vertices } = record;
    const [west, , east] = areaBounds;
    const shift = Math.round((west + east) / 2 - center[0]);
    if (!overlapsView(areaBounds, bounds, center)) return [];
    let shifted = copies.get(shift);
    if (!shifted) {
      shifted = prepareLandingMask(mask.map(polygon => polygon.map(ring => ring.map(([x, y]) => [x + shift, y] as Point))));
      copies.set(shift, shifted);
    }
    if (!shifted.clip(area.polygon, areaBounds).length) return [];
    return [{ area, vertices, distance: priority(areaBounds) }];
  }).sort((a, b) => a.distance - b.distance || a.area.id.localeCompare(b.area.id));
  const selected: LandingArea[] = [];
  let vertices = 0, limited = false;
  for (const candidate of candidates) {
    if (vertices + candidate.vertices > budget) { limited = true; continue; }
    selected.push(candidate.area); vertices += candidate.vertices;
  }
  const selectedIds = new Set(selected.map(area => area.id)), previousIds = new Set(retained.map(area => area.id));
  for (const record of records) if (previousIds.has(record.area.id) && !selectedIds.has(record.area.id)
    && vertices + record.vertices <= budget) {
    selected.push(record.area); selectedIds.add(record.area.id); vertices += record.vertices;
  }
  const remaining = records.filter(record => !selectedIds.has(record.area.id)).map(record => record.bounds);
  return { areas: selected, vertices, limited, remaining };
}

/** Decoded and clipped geometry stays in this worker across camera movement.
 * Only missing visible, route-adjacent shards are acquired. */
export function createLandingWorker(loadManifest = loadLandingManifest, loadShard = loadLandingShard): LandingWorker {
  let manifest: LandingManifest | undefined, manifestKey = '', url = '', routeKey = '', shapeKey = '', renderKey = 0;
  let collection = emptyLandings(), count = 0, cultivated = false, shrub = false, canopyUncertain = false, terrainFallback = false, urban = false, closeBuildings = false, mixedOpen = false, constrained = false, obstacleUncertain = false;
  let job: { id: number; controller: AbortController } | undefined;
  let manifestFailure: LandingStatus['state'] | undefined, lastAttempt = -Infinity;
  const entries = new Map<string, Entry>(), attempted = new Map<string, boolean>();
  const acceptManifest = (next: LandingManifest) => {
    const nextKey = landingSourceKey(url, next);
    if (manifestKey !== nextKey) { entries.clear(); attempted.clear(); shapeKey = ''; }
    manifest = next; manifestKey = nextKey; manifestFailure = undefined;
  };
  let selectionKey = '';
  let rangeMask: MultiPolygon | undefined;
  const maskFor = (bounds: Bounds, segments: Segment[]) => {
    if (!rangeMask) return corridor(bounds, segments);
    const view = boundsViewport(bounds), center = (view[0]![0] + view[2]![0]) / 2;
    const local = rangeMask.map(polygon => {
      const shift = Math.round(center - polygon[0]![0]![0]);
      return polygon.map(ring => ring.map(([x, y]) => [x + shift, y] as Point));
    });
    return local.length ? clipping.intersection(local, [[...view, view[0]!]]) : [];
  };
  const render = (segments: Segment[]) => {
    const key = JSON.stringify([url, manifestKey, routeKey, [...entries.keys()].sort()]);
    if (key === shapeKey) return;
    const polygons: [Polygon[], Polygon[]] = [[], []], flags = [0, 0];
    for (const entry of entries.values()) {
      if (!entry.clipped) {
        const mask = scopedLandingMask(maskFor(entry.shard.bounds, segments), entry.shard.scope);
        const prepared = prepareLandingMask(mask);
        entry.clipped = [[], []]; entry.flags = [0, 0];
        if (mask.length) for (const area of entry.areas) {
          const clipped = prepared.clip(area.polygon);
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
    mixedOpen = collection.features.some(feature => !!(feature.properties.flags & 128));
    constrained = collection.features.some(feature => !!(feature.properties.flags & 256));
    obstacleUncertain = collection.features.some(feature => !!(feature.properties.flags & 512));
    shapeKey = key; renderKey++;
  };
  return {
    inspect(coordinate) {
      const matches: LandingArea[] = [];
      for (const entry of entries.values()) {
        if (!entry.clipped) continue;
        const point = project(coordinate);
        point[0] += Math.round(project([(entry.shard.bounds[0] + entry.shard.bounds[2]) / 2, 0])[0] - point[0]);
        if (!entry.clipped.some(polygons => polygons.some(polygon => containsPoint(point, polygon)))) continue;
        for (const area of entry.areas) if (containsPoint(point, area.polygon)) matches.push(area);
      }
      // Prefer green, then the strongest measured fit; never OR neighboring flags.
      matches.sort((a, b) => b.tier - a.tier || b.lengthFt * b.widthFt - a.lengthFt * a.widthFt || a.id.localeCompare(b.id));
      const area = matches[0];
      if (!area) return null;
      const { polygon: _polygon, ...site } = area;
      return { ...site, sourceKey: manifestKey };
    },
    cancel(id) { if (job?.id === id) job.controller.abort(); },
    async query(request, currentManifest) {
      const task = { id: request.id, controller: new AbortController() }; job = task;
      const signal = task.controller.signal;
      let limited = false;
      const reply = (state: LandingStatus['state']): LandingResult => ({
        status: { state, count, cultivated, shrub, canopyUncertain, terrainFallback, urban, closeBuildings, mixedOpen, constrained, obstacleUncertain,
          coverUncertain: collection.features.some(f => !!(f.properties.flags & 1024)),
          shrubEvidenceMissing: manifest?.coverage.some(region => region.shrubEvidenceMissing && landingBoundsOverlap(region.bounds, request.bounds) && maskFor(region.bounds, request.segments).length > 0) ?? false,
          preferredLengthFt: manifest?.schemaVersion === 4 ? 3000 : 2000,
          ...(manifest ? { generatedAt: manifest.generatedAt, sourceKey: manifestKey } : {}) },
        limited, renderKey: String(renderKey), ...(request.renderedKey !== String(renderKey) ? { collection } : {}),
      });
      try {
        if (url !== request.manifestUrl) {
          url = request.manifestUrl; manifest = undefined; manifestKey = ''; entries.clear(); attempted.clear(); shapeKey = '';
          manifestFailure = undefined; lastAttempt = -Infinity;
        }
        if (currentManifest) acceptManifest(currentManifest);
        const nextRoute = JSON.stringify(request.ranges ?? request.segments);
        rangeMask = request.ranges?.features.flatMap(feature => feature.geometry.coordinates)
          .map(polygon => polygon.map(ring => ring.map(point => project(point as Point))));
        if (routeKey !== nextRoute) {
          routeKey = nextRoute;
          for (const entry of entries.values()) { delete entry.clipped; delete entry.flags; }
        }
        if (rangeMask ? !rangeMask.length : !request.segments.length) { entries.clear(); attempted.clear(); selectionKey = ''; render([]); return reply('route'); }
        if (!currentManifest && request.discover && (!manifest || request.revalidate)) {
          const now = Date.now(), age = now - lastAttempt;
          if (request.revalidate || !manifestFailure || age < 0 || age >= 60_000) {
            lastAttempt = now;
            try {
              const next = await loadManifest(url, signal, request.sources);
              signal.throwIfAborted();
              acceptManifest(next);
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
        const nextSelection = JSON.stringify([view, routeKey]);
        if (selectionKey !== nextSelection) { selectionKey = nextSelection; attempted.clear(); }
        const viewMask = maskFor(view, request.segments), center = project([(view[0] + view[2]) / 2, (view[1] + view[3]) / 2]);
        const priority = landingPriority(request.ranges, center);
        const distance = (shard: LandingShard) => priority(polygonBounds([[boundsViewport(shard.bounds)]]));
        let inventory: Awaited<ReturnType<typeof landingShards>> = { shards: [], limited: false }, indexFailed = false;
        if (request.discover) {
          try { inventory = await landingShards(manifest, 'detail', view, 0, signal); }
          catch { signal.throwIfAborted(); indexFailed = true; }
        }
        const visible = request.discover ? inventory.shards.filter(shard => {
          if (!landingBoundsOverlap(shard.bounds, view)) return false;
          const bounds = localBounds(shard.bounds, view);
          const overlap: Bounds = [Math.max(view[0], bounds[0]), Math.max(view[1], bounds[1]), Math.min(view[2], bounds[2]), Math.min(view[3], bounds[3])];
          return overlap[0] < overlap[2] && overlap[1] < overlap[3] && scopedLandingMask(maskFor(overlap, request.segments), shard.scope).length > 0;
        }).sort((a, b) => distance(a) - distance(b) || a.id.localeCompare(b.id)) : [];
        const wanted = new Set(visible.map(shard => shard.file));
        const viewBounds = polygonBounds(viewMask);
        let failed = indexFailed || !!inventory.failed || !!manifest.unavailableScopes?.some(scope => scopeIntersects(request.bounds, scope));
        limited = inventory.limited;
        for (const shard of visible) {
          signal.throwIfAborted();
          const prior = entries.get(shard.file);
          if (prior?.selection && prior.selection.key !== selectionKey
            && !prior.selection.remaining.some(bounds => overlapsView(bounds, viewBounds, center))) {
            prior.selection.key = selectionKey; prior.selection.limited = false;
          }
          if (prior && (!prior.selection || prior.selection.key === selectionKey)) {
            entries.delete(shard.file); entries.set(shard.file, prior); limited ||= prior.selection?.limited ?? false; continue;
          }
          if (attempted.has(shard.file)) { limited ||= attempted.get(shard.file)!; continue; }
          // Make useful progress in dense views without reading files we cannot retain.
          const retained = () => [...entries.values()].filter(entry => entry !== prior);
          // One explicitly advertised large record may exceed the ordinary budget;
          // its supplied geometry stays whole and other detail waits for room.
          const vertexLimit = shard.package?.block.oversized
            ? Math.max(MAX_VERTICES, shard.package.block.vertices + shard.package.block.rings) : MAX_VERTICES;
          for (const [key] of entries) {
            const others = retained();
            if (others.length < MAX_SHARDS && others.reduce((n, e) => n + e.shard.rawBytes, shard.rawBytes) <= MAX_RAW_BYTES
              && others.reduce((n, e) => n + e.vertices, 0) < vertexLimit) break;
            if (!wanted.has(key)) entries.delete(key);
          }
          const others = retained(), budget = vertexLimit - others.reduce((n, e) => n + e.vertices, 0);
          if (others.length >= MAX_SHARDS || others.reduce((n, e) => n + e.shard.rawBytes, shard.rawBytes) > MAX_RAW_BYTES || budget <= 0) {
            limited = true; continue;
          }
          try {
            const areas = await loadShard(url, shard, signal, manifest.schemaVersion);
            signal.throwIfAborted();
            const selected = selectAreas(areas, scopedLandingMask(viewMask, shard.scope), center, budget, priority, prior?.areas);
            limited ||= selected.limited; attempted.set(shard.file, selected.limited);
            const priorIds = new Set(prior?.areas.map(area => area.id));
            const unchanged = prior && selected.areas.length === prior.areas.length
              && selected.areas.every(area => priorIds.has(area.id));
            if (prior) entries.delete(shard.file);
            if (selected.areas.length) entries.set(shard.file, { shard, areas: selected.areas, vertices: selected.vertices,
              ...(unchanged ? { clipped: prior.clipped, flags: prior.flags } : {}),
              ...(selected.remaining.length ? { selection: { key: selectionKey, limited: selected.limited, remaining: selected.remaining } } : {}) });
            if (!unchanged) shapeKey = ''; // New records under the same file identity must reach the map.
          } catch {
            signal.throwIfAborted(); failed = true;
          }
        }
        render(request.segments);
        if (!request.discover) return reply('zoom');
        if (manifestFailure) return reply(count ? 'partial' : manifestFailure);
        if (failed) return reply('partial');
        if (limited) return reply('limited');
        const visibleRoute = maskFor(view, request.segments);
        if (!visibleRoute.length) return reply('outside');
        // Coverage describes selected preparation bounds, not proof every source pixel was known.
        const coverage = landingCoverageMask(manifest, view);
        if (!coverage.length || !clipping.intersection(visibleRoute, coverage).length) return reply('outside');
        return reply(clipping.difference(visibleRoute, coverage).length ? 'partial' : 'ready');
      } finally { if (job === task) job = undefined; }
    },
  };
}
