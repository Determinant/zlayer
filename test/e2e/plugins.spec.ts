import { test, expect, type Page } from '@playwright/test';
import { mockGps, countWatches, sendFix } from './ownship-fixture';

test.beforeEach(async ({ request }) => { await request.post('/__test/reset'); });

async function settings(page: Page) {
  await page.getByLabel('Settings and offline downloads').click();
  await page.getByRole('tab', { name: 'Plugins', exact: true }).click();
}
const row = (page: Page, id: string) => page.locator(`.plugin-row[data-plugin="${id}"]`);
const camera = (page: Page) => page.evaluate(() => JSON.parse(localStorage.getItem('zlayers-map-view-v1')!));

test('all ten plugins disable and re-enable without replacing the map or erasing a route', async ({ page }) => {
  const errors: string[] = [];
  page.on('pageerror', error => errors.push(error.message));
  await mockGps(page);
  await page.goto('/');
  await expect(page.locator('.app-shell')).toHaveAttribute('aria-busy', 'false');
  await expect.poll(() => countWatches(page)).toBe(1);
  await sendFix(page);
  await page.waitForTimeout(650);
  const editor = page.getByRole('textbox', { name: 'Add route waypoint', exact: true });
  await editor.fill('KSBA KSMO'); await editor.press('Enter');
  await expect(page.locator('.route-token')).toHaveCount(2);
  await page.getByRole('button', { name: 'Fit route on map', exact: true }).click();
  await page.locator('.maplibregl-canvas').evaluate(canvas => canvas.setAttribute('data-original-map', 'true'));
  await settings(page);
  await expect(page.locator('.plugin-row')).toHaveCount(10);
  const savedDraft = await page.evaluate(() => localStorage.getItem('zlayer-plugin:routes:draft'));
  // Wait for the explicit Fit action before checking that toggles preserve it.
  await expect.poll(async () => (await camera(page)).center[0]).toBeCloseTo(-119.145, 2);
  await page.waitForTimeout(650);
  const before = await camera(page);
  for (const id of ['ahrs', 'ruler', 'ownship', 'terrain', 'obstructions', 'charts', 'metar', 'plates', 'navigation', 'routes']) {
    await row(page, id).getByRole('switch', { checked: true }).click();
    await expect(row(page, id).getByRole('switch')).toHaveAttribute('aria-checked', 'false');
  }
  await expect(page.locator('.plugin-list').getByRole('switch', { checked: false })).toHaveCount(10);
  await expect.poll(() => countWatches(page)).toBe(0);
  await expect(page.locator('.route-bar')).toHaveCount(0);
  await expect(page.locator('.map-edge-tool')).toHaveCount(0);
  await expect(page.locator('.ruler-toggle')).toHaveCount(0);
  await expect(page.locator('.maplibregl-canvas[data-original-map="true"]')).toHaveCount(1);
  expect(await page.evaluate(() => localStorage.getItem('zlayer-plugin:routes:draft'))).toBe(savedDraft);
  expect(await camera(page)).toEqual(before);
  for (const id of ['charts', 'terrain', 'plates', 'obstructions', 'navigation', 'metar', 'routes', 'ruler', 'ownship', 'ahrs']) {
    await row(page, id).getByRole('switch', { checked: false }).click();
    await expect(row(page, id).getByRole('switch')).toHaveAttribute('aria-checked', 'true');
  }
  await page.getByLabel('Close settings').click();
  await expect(page.locator('.route-token')).toHaveCount(2);
  await expect(page.locator('.map-edge-tool')).toHaveCount(4);
  await expect.poll(() => countWatches(page)).toBe(1);
  await sendFix(page, { longitude: -119, latitude: 35 });
  await page.waitForTimeout(700);
  expect(await camera(page)).toEqual(before);
  await expect(page.locator('.maplibregl-canvas[data-original-map="true"]')).toHaveCount(1);
  await expect(page.locator('.map-runtime-error')).toHaveCount(0);
  expect(errors).toEqual([]);
});

