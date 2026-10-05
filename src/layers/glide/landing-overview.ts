import clipping from 'polygon-clipping';
import type { Bounds } from '@zlayer/contracts';
import { project, type Point } from '../../core/geo/route-corridor';
import { boundsViewport, localRouteSegments, routeMask } from './coverage';
import { landingBoundsOverlap, type LandingManifest, type LandingShard } from './landing-data';
import { createLandingHeatTiles, type LandingHeatEntry, type LandingHeatTile } from './landing-heat-tiles';
import { landingShards } from './landing-inventory';
import { loadLandingHeat } from './landing-loader';
import { landingCoverageMask, scopedLandingMask, scopeIntersects } from './landing-scope';
import type { LandingQuery } from './landing-planner';

const MAX_ACQUIRED = 32, MAX_RESIDENT = 64;
type OverviewQuery = LandingQuery & { zoom: number };
function viewPlan(request: OverviewQuery, manifest: LandingManifest) {
  const east = request.bounds[2] < request.bounds[0] ? request.bounds[2] + 360 : request.bounds[2];
  const view: Bounds = [request.bounds[0], request.bounds[1], east, request.bounds[3]];
  const viewport = boundsViewport(view), segments = localRouteSegments(request.segments, viewport), mask = routeMask(segments, viewport);
  const center = project([(view[0] + view[2]) / 2, (view[1] + view[3]) / 2]);
  const eligibility = new WeakMap<LandingShard, boolean>();
  const eligible = (shard: LandingShard) => {
    const known = eligibility.get(shard);
    if (known !== undefined) return known;
    let match = false;
    if (mask.length && landingBoundsOverlap(shard.bounds, view)) {
      const box = boundsViewport(shard.bounds), shift = Math.round(center[0] - (box[0]![0] + box[2]![0]) / 2);
      const ring = box.map(([x, y]) => [x + shift, y] as Point); ring.push(ring[0]!);
      match = scopedLandingMask(clipping.intersection(mask, [ring]), shard.scope).length > 0;
    }
    eligibility.set(shard, match);
    return match;
  };
  const distance = (shard: LandingShard) => {
    const point = project([(shard.bounds[0] + shard.bounds[2]) / 2, (shard.bounds[1] + shard.bounds[3]) / 2]);
    return Math.hypot(point[0] + Math.round(center[0] - point[0]) - center[0], point[1] - center[1]);
  };
  const coverage = mask.length ? landingCoverageMask(manifest, view) : [];
  const outside = !mask.length || !coverage.length || !clipping.intersection(mask, coverage).length;
  return { eligible, distance, routeVisible: mask.length > 0, outside,
    partial: !outside && !!clipping.difference(mask, coverage).length,
    unavailable: !!manifest.unavailableScopes?.some(scope => scopeIntersects(view, scope)) };
}

/** Owns overview admission, resident grids and tile reuse. Acquisition is bounded
 * separately from presentation: all relevant residents can draw at every zoom. */
export function createLandingOverview(loadHeat = loadLandingHeat, inventoryFor = landingShards) {
  const entries = new Map<string, LandingHeatEntry>(), failed = new Set<string>();
  const prepared = createLandingHeatTiles();
  let published: LandingHeatTile[] | undefined, revision = 0;
  let view: { manifest: LandingManifest; key: string; plan: ReturnType<typeof viewPlan> } | undefined;
  let demand: { view: NonNullable<typeof view>; zoom: number; discover: boolean; wanted: LandingShard[];
    files: Set<string>; limited: boolean; incomplete: boolean } | undefined;
  return {
    reset() { entries.clear(); failed.clear(); prepared.clear(); published = undefined; view = demand = undefined; },
    retry() { failed.clear(); demand = undefined; },
    async query(request: OverviewQuery, manifest: LandingManifest, signal: AbortSignal) {
      signal.throwIfAborted();
      const key = JSON.stringify([request.bounds, request.segments]);
      if (view?.manifest !== manifest || view.key !== key) view = { manifest, key, plan: viewPlan(request, manifest) };
      const active = view, { plan } = active, zoom = Math.max(0, Math.floor(request.zoom) - 1);
      if (demand?.view !== active || demand.zoom !== zoom || demand.discover !== request.discover) {
        let inventory: Awaited<ReturnType<typeof landingShards>> = { shards: [], limited: false }, indexFailed = false;
        if (request.discover && plan.routeVisible) {
          try { inventory = await inventoryFor(manifest, 'overview', request.bounds, zoom, signal); }
          catch { signal.throwIfAborted(); indexFailed = true; }
        }
        signal.throwIfAborted();
        const visible = inventory.shards.filter(plan.eligible).map(shard => ({ shard, distance: plan.distance(shard) }))
          .sort((a, b) => a.distance - b.distance || a.shard.file.localeCompare(b.shard.file));
        const wanted = visible.slice(0, MAX_ACQUIRED).map(({ shard }) => shard);
        demand = { view: active, zoom, discover: request.discover, wanted, files: new Set(wanted.map(shard => shard.file)),
          limited: inventory.limited || visible.length > MAX_ACQUIRED, incomplete: indexFailed || !!inventory.failed || plan.unavailable };
      }
      const { wanted, files, limited, incomplete } = demand;
      const trim = () => {
        for (const file of entries.keys()) {
          if (entries.size <= MAX_RESIDENT) break;
          if (!files.has(file)) { entries.delete(file); prepared.evict(file); }
        }
        for (const file of failed) {
          if (failed.size <= MAX_RESIDENT) break;
          if (!files.has(file)) failed.delete(file);
        }
      };
      const pending = wanted.filter(shard => !entries.has(shard.file) && !failed.has(shard.file));
      // Publish each pair before admitting the next. A canceled batch may retain
      // completed inputs, but can never publish against superseded demand.
      const results = await Promise.allSettled(pending.slice(0, 2).map(async shard => {
        const heat = await loadHeat(request.manifestUrl, shard, signal, manifest.schemaVersion); signal.throwIfAborted();
        entries.set(shard.file, { shard, heat: { ...heat, scope: shard.scope } });
        trim(); // A later cancellation must not leave an oversized cache behind.
      }));
      signal.throwIfAborted();
      results.forEach((result, i) => { if (result.status === 'rejected') failed.add(pending[i]!.file); });
      let flags = 0;
      for (const [file, entry] of [...entries]) if (plan.eligible(entry.shard)) {
        entries.delete(file); entries.set(file, entry); flags |= entry.heat.flags;
      }
      trim();
      // Presentation owns the entire resident geography. Leaving the viewport
      // changes acquisition priority, never the prepared tile set or its mips.
      const tiles = prepared.prepare([...entries.values()], request.segments);
      if (tiles !== published) { published = tiles; revision++; }
      return {
        tiles, shadedCells: tiles.reduce((n, tile) => n + tile.levels[0]!.shadedCells, 0), revision: String(revision), flags,
        loadedFiles: wanted.filter(shard => entries.has(shard.file)).length, totalFiles: wanted.length,
        more: wanted.some(shard => !entries.has(shard.file) && !failed.has(shard.file)), limited,
        incomplete: incomplete || wanted.some(shard => failed.has(shard.file)),
        routeVisible: plan.routeVisible, outside: plan.outside, partial: plan.partial,
      };
    },
  };
}
