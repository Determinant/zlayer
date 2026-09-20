import { createServer } from 'node:http';
import { createHash } from 'node:crypto';
import { readFile, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve, extname } from 'node:path';
import { build } from 'vite';
import { fixtureFiles } from './fixtures.mjs';
import { terrainPng } from './terrain-fixture.mjs';

const directory = await mkdtemp(resolve(tmpdir(), 'zlayer-e2e-'));
const port = Number(process.env.ZLAYER_TEST_PORT ?? 4197);
process.env.VITE_ZLAYERS_CHART_ROOT = '/chart-data';
process.env.VITE_ZLAYERS_CHART_REVISION = 'latest';
process.env.VITE_ZLAYERS_BASEMAP_TILE_URL = `http://127.0.0.1:${port}/basemap.png`;
process.env.VITE_ZLAYERS_BASEMAP_STYLE_URL = '';
process.env.VITE_ZLAYERS_TERRAIN_TILE_URL = `http://127.0.0.1:${port}/terrain/{z}/{x}/{y}.png`;
await build({ build: { outDir: directory, rolldownOptions: {
  input: { regionalTest: resolve('test/e2e/regional-renderer.ts'), lifecycleTest: resolve('test/e2e/lifecycle.html'),
    identificationTest: resolve('test/browser/identification.html'),
    obstructionTest: resolve('test/browser/obstructions.html'),
    routeEditor: resolve('test/browser/routes.html'), routeMap: resolve('test/browser/route-map.html'), terrainTest: resolve('test/browser/terrain.html'),
    ownshipTest: resolve('test/browser/ownship.html'), graphicsTest: resolve('test/browser/graphics.html'),
    ahrsDrums: resolve('test/browser/ahrs-drums.html'), ahrsGeometry: resolve('test/browser/ahrs-geometry.html') },
  output: { entryFileNames: chunk => chunk.name === 'regionalTest' ? 'regional-test.js'
    : chunk.name === 'sw' ? 'sw.js' : 'assets/[name]-[hash].js' },
} }, logLevel: 'error' });
const fixtures = await fixtureFiles();
const originalFixtures = new Map(fixtures);
const identificationNavaids = JSON.parse(await readFile(new URL('../fixtures/id-navaids.json', import.meta.url), 'utf8'));
let failUpdatedBook = false;
let failNevadaAirports = false;
let failBrowsingAirports = false;
let disconnected = false;
let appRelease;
let failAppInstall = false;
let mismatchedAppHtml = false;
let appInstallGate;
let releaseAppInstall;
const types = { '.js': 'text/javascript', '.mjs': 'text/javascript', '.wasm': 'application/wasm',
  '.html': 'text/html', '.css': 'text/css', '.webmanifest': 'application/manifest+json',
  '.svg': 'image/svg+xml', '.png': 'image/png', '.woff2': 'font/woff2', '.woff': 'font/woff' };
