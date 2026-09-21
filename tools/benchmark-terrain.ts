/** CPU preparation only: no download, decoding, canvas, MapLibre or GPU time.
 * Run: node --import=tsx tools/benchmark-terrain.ts */
import { performance } from 'node:perf_hooks';
import { paintTerrain } from '../src/layers/terrain/contours';
import { terrainDetail } from '../src/layers/terrain/detail';
import { INNER_NM, project, segmentsForTile, type Segment } from '../src/layers/terrain/geometry';
import { interpolateElevation, sampledHigh, simplifyElevation } from '../src/layers/terrain/grid';
import { terrainIsolines } from '../src/layers/terrain/isolines';
import { viewportPixels } from '../src/layers/terrain/viewport';

const results = [];
for (const density of [1, 6]) for (const z of [9, 11, 13]) {
  const n = 2 ** z, center = project([-122.1, 37.4]);
  const tile = { z, x: Math.floor(center[0] * n), y: Math.floor(center[1] * n) };
  const segments: Segment[] = [[[(tile.x - 1) / n, (tile.y - 1) / n], [(tile.x + 2) / n, (tile.y + 2) / n]]];
  const { demZoom, gridSize, interval } = terrainDetail(z);
  const factor = 2 ** (demZoom - z), partSize = 512 / factor, heightSize = Math.min(256, gridSize / factor);
  const parts = Array.from({ length: factor * factor }, (_, i) => {
    const x = i % factor, y = Math.floor(i / factor);
    const demTile = { z: demZoom, x: tile.x * factor + x, y: tile.y * factor + y };
    const values = Float32Array.from({ length: 256 * 256 }, (_, j) => {
      const u = (x + (j % 256 + 0.5) / 256) / factor, v = (y + (Math.floor(j / 256) + 0.5) / 256) / factor;
      return 4000 + 2800 * Math.sin(u * Math.PI * 2 * density) * Math.cos(v * Math.PI * 2 * density);
    });
    return { tile: demTile, values, nearby: segmentsForTile(demTile, segments) };
  });
  for (const coverage of ['route', 'viewport']) {
    const run = () => {
      for (const part of parts) {
        if (coverage === 'viewport') { viewportPixels(part.values, partSize); continue; }
        const grid = simplifyElevation(part.values, 256, heightSize);
        paintTerrain(interpolateElevation(grid, heightSize, partSize), part.tile, part.nearby, interval, partSize);
        terrainIsolines(grid, heightSize, part.tile, part.nearby, interval, partSize);
        sampledHigh(part.values, part.tile, segmentsForTile(part.tile, part.nearby, INNER_NM));
      }
    };
    for (let i = 0; i < 5; i++) run();
    const times = Array.from({ length: 20 }, () => { const start = performance.now(); run(); return performance.now() - start; }).sort((a, b) => a - b);
    results.push({ ridges: density === 1 ? 'smooth' : 'dense', zoom: z, coverage,
      medianMs: Number(((times[9]! + times[10]!) / 2).toFixed(2)) });
  }
}
console.log(JSON.stringify({ node: process.version, warmups: 5, iterations: 20, results }, null, 2));
