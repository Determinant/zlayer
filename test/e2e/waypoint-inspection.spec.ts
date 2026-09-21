import { test, expect, type Page } from '@playwright/test';
import type { Map as MapLibreMap, GeoJSONSource } from 'maplibre-gl';
import { terrainMeters, terrainPng } from './terrain-fixture.mjs';
import { terrainPointLocation } from '../../src/layers/terrain/point-elevation';

const elevationFact = (page: Page) => page.locator('.feature-facts > div')
  .filter({ has: page.getByText('Elevation', { exact: true }) });

async function ready(page: Page, route = 'KSBA KSMX') {
  await page.goto(`/test/browser/route-map.html?details&route=${encodeURIComponent(route)}`);
  await page.waitForFunction(() => {
    const map = (window as unknown as { routeMapAudit?: { map: MapLibreMap } }).routeMapAudit?.map;
    return map?.getLayer('waypoint-inspection-point') && map.isStyleLoaded();
  });
}

async function inspectedPoint(page: Page) {
  return page.evaluate(async () => {
    const map = (window as unknown as { routeMapAudit: { map: MapLibreMap } }).routeMapAudit.map;
    const data = await (map.getSource('waypoint-inspection') as GeoJSONSource).getData();
    if (data.type !== 'FeatureCollection' || data.features[0]?.geometry.type !== 'Point') throw new Error('Missing inspection point');
    return data.features[0].geometry.coordinates as [number, number];
  });
}

for (const [width, height] of [[1280, 900], [390, 844]] as const) {
  test(`empty-map inspection shows elevation without route edits at ${width}px`, async ({ page }, testInfo) => {
    await page.setViewportSize({ width, height });
    const tiles: string[] = [];
    page.on('request', request => { if (/\/terrain\/\d+\//.test(request.url())) tiles.push(request.url()); });
    await ready(page);
    await page.mouse.click(Math.round(width * 0.3), 210, { button: 'right' });
    await expect(page.getByLabel('Selection')).toHaveText('coordinate: GPS waypoint');
    await expect(page.getByLabel('Edits')).toHaveText('0');
    await expect(page.getByLabel('Route', { exact: true })).toHaveText('KSBA KSMX');
    const elevation = elevationFact(page);
    const point = await inspectedPoint(page);
    const sample = terrainPointLocation(point)!;
    const { x, y, z } = sample.tile;
    const meters = terrainMeters((x + (sample.sampleIndex % 256 + 0.5) / 256) / 2 ** z,
      (y + (Math.floor(sample.sampleIndex / 256) + 0.5) / 256) / 2 ** z);
    const heightFt = Math.round(Math.round(meters * 256) / 256 / 0.3048 / 10) * 10;
    await expect(elevation).toContainText(`≈ ${heightFt.toLocaleString('en-US')} ft MSL`);
    expect(tiles).toHaveLength(1);
    expect(tiles[0]).toContain(`/terrain/13/${x}/${y}.png`);
    await expect(page.getByRole('button', { name: /^Remove .* from route$/ })).toHaveCount(0);
    const original = await elevation.innerText();
    await page.evaluate(center => (window as unknown as { routeMapAudit: { map: MapLibreMap } }).routeMapAudit.map
      .jumpTo({ center, zoom: 8 }), point);
    await expect(elevation).toHaveText(original, { useInnerText: true });
    expect(tiles).toHaveLength(1);
    await expect(elevation).toBeVisible();
    expect(await elevation.evaluate(element => element.scrollWidth <= element.clientWidth)).toBe(true);
    await page.screenshot({ path: testInfo.outputPath(`waypoint-elevation-${width}.png`) });
    await page.getByRole('button', { name: 'Close detail', exact: true }).click();
    await expect(page.getByLabel('Selection')).toHaveText('None');
    await expect.poll(() => page.evaluate(async () => {
      const map = (window as unknown as { routeMapAudit: { map: MapLibreMap } }).routeMapAudit.map;
      const data = await (map.getSource('waypoint-inspection') as GeoJSONSource).getData();
      return data.type === 'FeatureCollection' ? data.features.length : -1;
    })).toBe(0);
    await expect(page.getByLabel('Edits')).toHaveText('0');
    await expect(page.getByRole('alert')).toBeEmpty();
  });
}

test('a long press opens one temporary waypoint and keeps it selected after release', async ({ page, context }) => {
  await ready(page, '');
  const session = await context.newCDPSession(page);
  await session.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x: 300, y: 240 }] });
  await expect(page.getByLabel('Selection')).toHaveText('coordinate: GPS waypoint');
  const point = await inspectedPoint(page);
  await session.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
  await session.detach();
  await expect(elevationFact(page)).toContainText('ft MSL');
  expect(await inspectedPoint(page)).toEqual(point);
  await expect(page.getByLabel('Edits')).toHaveText('0');
});

test('existing route GPS waypoints use the same elevation display and keep their route actions', async ({ page }) => {
  await ready(page, '350000N1190000W');
  await page.mouse.click(640, 450);
  await expect(elevationFact(page)).toContainText('ft MSL');
  await expect(page.getByRole('button', { name: 'Remove 350000N1190000W from route', exact: true })).toBeVisible();
  await expect(page.getByLabel('Edits')).toHaveText('0');
});