const server = createServer(async (request, response) => {
  const path = decodeURIComponent(new URL(request.url, 'http://127.0.0.1').pathname);
  if (disconnected && !path.startsWith('/__test/')) { request.socket.destroy(); return; }
  const terrain = /^\/terrain\/(\d+)\/(\d+)\/(\d+)\.png$/.exec(path);
  if (terrain) {
    response.writeHead(200, { 'Content-Type': 'image/png', 'Cache-Control': 'max-age=3600' });
    response.end(terrainPng(...terrain.slice(1).map(Number))); return;
  }
  // Mutate the actual origin: browser request routing can bypass service-worker requests.
  if (request.method === 'POST' && path.startsWith('/__test/')) {
    if (path === '/__test/reset') {
      fixtures.clear(); for (const [key, value] of originalFixtures) fixtures.set(key, value);
      failUpdatedBook = false;
      failNevadaAirports = false;
      failBrowsingAirports = false;
      disconnected = false;
      appRelease = undefined;
      failAppInstall = false;
      mismatchedAppHtml = false;
      releaseAppInstall?.();
      appInstallGate = releaseAppInstall = undefined;
    } else if (['/__test/app-update', '/__test/fail-app-update', '/__test/hold-app-update', '/__test/mismatched-app-update'].includes(path)) {
      appRelease = '2222222222222222';
      failAppInstall = path === '/__test/fail-app-update';
      mismatchedAppHtml = path === '/__test/mismatched-app-update';
      if (path === '/__test/hold-app-update') appInstallGate = new Promise(resolve => { releaseAppInstall = resolve; });
    } else if (path === '/__test/allow-app-update') {
      failAppInstall = false;
      mismatchedAppHtml = false;
      releaseAppInstall?.();
      appInstallGate = releaseAppInstall = undefined;
    } else if (path === '/__test/id-navaids-legacy' || path === '/__test/id-navaids-current') {
      const root = '/chart-data/2026-09-03/nav';
      const legacy = path.endsWith('-legacy');
      const data = structuredClone(identificationNavaids);
      if (legacy) for (const feature of data.features) delete feature.properties.stationDeclinationDeg;
      const manifest = JSON.parse(originalFixtures.get(`${root}/manifest.json`).body);
      manifest.generatedAt = legacy ? '2026-09-02T00:00:00Z' : data.fixtureSource.generatedAt;
      manifest.products.find(product => product.id === 'navaids').count = data.features.length;
      fixtures.set(`${root}/manifest.json`, { type: 'application/json', body: Buffer.from(JSON.stringify(manifest)) });
      fixtures.set(`${root}/navaids.geojson`, { type: 'application/geo+json', body: Buffer.from(JSON.stringify(data)) });
    } else if (path === '/__test/legacy-latest-charts') {
      const root = '/chart-data/2026-09-03/mbtiles';
      const { effectiveDate, generatedAt, charts } = JSON.parse(originalFixtures.get(`${root}/manifest.json`).body);
      fixtures.delete(`${root}/manifest.json`);
      fixtures.set(`${root}/chart-manifest.json`, { type: 'application/json',
        body: Buffer.from(JSON.stringify({ schemaVersion: 1, effectiveDate, generatedAt, charts })) });
    } else if (path === '/__test/update-supplement') {
      const url = '/chart-data/2026-09-03/cs/catalog.json';
      const catalog = JSON.parse(originalFixtures.get(url).body);
      const body = Buffer.concat([originalFixtures.get('/chart-data/2026-09-03/book.pdf').body, Buffer.from('\n')]);
      catalog.generatedAt = '2026-09-17T00:00:00Z';
      Object.assign(catalog.volumes[0], { url: '../updated-book.pdf', byteLength: body.length,
        sha256: createHash('sha256').update(body).digest('hex') });
      fixtures.set(url, { body: Buffer.from(JSON.stringify(catalog)), type: 'application/json' });
      fixtures.set('/chart-data/2026-09-03/updated-book.pdf', { body, type: 'application/pdf' });
      failUpdatedBook = true;
    } else if (path === '/__test/replace-navigation') {
      const url = '/chart-data/2026-09-03/nav/airports.geojson';
      const data = JSON.parse(originalFixtures.get(url).body);
      data.features[0].properties.name = 'REPLACEMENT AIRPORT';
      fixtures.set(url, { body: Buffer.from(JSON.stringify(data)), type: 'application/json' });
    } else if (path === '/__test/replace-tpp-metadata') {
      const url = '/chart-data/2026-09-03/tpp/catalog.json';
      const catalog = JSON.parse(originalFixtures.get(url).body);
      catalog.volumes = catalog.volumes.map(volume => ({ ...volume, url: '../replacement.pdf', sha256: 'c'.repeat(64) }));
      fixtures.set(url, { body: Buffer.from(JSON.stringify(catalog)), type: 'application/json' });
    } else if (path === '/__test/disconnect') disconnected = true;
    else if (path === '/__test/fail-browsing-airports') failBrowsingAirports = true;
    else if (path === '/__test/allow-updated-book') failUpdatedBook = false;
    else if (path === '/__test/fail-nevada-airports') failNevadaAirports = true;
    else if (path === '/__test/allow-nevada-airports') failNevadaAirports = false;
    else { response.writeHead(404).end(); return; }
    response.end('ok'); return;
  }
  if (failUpdatedBook && path.endsWith('/updated-book.pdf')) { response.writeHead(503).end(); return; }
  if (failAppInstall && path === '/icon.svg') { response.writeHead(503).end(); return; }
  if (appInstallGate && path === '/icon.svg') await appInstallGate;
  if (failNevadaAirports && path === '/chart-data/2026-08-06/nav/airports.geojson') { response.writeHead(503).end(); return; }
  if (failBrowsingAirports && path === '/chart-data/2026-09-03/nav/airports.geojson') { response.writeHead(503).end(); return; }
  const fixture = fixtures.get(path);
  try {
    const file = resolve(directory, `.${path === '/' ? '/index.html' : path}`);
    if (!file.startsWith(`${directory}/`)) { response.writeHead(403).end(); return; }
    let body = fixture?.body ?? await readFile(file);
    if (appRelease && (path === '/' || path === '/index.html' || path === '/sw.js')) {
      const html = await readFile(resolve(directory, 'index.html'), 'utf8');
      const originalRelease = /name="zlayer-release" content="([a-f0-9]{16})"/.exec(html)[1];
      const originalVersion = /name="zlayer-version" content="([^"]+)"/.exec(html)[1];
      const nextRelease = mismatchedAppHtml && path !== '/sw.js' ? '3333333333333333' : appRelease;
      const nextVersion = originalVersion.replace(/\.b[a-f0-9]{8}$/, `.b${nextRelease.slice(0, 8)}`);
      body = Buffer.from(body.toString().replaceAll(originalVersion, nextVersion).replaceAll(originalRelease, nextRelease));
    }
    response.writeHead(200, { 'content-type': fixture?.type ?? types[extname(file)] ?? 'application/octet-stream',
      'content-length': body.length, 'cache-control': 'no-store', 'service-worker-allowed': '/' });
    response.end(request.method === 'HEAD' ? undefined : body);
  } catch { response.writeHead(404).end(); }
});
server.listen(port, '127.0.0.1');
for (const signal of ['SIGTERM', 'SIGINT']) process.once(signal, () => {
  server.close();
  server.closeAllConnections();
  void rm(directory, { recursive: true, force: true }).finally(() => process.exit());
});
