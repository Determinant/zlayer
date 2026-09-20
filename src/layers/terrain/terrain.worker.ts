import { expose, transfer } from 'comlink';
import { createPixelContext } from '../../core/graphics/pixel-context';
import { paintTerrain, type TerrainLabel } from './contours';
import { MIN_TERRAIN_ZOOM, terrainDetail } from './detail';
import { ElevationTiles } from './elevation';
import { INNER_NM, segmentsForTile } from './geometry';
import { interpolateElevation, sampledHigh, simplifyElevation } from './grid';
import { terrainIsolines, type TerrainIsoline } from './isolines';
import type { TerrainRequest, TerrainResult, TerrainWorker } from './types';
import { TerrainWorkLimit } from './work-limit';

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

async function renderTile({ tile, segments, tileUrl }: TerrainRequest, signal: AbortSignal): Promise<TerrainResult> {
  if (tile.z < MIN_TERRAIN_ZOOM || !segmentsForTile(tile, segments).length) return { data: null, labels: [], lines: [] };
  const detail = terrainDetail(tile.z), { demZoom, gridSize, interval } = detail;
  const factor = 2 ** (demZoom - tile.z), heightSize = Math.min(256, gridSize / factor), partSize = 512 / factor;
  const context = createPixelContext(512, 512), canvas = context.canvas;
  try {
    const labels: TerrainLabel[] = [];
    const lines: TerrainIsoline[] = [];
    let incomplete = false;
    for (let y = 0; y < factor; y++) {
      for (let x = 0; x < factor; x++) {
        signal.throwIfAborted();
        const demTile = { z: demZoom, x: tile.x * factor + x, y: tile.y * factor + y };
        const nearby = segmentsForTile(demTile, segments);
        if (!nearby.length) continue;
        const values = await elevation.read(demTile, tileUrl, signal);
        signal.throwIfAborted();
        const simplified = simplifyElevation(values, 256, heightSize);
        const heights = interpolateElevation(simplified, heightSize, partSize);
        const painted = paintTerrain(heights, demTile, nearby, interval, 1, partSize, false, true);
        incomplete ||= painted.incomplete;
        // Copy numeric pixels directly, with no resampling or alpha composition.
        context.putImageData(new ImageData(painted.pixels as Uint8ClampedArray<ArrayBuffer>, partSize, partSize),
          x * partSize, y * partSize);
        const outlines = terrainIsolines(simplified, heightSize, demTile, nearby, interval, partSize);
        lines.push(...outlines.lines);
        labels.push(...outlines.labels);
        const high = sampledHigh(values, demTile, segmentsForTile(demTile, nearby, INNER_NM));
        if (high) labels.push(high);
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
    return transfer({ data, labels: selected, lines, incomplete }, [data]);
  } finally {
    // Release backing stores promptly, including on canceled/failed requests.
    canvas.width = canvas.height = 0;
  }
}

expose({ render, cancel: (id: number) => jobs.get(id)?.abort() } satisfies TerrainWorker);
