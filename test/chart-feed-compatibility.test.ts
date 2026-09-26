import assert from 'node:assert/strict';
import test from 'node:test';
import { fetchChartCatalog } from '../src/workspace/catalog/catalog';
import { retainCachedProducts } from '../src/workspace/catalog/saved-catalog';
import { cacheFixture } from './helpers/cache';

const root = 'https://charts.tedyin.com/charts/2026-09-03/mbtiles';
function manifest(schemaVersion = 2) {
  const bounds = [-180, -85.0511287798066, 180, 85.0511287798066];
  const charts = ['vfr-sectional', 'ifr-high'].map(kind => ({
    id: `${kind}-test`, title: kind, kind, file: `${kind}-test.mbtiles`, bounds,
    minZoom: 0, maxZoom: 0, byteLength: 32768, sha256: 'a'.repeat(64), cutlineProvenance: 'test',
  }));
  const archives = charts.map(({ kind }) => {
    const id = `${kind}-z0-r0-0-0`;
    return { id, kind, file: `${id}-${'b'.repeat(64)}.mbtiles`, sha256: 'b'.repeat(64),
      zoom: 0, root: { z: 0, x: 0, y: 0 }, bounds, byteLength: 32768, tileMask: '1' };
  });
  return { schemaVersion, packagingVersion: 1, effectiveDate: '2026-09-03', generatedAt: '2026-09-22T22:28:38Z',
    charts, maximumArchiveBytes: 4194304, archives,
    regions: [{ id: 'test', title: 'Test', bounds: [bounds], archiveIds: archives.map(item => item.id) }] };
}

for (const layout of ['flat-packages', 'nested-packages', 'nested-sheets', 'legacy-sheets']) {
  test(`additional chart families preserve supported charts and offline reads: ${layout}`, async t => {
    const { stored } = cacheFixture(t);
    const packages = layout.endsWith('packages');
    const data = manifest(packages ? 2 : 1);
    const url = layout === 'flat-packages' ? `${root}/manifest.json`
      : layout === 'nested-packages' ? `${root}/packages/manifest.json`
        : layout === 'nested-sheets' ? `${root}/chart-manifest.json`
          : `${root.replace('/mbtiles', '')}/chart-manifest.json`;
    t.mock.method(globalThis, 'fetch', async (input: RequestInfo | URL) => String(input) === url
      ? Response.json(data) : new Response(null, { status: 404 }));
    const result = await fetchChartCatalog('2026-09-03');
    assert.deepEqual(result.charts.map(chart => chart.kind), ['vfr-sectional']);
    assert.equal(result.issues.some(issue => issue.product === 'charts'), false);
    if (packages) {
      assert.deepEqual(result.chartPackages!.archives.map(item => item.kind), ['vfr-sectional']);
      assert.deepEqual(result.chartPackages!.regions[0]!.archiveIds, [data.archives[0]!.id]);
    }
    assert.deepEqual(await stored.get(url)!.clone().json(), data, 'cache preserves the publisher response for newer clients');
    t.mock.method(globalThis, 'fetch', async () => { throw new TypeError('Offline'); });
    const offline = await fetchChartCatalog('2026-09-03');
    assert.deepEqual(offline.charts, result.charts);
    assert.deepEqual(offline.chartPackages, result.chartPackages);
    assert.equal(offline.issues.some(issue => issue.product === 'charts'), false);
  });
}

test('family filtering cannot hide broken supported charts, package identities or region dependencies', async t => {
  const { stored } = cacheFixture(t);
  const mutations: Array<[string, (data: ReturnType<typeof manifest>) => void]> = [
    ['unsupported schema', data => { data.schemaVersion = 3; }],
    ['unsupported packaging', data => { data.packagingVersion = 2; }],
    ['wrong edition', data => { data.effectiveDate = '2026-08-06'; }],
    ['bad supported chart', data => { data.charts[0]!.sha256 = 'invalid'; }],
    ['unidentified chart family', data => { data.charts[1]!.kind = ''; }],
    ['bad supported archive', data => { data.archives[0]!.tileMask = '0'; }],
    ['unidentified archive family', data => { data.archives[1]!.kind = ''; }],
    ['colliding archive IDs', data => { data.archives[1]!.id = data.archives[0]!.id; }],
    ['missing supported dependency', data => { data.regions[0]!.archiveIds.shift(); }],
    ['unknown dependency', data => { data.regions[0]!.archiveIds.push('missing-archive'); }],
    ['duplicate excluded dependency', data => { data.regions[0]!.archiveIds.push(data.archives[1]!.id); }],
    ['no supported charts', data => { data.charts.shift(); data.archives.shift(); data.regions[0]!.archiveIds.shift(); }],
  ];
  for (const [label, mutate] of mutations) {
    const data = manifest(); mutate(data);
    t.mock.method(globalThis, 'fetch', async (input: RequestInfo | URL) => String(input) === `${root}/manifest.json`
      ? Response.json(data) : new Response(null, { status: 404 }));
    const result = await fetchChartCatalog('2026-09-03');
    assert.equal(result.charts.length, 0, label);
    assert.match(result.issues.find(issue => issue.product === 'charts')!.message, /invalid document/, label);
    assert.equal(stored.has(`${root}/manifest.json`), false, label);
  }
});

test('an invalid refresh preserves the last valid manifest and saved catalog independently', async t => {
  const { stored } = cacheFixture(t);
  const data = manifest();
  t.mock.method(globalThis, 'fetch', async (input: RequestInfo | URL) => String(input) === `${root}/manifest.json`
    ? Response.json(data) : new Response(null, { status: 404 }));
  const saved = await fetchChartCatalog('2026-09-03');
  data.archives[0]!.sha256 = 'broken';
  const fallback = await fetchChartCatalog('2026-09-03');
  assert.deepEqual(fallback.charts, saved.charts);
  assert.deepEqual(fallback.chartPackages, saved.chartPackages);
  assert.equal(fallback.issues.some(issue => issue.product === 'charts'), false);
  assert.equal((await stored.get(`${root}/manifest.json`)!.clone().json()).archives[0].sha256, 'b'.repeat(64));
  stored.clear();
  const failed = await fetchChartCatalog('2026-09-03');
  assert.equal(failed.charts.length, 0);
  const retained = retainCachedProducts(failed, saved);
  assert.deepEqual(retained.charts, saved.charts);
  assert.deepEqual(retained.chartPackages, saved.chartPackages);
  assert.match(retained.issues.find(issue => issue.product === 'charts')!.message, /refresh failed; using saved FAA Sep 3 charts/);
  assert.match(failed.issues.find(issue => issue.product === 'charts')!.message, /^FAA chart package manifest/,
    'adding the fallback notice does not mutate the failed response');
});
