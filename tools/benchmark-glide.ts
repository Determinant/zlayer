// Diagnostic only: no network, renderer or timing-based pass/fail thresholds.
// Run: node --import=tsx tools/benchmark-glide.ts
import type { Bounds } from '@zlayer/contracts';
import { project, type Point, type Tile } from '../src/core/geo/route-corridor';
import { boundsViewport } from '../src/layers/glide/coverage';
import { GlidePlanner } from '../src/layers/glide/planner';
import type { GlideAirport, GlideRequest } from '../src/layers/glide/types';

const airports: GlideAirport[] = Array.from({ length: 12 }, (_, i) => {
  const coordinate: Point = [-.1 + i * .018, 0], id = String(i);
  return { id, coordinate, elevationFt: 0, feature: {
    type: 'Feature', id, geometry: { type: 'Point', coordinates: coordinate },
    properties: { elevationFt: 0, faaId: id, kind: 'landing-facility' },
  } };
});
const bounds: Bounds = [-.35, -.3, .35, .3];
const request: GlideRequest = {
  id: 1, airports, altitude: 6500, ratio: 8, viewport: boundsViewport(bounds),
  segments: [[project([-.3, 0]), project([.3, 0])]], ownship: [.03, 0], point: [.02, 0],
  sources: [], sourceKey: 'bench', base: 'https://charts.test', tileUrl: '',
};
const samples: { cold: number; camera: number }[] = [];
let evidence: object | undefined;
for (let run = 0; run < 5; run++) {
  const tiles = new Map<string, Float32Array>();
  const read = async ({ z, x, y }: Tile) => {
    const key = `${z}/${x}/${y}`;
    if (tiles.has(key)) return tiles.get(key)!;
    const size = 256 * 2 ** z;
    const grid = Float32Array.from({ length: 65536 }, (_, i) => {
      const east = ((x * 256 + i % 256 + .5) / size - .5) * 21600;
      const south = ((y * 256 + Math.floor(i / 256) + .5) / size - .5) * 21600;
      return east > 2 && Math.abs(south) > .4 ? 9000 : 0;
    });
    tiles.set(key, grid); return grid;
  };
  const planner = new GlidePlanner(read), signal = new AbortController().signal;
  const start = performance.now(), cold = await planner.calculate(request, signal), ready = performance.now();
  let terrainCells = 0, profilesBuilt = 0;
  for (const view of [[-.3, -.25, .4, .35], [-.15, -.15, .15, .15], [-.7, -.6, .7, .6], bounds] as Bounds[]) {
    const result = await planner.calculate({ ...request, viewport: boundsViewport(view) }, signal);
    terrainCells += result.work.terrainCells; profilesBuilt += result.work.profilesBuilt;
  }
  const end = performance.now();
  if (run) samples.push({ cold: ready - start, camera: end - ready });
  evidence = { cold: cold.work, cameraTerrainCells: terrainCells, cameraProfilesBuilt: profilesBuilt };
}
const median = (key: 'cold' | 'camera') => samples.map(s => s[key]).sort((a, b) => a - b)[Math.floor(samples.length / 2)]!.toFixed(1);
console.log(JSON.stringify({ origins: 14, coldMedianMs: median('cold'), fourCameraChangesMs: median('camera'), ...evidence }));