test('plugin selection and dependencies survive refresh, and a route can stay disabled during map selection', async ({ page }) => {
  await page.goto('/');
  await settings(page);
  await row(page, 'ownship').getByRole('switch').click();
  await expect(row(page, 'ahrs').getByRole('switch')).toHaveAttribute('aria-checked', 'true');
  await row(page, 'navigation').getByRole('switch').click();
  await expect(row(page, 'metar').getByRole('switch')).toHaveAttribute('aria-checked', 'true');
  await row(page, 'routes').getByRole('switch').click();
  await page.reload();
  await expect(page.getByRole('tab', { name: 'Plugins', exact: true })).toHaveAttribute('aria-selected', 'true');
  for (const id of ['ownship', 'navigation', 'routes']) await expect(row(page, id).getByRole('switch')).toHaveAttribute('aria-checked', 'false');
  await expect(row(page, 'ahrs').getByRole('switch')).toHaveAttribute('aria-checked', 'true');
  await row(page, 'ahrs').getByRole('switch').click();
  await expect(row(page, 'ahrs').getByRole('switch')).toHaveAttribute('aria-checked', 'false');
  await row(page, 'ahrs').getByRole('switch').click();
  await expect(row(page, 'ahrs').getByRole('switch')).toHaveAttribute('aria-checked', 'true');
  await expect(row(page, 'ownship').getByRole('switch')).toHaveAttribute('aria-checked', 'false');
  await row(page, 'navigation').getByRole('switch').click();
  await expect(row(page, 'navigation').getByRole('switch')).toHaveAttribute('aria-checked', 'true');
  await page.getByLabel('Close settings').click();
  await expect(page.locator('.route-bar')).toHaveCount(0);
  await page.getByLabel('Search FAA navigation data').fill('KSBA');
  await page.locator('.search-results button').filter({ hasText: 'KSBA' }).click();
  await expect(page.locator('.feature-card')).toBeVisible();
  await expect(page.getByLabel('Add KSBA to end of route')).toHaveCount(0);
  // The map keeps its selection/context gestures even with the route plugin absent.
  await page.getByLabel('Close detail').click();
  const map = page.locator('.maplibregl-canvas');
  const bounds = (await map.boundingBox())!;
  await page.mouse.click(bounds.x + bounds.width / 2, bounds.y + bounds.height / 2, { button: 'right' });
  await expect(page.locator('.feature-card')).toBeVisible();
  await expect(page.locator('.map-runtime-error')).toHaveCount(0);
});

test('disabling plates retains reader state and falls back to airport information', async ({ page }) => {
  await page.goto('/');
  await page.getByLabel('Search FAA navigation data').fill('KSBA');
  await page.locator('.search-results button').filter({ hasText: 'KSBA' }).click();
  await page.getByRole('tab', { name: 'Plates', exact: true }).click();
  await page.getByRole('button', { name: /TEST APPROACH/ }).click();
  await expect(page.locator('.procedure-page-stage')).toHaveAttribute('aria-busy', 'false');
  await page.locator('.procedure-window').getByRole('button', { name: 'Zoom in', exact: true }).click();
  await expect(page.locator('.procedure-page-stage')).toHaveAttribute('aria-busy', 'false');
  const zoom = await page.locator('.procedure-zoom-controls').textContent();
  const selection = await page.evaluate(() => localStorage.getItem('zlayer-plugin:plates:plate-selection'));
  await settings(page);
  await row(page, 'plates').getByRole('switch').click();
  await expect(page.locator('.procedure-window')).toHaveCount(0);
  expect(await page.evaluate(() => localStorage.getItem('zlayer-plugin:plates:plate-selection'))).toBe(selection);
  await page.getByLabel('Close settings').click();
  await page.getByRole('button', { name: 'Show KSBA details', exact: true }).click();
  await expect(page.getByRole('region', { name: 'Feature information', exact: true })).toBeVisible();
  await expect(page.getByRole('tab', { name: 'Plates', exact: true })).toHaveCount(0);
  await settings(page);
  await row(page, 'plates').getByRole('switch').click();
  await page.getByLabel('Close settings').click();
  await expect(page.locator('.procedure-page-stage')).toHaveAttribute('aria-busy', 'false');
  await expect(page.locator('.procedure-zoom-controls')).toHaveText(zoom!);
  await expect(page.getByRole('tab', { name: 'Plates', exact: true })).toHaveAttribute('aria-selected', 'true');
});

