import assert from 'node:assert/strict';
import test from 'node:test';

import { fetchChartCatalog, isInsideChartCoverage } from '../src/workspace/catalog/catalog';
import { resource as historyResource } from './helpers/route-history';
import { cacheFixture } from './helpers/cache';

for (const layout of ['flat-packages', 'packages', 'mbtiles', 'legacy-404', 'legacy-410', 'legacy-cors'] as const) {
  test(`consumes all published chart identities from the ${layout} layout`, async () => {
    const originalFetch = globalThis.fetch;
    const requests: string[] = [];
    let navigationGeneratedAt = '2026-09-14T20:00:00Z';
    let procedureGeneratedAt = '2026-09-14T20:00:00Z';
    let failedProduct = '';
    let historyStatus = 'valid';
    const packageLayout = layout === 'flat-packages' || layout === 'packages';
    globalThis.fetch = async (input, options) => {
      const url = String(input);
      requests.push(url);
      assert.equal(options?.cache, 'no-store');
      if (url.endsWith('/terrain/manifest.json')) return new Response(null, { status: 404 });
      if (failedProduct && url.includes(`/${failedProduct}/`)) return new Response(null, { status: 503 });
      if ((url.endsWith('/mbtiles/manifest.json') && layout !== 'flat-packages') ||
          (url.endsWith('/packages/manifest.json') && layout !== 'packages')) {
        if (layout === 'legacy-cors') throw new TypeError('Failed to fetch');
        return new Response(null, { status: layout === 'legacy-410' ? 410 : 404 });
      }
      if (layout !== 'mbtiles' && url.endsWith('/mbtiles/chart-manifest.json')) {
        if (layout === 'legacy-cors') throw new TypeError('Failed to fetch');
        return new Response(null, { status: layout === 'legacy-410' ? 410 : 404 });
      }
      if (url.endsWith('/chart-manifest.json') || url.endsWith('/packages/manifest.json') || url.endsWith('/mbtiles/manifest.json')) {
        return Response.json({
          schemaVersion: packageLayout ? 2 : 1,
          ...(packageLayout ? {
            packagingVersion: 1, maximumArchiveBytes: 4194304, regions: [],
            archives: [{
              id: 'vfr-sectional-z0-r0-0-0', kind: 'vfr-sectional', zoom: 0, root: { z: 0, x: 0, y: 0 },
              file: `vfr-sectional-z0-r0-0-0-${'e'.repeat(64)}.mbtiles`, sha256: 'e'.repeat(64),
              bounds: [-180, -85.0511287798066, 180, 85.0511287798066], byteLength: 32768, tileMask: '1',
            }],
          } : {}),
          effectiveDate: '2026-09-03',
          generatedAt: '2026-09-14T21:00:00Z',
          charts: [{
            id: 'vfr-sectional-san_francisco',
            title: 'Sectional · San Francisco',
            kind: 'vfr-sectional',
            file: 'vfr-sectional-san_francisco.mbtiles',
            bounds: [-124.9799519, 36.0134553, -117.6799031, 40.2498947],
            minZoom: 5,
            maxZoom: 12,
            byteLength: 145_707_008,
            sha256: 'a'.repeat(64),
            sourceByteLength: 79_738_153,
            sourceSha256: 'b'.repeat(64),
            tilerVersion: 1,
            buildConfigurationSha256: 'c'.repeat(64),
            cutlineProvenance: 'chartmaker',
          }, ...Array.from({ length: 102 }, (_, index) => ({
            id: `expanded-sheet-${index}`,
            title: `Expanded sheet ${index}`,
            kind: ['vfr-sectional', 'ifr-low', 'vfr-terminal', 'vfr-flyway'][index % 4],
            file: `expanded-sheet-${index}.mbtiles`,
            bounds: [170, 51, 180, 54],
            minZoom: 5,
            maxZoom: 12,
            byteLength: 1_024,
            sha256: 'd'.repeat(64),
            cutlineProvenance: 'chartmaker',
          }))],
        });
      }
      if (url.endsWith('/nav/manifest.json')) {
        return Response.json({
          schemaVersion: 1,
          effectiveDate: '2026-09-03',
          generatedAt: navigationGeneratedAt,
          products: [
            { id: 'airports', file: 'airports.geojson', count: 1 },
            { id: 'vfr-waypoints', file: 'vfr-waypoints.geojson', count: 1 },
            { id: 'navaids', file: 'navaids.geojson', count: 1 },
            { id: 'fixes', file: 'fixes.geojson', count: 1 },
            { id: 'airways', file: 'airways.json', count: 1 },
            { id: 'preferred-routes', file: 'preferred-routes.json', count: 13199 },
            { id: 'terminal-procedures', file: 'terminal-procedures.json', count: 1849 },
            ...(historyStatus === 'missing' ? [] : [{ ...historyResource, file: 'route-history.json.gz',
              ...(historyStatus === 'invalid' ? { compression: 'zstd' } : {}) }]),
          ],
        });
      }
      if (url.endsWith('/tpp/manifest.json')) {
        return Response.json({
          schemaVersion: 1,
          cycle: '2609',
          effectiveDate: '2026-09-03',
          expirationDate: '2026-10-01',
          generatedAt: procedureGeneratedAt,
          airportCount: 1,
          procedureCount: 1,
        });
      }
      throw new Error(`Unexpected fetch: ${url}`);
    };

    try {
      const catalog = await fetchChartCatalog('2026-09-03');
      assert.deepEqual(catalog.issues, []);
      assert.equal(catalog.charts.length, 103);
      assert.equal(catalog.charts.at(-1)?.id, 'expanded-sheet-101');
      // Catalog discovery fetches metadata only, never the chart archives.
      assert.equal(requests.length, layout === 'flat-packages' ? 4 : layout === 'packages' ? 5 : layout === 'mbtiles' ? 6 : 7);
      assert.equal(catalog.chartPackages?.archives.length, packageLayout ? 1 : undefined);
      if (packageLayout) assert.equal(catalog.chartPackages?.root,
        `https://charts.tedyin.com/charts/2026-09-03/mbtiles${layout === 'packages' ? '/packages' : ''}`);
      assert.ok(requests.every((url) => url.endsWith('.json')));
      assert.equal(
        catalog.charts[0]?.url,
        `https://charts.tedyin.com/charts/2026-09-03/` +
          (layout === 'mbtiles' || packageLayout ? 'mbtiles/' : '') +
          `vfr-sectional-san_francisco.mbtiles?sha256=${'a'.repeat(64)}&bytes=145707008`,
      );
      assert.ok(catalog.navigation.every((layer) => !layer.url.includes('/mbtiles/')));
      assert.ok(!catalog.procedures?.url.includes('/mbtiles/'));
      assert.equal(catalog.charts[0]?.byteLength, 145_707_008);
      assert.equal('sourceByteLength' in catalog.charts[0]!, false);
      assert.equal(catalog.generatedAt, '2026-09-14T21:00:00Z');
      assert.deepEqual(
        catalog.charts.find((chart) => chart.id === 'vfr-sectional-san_francisco')?.bounds,
        [-124.9799519, 36.0134553, -117.6799031, 40.2498947],
      );
      assert.equal(isInsideChartCoverage([-122.1, 37.5], catalog.charts), true);
      assert.equal(isInsideChartCoverage([-115.2, 36.1], catalog.charts), false);
      assert.ok(catalog.navigation.every(layer =>
        new URL(layer.url).searchParams.get('v') === navigationGeneratedAt));
      assert.equal(new URL(catalog.airways!.url).searchParams.get('v'), navigationGeneratedAt);
      assert.equal(catalog.preferredRoutes?.count, 13199);
      assert.equal(catalog.terminalProcedures?.count, 1849);
      assert.equal(new URL(catalog.terminalProcedures!.url).searchParams.get('v'), navigationGeneratedAt);
      assert.equal(new URL(catalog.preferredRoutes!.url).searchParams.get('v'), navigationGeneratedAt);
      assert.equal(catalog.routeHistory?.bytes, historyResource.bytes);
      assert.equal(new URL(catalog.routeHistory!.url).searchParams.get('v'), navigationGeneratedAt);
      if (layout === 'flat-packages') {
        navigationGeneratedAt = '2026-09-15T20:43:49.885Z';
        procedureGeneratedAt = '2026-09-16T00:00:00Z';
        const updated = await fetchChartCatalog('2026-09-03');
        assert.notEqual(updated.navigation[0]!.url, catalog.navigation[0]!.url,
          'a same-cycle rebuild must bypass old cached runway data');
        assert.notEqual(updated.preferredRoutes!.url, catalog.preferredRoutes!.url);
        assert.notEqual(updated.routeHistory!.url, catalog.routeHistory!.url);
        assert.equal(new URL(updated.navigation[0]!.url).searchParams.get('v'), navigationGeneratedAt);
        assert.equal(updated.charts[0]!.url, catalog.charts[0]!.url);
        assert.notEqual(updated.procedures!.url, catalog.procedures!.url);
        assert.equal(new URL(updated.procedures!.url).searchParams.get('v'), procedureGeneratedAt);
        historyStatus = 'invalid';
        const invalidHistory = await fetchChartCatalog('2026-09-03');
        assert.equal(invalidHistory.routeHistory, undefined);
        assert.ok(invalidHistory.preferredRoutes);
        assert.equal(invalidHistory.navigation.length, 4);
        assert.deepEqual(invalidHistory.issues.map(issue => issue.product), ['route-history']);
        historyStatus = 'missing';
        const oldFeed = await fetchChartCatalog('2026-09-03');
        assert.equal(oldFeed.routeHistory, undefined);
        assert.deepEqual(oldFeed.issues, []);
        historyStatus = 'valid';
        failedProduct = 'tpp';
        const withoutPlates = await fetchChartCatalog('2026-09-03');
        assert.equal(withoutPlates.charts.length, 103);
        assert.equal(withoutPlates.navigation.length, 4);
        assert.equal(withoutPlates.procedures, undefined);
        assert.deepEqual(withoutPlates.issues.map(issue => issue.product), ['procedures']);
        failedProduct = 'nav';
        const withoutNavigation = await fetchChartCatalog('2026-09-03');
        assert.equal(withoutNavigation.charts.length, 103);
        assert.equal(withoutNavigation.navigation.length, 0);
        assert.ok(withoutNavigation.procedures);
        assert.deepEqual(withoutNavigation.issues.map(issue => issue.product), ['navigation']);
      }

    } finally {
      globalThis.fetch = originalFetch;
    }
  });
}

