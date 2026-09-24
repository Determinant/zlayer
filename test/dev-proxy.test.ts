import assert from 'node:assert/strict';
import test from 'node:test';
import type { ProxyOptions } from 'vite';
import { developmentProxy } from '../tools/dev-proxy';

test('weather API requests reach the shared server without changing paths or queries', () => {
  const proxy: ProxyOptions = developmentProxy['/api/weather/'];
  assert.equal(proxy.target, process.env.WEATHER_API_ORIGIN || 'https://zlayer.tedyin.com');
  for (const path of ['/api/weather/grids/clouds.json', '/api/weather/advisories/gairmet.json',
    '/api/weather/metars.geojson?ids=KHWD&format=geojson']) {
    assert.equal(proxy.rewrite?.(path) ?? path, path);
  }
});

test('development proxies preserve dated chart asset paths', () => {
  const charts = developmentProxy['/chart-data'];
  assert.equal(charts.target, 'https://charts.tedyin.com');
  assert.equal(charts.rewrite('/chart-data/2026-09-03/mbtiles/manifest.json?revision=1'),
    '/charts/2026-09-03/mbtiles/manifest.json?revision=1');
});

test('the FAA PDF fallback stays restricted to a cycle and single PDF filename', () => {
  const entry = Object.entries(developmentProxy).find(([path]) => path.startsWith('^/faa-procedures/'));
  assert.ok(entry);
  const [pattern, proxy] = entry;
  assert.ok('rewrite' in proxy);
  const path = '/faa-procedures/2609/00195R28L.PDF?revision=1';
  assert.equal(proxy.target, 'https://aeronav.faa.gov');
  assert.ok(new RegExp(pattern).test(path));
  assert.equal(proxy.rewrite(path), '/d-tpp/2609/00195R28L.PDF?revision=1');
  for (const invalid of [
    '/faa-procedures/2609/../secret.PDF', '/faa-procedures/2609/plate.xml',
    '/faa-procedures/2609/sub/plate.PDF', '/faa-procedures/https://example.test/plate.PDF',
  ]) assert.ok(!new RegExp(pattern).test(invalid), invalid);
});
