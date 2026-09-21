import { expect, test, type Page } from '@playwright/test';

test.use({ serviceWorkers: 'block', hasTouch: true, viewport: { width: 393, height: 852 } });
test.beforeEach(async ({ page }) => {
  await page.addInitScript(() => localStorage.setItem('zlayers-map-preferences-v1', JSON.stringify({
    chartBase: '', ownshipEnabled: false, metarEnabled: false, terrainEnabled: false, obstructionsEnabled: false,
  })));
});

async function hold(page: Page, pattern: string | RegExp) {
  let release!: () => void;
  const pending = new Promise<void>(resolve => { release = resolve; });
  let requested = false;
  await page.route(pattern, async route => {
    requested = true;
    await pending;
    await route.continue();
  });
  return { release, started: () => expect.poll(() => requested).toBe(true) };
}

const splash = (page: Page) => page.getByRole('dialog', { name: 'ZLayer', exact: true });

test('keeps the workspace covered through lazy map code, navigation data, and the first map render', async ({ page }, testInfo) => {
  const errors: string[] = [];
  page.on('pageerror', error => errors.push(error.message));
  const code = await hold(page, /\/assets\/canvas-[^/]+\.js$/);
  const navigation = await hold(page, '**/nav/airports.geojson*');
  const tiles = await hold(page, '**/basemap.png');
  await page.goto('/', { waitUntil: 'domcontentloaded' });
  await code.started();
  await navigation.started();
  await expect(splash(page)).toBeVisible();
  await expect(page.locator('.app-shell')).toHaveAttribute('inert');
  await expect(page.getByLabel('Search FAA navigation data')).toBeDisabled();
  await expect(page.locator('.maplibregl-canvas')).toHaveCount(0);
  await page.screenshot({ path: testInfo.outputPath('startup-phone.png') });
  code.release();
  await tiles.started();
  await expect(page.locator('.maplibregl-canvas')).toHaveCount(1);
  expect(await page.locator('.map-canvas').evaluate(element => element.clientWidth > 0 && element.clientHeight > 0)).toBe(true);
  tiles.release();
  // This exceeds the minimum splash duration: readiness, not time alone, gates entry.
  await page.waitForTimeout(1200);
  await expect(splash(page)).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(splash(page)).toBeVisible();
  // Simulate initialization work still occupying the main thread after the
  // data arrives. A ready flag alone must not uncover these long frames.
  await page.evaluate(() => {
    const until = performance.now() + 1400;
    const work = () => {
      const end = performance.now() + 70;
      while (performance.now() < end) { /* Startup work. */ }
      if (performance.now() < until) requestAnimationFrame(work);
    };
    requestAnimationFrame(work);
  });
  navigation.release();
  await page.waitForTimeout(650);
  await expect(splash(page)).toBeVisible();
  await expect(splash(page)).toHaveCount(0);
  await expect(page.locator('.app-shell')).not.toHaveAttribute('inert');
  await expect(page.getByLabel('Search FAA navigation data')).toBeEnabled();
  await page.getByLabel('Search FAA navigation data').fill('KSBA');
  await page.locator('.search-results button').filter({ hasText: 'KSBA' }).click();
  await expect(page.locator('.feature-card')).toBeVisible();
  await expect(splash(page)).toHaveCount(0);
  await page.locator('.side-panels').evaluate(element => Promise.all(element.getAnimations().map(animation => animation.finished)));
  await page.screenshot({ path: testInfo.outputPath('workspace-phone.png') });
  expect(errors).toEqual([]);
});

test('waits for map tiles after core data is ready', async ({ page }) => {
  const tiles = await hold(page, '**/basemap.png');
  await page.goto('/', { waitUntil: 'domcontentloaded' });
  await tiles.started();
  await expect(page.locator('#startup-status')).toHaveText('Preparing your map…');
  await page.waitForTimeout(1200);
  await expect(splash(page)).toBeVisible();
  tiles.release();
  await expect(splash(page)).toHaveCount(0);
  await expect(page.locator('.app-shell')).toHaveAttribute('aria-busy', 'false');
});

