import { expect, test, type Page } from '@playwright/test';
import { gridFixture } from '../fixtures/awc-grids';
import { WEATHER_NOW } from '../fixtures/awc-advisories';

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
const step = (page: Page, label: string) => splash(page).getByRole('listitem').filter({ has: page.getByText(label, { exact: true }) });

test('workspace discovery has indeterminate progress until plugin work is known', async ({ page }) => {
  const catalog = await hold(page, '**/chart-data/cycles.json');
  const tiles = await hold(page, '**/basemap.png');
  await page.goto('/', { waitUntil: 'domcontentloaded' });
  await catalog.started();
  await expect(splash(page).getByRole('progressbar')).not.toHaveAttribute('value');
  await expect(step(page, 'Workspace')).toContainText('Loading…');
  await expect(splash(page).getByRole('button', { name: 'Reload', exact: true })).toHaveCount(0);
  catalog.release();
  await tiles.started();
  await expect(splash(page).getByRole('progressbar')).toHaveAttribute('aria-valuetext', '2 of 3 steps finished');
  tiles.release();
  await expect(splash(page)).toHaveCount(0);
});

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
  await expect(step(page, 'Workspace')).toContainText('Ready');
  await expect(step(page, 'Navigation')).toContainText('Loading…');
  await expect(splash(page).getByRole('progressbar')).toHaveAttribute('aria-valuetext', '1 of 3 steps finished');
  await expect(step(page, 'Terrain')).toHaveCount(0);
  await expect(step(page, 'Routes')).toHaveCount(0);
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

test('waits for map tiles after core data is ready', async ({ page }, testInfo) => {
  const tiles = await hold(page, '**/basemap.png');
  await page.goto('/', { waitUntil: 'domcontentloaded' });
  await tiles.started();
  await expect(page.locator('#startup-status')).toHaveText('Preparing your map…');
  await expect(step(page, 'Navigation')).toContainText('Ready');
  await expect(step(page, 'Map')).toContainText('Loading…');
  await expect(splash(page).getByRole('progressbar')).toHaveAttribute('aria-valuetext', '2 of 3 steps finished');
  for (const [width, height] of [[320, 568], [568, 320], [1280, 900]] as const) {
    await page.setViewportSize({ width, height });
    expect(await splash(page).evaluate(element => element.scrollWidth <= element.clientWidth)).toBe(true);
    await expect(step(page, 'Map')).toBeInViewport();
    await page.screenshot({ path: testInfo.outputPath(`startup-${width}x${height}.png`) });
  }
  await page.waitForTimeout(1200);
  await expect(splash(page)).toBeVisible();
  tiles.release();
  await expect(splash(page)).toHaveCount(0);
  await expect(page.locator('.app-shell')).toHaveAttribute('aria-busy', 'false');
});

test('optional navigation failures settle startup and leave the workspace usable', async ({ page }) => {
  const tiles = await hold(page, '**/basemap.png');
  await page.route('**/nav/airways.json*', route => route.fulfill({ status: 503, body: 'Unavailable' }));
  await page.route('**/nav/navaids.geojson*', route => route.fulfill({ status: 503, body: 'Unavailable' }));
  await page.goto('/', { waitUntil: 'domcontentloaded' });
  await tiles.started();
  await expect(step(page, 'Navigation')).toContainText('Limited data');
  await expect(splash(page).getByRole('progressbar')).toHaveAttribute('aria-valuetext', '2 of 3 steps finished');
  tiles.release();
  await expect(splash(page)).toHaveCount(0);
  await page.getByRole('button', { name: 'Settings and offline downloads', exact: true }).click();
  await expect(page.getByRole('dialog', { name: 'Settings', exact: true })).toBeVisible();
});

