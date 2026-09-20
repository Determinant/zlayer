import assert from 'node:assert/strict';
import test from 'node:test';
import type { CatalogResponse, ChartPackageArchive } from '@zlayer/contracts';
import { OFFLINE_REGIONS } from '../src/offline/regions';
import { chartRegionPlans } from '../src/layers/charts/offline';
import { resource as routeHistory } from './helpers/route-history';

function archive([longitude, latitude]: [number, number], kind: ChartPackageArchive['kind'], zoom: number): ChartPackageArchive {
  const n = 2 ** zoom;
  const x = Math.floor((longitude + 180) / 360 * n);
  const y = Math.floor((1 - Math.asinh(Math.tan(latitude * Math.PI / 180)) / Math.PI) / 2 * n);
  const lat = (row: number) => Math.atan(Math.sinh(Math.PI * (1 - 2 * row / n))) * 180 / Math.PI;
  const id = `${kind}-z${zoom}-r${zoom}-${x}-${y}`;
  return { id, kind, zoom, root: { z: zoom, x, y }, file: `${id}.mbtiles`, byteLength: 32768,
    sha256: 'a'.repeat(64), tileMask: '1', bounds: [x / n * 360 - 180, lat(y + 1), (x + 1) / n * 360 - 180, lat(y)] };
}

function catalog(archives: ChartPackageArchive[]): CatalogResponse {
  return {
    schemaVersion: 1, revision: '2026-09-03', generatedAt: '2026-09-03T00:00:00Z', weather: [],
    charts: archives.map(file => ({ ...file, title: file.id, minZoom: file.zoom, maxZoom: file.zoom,
      format: 'mbtiles', revision: '2026-09-03', url: `/unused/${file.file}` })),
    navigation: (['airports', 'fixes', 'navaids', 'vfr-waypoints'] as const)
      .map(id => ({ id, title: id, url: `/nav/${id}.geojson`, minZoom: 0, count: 1, sourceCount: 1 })),
    airways: { id: 'airways', title: 'Airways', url: '/nav/airways.json', count: 1, sourceCount: 1 },
    chartPackages: { root: '/charts/2026-09-03/mbtiles', maximumArchiveBytes: 4194304, archives, regions: [] },
  };
}

test('region geography covers 50 states, DC and five territories with valid date-line-safe bounds', () => {
  assert.equal(OFFLINE_REGIONS.length, 56);
  assert.equal(new Set(OFFLINE_REGIONS.map(r => r.id)).size, 56);
  assert.deepEqual(OFFLINE_REGIONS.map(r => r.title), OFFLINE_REGIONS.map(r => r.title).sort());
  for (const region of OFFLINE_REGIONS) for (const [w, s, e, n] of region.bounds) {
    assert.ok(w >= -180 && w < e && e <= 180 && s >= -90 && s < n && n <= 90);
    assert.ok(e - w < 60, `${region.code} must not span the globe`);
  }
  for (const [code, x, y] of [
    ['CA', -122.12, 37.66], ['AK', 173.18, 52.83], ['AK', -149.99, 61.17],
    ['GU', 144.8, 13.49], ['MP', 145.73, 15.12], ['AS', -170.7, -14.33],
    ['PR', -66, 18.44], ['VI', -64.97, 18.34],
  ] as const) {
    assert.ok(OFFLINE_REGIONS.find(r => r.code === code)!.bounds.some(([w, s, e, n]) => x >= w && x <= e && y >= s && y <= n), code);
  }
});

test('one state selection includes every published family/zoom and shares canonical file URLs', () => {
  const archives = (['vfr-sectional', 'vfr-terminal', 'vfr-flyway', 'ifr-low'] as const)
    .flatMap(kind => [0, 7, 8].map(zoom => archive([-118, 37], kind, zoom)));
  const eastern = archive([-74, 41], 'ifr-low', 8);
  const feed = catalog([...archives, eastern]);
  const selections = chartRegionPlans(feed, 'https://zlayer.test/');
  const california = selections.find(({ region }) => region.code === 'CA')!.plan;
  const nevada = selections.find(({ region }) => region.code === 'NV')!.plan;
  assert.equal(california.files.length, archives.length);
  assert.ok(california.files.every(file => !file.url.includes(eastern.id)));
  assert.deepEqual(california.files, nevada.files, 'overlapping envelopes reuse whole files');
  assert.match(california.id, /us-CA\|all-v1$/);
  assert.ok(california.files.every(file => file.url.startsWith('https://zlayer.test/charts/') && file.url.includes('sha256=')));
});

test('Alaska selects both sides of the date line without downloading distant mainland packages', () => {
  const alaska = [archive([173.18, 52.83], 'vfr-sectional', 8), archive([-149.99, 61.17], 'vfr-sectional', 8)];
  const mainland = archive([-122.12, 37.66], 'ifr-low', 8);
  const plans = chartRegionPlans(catalog([...alaska, mainland]), 'https://zlayer.test/');
  const selection = plans.find(({ region }) => region.code === 'AK')!.plan;
  assert.equal(selection.files.length, 2);
  assert.ok(selection.files.every(file => !file.url.includes(mainland.id)));
  assert.equal(new Set(selection.files.map(file => file.url)).size, 2);
});

test('published preferred routes are shared national reference data and older feeds remain usable', () => {
  const feed = catalog([archive([-118, 37], 'vfr-sectional', 0)]);
  const old = chartRegionPlans(feed, 'https://zlayer.test/');
  assert.ok(old.length > 0);
  feed.preferredRoutes = { id: 'preferred-routes', title: 'Preferred routes', count: 13199, sourceCount: 13199,
    url: '/nav/preferred-routes.json?v=current' };
  feed.routeHistory = routeHistory;
  feed.terminalProcedures = { id: 'terminal-procedures', title: 'SID/STAR routes', count: 1849, sourceCount: 1849,
    url: '/nav/terminal-procedures.json?v=current' };
  const plans = chartRegionPlans(feed, 'https://zlayer.test/');
  assert.deepEqual(plans.map(({ plan }) => plan.id), old.map(({ plan }) => plan.id));
  for (const { plan } of plans) {
    assert.deepEqual(plan.references.filter(resource => resource.id === 'preferred-routes'),
      [{ ...feed.preferredRoutes, url: 'https://zlayer.test/nav/preferred-routes.json?v=current' }]);
    assert.deepEqual(plan.references.filter(resource => resource.id === 'route-history'), [routeHistory]);
    assert.deepEqual(plan.references.filter(resource => resource.id === 'terminal-procedures'),
      [{ ...feed.terminalProcedures, url: 'https://zlayer.test/nav/terminal-procedures.json?v=current' }]);
  }
});

test('the same region and identical archive hashes in different cycles have separate plans and file URLs', () => {
  const current = catalog([archive([-118, 37], 'vfr-sectional', 0)]);
  const previous = JSON.parse(JSON.stringify(current).replaceAll('2026-09-03', '2026-08-06')) as CatalogResponse;
  const select = (feed: CatalogResponse) => chartRegionPlans(feed, 'https://zlayer.test/')
    .find(({ region }) => region.code === 'CA')!.plan;
  const a = select(current), b = select(previous);
  assert.equal(a.regionId, b.regionId);
  assert.notEqual(a.id, b.id);
  assert.notEqual(a.revision, b.revision);
  assert.equal(a.files[0]!.sha256, b.files[0]!.sha256);
  assert.ok(a.files.every(file => file.url.includes('/2026-09-03/')));
  assert.ok(b.files.every(file => file.url.includes('/2026-08-06/')));
});