test('optional navigation failures settle startup and leave the workspace usable', async ({ page }) => {
  await page.route('**/nav/airways.json*', route => route.fulfill({ status: 503, body: 'Unavailable' }));
  await page.route('**/nav/navaids.geojson*', route => route.fulfill({ status: 503, body: 'Unavailable' }));
  await page.goto('/');
  await expect(splash(page)).toHaveCount(0);
  await page.getByRole('button', { name: 'Settings and offline downloads', exact: true }).click();
  await expect(page.getByRole('dialog', { name: 'Settings', exact: true })).toBeVisible();
});

test('a stalled request offers an explicit way in and never covers the workspace again', async ({ page }) => {
  const navigation = await hold(page, '**/nav/airports.geojson*');
  await page.goto('/', { waitUntil: 'domcontentloaded' });
  await navigation.started();
  await expect(splash(page)).toBeVisible();
  const proceed = splash(page).getByRole('button', { name: 'Open workspace', exact: true });
  await expect(proceed).toBeVisible({ timeout: 15_000 });
  await proceed.click();
  await expect(splash(page)).toHaveCount(0);
  await expect(page.locator('.app-shell')).not.toHaveAttribute('inert');
  const loaded = page.waitForResponse('**/nav/airports.geojson*');
  navigation.release();
  await (await loaded).finished();
  await page.getByLabel('Search FAA navigation data').fill('KSBA');
  await expect(page.locator('.search-results button').filter({ hasText: 'KSBA' })).toBeVisible();
  await expect(splash(page)).toHaveCount(0);
});

test('restored dialogs initialize behind the splash and retain their order after startup', async ({ page }) => {
  await page.addInitScript(() => {
    for (const key of ['settings-open', 'about-open']) {
      localStorage.setItem(`zlayer-ui:${key}`, JSON.stringify({ version: 1, value: true }));
    }
  });
  const navigation = await hold(page, '**/nav/airports.geojson*');
  await page.goto('/', { waitUntil: 'domcontentloaded' });
  await navigation.started();
  await expect.poll(() => page.locator('.about-dialog').evaluate(dialog => dialog.matches(':modal'))).toBe(true);
  await expect(splash(page)).toBeVisible();
  await expect(splash(page).getByRole('heading', { name: 'ZLayer', exact: true })).toBeFocused();
  navigation.release();
  await expect(splash(page)).toHaveCount(0);
  const about = page.getByRole('dialog', { name: 'About ZLayer', exact: true });
  await expect(about).toBeVisible();
  await about.getByRole('button', { name: 'Close about dialog', exact: true }).click();
  await expect(page.getByRole('dialog', { name: 'Settings', exact: true })).toBeVisible();
});

test('WebGL initialization failure exposes recovery instead of leaving a loading screen', async ({ page }) => {
  await page.addInitScript(() => {
    const original = HTMLCanvasElement.prototype.getContext;
    Object.defineProperty(HTMLCanvasElement.prototype, 'getContext', { value: function (type: string, ...args: unknown[]) {
      if (type.includes('webgl')) return null;
      return Reflect.apply(original, this, [type, ...args]);
    } });
  });
  await page.goto('/');
  await expect(page.getByRole('alert')).toContainText('Map layer unavailable');
  await expect(splash(page)).toHaveCount(0);
  await page.getByRole('button', { name: 'Settings and offline downloads', exact: true }).click();
  await expect(page.getByRole('dialog', { name: 'Settings', exact: true })).toBeVisible();
});

test('a failed lazy map import exposes the map reload control', async ({ page }) => {
  await page.route(/\/assets\/canvas-[^/]+\.js$/, route => route.abort());
  await page.goto('/');
  await expect(page.getByRole('alert')).toContainText('Map unavailable');
  await expect(splash(page)).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Reload app', exact: true })).toBeVisible();
});