test('failed elevation can retry, and unavailable data is never displayed as zero', async ({ page, context }) => {
  await context.route('**/terrain/**/*.png', route => route.fulfill({ status: 404, body: 'Missing' }));
  await ready(page);
  await page.mouse.click(300, 240, { button: 'right' });
  const elevation = elevationFact(page);
  await expect(elevation).toContainText('Unavailable');
  await expect(elevation).not.toContainText('ft MSL');
  await context.unroute('**/terrain/**/*.png');
  await page.getByRole('button', { name: 'Retry terrain elevation', exact: true }).click();
  await expect(elevation).toContainText('ft MSL');
});

test('an existing GPS feature elevation survives an unavailable terrain lookup, including zero', async ({ page, context }) => {
  await context.route('**/terrain/**/*.png', route => route.fulfill({ status: 404, body: 'Missing' }));
  await ready(page, '');
  await page.mouse.click(300, 240, { button: 'right' });
  const elevation = elevationFact(page);
  await expect(elevation).toContainText('Unavailable');
  await page.evaluate(async () => {
    const map = window.routeMapAudit.map;
    const source = map.getSource('waypoint-inspection') as GeoJSONSource;
    const data = await source.getData();
    if (data.type !== 'FeatureCollection') throw new Error('Missing inspection point');
    data.features[0]!.properties = { ...data.features[0]!.properties, elevationFt: 0 };
    source.setData(data);
  });
  await page.waitForFunction(() => window.routeMapAudit.map.queryRenderedFeatures({ layers: ['waypoint-inspection-point'] })
    .some(feature => feature.properties.elevationFt === 0));
  await page.mouse.click(300, 240);
  await expect(elevation.locator('dd')).toHaveText('0 ft');
  await expect(page.getByRole('button', { name: 'Retry terrain elevation' })).toHaveCount(0);
  await expect(page.getByLabel('Edits')).toHaveText('0');
});

test('switching points ignores a delayed old elevation result and preserves negative elevations', async ({ page, context }) => {
  let release!: () => void;
  const pending = new Promise<void>(resolve => { release = resolve; });
  let first = true;
  await context.route('**/terrain/**/*.png', async route => {
    const delayed = first; first = false;
    if (delayed) await pending;
    const match = /\/terrain\/(\d+)\/(\d+)\/(\d+)\.png/.exec(route.request().url())!;
    await route.fulfill({ contentType: 'image/png', body: terrainPng(Number(match[1]), Number(match[2]), Number(match[3]),
      () => delayed ? 1500 : -50) }).catch(() => {});
  });
  await ready(page);
  await page.mouse.click(300, 240, { button: 'right' });
  const elevation = elevationFact(page);
  await expect(elevation).toContainText('Loading…');
  await expect.poll(() => first).toBe(false);
  await page.mouse.click(500, 300, { button: 'right' });
  await expect(elevation).toContainText('≈ -160 ft MSL');
  release();
  await expect(elevation).toContainText('≈ -160 ft MSL');
  await expect(page.getByLabel('Edits')).toHaveText('0');
});

test('the app inspects an empty location, adopts saved terrain and retains elevation offline', async ({ page, context }, testInfo) => {
  await page.addInitScript(() => {
    localStorage.setItem('zlayers-map-preferences-v1', JSON.stringify({ version: 2, chartBase: '',
      terrainEnabled: false, ownshipEnabled: false }));
    localStorage.setItem('zlayers-map-view-v1', JSON.stringify({ version: 1, center: [-122.01, 37.01], zoom: 13 }));
  });
  await page.goto('/');
  const canvas = page.locator('.map-canvas canvas');
  await expect(canvas).toBeVisible();
  await expect(page.locator('.startup-screen')).toHaveCount(0);
  const box = (await canvas.boundingBox())!;
  await canvas.click({ button: 'right', position: { x: box.width / 2, y: box.height / 2 } });
  const elevation = elevationFact(page);
  await expect(elevation).toContainText('ft MSL');
  await expect(page.locator('.route-token')).toHaveCount(0);
  await expect(page.getByRole('button', { name: /^Remove .* from route$/ })).toHaveCount(0);
  await page.waitForFunction(() => navigator.serviceWorker.controller?.state === 'activated');
  const saved = await page.evaluate(async () => {
    const path = '/assets/terrain-storage-test.js';
    return (await import(/* @vite-ignore */ path) as typeof import('../browser/terrain-storage')).save('fine', true);
  });
  expect(saved?.state, saved?.error).toBe('complete');
  await expect(elevation).toContainText('≈ 2,150 ft MSL');
  await page.screenshot({ path: testInfo.outputPath('app-waypoint-elevation.png') });
  await context.setOffline(true);
  await page.reload();
  await expect(elevation).toContainText('≈ 2,150 ft MSL');
  await expect(page.locator('.route-token')).toHaveCount(0);
});
