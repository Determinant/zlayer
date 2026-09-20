import assert from 'node:assert/strict';
import test from 'node:test';
import { isOnChartFeed } from '../src/workspace/catalog/feed';
import { mapErrorMessage } from '../src/workspace/map/errors';

test('feed matching respects configured origins, paths, and directory boundaries', () => {
  const base = 'https://app.test/';
  for (const root of ['/chart-data', '/custom/charts/', 'https://example.test/charts']) {
    const normalized = root.replace(/\/$/, '');
    assert.equal(isOnChartFeed(new URL(`${normalized}/2026-09-03/mbtiles/a.mbtiles`, base), base, root), true);
    assert.equal(isOnChartFeed(new URL(`${normalized}-other/a.mbtiles`, base), base, root), false);
    assert.equal(isOnChartFeed(new URL('https://unrelated.test/charts/a.mbtiles'), base, root), false);
  }
});

test('reports asynchronous map/source errors but not cancelled tile requests', () => {
  assert.equal(mapErrorMessage({ error: new Error('decode failed'), sourceId: 'chart-@ifr-low' }), 'chart-@ifr-low: decode failed');
  assert.equal(mapErrorMessage({ error: { message: 'WebGL unavailable' } }), 'Map: WebGL unavailable');
  assert.equal(mapErrorMessage({ error: new DOMException('Cancelled', 'AbortError') }), undefined);
});