test('a stalled request offers an explicit way in and never covers the workspace again', async ({ page }, testInfo) => {
  const now = Date.now();
  await page.clock.install({ time: now });
  await page.clock.pauseAt(now + 1000);
  const navigation = await hold(page, '**/nav/airports.geojson*');
  await page.goto('/', { waitUntil: 'domcontentloaded' });
  await navigation.started();
  await expect(splash(page)).toBeVisible();
  const proceed = splash(page).getByRole('button', { name: 'Open workspace', exact: true });
  await page.clock.fastForward(14_000);
  await expect(proceed).toHaveCount(0);
  await page.clock.fastForward(1000);
  await expect(proceed).toBeVisible();
  await page.setViewportSize({ width: 568, height: 320 });
  await proceed.scrollIntoViewIfNeeded();
  await expect(proceed).toBeInViewport();
  expect(await splash(page).evaluate(element => element.scrollWidth <= element.clientWidth)).toBe(true);
  await page.screenshot({ path: testInfo.outputPath('startup-slow-landscape.png') });
  await proceed.click();
  await page.clock.resume();
  await expect(splash(page)).toHaveCount(0);
  await expect(page.locator('.app-shell')).not.toHaveAttribute('inert');
  const loaded = page.waitForResponse('**/nav/airports.geojson*');
  navigation.release();
  await (await loaded).finished();
  await page.getByLabel('Search FAA navigation data').fill('KSBA');
  await expect(page.locator('.search-results button').filter({ hasText: 'KSBA' })).toBeVisible();
  await expect(splash(page)).toHaveCount(0);
});

test('disabled plugins do not appear as startup work', async ({ page }) => {
  await page.addInitScript(() => localStorage.setItem('zlayer-ui:plugins-unloaded', JSON.stringify({ version: 1,
    value: ['charts', 'terrain', 'plates', 'obstructions', 'navigation', 'metar', 'routes', 'ruler', 'ownship', 'ahrs'] })));
  const tiles = await hold(page, '**/basemap.png');
  await page.goto('/', { waitUntil: 'domcontentloaded' });
  await tiles.started();
  await expect(splash(page).getByRole('listitem')).toHaveCount(2);
  await expect(splash(page).getByRole('progressbar')).toHaveAttribute('aria-valuetext', '1 of 2 steps finished');
  await expect(step(page, 'Navigation')).toHaveCount(0);
  tiles.release();
  await expect(splash(page)).toHaveCount(0);
});

test('restored weather UI is usable while METAR and TAF responses are pending', async ({ page }) => {
  await page.addInitScript(() => {
    localStorage.setItem('zlayer-ui:selected-feature', JSON.stringify({ version: 1, value: {
      type: 'Feature', id: 'airport:KSBA', geometry: { type: 'Point', coordinates: [-119.84, 34.43] },
      properties: { ident: 'KSBA', icaoId: 'KSBA', faaId: 'SBA', kind: 'landing-facility',
        name: 'KSBA TEST AIRPORT', state: 'CA', facilityType: 'AIRPORT', use: 'PUBLIC' },
    } }));
  });
  const metar = await hold(page, '**/api/weather/metars.geojson?*');
  const taf = await hold(page, '**/api/weather/tafs.json?*');
  const tiles = await hold(page, '**/basemap.png');
  await page.goto('/', { waitUntil: 'domcontentloaded' });
  await metar.started();
  await taf.started();
  await expect(splash(page)).toBeVisible();
  await expect(step(page, 'METAR/TAF')).toContainText('Loading…');
  await expect(step(page, 'METAR/TAF')).toContainText('In background');
  tiles.release();
  await expect(splash(page)).toHaveCount(0);
  await expect(page.locator('.app-shell')).toHaveAttribute('aria-busy', 'false');
  const observation = page.getByRole('region', { name: 'METAR', exact: true });
  const forecast = page.getByRole('region', { name: 'TAF', exact: true });
  await expect(observation).toHaveAttribute('aria-busy', 'true');
  await expect(forecast).toHaveAttribute('aria-busy', 'true');
  await page.getByLabel('Settings and offline downloads').click();
  await expect(page.getByRole('dialog', { name: 'Settings', exact: true })).toBeVisible();
  await page.getByLabel('Close settings').click();
  metar.release();
  taf.release();
  await expect(observation).toHaveAttribute('aria-busy', 'false');
  await expect(forecast).toHaveAttribute('aria-busy', 'false');
  await expect(splash(page)).toHaveCount(0);
});

