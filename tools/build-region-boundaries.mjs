// Regenerate the checked-in offline ownership masks; never fetch these at runtime.
// Run: node tools/build-region-boundaries.mjs [previously downloaded Census GeoJSON]
import { feature } from 'topojson-client';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const source = 'https://tigerweb.geo.census.gov/arcgis/rest/services/Generalized_ACS2024/State_County/MapServer/7/query';
const query = new URLSearchParams({ where: '1=1', outFields: 'STUSAB', outSR: '4326', f: 'geojson', geometryPrecision: '5' });
const directory = await mkdtemp(join(tmpdir(), 'zlayer-regions-'));
try {
  const response = process.argv[2] ? undefined : await fetch(`${source}?${query}`);
  if (response && !response.ok) throw new Error(`Census request failed: ${response.status}`);
  const input = process.argv[2] ? await readFile(process.argv[2], 'utf8') : await response.text();
  const original = join(directory, 'states.geojson'), simplified = join(directory, 'simplified.json');
  await writeFile(original, input);
  // Shared topology is simplified together so adjacent states retain matching edges.
  // Douglas-Peucker uses a 100 metre spherical interval; retain small state shapes.
  execFileSync('npx', ['--yes', 'mapshaper@0.7.61', original,
    '-simplify', 'dp', 'interval=100', 'keep-shapes',
    '-rename-layers', 'states', '-o', simplified, 'format=topojson', 'quantization=36000001'], { stdio: 'inherit' });
  const topology = JSON.parse(await readFile(simplified, 'utf8'));
  const features = feature(topology, topology.objects.states).features;
  const states = features.map(({ properties, geometry }) => [`us-${properties.STUSAB}`,
    geometry.type === 'MultiPolygon' ? geometry.coordinates : [geometry.coordinates]])
    .sort(([a], [b]) => a.localeCompare(b));
  if (states.length !== 56 || new Set(states.map(([code]) => code)).size !== 56) throw new Error('Expected 56 states/territories');
  for (const [, polygons] of states) for (const polygon of polygons) for (const ring of polygon) {
    for (let i = 1; i < ring.length; i++) if (Math.abs(ring[i][0] - ring[i - 1][0]) > 180) {
      throw new Error('Boundary crosses the date line; split it before publishing');
    }
  }
  await writeFile(new URL('../src/offline/region-boundaries.json', import.meta.url),
    JSON.stringify(topology) + '\n');
  console.log(`Census input SHA-256: ${createHash('sha256').update(input).digest('hex')}`);
} finally { await rm(directory, { recursive: true, force: true }); }
