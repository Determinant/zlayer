import { expose, transfer } from 'comlink';
import { createPixelContext } from '../../core/graphics/pixel-context';
import { paintTerrain, type PaintedTile, type TerrainLabel } from './contours';
import { MIN_TERRAIN_ZOOM, terrainDetail } from './detail';
import { packagesForElevationTile } from './geographic';
import { ElevationTiles } from './elevation';
import { INNER_NM, segmentsForTile } from './geometry';
import { interpolateElevation, sampledHigh, simplifyElevation } from './grid';
import { terrainIsolines, type TerrainIsoline } from './isolines';
import type { TerrainRequest, TerrainResult, TerrainWorker } from './types';
import { TerrainWorkLimit } from './work-limit';
import { viewportPixels } from './viewport';
import { terrainBorder, type TerrainBorder } from './seams';

const elevation = new ElevationTiles();
const jobs = new Map<number, AbortController>();
const renderLimit = new TerrainWorkLimit(4);

async function render(request: TerrainRequest): Promise<TerrainResult> {
  const controller = new AbortController();
  jobs.set(request.id, controller);
  try {
    return await renderLimit.run(controller.signal, () => renderTile(request, controller.signal));
  } finally { jobs.delete(request.id); }
}

async function renderTile({ tile, segments, tileUrl, packages, coverage, surfaceFill }: TerrainRequest, signal: AbortSignal): Promise<TerrainResult> {
  const viewport = coverage === 'viewport';
  if (!viewport && (tile.z < MIN_TERRAIN_ZOOM || !segmentsForTile(tile, segments).length)) return { data: null, labels: [], lines: [] };
  const detail = terrainDetail(tile.z), { demZoom, gridSize, interval } = detail;
  const factor = 2 ** (demZoom - tile.z), heightSize = Math.min(256, gridSize / factor), partSize = 512 / factor;
  const context = createPixelContext(512, 512), canvas = context.canvas;
  try {
    const labels: TerrainLabel[] = [];
    const lines: TerrainIsoline[] = [];
    const borders: TerrainBorder[] = [];
    let incomplete = false;
    for (let y = 0; y < factor; y++) {
      for (let x = 0; x < factor; x++) {
        signal.throwIfAborted();
        const demTile = { z: demZoom, x: tile.x * factor + x, y: tile.y * factor + y };
        const nearby = viewport ? [] : segmentsForTile(demTile, segments);
        if (!viewport && !nearby.length) continue;
        const source = packagesForElevationTile(packages ?? [], demTile);
        const values = await elevation.read(demTile, tileUrl, signal, source);
        signal.throwIfAborted();
        let painted: PaintedTile;
        if (viewport) painted = viewportPixels(values, partSize);
        else {
          const surface = source[0]?.grid ? await elevation.read(demTile, tileUrl, signal, source, true) : values;
          signal.throwIfAborted();
          const simplified = source[0]?.grid ? interpolateElevation(surface, 256, heightSize) : simplifyElevation(surface, 256, heightSize);
          // Absolute elevation fills follow the same surface as the contours.
          // Clearance fills and sampled highs retain the conservative maxima.
          const heights = interpolateElevation(surfaceFill ? simplified : simplifyElevation(values, 256, heightSize), heightSize, partSize);
          painted = paintTerrain(heights, demTile, nearby, interval, partSize);
          const outlines = terrainIsolines(simplified, heightSize, demTile, nearby, interval, partSize, false);
          lines.push(...outlines.lines);
          borders.push(terrainBorder(simplified, heightSize, demTile, interval, partSize));
          labels.push(...outlines.labels);
          const high = sampledHigh(values, demTile, segmentsForTile(demTile, nearby, INNER_NM));
          if (high) labels.push(high);
        }
        incomplete ||= painted.incomplete;
        // Copy numeric pixels directly, with no resampling or alpha composition.
        context.putImageData(new ImageData(painted.pixels as Uint8ClampedArray<ArrayBuffer>, partSize, partSize),
          x * partSize, y * partSize);
        // Give route cancellation messages a chance to interrupt cached CPU work.
        await new Promise<void>(resolve => setTimeout(resolve, 0));
      }
    }
    signal.throwIfAborted();
    const peak = labels.filter(label => label.peak).sort((a, b) => b.elevation - a.elevation)[0];
    const contours = labels.filter(label => !label.peak);
    const levels = new Set<number>();
    const selected = contours.filter(label => {
      if (levels.has(label.elevation) || levels.size >= detail.contourLabels) return false;
      levels.add(label.elevation); return true;
    });
    if (peak) selected.push(peak);
    const data = canvas.transferToImageBitmap();
    return transfer({ data, labels: selected, lines, borders, incomplete }, [data]);
  } finally {
    // Release backing stores promptly, including on canceled/failed requests.
    canvas.width = canvas.height = 0;
  }
}

expose({ render, cancel: (id: number) => jobs.get(id)?.abort() } satisfies TerrainWorker);
