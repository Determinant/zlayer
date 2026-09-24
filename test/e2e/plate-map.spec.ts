import { createHash } from 'node:crypto';
import { test, expect, type Page, type Route } from '@playwright/test';
import { expectMapPlate, hideMapPlate } from './plate-map-fixture';
import { gridFixture } from '../fixtures/awc-grids';
import { WEATHER_NOW } from '../fixtures/awc-advisories';

test.use({ hasTouch: true });

test.beforeEach(async ({ page, request }) => {
  // Keep interception deterministic; the ordinary plate suite covers the app shell.
  await page.addInitScript(() => { Reflect.deleteProperty(Navigator.prototype, 'serviceWorker'); });
  const bytes = await (await request.get('/georeferenced-book.pdf')).body();
  await page.route('**/tpp/manifest.json*', async route => {
    const response = await route.fetch();
    await route.fulfill({ response, json: { ...await response.json(), procedureCount: 3 } });
  });
  await page.route('**/tpp/catalog.json*', async route => {
    const response = await route.fetch();
    const catalog = await response.json();
    const volume = catalog.volumes[0];
    const plainUrl = new URL(volume.url, route.request().url()).href;
    Object.assign(volume, { url: '/georeferenced-book.pdf', byteLength: bytes.length, pageCount: 2,
      sha256: createHash('sha256').update(bytes).digest('hex'), resolvedTargetCount: 2 });
    const first = catalog.airports[0].procedures[0];
    catalog.airports[0].procedures.push({ ...first, id: 'second', name: 'SECOND APPROACH', sortOrder: 2 },
      { ...first, id: 'plain', name: 'UNREFERENCED APPROACH', sortOrder: 3, volumeTarget: null, pdfUrl: plainUrl });
    await route.fulfill({ response, json: catalog });
  });
  await page.goto('/');
});

async function openPlate(page: Page, name = 'TEST APPROACH') {
  await page.getByLabel('Search FAA navigation data').fill('KSBA');
  await page.locator('.search-results button').filter({ hasText: 'KSBA' }).click();
  const showDetails = page.getByRole('button', { name: 'Show KSBA details', exact: true });
  if (await showDetails.isVisible()) await showDetails.click();
  await page.getByRole('tab', { name: 'Plates', exact: true }).click();
  await page.getByRole('button', { name: new RegExp(`^${name}`) }).click();
  await expect(page.getByRole('button', { name: 'Show on map', exact: true })).toBeEnabled();
}

async function showPlate(page: Page, name = 'TEST APPROACH') {
  await openPlate(page, name);
  await page.getByRole('button', { name: 'Show on map', exact: true }).click();
  await expect(page.getByRole('dialog')).toHaveCount(0);
  await expectMapPlate(page, name);
  // moveend persists the camera after the fit animation finishes.
  await expect.poll(() => page.evaluate(() => {
    const view = JSON.parse(localStorage.getItem('zlayers-map-view-v1') ?? 'null');
    return !!view && Math.abs(view.center[0] + 119.85) < 0.001 && view.zoom < 10.5;
  })).toBe(true);
}

async function center(page: Page) {
  const box = (await page.locator('.maplibregl-canvas').boundingBox())!;
  return { x: box.x + box.width / 2, y: box.y + box.height / 2 };
}

test('weather, plate actions and navigation share one map menu while the AWC toolbox is open', async ({ page, request }) => {
  await page.clock.install({ time: WEATHER_NOW });
  await request.post('/__test/awc-grids', { data: { products: [gridFixture('clouds')] } });
  await page.reload();
  await showPlate(page);
  await page.getByRole('button', { name: 'Show AWC Weather toolbox', exact: true }).click();
  await page.getByRole('switch', { name: 'Show AWC weather', exact: true }).click();
  for (const name of ['G-AIRMET', 'SIGMET', 'Convective SIGMET', 'CWA']) await page.getByRole('checkbox', { name, exact: true }).uncheck();
  await page.getByRole('tab', { name: 'Cloud', exact: true }).click();
  await page.getByRole('combobox', { name: 'Forecast overlay', exact: true }).selectOption('cloudCover');
  await expect(page.locator('.awc-grid-status')).toContainText('Valid Sep 22 · 21:00Z');
  const point = await center(page);
  await page.mouse.click(point.x, point.y, { button: 'right' });
  const menu = page.getByRole('menu', { name: 'Map actions' });
  await expect(menu.getByRole('menuitem', { name: 'Inspect weather', exact: true })).toBeVisible();
  await expect(menu.getByRole('menuitem', { name: 'Show plate panel', exact: true })).toBeVisible();
  await expect(menu.getByRole('menuitem', { name: 'Hide IAP from map', exact: true })).toBeVisible();
  expect(await menu.getByRole('menuitem').count()).toBeGreaterThan(3);
  await menu.getByRole('menuitem', { name: 'Inspect weather', exact: true }).click();
  await expect(page.getByRole('article', { name: 'Forecast at selected point' })).toBeVisible();
  await expectMapPlate(page);
  await page.getByRole('button', { name: 'Hide AWC Weather toolbox', exact: true }).click();
  await page.mouse.click(point.x, point.y, { button: 'right' });
  await expect(menu.getByRole('menuitem', { name: 'Inspect weather', exact: true })).toBeVisible();
  await expect(menu.getByRole('menuitem', { name: 'Show plate panel', exact: true })).toBeVisible();
});

