// Production-built preparation paths, real workers/MapLibre, local fixed inputs.
// node --import=tsx tools/benchmark-render-preparation.mjs [chromium|webkit] [label] [rounds] [plates/glide baseline commit]
import assert from 'node:assert/strict';
import { build } from 'vite';
import { chromium, webkit } from 'playwright';
import { createServer } from 'node:http';
import { createHash } from 'node:crypto';
import { readFile, writeFile, mkdir, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir, cpus } from 'node:os';
import { resolve, extname, join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { parseSurfaceCatalog, parseSurfaceChart } from '../src/layers/weather-awc/progs/source.ts';
import { isSurfaceArtifact, SURFACE_PROCESSING, isRadarContours, RADAR_LEVELS } from '@zlayer/contracts';

const engineName = process.argv[2] ?? 'chromium', label = process.argv[3] ?? 'current', rounds = Number(process.argv[4] ?? 5);
const engine = { chromium, webkit }[engineName];
assert(engine && /^[a-z0-9-]+$/i.test(label) && Number.isInteger(rounds) && rounds > 0 && rounds <= 20);
const baseline = process.argv[5];
assert(!baseline || /^[a-f0-9]{7,40}$/i.test(baseline));
const overrides = new Map(baseline ? ['src/layers/plates/prepare-map-image.ts', 'src/layers/glide/landing-heat-layer.ts']
  .map(file => [resolve(file), execFileSync('git', ['show', `${baseline}:${file}`], { encoding: 'utf8' })]) : []);
const output = resolve(`tmp/render-preparation/${label}-${engineName}`);
await mkdir(output, { recursive: true });
const directory = await mkdtemp(join(tmpdir(), 'zlayer-preparation-'));
const digest = bytes => createHash('sha256').update(bytes).digest('hex');
const now = Date.parse('2026-09-24T19:00:00Z');
const catalog = parseSurfaceCatalog(await readFile('test/fixtures/wpc/2026-09-24-catalog.json', 'utf8'), now);
const chart = catalog.find(chart => chart.forecastHour === 168);
const original = await readFile(`test/fixtures/wpc/${chart.file}`, 'utf8');
const progs = { schemaVersion: 1, processing: SURFACE_PROCESSING, product: 'forecast',
  frame: parseSurfaceChart(original, chart, now, digest(original)) };
assert(isSurfaceArtifact(progs));
// Many independent rings exercise object parsing and indexing, not a giant offscreen polygon.
const radar = { schemaVersion: 1, site: 'CONUS', observedAt: now, sourceHash: 'a'.repeat(64),
  source: 'https://noaa-mrms-pds.s3.amazonaws.com/CONUS/MergedReflectivityQCComposite_00.50/20260924/MRMS_MergedReflectivityQCComposite_00.50_20260924-190000.grib2.gz',
  bounds: [-130, 20, -60, 55], type: 'FeatureCollection', features: RADAR_LEVELS.map((dbz, level) => ({
    type: 'Feature', properties: { dbz }, geometry: { type: 'MultiPolygon', coordinates: Array.from({ length: 100 }, (_, i) => {
      const x = -125 + i % 10 * 5, y = 25 + Math.floor(i / 10) * 2;
      const ring = Array.from({ length: 256 }, (_, j) => { const angle = j / 256 * Math.PI * 2, radius = (.8 - level * .08) * (1 + .1 * Math.sin(angle * 11));
        return [x + radius * Math.cos(angle), y + radius * Math.sin(angle)]; });
      ring.push(ring[0]); return [ring];
    }) },
  })) };
assert(isRadarContours(radar));
const bodies = new Map(Object.entries({ radar, progs }).map(([key, value]) => [`/${key}.json`, Buffer.from(JSON.stringify(value))]));
const types = { '.html': 'text/html', '.js': 'text/javascript', '.mjs': 'text/javascript', '.css': 'text/css', '.woff2': 'font/woff2' };
let browser;
const server = createServer(async (request, response) => {
  const path = new URL(request.url, 'http://localhost').pathname;
  const body = bodies.get(path);
  if (body) { response.writeHead(200, { 'content-type': 'application/json', 'x-fixture-sha256': digest(body) }); response.end(body); return; }
  const file = resolve(directory, `.${path}`);
  if (!file.startsWith(`${directory}/`)) { response.writeHead(403).end(); return; }
  try { const bytes = await readFile(file); response.writeHead(200, { 'content-type': types[extname(file)] ?? 'application/octet-stream' }); response.end(bytes); }
  catch { response.writeHead(404).end(); }
});
try {
  await build({ configFile: false, logLevel: 'error', plugins: [{ name: 'preparation-baseline', enforce: 'pre', load: id => overrides.get(id) }],
    build: { outDir: directory, emptyOutDir: true,
    rolldownOptions: { input: resolve('test/browser/render-preparation.html') } } });
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
  browser = await engine.launch({ headless: true });
  const page = await browser.newPage({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 3, hasTouch: true });
  page.setDefaultTimeout(120_000);
  const errors = []; page.on('pageerror', error => errors.push(String(error)));
  await page.goto(`http://127.0.0.1:${server.address().port}/test/browser/render-preparation.html`);
  await page.waitForFunction(() => !!window.preparationBenchmark);
  const results = [];
  for (let round = -1; round < rounds; round++) {
    const result = await page.evaluate(() => window.preparationBenchmark.run());
    if (round >= 0) { results.push(result); console.log(JSON.stringify({ round, ...result })); }
  }
  assert.deepEqual(errors, []);
  await writeFile(join(output, 'results.json'), JSON.stringify({ revision: execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim(),
    workingTree: execFileSync('git', ['status', '--short'], { encoding: 'utf8' }), baseline: baseline ? { revision: baseline, files: [...overrides.keys()] } : null,
    browser: browser.version(), engine: engineName,
    cpu: cpus()[0]?.model, viewport: [390, 844], density: 3, warmups: 1, rounds,
    inputs: Object.fromEntries([...bodies].map(([name, bytes]) => [name, { bytes: bytes.length, sha256: digest(bytes) }])),
    limitations: ['Synthetic dense radar/terrain/heat and a captured Progs chart; generated georeferenced PDF.',
      'Local desktop browser timings, not iPhone energy, process memory or GPU completion timings.',
      'Fixture construction, downloads and shader compilation are outside the measured preparation stages.'], results }, null, 2) + '\n');
} finally {
  await browser?.close();
  await new Promise(resolve => server.close(resolve));
  await rm(directory, { recursive: true, force: true });
}
