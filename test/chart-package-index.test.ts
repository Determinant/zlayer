import assert from 'node:assert/strict';
import test from 'node:test';
import { chartPackageUrl, isChartPackageIndex, type CatalogResponse, type ChartPackageArchive } from '@zlayer/contracts';
import { createChartPackageIndex } from '../src/layers/charts/package-index';
import { chartRegionPlans } from '../src/layers/charts/offline';
import { OFFLINE_REGIONS } from '../src/offline/regions';

function archive(zoom: number, root = { z: 0, x: 0, y: 0 }, tileMask = '1'): ChartPackageArchive {
  const n = 2 ** root.z;
  const latitude = (row: number) => Math.atan(Math.sinh(Math.PI * (1 - 2 * row / n))) * 180 / Math.PI;
  const id = `vfr-sectional-z${zoom}-r${root.z}-${root.x}-${root.y}`;
  const sha256 = 'a'.repeat(64);
  return {
    id, kind: 'vfr-sectional', file: `${id}-${sha256}.mbtiles`, zoom, root,
    bounds: [root.x / n * 360 - 180, latitude(root.y + 1), (root.x + 1) / n * 360 - 180, latitude(root.y)],
    tileMask, byteLength: 32768, sha256,
  };
}

function catalog(): CatalogResponse {
  const archives = [archive(0), archive(1), archive(2, { z: 2, x: 1, y: 1 })];
  return {
    schemaVersion: 1, revision: '2026-09-03', generatedAt: '2026-09-15T00:00:00Z',
    navigation: [], weather: [],
    charts: [{
      id: 'coarse', title: 'Coarse', kind: 'vfr-sectional', bounds: [-180, 0, 0, 85], minZoom: 1, maxZoom: 1,
      format: 'mbtiles', revision: '2026-09-03', url: '/unused.mbtiles', byteLength: 1, sha256: 'b'.repeat(64),
    }, {
      id: 'fine', title: 'Fine', kind: 'vfr-sectional', bounds: [-90, 0, 0, 60], minZoom: 2, maxZoom: 2,
      format: 'mbtiles', revision: '2026-09-03', url: '/unused-fine.mbtiles', byteLength: 1, sha256: 'c'.repeat(64),
    }],
    chartPackages: {
      root: 'https://charts.tedyin.com/charts/2026-09-03/mbtiles/packages', maximumArchiveBytes: 4194304, archives,
      regions: ['west', 'overlap'].map(id => ({ id, title: id, bounds: [[-180, 0, 0, 85]], archiveIds: archives.map(item => item.id) })),
    },
  };
}

test('routes by kind, native zoom, spatial root and sparse tile mask without fetching', () => {
  const feed = catalog();
  const resolve = createChartPackageIndex(feed);
  const index = feed.chartPackages!;
  assert.equal(resolve('vfr-sectional', { z: 0, x: 0, y: 0 }), chartPackageUrl(index.root, index.archives[0]!));
  assert.equal(resolve('vfr-sectional', { z: 3, x: 0, y: 0 }), chartPackageUrl(index.root, index.archives[1]!));
  assert.equal(resolve('vfr-sectional', { z: 3, x: 2, y: 2 }), chartPackageUrl(index.root, index.archives[2]!));
  assert.equal(resolve('vfr-sectional', { z: 2, x: 3, y: 0 }), undefined, 'outside source coverage');
  assert.equal(resolve('ifr-low', { z: 0, x: 0, y: 0 }), undefined);
  index.archives[1]!.tileMask = '2';
  const updated = createChartPackageIndex(feed);
  assert.equal(updated('vfr-sectional', { z: 3, x: 0, y: 0 }), undefined, 'absent native cell must not fall back');
});

test('resolves relative development feed URLs before selecting the package reader', () => {
  const feed = catalog();
  const index = feed.chartPackages!;
  const pageUrl = 'http://localhost:4173/workspace/';
  for (const root of ['/chart-data/2026-09-03/mbtiles', './chart-data/2026-09-03/mbtiles', index.root]) {
    index.root = root;
    const resolve = createChartPackageIndex(feed, pageUrl);
    const resolved = resolve('vfr-sectional', { z: 0, x: 0, y: 0 });
    const expected = new URL(chartPackageUrl(root, index.archives[0]!), pageUrl);
    assert.equal(resolved, expected.href);
    // Both the reader selection and package loader parse the identity without a base.
    const parsed = new URL(resolved!);
    assert.equal(Number(parsed.searchParams.get('bytes')), index.archives[0]!.byteLength);
    assert.equal(parsed.searchParams.get('sha256'), index.archives[0]!.sha256);
  }
});

test('download selections use absolute shared file identities and require navigation coverage', () => {
  const feed = catalog();
  assert.deepEqual(chartRegionPlans(feed, 'https://zlayer.test/'), []);
  feed.navigation = (['airports', 'fixes', 'navaids', 'vfr-waypoints'] as const)
    .map(id => ({ id, title: id, url: `/nav/${id}.geojson`, minZoom: 0, count: 1, sourceCount: 1 }));
  feed.airways = { id: 'airways', title: 'Airways', url: '/nav/airways.json', count: 1, sourceCount: 1 };
  const plans = chartRegionPlans(feed, 'https://zlayer.test/', OFFLINE_REGIONS.filter(r => ['NY', 'PA'].includes(r.code)));
  assert.equal(plans.length, 2);
  assert.deepEqual(plans[0]!.plan.files, plans[1]!.plan.files, 'overlapping states share all file keys');
  assert.equal(plans[0]!.plan.files.length, 3, 'includes every native zoom');
  assert.equal(plans[0]!.plan.references.length, 5);
  assert.ok(plans[0]!.plan.references.every(resource => resource.url.startsWith('https://zlayer.test/')));
  assert.match(plans[0]!.plan.title, /New York/);
  assert.deepEqual(chartRegionPlans({ ...feed, charts: [] }, 'https://zlayer.test/'), [], 'no false coverage from global overview files');
});

test('rejects malformed, overlapping, oversized and incomplete package indexes', () => {
  const index = catalog().chartPackages!;
  assert.equal(isChartPackageIndex(index), true);
  const corruptions: Array<(copy: typeof index) => void> = [
    copy => { copy.archives[0]!.bounds[0] = -179; },
    copy => { copy.archives[0]!.byteLength = copy.maximumArchiveBytes + 1; },
    copy => { copy.archives[0]!.tileMask = '2'; },
    copy => { copy.archives[0]!.file = '../evil.mbtiles'; },
    copy => { copy.archives.push(copy.archives[0]!); },
    copy => { copy.archives.push(archive(2)); }, // ancestor overlaps the adaptive leaf
    copy => { copy.regions[0]!.archiveIds.pop(); },
    copy => { copy.regions[0]!.archiveIds.push('missing'); },
  ];
  for (const mutate of corruptions) {
    const copy = structuredClone(index);
    mutate(copy);
    assert.equal(isChartPackageIndex(copy), false);
  }
});
