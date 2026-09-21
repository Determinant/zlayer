import assert from 'node:assert/strict';
import test from 'node:test';

import { DEFAULT_MAP_VIEW, mapStyle } from '../src/workspace/map/style.js';

test('the initial camera is centered on KPAO at a regional zoom', () => {
  assert.deepEqual(DEFAULT_MAP_VIEW, { center: [-122.11504666, 37.46112138], zoom: 9 });
});

test('the default basemap uses attributed opaque topo without separate relief requests', () => {
  const style = mapStyle({});
  assert.ok(typeof style !== 'string');
  const rasters = style.layers.filter((layer) => layer.type === 'raster');
  assert.equal(rasters.length, 1);
  const [topo] = rasters;
  assert.ok(topo);
  assert.equal(topo.source, 'zlayer-basemap');
  assert.equal(topo.paint?.['raster-opacity'], 1);
  assert.deepEqual(Object.keys(style.sources), ['zlayer-basemap']);
  const source = style.sources['zlayer-basemap'];
  assert.ok(source?.type === 'raster');
  assert.equal(source.attribution, 'USGS The National Map');
  assert.deepEqual(source.tiles, [
    'https://basemap.nationalmap.gov/arcgis/rest/services/USGSTopo/MapServer/tile/{z}/{y}/{x}',
  ]);
});

test('preserves a custom basemap without mixing in default relief', () => {
  const url = 'https://example.test/tiles/{z}/{x}/{y}.png';
  const style = mapStyle({ VITE_ZLAYERS_BASEMAP_TILE_URL: ` ${url} ` });
  assert.ok(typeof style !== 'string');
  assert.deepEqual(Object.keys(style.sources), ['zlayer-basemap']);
  const source = style.sources['zlayer-basemap'];
  assert.ok(source?.type === 'raster');
  assert.deepEqual(source.tiles, [url]);
  assert.equal(source.attribution, undefined);
  const layer = style.layers.find((candidate) => candidate.id === 'zlayer-basemap');
  assert.equal(layer?.type === 'raster' && layer.paint?.['raster-opacity'], 1);
});

test('an external style overrides the raster basemap', () => {
  assert.equal(mapStyle({
    VITE_ZLAYERS_BASEMAP_STYLE_URL: ' https://example.test/style.json ',
    VITE_ZLAYERS_BASEMAP_TILE_URL: 'https://example.test/tiles/{z}/{x}/{y}.png',
  }), 'https://example.test/style.json');
});