test('does not fall back on invalid manifests, readable server errors, or cancellation', async (t) => {
  const originalFetch = globalThis.fetch;
  t.after(() => { globalThis.fetch = originalFetch; });
  const root = 'https://charts.tedyin.com/charts/2026-09-03';
  for (const location of ['mbtiles/manifest.json', 'mbtiles/chart-manifest.json', 'mbtiles/packages/manifest.json']) {
    for (const mode of ['invalid', 'unavailable', 'abort'] as const) {
      const requested: string[] = [];
      globalThis.fetch = async (input) => {
        const url = String(input);
        requested.push(url);
        if (url === `${root}/${location}`) {
          if (mode === 'abort') throw new DOMException('Aborted', 'AbortError');
          return mode === 'invalid' ? Response.json({}) : new Response(null, { status: 503 });
        }
        if (url.endsWith('/packages/manifest.json') || url.endsWith('/mbtiles/manifest.json')) return new Response(null, { status: 404 });
        // Let unrelated manifest loads complete without masking the chart error.
        const navigation = url.endsWith('/nav/manifest.json');
        return Response.json({
          schemaVersion: 1, effectiveDate: '2026-09-03', generatedAt: '2026-09-15T00:00:00Z',
          ...(navigation ? { products: [] } : {
            cycle: '2609', expirationDate: '2026-10-01', airportCount: 0, procedureCount: 0,
          }),
        });
      };
      if (mode === 'abort') await assert.rejects(fetchChartCatalog('2026-09-03'));
      else {
        const catalog = await fetchChartCatalog('2026-09-03');
        assert.equal(catalog.charts.length, 0);
        assert.ok(catalog.procedures, 'chart failure does not disable procedures');
        assert.ok(catalog.issues.some(issue => issue.product === 'charts'));
      }
      assert.ok(!requested.includes(`${root}/chart-manifest.json`), mode);
      if (location.includes('/packages/')) assert.ok(!requested.includes(`${root}/mbtiles/chart-manifest.json`), mode);
      if (location === 'mbtiles/manifest.json') assert.ok(!requested.includes(`${root}/mbtiles/packages/manifest.json`), mode);
    }
  }
});

