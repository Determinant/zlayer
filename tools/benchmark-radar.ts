// Run from the repository root: node --import=tsx tools/benchmark-radar.ts
// Captured inputs only; timings are local CPU measurements, not device budgets.
import { readFile } from 'node:fs/promises';
import { contours } from 'd3-contour';
import { RADAR_LEVELS } from '@zlayer/contracts';
import { decodeMrms, decodeTdwr } from './weather-server/radar-decode';
import { radarContours } from './weather-server/radar-contours';
import { simplifyMrms } from './weather-server/radar-simplify';

for (const [site, filename] of [['CONUS', '20260924-202439-mrms.grib2.gz'], ['TOKC', '20260924-202234-tokc.level3'], ['TATL', '20260924-202301-tatl.level3']]) {
  const raw = await readFile(`test/fixtures/radar/${filename}`);
  const start = performance.now();
  const field = site === 'CONUS' ? decodeMrms(raw) : decodeTdwr(raw, site!);
  const decodeMs = performance.now() - start;
  for (const optimized of [false, true]) {
    const start = performance.now();
    const polygons = optimized ? RADAR_LEVELS.map(level => radarContours(field.values, field.width, field.height, level))
      : contours().size([field.width, field.height]).thresholds([...RADAR_LEVELS])(field.values as unknown as number[]).map(c => c.coordinates);
    const contourMs = performance.now() - start;
    const simplified = optimized && site === 'CONUS' ? simplifyMrms(polygons as [number, number][][][][]) : polygons;
    const simplifyMs = performance.now() - start - contourMs;
    const geometry = simplified.map(level => level.map(polygon => polygon.map(ring => ring.map(([x, y]) => field.project(x!, y!)))));
    const json = JSON.stringify(geometry);
    console.log(JSON.stringify({ site, optimized, decodeMs, contourMs, simplifyMs, totalMs: performance.now() - start,
      positions: geometry.flat(2).reduce((sum, ring) => sum + ring.length, 0), jsonBytes: Buffer.byteLength(json) }));
  }
}