test('right-click offers the plate panel and removal only inside the plate, and dismissal preserves it', async ({ page }, testInfo) => {
  const errors: string[] = [];
  page.on('pageerror', error => errors.push(error.message));
  await showPlate(page);
  await page.screenshot({ path: testInfo.outputPath('iap-on-map.png') });
  const box = (await page.locator('.maplibregl-canvas').boundingBox())!;
  await page.mouse.click(box.x + 40, box.y + box.height / 2, { button: 'right' });
  await expectMapPlate(page);
  const menu = page.getByRole('menu', { name: 'Map actions' });
  await expect(menu).toHaveCount(0);
  await showPlate(page, 'SECOND APPROACH');
  const point = await center(page);
  await page.locator('.maplibregl-canvas').focus();
  await page.mouse.click(point.x, point.y, { button: 'right' });
  await expect(menu).toBeVisible();
  await expectMapPlate(page, 'SECOND APPROACH');
  const hide = menu.getByRole('menuitem', { name: 'Hide IAP from map' });
  const show = menu.getByRole('menuitem', { name: 'Show plate panel' });
  await expect(show).toBeFocused();
  await expect(page.getByRole('dialog', { name: 'Nearby map features' })).toHaveCount(0);
  await page.screenshot({ path: testInfo.outputPath('iap-menu.png') });
  await page.keyboard.press('Escape');
  await expect(menu).toHaveCount(0);
  await expect(page.locator('.maplibregl-canvas')).toBeFocused();
  await expectMapPlate(page, 'SECOND APPROACH');
  await page.mouse.click(point.x, point.y, { button: 'right' });
  await expect(menu).toBeVisible();
  await page.mouse.click(box.x + 40, box.y + box.height / 2);
  await expect(menu).toHaveCount(0);
  await expectMapPlate(page, 'SECOND APPROACH');
  await page.mouse.click(point.x, point.y, { button: 'right' });
  const camera = await page.evaluate(() => localStorage.getItem('zlayers-map-view-v1'));
  await show.click();
  await expect(menu).toHaveCount(0);
  const reader = page.getByRole('dialog', { name: 'SECOND APPROACH', exact: true });
  await expect(reader).toBeVisible();
  await expect(reader.locator('.procedure-page-stage')).toHaveAttribute('aria-busy', 'false');
  await expect(reader.locator('canvas')).toBeVisible();
  await expect(reader.getByRole('button', { name: 'Close plate' })).toBeFocused();
  await expectMapPlate(page, 'SECOND APPROACH');
  expect(await page.evaluate(() => localStorage.getItem('zlayers-map-view-v1'))).toBe(camera);
  await reader.getByRole('button', { name: 'Close plate' }).click();
  await expect(reader).toHaveCount(0);
  await page.mouse.click(point.x, point.y, { button: 'right' });
  await hide.click();
  await expect(menu).toHaveCount(0);
  await expectMapPlate(page, null);
  await page.screenshot({ path: testInfo.outputPath('iap-removed.png') });
  expect(errors).toEqual([]);
});

test('touch gestures preserve the IAP, and a long press offers the plate panel and removal after release', async ({ page }, testInfo) => {
  await page.setViewportSize({ width: 393, height: 852 });
  await showPlate(page);
  await page.screenshot({ path: testInfo.outputPath('iap-mobile.png') });
  const point = await center(page);
  const menu = page.getByRole('menu', { name: 'Map actions' });
  const cdp = await page.context().newCDPSession(page);
  await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [
    { x: point.x - 25, y: point.y, id: 1 }, { x: point.x + 25, y: point.y, id: 2 },
  ] });
  await cdp.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: [
    { x: point.x - 35, y: point.y, id: 1 }, { x: point.x + 35, y: point.y, id: 2 },
  ] });
  await page.waitForTimeout(650); // A held two-finger gesture must never remove the plate.
  await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
  await expectMapPlate(page);
  await expect(menu).toHaveCount(0);
  await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [point] });
  await cdp.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: [{ x: point.x + 18, y: point.y }] });
  await page.waitForTimeout(650); // Exceed the hold threshold while a moved finger remains down.
  await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
  await expectMapPlate(page);
  await expect(menu).toHaveCount(0);
  await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [point] });
  await expect(menu).toBeVisible();
  await expectMapPlate(page);
  await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
  await expect(menu).toBeVisible();
  await expectMapPlate(page);
  await expect(page.getByRole('dialog', { name: 'Nearby map features' })).toHaveCount(0);
  await expect(page.locator('.feature-card')).toHaveCount(0);
  await page.screenshot({ path: testInfo.outputPath('iap-menu-mobile.png') });
  await menu.getByRole('menuitem', { name: 'Show plate panel' }).tap();
  await expect(menu).toHaveCount(0);
  const reader = page.getByRole('dialog', { name: 'TEST APPROACH', exact: true });
  await expect(reader).toBeVisible();
  await expect(reader.locator('.procedure-page-stage')).toHaveAttribute('aria-busy', 'false');
  await expect(reader.locator('canvas')).toBeVisible();
  await expectMapPlate(page);
  await reader.getByRole('button', { name: 'Close plate' }).tap();
  await expect(reader).toHaveCount(0);
  await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [point] });
  await expect(menu).toBeVisible();
  await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
  await menu.getByRole('menuitem', { name: 'Hide IAP from map' }).tap();
  await expect(menu).toHaveCount(0);
  await expectMapPlate(page, null);
  await cdp.detach();
});

