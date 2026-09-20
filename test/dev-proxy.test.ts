import assert from 'node:assert/strict';
import test from 'node:test';
import { developmentProxy } from '../tools/dev-proxy';

test('development proxies preserve dated asset paths and METAR query parameters', () => {
  const charts = developmentProxy['/chart-data'];
  assert.equal(charts.target, 'https://charts.tedyin.com');
  assert.equal(charts.rewrite('/chart-data/2026-09-03/mbtiles/manifest.json?revision=1'),
    '/charts/2026-09-03/mbtiles/manifest.json?revision=1');

  const metars = developmentProxy['/weather/metars.geojson'];
  assert.equal(metars.target, 'https://aviationweather.gov');
  assert.equal(metars.rewrite('/weather/metars.geojson?ids=KHWD,KSFO&format=geojson'),
    '/api/data/metar?ids=KHWD,KSFO&format=geojson');
});

test('the FAA PDF fallback stays restricted to a cycle and single PDF filename', () => {
  const entry = Object.entries(developmentProxy).find(([path]) => path.startsWith('^'));
  assert.ok(entry);
  const [pattern, proxy] = entry;
  const path = '/faa-procedures/2609/00195R28L.PDF?revision=1';
  assert.equal(proxy.target, 'https://aeronav.faa.gov');
  assert.ok(new RegExp(pattern).test(path));
  assert.equal(proxy.rewrite(path), '/d-tpp/2609/00195R28L.PDF?revision=1');
  for (const invalid of [
    '/faa-procedures/2609/../secret.PDF', '/faa-procedures/2609/plate.xml',
    '/faa-procedures/2609/sub/plate.PDF', '/faa-procedures/https://example.test/plate.PDF',
  ]) assert.ok(!new RegExp(pattern).test(invalid), invalid);
});
