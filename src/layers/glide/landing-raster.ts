import clipping, { type MultiPolygon } from 'polygon-clipping';
import type { Bounds } from '@zlayer/contracts';
import { project, unproject, type Point } from '../../core/geo/route-corridor';
import { boundsViewport } from './coverage';
import { containsPoint, landingPriority, landingRowSpans, polygonBounds } from './landing-geometry';
import { emptyLandings, landingBoundsOverlap, landingSourceKey, type LandingArea, type LandingManifest, type LandingSelection, type LandingShard } from './landing-data';
import { landingShards } from './landing-inventory';
import { loadLandingShard } from './landing-loader';
import { landingCoverageMask, scopedLandingMask, scopeIntersects } from './landing-scope';
import type { LandingHeatImage } from './landing-heat';
import type { LandingQuery, LandingResult } from './landing-planner';

const GREEN = [83, 229, 45], PURPLE = [162, 59, 255];

export type LandingRasterResult = LandingResult & { raster?: LandingHeatImage | null; more?: boolean };

/** Original polygon paths at display resolution, without retaining or unioning
 * the whole range's geometry. One decoded block is live at a time. */
export function createLandingRasterWorker(loadShard = loadLandingShard) {
  let key = '', rangeKey = '', revision = 0, flags = 0, count = 0, manifestKey = '';
  let canvas: OffscreenCanvas | undefined, context: OffscreenCanvasRenderingContext2D | undefined;
  let frame: { left: number; top: number; step: number; zoom: number; width: number; height: number; bounds: Bounds } | undefined;
  let image: LandingHeatImage | null = null, mask: MultiPolygon = [], viewportMask: MultiPolygon = [];
  let shards: LandingShard[] = [], current: LandingManifest | undefined, url = '';
  let job: { id: number; controller: AbortController } | undefined;
  let inspection = new AbortController();
  const done = new Set<string>(), failed = new Set<string>();
  const reset = () => {
    inspection.abort(); inspection = new AbortController();
    if (canvas) canvas.width = canvas.height = 1;
    canvas = undefined; context = undefined; frame = undefined; image = null; key = rangeKey = '';
    mask = []; viewportMask = []; shards = []; current = undefined; done.clear(); failed.clear(); count = flags = 0;
  };
  const trace = (polygons: MultiPolygon) => {
    context!.beginPath();
    for (const polygon of polygons) for (const ring of polygon) {
      ring.forEach(([x, y], i) => {
        const px = (x - frame!.left) / frame!.step, py = (y - frame!.top) / frame!.step;
        if (i) context!.lineTo(px, py); else context!.moveTo(px, py);
      });
      context!.closePath();
    }
  };
  const snapshot = (): LandingHeatImage => {
    const { width, height, bounds } = frame!;
    const rgba = context!.getImageData(0, 0, width, height).data;
    const tiers = new Uint8Array(width * height);
    for (let i = 0; i < tiers.length; i++) tiers[i] = rgba[i * 4 + 3]! < 128 ? 0 : rgba[i * 4 + 1]! >= 128 ? 2 : rgba[i * 4]! >= 128 ? 1 : 0;
    let shadedCells = 0;
    for (let y = 0; y < height; y++) {
      const spans = landingRowSpans(mask, frame!.top + (y + .5) * frame!.step);
      for (let x = 0; x < width; x++) {
        const at = y * width + x, tier = tiers[at]!, i = at * 4, wx = frame!.left + (x + .5) * frame!.step;
        if (!tier || !spans.some(([left, right]) => wx >= left && wx < right)) { rgba.fill(0, i, i + 4); continue; }
        // An inside casing preserves holes and never paints outside the range.
        const edge = !x || x + 1 === width || !y || y + 1 === height
          || tiers[at - 1] !== tier || tiers[at + 1] !== tier || tiers[at - width] !== tier || tiers[at + width] !== tier;
        const color = tier === 2 ? GREEN : PURPLE;
        rgba[i] = edge ? Math.round(color[0]! * .6) : color[0]!;
        rgba[i + 1] = edge ? Math.round(color[1]! * .6) : color[1]!;
        rgba[i + 2] = edge ? Math.round(color[2]! * .6) : color[2]!;
        rgba[i + 3] = edge ? 191 : 158; shadedCells++;
      }
    }
    return { bounds, width, height, rgba, shadedCells };
  };
  return {
    reset,
    cancel(id: number) { if (job?.id === id) job.controller.abort(); },
    async inspect(coordinate: Point): Promise<LandingSelection | null> {
      const signal = inspection.signal, accepted = current, sourceKey = manifestKey;
      if (!accepted || !frame) return null;
      const point = project(coordinate); point[0] += Math.round(frame.left + frame.width * frame.step / 2 - point[0]);
      if (!mask.some(polygon => containsPoint(point, polygon))) return null;
      try {
        let best: Omit<LandingArea, 'polygon'> | undefined;
        for (const shard of shards) {
          if (!done.has(shard.file) || !landingBoundsOverlap(shard.bounds, [coordinate[0], coordinate[1], coordinate[0], coordinate[1]])
            || !scopedLandingMask(mask, shard.scope).some(polygon => containsPoint(point, polygon))) continue;
          const areas = await loadShard(url, shard, signal, accepted.schemaVersion); signal.throwIfAborted();
          const local: Point = [point[0] + Math.round(project([(shard.bounds[0] + shard.bounds[2]) / 2, 0])[0] - point[0]), point[1]];
          for (const area of areas) if (containsPoint(local, area.polygon)
            && (!best || area.tier > best.tier || area.tier === best.tier && (area.lengthFt * area.widthFt > best.lengthFt * best.widthFt
              || area.lengthFt * area.widthFt === best.lengthFt * best.widthFt && area.id.localeCompare(best.id) < 0))) {
            const { polygon: _polygon, ...site } = area; best = site;
          }
        }
        if (!best) return null;
        return { ...best, sourceKey };
      } catch (error) {
        // Range/frame replacement retires the selection, not the source data.
        if (signal.aborted) return null;
        throw error;
      }
    },
    async query(request: LandingQuery & { zoom: number }, manifest: LandingManifest): Promise<LandingRasterResult> {
      const task = { id: request.id, controller: new AbortController() }; job = task;
      const signal = task.controller.signal;
      try {
        const east = request.bounds[2] < request.bounds[0] ? request.bounds[2] + 360 : request.bounds[2];
        const view: Bounds = [request.bounds[0], request.bounds[1], east, request.bounds[3]];
        const nw = project([view[0], view[3]]), se = project([view[2], view[1]]);
        // Padded camera frames let GPS-follow motion and rotation reuse completed blocks.
        // The bitmap holds original candidates; only its published image is range-clipped.
        const step = Math.max(1 / (1024 * 2 ** request.zoom), (se[0] - nw[0]) / 1280, (se[1] - nw[1]) / 1280);
        const sourceKey = landingSourceKey(request.manifestUrl, manifest);
        // Bearing changes the viewport envelope, but not the existing pixel scale.
        const reusable = key === sourceKey && frame && Math.abs(frame.zoom - request.zoom) < 1e-6
          && nw[0] >= frame.left && nw[1] >= frame.top
          && se[0] <= frame.left + frame.width * frame.step && se[1] <= frame.top + frame.height * frame.step;
        if (!reusable) {
          reset(); key = sourceKey; revision++; current = manifest; manifestKey = sourceKey; url = request.manifestUrl;
          const left = (Math.floor(nw[0] / step / 128) * 128 - 64) * step;
          const top = (Math.floor(nw[1] / step / 128) * 128 - 64) * step;
          const width = Math.min(1536, Math.max(1, Math.ceil((se[0] - left) / step) + 64));
          const height = Math.min(1536, Math.max(1, Math.ceil((se[1] - top) / step) + 64));
          const upper = unproject([left, top]), bottom = unproject([left + width * step, top + height * step]);
          frame = { left, top, width, height, step, zoom: request.zoom, bounds: [upper[0], bottom[1], bottom[0], upper[1]] };
          const viewport = boundsViewport(frame.bounds); viewportMask = [[ [...viewport, viewport[0]!] ]];
          canvas = new OffscreenCanvas(width, height); context = canvas.getContext('2d', { willReadFrequently: true })!;
          // Red and green channels union independently; green wins overlap at display time.
          context.globalCompositeOperation = 'lighten';
        }
        const nextRange = JSON.stringify(request.ranges ?? null);
        if (rangeKey !== nextRange) {
          rangeKey = nextRange; revision++; inspection.abort(); inspection = new AbortController();
          const polygons = request.ranges?.features.flatMap(feature => feature.geometry.coordinates).map(polygon => {
            const projected = polygon.map(ring => ring.map(point => project(point as Point)));
            const shift = Math.round(frame!.left + frame!.width * frame!.step / 2 - projected[0]![0]![0]);
            return projected.map(ring => ring.map(([x, y]) => [x + shift, y] as Point));
          }) ?? [];
          mask = polygons.length ? clipping.intersection(clipping.union(polygons[0]!, ...polygons.slice(1)), viewportMask) : [];
        }
        if (request.revalidate) failed.clear();
        if (!mask.length) shards = [];
        let limited = false, unavailable = false;
        if (request.discover && mask.length) {
          try {
            const inventory = await landingShards(manifest, 'detail', frame!.bounds, 0, signal);
            limited = inventory.limited; unavailable = !!inventory.failed;
            const center = [frame!.left + frame!.width * frame!.step / 2, frame!.top + frame!.height * frame!.step / 2];
            const priority = landingPriority(request.ranges, project([(view[0] + view[2]) / 2, (view[1] + view[3]) / 2]));
            shards = inventory.shards.flatMap(shard => {
              const box = boundsViewport(shard.bounds), shift = Math.round(center[0]! - (box[0]![0] + box[2]![0]) / 2);
              const ring = box.map(([x, y]) => [x + shift, y] as Point); ring.push(ring[0]!);
              if (!scopedLandingMask(clipping.intersection(mask, [ring]), shard.scope).length) return [];
              return [{ shard, distance: priority(polygonBounds([[ring]])) }];
            }).sort((a, b) => a.distance - b.distance || a.shard.id.localeCompare(b.shard.id)).map(entry => entry.shard);
          } catch { signal.throwIfAborted(); unavailable = true; }
        }
        const pending = request.discover ? shards.filter(shard => !done.has(shard.file) && !failed.has(shard.file)) : [];
        for (const shard of pending.slice(0, 2)) {
          try {
            const areas = await loadShard(url, shard, signal, manifest.schemaVersion); signal.throwIfAborted();
            const selected = scopedLandingMask(viewportMask, shard.scope), bounds = polygonBounds(selected);
            context!.save(); trace(selected); context!.clip('evenodd');
            try {
              for (const area of areas) {
                const shift = Math.round(frame!.left + frame!.width * frame!.step / 2 - area.polygon[0]![0]![0]);
                const box = polygonBounds([area.polygon]);
                if (box[2] + shift < bounds[0] || box[0] + shift > bounds[2] || box[3] < bounds[1] || box[1] > bounds[3]) continue;
                trace([shift ? area.polygon.map(ring => ring.map(([x, y]) => [x + shift, y] as Point)) : area.polygon]);
                context!.fillStyle = area.tier === 2 ? '#00ff00' : '#ff0000'; context!.fill('evenodd');
                count++; flags |= area.flags;
              }
            } finally { context!.restore(); }
            done.add(shard.file); revision++;
          } catch { signal.throwIfAborted(); failed.add(shard.file); }
        }
        const more = request.discover && shards.some(shard => !done.has(shard.file) && !failed.has(shard.file));
        const renderKey = `r${revision}`;
        if (request.renderedKey !== renderKey) image = snapshot();
        const coverage = landingCoverageMask(manifest, view), viewport = boundsViewport(view);
        const visibleMask = mask.length ? clipping.intersection(mask, [[...viewport, viewport[0]!]]) : [];
        const outside = !visibleMask.length || !coverage.length || !clipping.intersection(visibleMask, coverage).length;
        const partial = unavailable || shards.some(shard => failed.has(shard.file)) || manifest.unavailableScopes?.some(scope => scopeIntersects(view, scope))
          || !outside && clipping.difference(visibleMask, coverage).length > 0;
        return { renderKey, ...(request.renderedKey !== renderKey ? { raster: image, collection: emptyLandings() } : {}), more,
          status: { state: !request.discover ? 'zoom' : more ? 'loading' : partial ? 'partial' : limited ? 'limited' : outside ? 'outside' : 'ready',
            sourceKey, generatedAt: manifest.generatedAt, raster: true, count: image?.shadedCells ? count : 0,
            cultivated: !!(flags & 1), shrub: !!(flags & 2), canopyUncertain: !!(flags & 8), terrainFallback: !!(flags & 16),
            urban: !!(flags & 32), closeBuildings: !!(flags & 64), mixedOpen: !!(flags & 128), constrained: !!(flags & 256),
            obstacleUncertain: !!(flags & 512), coverUncertain: !!(flags & 1024),
            shrubEvidenceMissing: manifest.coverage.some(region => region.shrubEvidenceMissing && landingBoundsOverlap(region.bounds, view)),
            preferredLengthFt: manifest.schemaVersion === 4 ? 3000 : 2000 } };
      } finally { if (job === task) job = undefined; }
    },
  };
}