test('a long press near the map edge cannot activate the menu underneath the released finger', async ({ page }, testInfo) => {
  await page.setViewportSize({ width: 393, height: 852 });
  await showPlate(page);
  const zoomBefore = await page.evaluate(() => JSON.parse(localStorage.getItem('zlayers-map-view-v1')!).zoom as number);
  for (const step of [1, 2]) {
    await page.getByRole('button', { name: 'Zoom in', exact: true }).press('Enter');
    await expect.poll(() => page.evaluate(() => JSON.parse(localStorage.getItem('zlayers-map-view-v1')!).zoom as number))
      .toBeGreaterThan(zoomBefore + step - 0.01);
  }
  const box = (await page.locator('.maplibregl-canvas').boundingBox())!;
  const point = { x: box.x + box.width - 20, y: box.y + box.height - 80 };
  const cdp = await page.context().newCDPSession(page);
  await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [point] });
  const menu = page.getByRole('menu', { name: 'Map actions' });
  await expect(menu).toBeVisible();
  const hide = menu.getByRole('menuitem', { name: 'Hide IAP from map' });
  const bounds = (await hide.boundingBox())!;
  expect(point.x).toBeGreaterThan(bounds.x);
  expect(point.x).toBeLessThan(bounds.x + bounds.width);
  expect(point.y).toBeGreaterThan(bounds.y);
  expect(point.y).toBeLessThan(bounds.y + bounds.height);
  await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
  await expect(menu).toBeVisible();
  await expectMapPlate(page);
  await page.screenshot({ path: testInfo.outputPath('iap-menu-edge.png') });
  await page.touchscreen.tap(box.x + 30, box.y + 100);
  await expect(menu).toHaveCount(0);
  await expectMapPlate(page);
  await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [point] });
  await expect(menu).toBeVisible();
  await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
  await expect(menu.getByRole('menuitem', { name: 'Show plate panel' })).toBeFocused();
  await page.keyboard.press('ArrowDown');
  await expect(hide).toBeFocused();
  await page.keyboard.press('Enter');
  await expectMapPlate(page, null);
  await cdp.detach();
});

test('paging through a book cannot patch a different page under the selected approach name', async ({ page }) => {
  await openPlate(page);
  await page.getByRole('button', { name: 'Next PDF page' }).click();
  await expect(page.getByRole('button', { name: 'Show on map', exact: true })).toHaveCount(0);
  await page.getByRole('button', { name: 'Return to approach' }).click();
  await expect(page.locator('.procedure-page-controls')).toContainText('Page 1 / 2');
  await page.getByRole('button', { name: 'Show on map', exact: true }).click();
  await expectMapPlate(page);
});

test('a plate without georeferencing keeps the existing map IAP and normal viewer available', async ({ page }) => {
  await showPlate(page);
  await openPlate(page, 'UNREFERENCED APPROACH');
  await page.getByRole('button', { name: 'Show on map', exact: true }).click();
  await expect(page.getByRole('dialog').getByRole('alert')).toContainText('no geographic placement data');
  await expect(page.getByRole('button', { name: 'Show on map', exact: true })).toBeEnabled();
  await page.getByRole('button', { name: 'Close plate' }).click();
  await expectMapPlate(page);
  // Opening the airport moved the camera; the airport is within this fixture plate.
  await hideMapPlate(page);
});

test('closing during map preparation cancels the pending patch', async ({ page }) => {
  let release!: (route: Route) => void;
  const held = new Promise<Route>(resolve => { release = resolve; });
  await page.route('**/assets/prepare-map-image-*.js', release, { times: 1 });
  await openPlate(page);
  await page.getByRole('button', { name: 'Show on map', exact: true }).click();
  const module = await held;
  await page.getByRole('button', { name: 'Close plate' }).click();
  await expect(page.getByRole('dialog')).toHaveCount(0);
  await module.continue();
  await expectMapPlate(page, null);
  await showPlate(page);
});

test('a previously shown IAP can be patched again from the saved PDF while offline', async ({ page, context }) => {
  await showPlate(page);
  await hideMapPlate(page);
  await openPlate(page);
  await context.setOffline(true);
  await page.getByRole('button', { name: 'Show on map', exact: true }).click();
  await expectMapPlate(page);
});
