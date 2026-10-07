import { test } from './persistent-webkit';
import { expect, type Page } from '@playwright/test';
import type { GeoJSONSource } from 'maplibre-gl';
import { heatPixels } from './glide-heat';
import { terrainPng } from './terrain-fixture.mjs';

async function focusFixture(page: Page) {
  await page.waitForFunction(() => !!window.glideAudit);
  await page.evaluate(() => {
    window.glideAudit.route([[-120.03, 35], [-119.97, 35]]);
    window.glideAudit.map.jumpTo({ center: [-119.998, 35.001], zoom: 13 });
  });
}

test.beforeEach(async ({ request }) => { await request.post('/__test/reset'); await request.post('/__test/glide-packages'); });

test('published glide overview renders without detail downloads; detail retains holes and works after offline reload', async ({ page, context }, testInfo) => {
  const detailRequests: string[] = [];
  context.on('request', request => { if (request.url().includes('.gld')) detailRequests.push(request.url()); });
  await context.route('**/terrain/*/*/*.png', route => {
    const match = /terrain\/(\d+)\/(\d+)\/(\d+)\.png/.exec(route.request().url())!;
    return route.fulfill({ contentType: 'image/png', body: terrainPng(Number(match[1]), Number(match[2]), Number(match[3]), () => 0) });
  });
  await page.goto('/test/browser/glide.html'); await focusFixture(page);
  await page.getByRole('switch', { name: 'Show glide coverage' }).click();
  await page.getByRole('switch', { name: 'Show off-field coverage' }).click();
  const shaded = () => heatPixels(page);
  await expect.poll(shaded).toBeGreaterThan(0); expect(detailRequests).toHaveLength(0);
  await page.screenshot({ path: testInfo.outputPath('packaged-glide-density.png') });
  await page.evaluate(() => window.glideAudit.ownship([-120, 35]));
  const detail = () => page.evaluate(async () => (await window.glideAudit.map.getSource<GeoJSONSource>('glide-landing-areas')!.getData()) as GeoJSON.FeatureCollection<GeoJSON.MultiPolygon>);
  await expect.poll(async () => (await detail()).features.length).toBe(2);
  const first = await detail();
  expect(first.features.find(f => f.properties?.tier === 2)!.geometry.coordinates[0]!).toHaveLength(2);
  expect(detailRequests).toHaveLength(1);
  const pixel = await page.evaluate(() => { const p = window.glideAudit.map.project([-120.001, 35.002]); return { x: p.x, y: p.y }; });
  await expect.poll(() => page.evaluate(() => window.glideAudit.map.queryRenderedFeatures({ layers: ['glide-landing-fill'] }).length)).toBeGreaterThan(0);
  await page.mouse.click(pixel.x, pixel.y, { button: 'right' });
  await page.getByRole('menuitem', { name: 'Inspect landing area', exact: true }).click();
  await expect(page.getByLabel('Selected glide point', { exact: true })).toContainText('Preferred · 2,000 × 200 ft fit');
  await page.screenshot({ path: testInfo.outputPath('packaged-glide-detail.png') });
  // Keep the fixture shell online, but reject every data request after a fresh worker.
  await context.route('**/chart-data/glide/**', route => route.abort('internetdisconnected'));
  await page.reload(); await focusFixture(page);
  await expect.poll(shaded).toBeGreaterThan(0);
  await page.evaluate(() => window.glideAudit.ownship([-120, 35]));
  await expect.poll(async () => (await detail()).features.length).toBe(2);
  await expect(page.getByTestId('errors')).toBeEmpty();
});

test('real service-worker region downloads retain shared glide archives and detect offline eviction', async ({ page, context, request }) => {
  await page.goto('/');
  await page.getByLabel('Settings and offline downloads').click();
  await page.getByRole('tab', { name: 'Offline', exact: true }).click();
  const region = (id: string) => page.locator(`.region-row[data-region-id="${id}"][data-revision="2026-09-03"]`);
  for (const id of ['us-CA', 'us-NV']) {
    await expect(region(id).getByRole('button', { name: 'Download', exact: true })).toBeEnabled();
    await region(id).getByRole('button', { name: 'Download', exact: true }).click();
    await expect(region(id).locator('.offline-tag')).toHaveText('Saved');
  }
  const savedGlide = () => page.evaluate(async () => {
    const files: string[] = [];
    for (const name of await caches.keys()) for (const key of await (await caches.open(name)).keys()) {
      if (/\/glide\/.*\.(gld|glo)\?/.test(key.url)) files.push(key.url);
    }
    return [...new Set(files)].sort();
  });
  const files = await savedGlide(); expect(files).toHaveLength(12);
  // WebKit's network emulation also blocks service-worker responses. Disconnect
  // the origin instead and prove that a new page can start from the saved shell.
  await page.waitForFunction(() => Boolean(navigator.serviceWorker.controller));
  await request.post('/__test/disconnect');
  try {
    await expect(request.get('/')).rejects.toThrow();
    const offline = await context.newPage();
    await offline.addInitScript(() => Object.defineProperty(navigator, 'onLine', { get: () => false }));
    await page.close();
    page = offline;
    await page.goto('/');
    await expect(region('us-NV').locator('.offline-tag')).toHaveText('Saved');
    await region('us-CA').getByRole('button', { name: 'Remove', exact: true }).click();
    await page.getByRole('alertdialog').getByRole('button', { name: 'Remove', exact: true }).click();
    await expect(region('us-CA').locator('.offline-tag')).toHaveCount(0);
    expect(await savedGlide()).toEqual(files);
    await page.evaluate(async () => {
      for (const name of await caches.keys()) {
        const cache = await caches.open(name);
        for (const key of await cache.keys()) if (key.url.includes('/glide/detail/')) await cache.delete(key);
      }
    });
    await region('us-NV').getByRole('button', { name: 'Verify saved files', exact: true }).click();
    await expect(region('us-NV').locator('.offline-tag')).not.toHaveText('Saved');
  } finally { await request.post('/__test/reset'); }
});