test('AWC preparation is listed under its plugin name and does not hold the usable workspace', async ({ page, request }, testInfo) => {
  await page.clock.install({ time: WEATHER_NOW });
  await request.post('/__test/reset');
  await request.post('/__test/awc-grids', { data: { products: [gridFixture('clouds')] } });
  await page.addInitScript(() => {
    localStorage.setItem('zlayer-plugin:weather-awc:preferences', JSON.stringify({ version: 2, awcEnabled: true,
      awcGridMode: 'cloudCover', awcGairmet: false, awcSigmet: false, awcConvective: false, awcCwa: false }));
    localStorage.setItem('zlayer-plugin:terrain:preferences', JSON.stringify({ version: 2, terrainEnabled: true, terrainCoverage: 'route' }));
  });
  const frame = await hold(page, '**/f4-all.zwg.gz');
  const tiles = await hold(page, '**/basemap.png');
  await page.goto('/', { waitUntil: 'domcontentloaded' });
  await frame.started();
  await expect(step(page, 'AWC Weather')).toContainText('Preparing forecasts · 2/3');
  await expect(step(page, 'AWC Weather')).toContainText('In background');
  await expect(step(page, 'Terrain')).toHaveCount(0);
  await expect(splash(page)).not.toContainText('Not needed');
  await page.screenshot({ path: testInfo.outputPath('startup-weather.png') });
  tiles.release();
  await expect(splash(page)).toHaveCount(0);
  await expect(page.locator('.app-shell')).toHaveAttribute('aria-busy', 'false');
  await page.getByRole('button', { name: 'Show AWC Weather toolbox', exact: true }).click();
  await expect(page.getByRole('progressbar', { name: 'Forecast preparation' })).toBeVisible();
  frame.release();
  await expect(page.getByRole('progressbar', { name: 'Forecast preparation' })).toHaveCount(0);
});

test('finishing stays steady while background weather completes and redraws the map', async ({ page, request }) => {
  await page.clock.install({ time: WEATHER_NOW });
  await request.post('/__test/reset');
  await request.post('/__test/awc-grids', { data: { products: [gridFixture('clouds')] } });
  const frame = await hold(page, '**/f4-all.zwg.gz');
  await page.exposeFunction('finishStartupWeather', frame.release);
  await page.addInitScript(() => {
    localStorage.setItem('zlayer-plugin:weather-awc:preferences', JSON.stringify({ version: 2, awcEnabled: true,
      awcGridMode: 'cloudCover', awcGairmet: false, awcSigmet: false, awcConvective: false, awcCwa: false }));
    const changes: { status: string; progress: number; total: number; weather: string }[] = [];
    Object.assign(window, { startupChanges: changes });
    new MutationObserver(() => {
      const status = document.querySelector('#startup-status')?.textContent ?? 'closed';
      const bar = document.querySelector<HTMLProgressElement>('[aria-label="Startup progress"]');
      const weather = [...document.querySelectorAll('.startup-step')].find(row => row.textContent?.includes('AWC Weather'))?.textContent ?? '';
      const change = { status, progress: bar?.value ?? 0, total: bar?.max ?? 0, weather };
      if (JSON.stringify(change) === JSON.stringify(changes.at(-1))) return;
      changes.push(change);
      // React to the first finishing frame, which may be shorter than a locator's
      // polling interval. The weather response and redraw then occur during settling.
      if (status === 'Finishing up…') void (window as unknown as { finishStartupWeather(): Promise<void> }).finishStartupWeather();
    }).observe(document, { subtree: true, childList: true, characterData: true, attributes: true, attributeFilter: ['value', 'max'] });
  });
  await page.goto('/');
  await expect(page.locator('.app-shell')).toHaveAttribute('aria-busy', 'false');
  const changes = await page.evaluate(() => (window as unknown as { startupChanges: {
    status: string; progress: number; total: number; weather: string;
  }[] }).startupChanges);
  const finishing = changes.findIndex(change => change.status === 'Finishing up…');
  expect(finishing).toBeGreaterThan(-1);
  const finalChanges = changes.slice(finishing).filter(change => change.status !== 'closed');
  expect(finalChanges.length).toBeGreaterThan(1);
  expect(finalChanges.every(change => change.status === 'Finishing up…' && change.progress === change.total)).toBe(true);
  expect(new Set(finalChanges.map(change => change.weather)).size).toBeGreaterThan(1);
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