test('a workspace saved with every plugin disabled starts with core settings available', async ({ page }) => {
  await page.addInitScript(() => localStorage.setItem('zlayer-ui:plugins-unloaded', JSON.stringify({ version: 1,
    value: ['charts', 'terrain', 'plates', 'obstructions', 'navigation', 'metar', 'routes', 'ruler', 'ownship', 'ahrs'] })));
  await page.goto('/');
  await expect(page.locator('.app-shell')).toHaveAttribute('aria-busy', 'false');
  await expect(page.locator('.route-bar')).toHaveCount(0);
  await expect(page.locator('.map-edge-tool')).toHaveCount(0);
  expect((await page.locator('.maplibregl-canvas').boundingBox())!.height).toBeGreaterThan(100);
  await settings(page);
  await expect(page.locator('.plugin-list').getByRole('switch', { checked: false })).toHaveCount(10);
  await page.getByRole('tab', { name: 'General', exact: true }).click();
  await expect(page.getByLabel('FAA data cycle')).toBeVisible();
  await page.getByRole('tab', { name: 'Plugins', exact: true }).click();
  await row(page, 'navigation').getByRole('switch').click();
  await expect(page.locator('.plugin-list').getByRole('switch', { checked: false })).toHaveCount(9);
  await page.getByLabel('Close settings').click();
  await expect(page.getByLabel('Search FAA navigation data')).toBeVisible();
});

test.describe('lazy plugin activation', () => {
  test.use({ serviceWorkers: 'block' });
  test('an import completing after disabling cannot attach, and re-enabling starts and stops its worker', async ({ page }) => {
    await page.addInitScript(() => {
      localStorage.setItem('zlayer-ui:plugins-unloaded', JSON.stringify({ version: 1, value: ['terrain'] }));
      localStorage.setItem('zlayers-map-preferences-v1', JSON.stringify({ version: 2, chartBase: '', terrainEnabled: true, terrainCoverage: 'viewport' }));
      localStorage.setItem('zlayers-map-view-v1', JSON.stringify({ version: 1, center: [-120, 35], zoom: 9, bearing: 0, pitch: 0 }));
    });
    let entered = false, completed = false, started = 0, active = 0;
    let release!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; });
    page.on('worker', worker => {
      if (!worker.url().includes('terrain.worker-')) return;
      started++; active++;
      worker.on('close', () => { active--; });
    });
    await page.route('**/assets/*.js', async route => {
      const response = await route.fetch();
      if ((await response.text()).includes('Terrain worker unavailable')) {
        entered = true;
        await gate;
        await route.fulfill({ response });
        completed = true;
      } else await route.fulfill({ response });
    });
    try {
      await mockGps(page);
      await page.goto('/');
      await expect(page.locator('.app-shell')).toHaveAttribute('aria-busy', 'false');
      await expect.poll(() => countWatches(page)).toBe(1);
      await settings(page);
      await row(page, 'terrain').getByRole('switch').click();
      await expect.poll(() => entered).toBe(true);
      expect(await countWatches(page), 'a pending import must not detach the healthy GPS attachment').toBe(1);
      await page.getByLabel('Close settings').click();
      const bounds = (await page.locator('.maplibregl-canvas').boundingBox())!;
      await page.mouse.click(bounds.x + bounds.width / 2, bounds.y + bounds.height / 2, { button: 'right' });
      await expect(page.locator('.feature-card')).toBeVisible();
      await page.getByLabel('Close detail').click();
      // Coordinate inspection can use its own short-lived elevation worker even
      // while the map renderer's import is held. Only new starts after releasing
      // that import would indicate a stale map attachment.
      await expect.poll(() => active).toBe(0);
      const inspectionStarts = started;
      await settings(page);
      await row(page, 'terrain').getByRole('switch').click();
      await expect(row(page, 'terrain').getByRole('switch')).toHaveAttribute('aria-checked', 'false');
      release();
      await expect.poll(() => completed).toBe(true);
      await page.waitForTimeout(700);
      expect(started).toBe(inspectionStarts);
      await row(page, 'terrain').getByRole('switch').click();
      await expect.poll(() => started).toBe(inspectionStarts + 1);
      await row(page, 'terrain').getByRole('switch').click();
      await expect.poll(() => active).toBe(0);
      await expect(page.locator('.map-runtime-error')).toHaveCount(0);
    } finally { release(); }
  });
});

