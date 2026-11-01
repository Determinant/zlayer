import assert from 'node:assert/strict';
import test from 'node:test';
import { isOnChartFeed } from '../src/workspace/catalog/feed';
import { mapErrorCode, mapErrorMessage, MapTileErrors } from '../src/workspace/map/errors';

test('feed matching respects configured origins, paths, and directory boundaries', () => {
  const base = 'https://app.test/';
  for (const root of ['/chart-data', '/custom/charts/', 'https://example.test/charts']) {
    const normalized = root.replace(/\/$/, '');
    assert.equal(isOnChartFeed(new URL(`${normalized}/2026-09-03/mbtiles/a.mbtiles`, base), base, root), true);
    assert.equal(isOnChartFeed(new URL(`${normalized}-other/a.mbtiles`, base), base, root), false);
    assert.equal(isOnChartFeed(new URL('https://unrelated.test/charts/a.mbtiles'), base, root), false);
  }
});

test('basemap failures use plain language while preserving request classification and tile recovery', () => {
  const tile = { state: 'errored' as const, uses: 1 };
  const event = { error: new Error('AJAXError: Service Unavailable (503): https://tiles.test/private-provider-path'),
    sourceId: 'zlayer-basemap', tile };
  const message = mapErrorMessage(event)!;
  assert.equal(message, 'Background imagery is unavailable. You can still use saved charts and navigation.');
  assert.equal(mapErrorCode(event.error), 'request');
  const failures = new MapTileErrors();
  assert.equal(failures.failed(event), 'zlayer-basemap');
  assert.equal(failures.loaded({ sourceId: 'another-source', tile: { state: 'loaded', uses: 1 } }), undefined);
  Object.assign(tile, { state: 'loaded' });
  assert.equal(failures.loaded(event), 'zlayer-basemap');
  assert.equal(mapErrorMessage({ ...event, error: new DOMException('cancelled', 'AbortError') }), undefined);
});

test('reports asynchronous map/source errors but not cancelled tile requests', () => {
  assert.equal(mapErrorMessage({ error: new Error('decode failed'), sourceId: 'chart-@ifr-low' }), 'chart-@ifr-low: decode failed');
  assert.equal(mapErrorMessage({ error: { message: 'WebGL unavailable' } }), 'Map: WebGL unavailable');
  assert.equal(mapErrorMessage({ error: new DOMException('Cancelled', 'AbortError') }), undefined);
});
