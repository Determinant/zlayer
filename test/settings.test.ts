import assert from 'node:assert/strict';
import test from 'node:test';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import type { ChartCatalog } from '../src/workspace/catalog/catalog';
import Settings from '../src/shell/settings';
import { SettingsDialog } from '../src/shell/settings-dialog';

test('state downloads always include books and do not show a chart-only subtotal while indexes load', t => {
  const original = Object.getOwnPropertyDescriptor(globalThis, 'location');
  Object.defineProperty(globalThis, 'location', { configurable: true, value: { href: 'https://zlayer.test/' } });
  t.after(() => original ? Object.defineProperty(globalThis, 'location', original) : Reflect.deleteProperty(globalThis, 'location'));
  const catalog: ChartCatalog = {
    schemaVersion: 1, revision: '2026-09-03', generatedAt: '2026-09-03T00:00:00Z',
    charts: [{ id: 'california', title: 'California', kind: 'vfr-sectional', bounds: [-125, 32, -114, 43],
      minZoom: 0, maxZoom: 1, format: 'mbtiles', revision: '2026-09-03', url: '/unused.mbtiles',
      byteLength: 32768, sha256: 'a'.repeat(64) }], weather: [], issues: [],
    navigation: (['airports', 'fixes', 'navaids', 'vfr-waypoints'] as const)
      .map(id => ({ id, title: id, url: `/nav/${id}.geojson`, minZoom: 0, count: 1, sourceCount: 1 })),
    airways: { id: 'airways', title: 'Airways', url: '/nav/airways.json', count: 1, sourceCount: 1 },
    chartPackages: {
      root: '/charts/2026-09-03/mbtiles', maximumArchiveBytes: 4194304,
      archives: [{ id: 'vfr-sectional-z0-r0-0-0', kind: 'vfr-sectional', zoom: 0, root: { z: 0, x: 0, y: 0 },
        file: 'chart.mbtiles', byteLength: 32768, sha256: 'a'.repeat(64), bounds: [-180, -85, 180, 85], tileMask: '1' }],
      regions: [{ id: 'west', title: 'West', bounds: [[-123, 37, -121, 39]], archiveIds: ['vfr-sectional-z0-r0-0-0'] }],
    },
  };
  const html = renderToStaticMarkup(createElement(SettingsDialog, {
    open: true, onClose: () => {}, children: createElement(Settings, { catalog, open: true }),
  }));
  assert.match(html, /<button\b[^>]*aria-label="Close settings"/);
  assert.match(html, /California \(CA\)/);
  assert.match(html, /all applicable plates and Chart Supplements/);
  assert.doesNotMatch(html, /type="checkbox"/, 'books cannot be excluded from a regional download');
  assert.match(html, /Loading size…/);
  assert.doesNotMatch(html, /32 KiB/, 'a chart-only size must not masquerade as a complete regional download');
  const download = html.match(/<button\b[^>]*>Download<\/button>/)?.[0];
  assert.ok(download?.includes('disabled=""'), 'new downloads wait for the complete book index');
});