for (const [width, height] of [[320, 568], [568, 320], [1280, 900]]) {
  test(`settings tabs support keyboard navigation and plugin controls fit at ${width}×${height}`, async ({ page }, testInfo) => {
    await page.setViewportSize({ width: width!, height: height! });
    await page.goto('/');
    await page.getByLabel('Settings and offline downloads').click();
    const general = page.getByRole('tab', { name: 'General', exact: true });
    const plugins = page.getByRole('tab', { name: 'Plugins', exact: true });
    await general.focus(); await general.press('ArrowRight');
    await expect(plugins).toBeFocused();
    await expect(page.getByRole('tabpanel', { name: 'Plugins', exact: true })).toBeVisible();
    const action = row(page, 'ahrs').getByRole('switch');
    await action.scrollIntoViewIfNeeded();
    const box = (await action.boundingBox())!;
    expect(box.width).toBeGreaterThanOrEqual(44); expect(box.height).toBeGreaterThanOrEqual(44);
    expect(box.x).toBeGreaterThanOrEqual(0); expect(box.x + box.width).toBeLessThanOrEqual(width!);
    expect(box.y).toBeGreaterThanOrEqual(0); expect(box.y + box.height).toBeLessThanOrEqual(height!);
    await page.screenshot({ path: testInfo.outputPath('plugin-settings.png') });
    await plugins.focus(); await plugins.press('Home');
    await expect(general).toBeFocused();
    await expect(page.getByLabel('FAA data cycle')).toBeVisible();
  });
}

test('chart workers stop when disabled and restart without accumulating across repeated activations', async ({ page }) => {
  const workers = new Set<import('@playwright/test').Worker>();
  const errors: string[] = [];
  page.on('pageerror', error => errors.push(error.message));
  page.on('worker', worker => {
    if (!/sqlite\.worker|package-worker/.test(worker.url())) return;
    workers.add(worker);
    worker.on('close', () => workers.delete(worker));
  });
  await page.goto('/');
  await expect(page.locator('.app-shell')).toHaveAttribute('aria-busy', 'false');
  await expect.poll(() => workers.size).toBeGreaterThan(0);
  await page.locator('.maplibregl-canvas').evaluate(canvas => canvas.setAttribute('data-original-map', 'true'));
  await settings(page);
  for (let cycle = 0; cycle < 5; cycle++) {
    await row(page, 'charts').getByRole('switch', { checked: true }).click();
    await expect.poll(() => workers.size).toBe(0);
    await row(page, 'charts').getByRole('switch', { checked: false }).click();
    await expect.poll(() => workers.size).toBeGreaterThan(0);
  }
  await row(page, 'charts').getByRole('switch', { checked: true }).click();
  await expect.poll(() => workers.size).toBe(0);
  await expect(page.locator('.maplibregl-canvas[data-original-map="true"]')).toHaveCount(1);
  expect(errors).toEqual([]);
});