test('concurrent dates validate and cache their own manifests, rejecting an edition placed at the wrong URL', async t => {
  const { stored } = cacheFixture(t);
  const originalFetch = globalThis.fetch;
  t.after(() => { globalThis.fetch = originalFetch; });
  const root = 'https://charts.tedyin.com/charts';
  const manifest = (revision: string) => ({ schemaVersion: 1, effectiveDate: revision,
    generatedAt: `${revision}T00:00:00Z`, products: ['airports', 'fixes', 'navaids', 'vfr-waypoints', 'airways']
      .map(id => ({ id, file: `${id}.json`, count: 1 })),
  });
  globalThis.fetch = async input => {
    const url = String(input);
    const revision = url.match(/\/charts\/(\d{4}-\d{2}-\d{2})\//)![1]!;
    if (url.endsWith('/nav/manifest.json')) return Response.json(manifest(revision));
    return new Response(null, { status: 404 });
  };
  const [old, fresh] = await Promise.all(['2026-08-06', '2026-09-03'].map(date => fetchChartCatalog(date)));
  for (const catalog of [old!, fresh!]) {
    assert.equal(catalog.navigation.length, 4);
    assert.ok(catalog.navigation.every(resource => resource.url.startsWith(`${root}/${catalog.revision}/`)));
    assert.equal(catalog.issues.some(issue => issue.product === 'navigation'), false);
  }
  const oldKey = `${root}/2026-08-06/nav/manifest.json`, freshKey = `${root}/2026-09-03/nav/manifest.json`;
  assert.ok(stored.has(oldKey) && stored.has(freshKey));
  stored.set(oldKey, Response.json(manifest('2026-09-03')));
  globalThis.fetch = async () => { throw new TypeError('Offline'); };
  const rejected = await fetchChartCatalog('2026-08-06');
  assert.equal(rejected.navigation.length, 0);
  assert.ok(rejected.issues.some(issue => issue.product === 'navigation'));
  assert.equal(stored.has(oldKey), false, 'wrong-date metadata cannot remain cached');
  assert.equal((await fetchChartCatalog('2026-09-03')).navigation.length, 4,
    'rejecting an older date does not evict the newer date');
  await assert.rejects(fetchChartCatalog('2026-07-09'), /Unsupported FAA cycle/);
});
