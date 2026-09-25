import { test, expect } from '@playwright/test';
import { gridFixture } from '../fixtures/awc-grids';
import { WEATHER_NOW } from '../fixtures/awc-advisories';
import { inspectWeather } from './weather-inspection';
import { FORECAST_REQUESTS, RAW_WEATHER_REQUESTS } from './weather-requests';

test.beforeEach(async ({ request, context }) => {
  await request.post('/__test/reset');
  await context.route(RAW_WEATHER_REQUESTS, route => route.abort());
});

test('published wind pressure slices serve both windows, mask terrain and reopen offline', async ({ page, context, request }) => {
  await page.clock.install({ time: WEATHER_NOW });
  await page.goto('/test/browser/weather-native.html');
  const second = await context.newPage();
  await second.clock.install({ time: WEATHER_NOW });
  await second.goto('/test/browser/weather-native.html');
  const results = await Promise.all([page, second].map(tab => tab.evaluate(() => window.nativeWeather.load('winds', true, 850))));
  expect(results[0]).toEqual(results[1]); expect(results[0]!.frames).toBe(703);
  expect(results[0]!.values[0]).toBe(5940); expect(results[0]!.values[3]).toBe(10);
  expect(Math.hypot(results[0]!.values[1]!, results[0]!.values[2]!)).toBeCloseTo(Math.hypot(10, 5) * 1.94384, 0);
  expect((await (await request.get('/__test/awc-counts')).json()).gridFiles).toBe(1);
  const below = await page.evaluate(() => window.nativeWeather.load('winds', true, 1000));
  expect(below.values).toEqual([-9998, -9998, -9998, -9998]);
  expect((await (await request.get('/__test/awc-counts')).json()).gridFiles).toBe(2);
  await context.route(FORECAST_REQUESTS, route => route.abort());
  await page.reload();
  expect(await page.evaluate(() => window.nativeWeather.load('winds', false, 850))).toEqual(results[0]);
  const reopened = await (await request.get('/__test/awc-counts')).json();
  expect(reopened.gridFiles).toBe(2);
  expect(reopened.nativeFiles).toBe(0);
  await context.unroute(FORECAST_REQUESTS);
  await second.close();
});

test('native wind barbs load on demand, overlay clouds, retain bounded density and reuse visited frames offline', async ({ page, request }, testInfo) => {
  test.setTimeout(180_000);
  await page.clock.install({ time: WEATHER_NOW });
  await page.goto('/test/browser/weather-grids.html?native');
  await page.evaluate(() => window.weatherGridFixture.controller.change({ awcWindBarbs: true }));
  const state = () => page.evaluate(() => {
    const { controller, map } = window.weatherGridFixture, s = controller.getSnapshot();
    return { wind: s.windDisplay?.frame.validTime, cloud: s.gridDisplay?.data.frame.validTime,
      prepared: s.wind.preparation, error: s.wind.error ?? s.wind.preparation?.error ?? s.windRenderError,
      symbols: map.getSource('weather-awc-winds')?.serialize().data };
  });
  const now = WEATHER_NOW;
  await expect.poll(async () => (await state()).wind, { timeout: 100_000 }).toBe(now);
  await expect.poll(async () => (await state()).cloud, { timeout: 60_000 }).toBe(now);
  expect((await state()).prepared?.total).toBe(2);
  const symbols = () => page.evaluate(() => {
    const { map } = window.weatherGridFixture;
    const data = map.getSource('weather-awc-winds')?.serialize().data;
    return data && typeof data !== 'string' && data.type === 'FeatureCollection' ? data.features.map((f: { properties: Record<string, unknown> | null }) => f.properties) : [];
  });
  const first = await symbols();
  expect(first.length).toBeGreaterThan(30); expect(first.length).toBeLessThan(350);
  await page.getByRole('button', { name: 'Next weather time' }).click();
  await expect.poll(async () => (await state()).wind).toBe(now + 3600000);
  await expect.poll(async () => (await state()).cloud).toBe(now + 3600000);
  expect(await symbols()).not.toEqual(first);
  await page.waitForFunction(() => {
    const state = window.weatherGridFixture.controller.getSnapshot();
    return [state.grid.preparation, state.wind.preparation].every(p => p && p.ready === p.total);
  }, undefined, { timeout: 60_000 });
  const acquired = (await (await request.get('/__test/awc-counts')).json()).gridFiles;
  expect(acquired).toBeGreaterThan(0);
  for (const zoom of [6, 8, 11]) {
    await page.evaluate(zoom => window.weatherGridFixture.map.jumpTo({ zoom, bearing: zoom === 8 ? 65 : 0, pitch: zoom === 11 ? 45 : 0 }), zoom);
    await expect.poll(async () => (await symbols()).length).toBeGreaterThan(5);
    expect((await symbols()).length).toBeLessThan(350);
  }
  expect((await (await request.get('/__test/awc-counts')).json()).gridFiles).toBe(acquired);
  await page.evaluate(() => window.weatherGridFixture.map.jumpTo({ zoom: 7, bearing: 0, pitch: 0 }));
  await page.screenshot({ path: testInfo.outputPath('native-wind-barbs.png') });
  await page.route(FORECAST_REQUESTS, route => route.abort());
  await page.evaluate(() => {
    Object.defineProperty(navigator, 'onLine', { get: () => false }); window.dispatchEvent(new Event('offline'));
    window.weatherGridFixture.controller.change({ awcGridMode: 'temperature' });
  });
  await expect.poll(() => page.evaluate(() => window.weatherGridFixture.value())).toBe(-10);
  await page.getByRole('button', { name: 'Previous weather time' }).click();
  await expect.poll(async () => (await state()).wind).toBe(now);
  await expect.poll(() => page.evaluate(() => window.weatherGridFixture.value())).toBe(10);
  await page.evaluate(() => window.weatherGridFixture.controller.change({ awcWindBarbs: false }));
  await expect.poll(() => page.evaluate(() => !!window.weatherGridFixture.map.getLayer('weather-awc-wind-barbs'))).toBe(false);
  expect(await page.evaluate(() => window.weatherGridFixture.value())).toBe(10);
  expect((await (await request.get('/__test/awc-counts')).json()).gridFiles).toBe(acquired);
  expect(await page.evaluate(() => window.weatherGridFixture.errors)).toEqual([]);
});

test('two rows of core tabs keep independent overlays, MSL altitude and shared time', async ({ page, request }, testInfo) => {
  await request.post('/__test/awc-grids', { data: { products: [gridFixture('clouds'), gridFixture('icing'), gridFixture('winds')] } });
  await page.clock.install({ time: WEATHER_NOW });
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto('/');
  await expect(page.locator('.app-shell')).toHaveAttribute('aria-busy', 'false');
  await page.getByRole('button', { name: 'Show AWC Weather toolbox', exact: true }).click();
  await page.getByRole('switch', { name: 'Show AWC weather', exact: true }).click();
  for (const name of ['G-AIRMET', 'SIGMET', 'Convective SIGMET', 'CWA']) await page.getByRole('checkbox', { name, exact: true }).uncheck();
  const tabs = page.getByRole('tablist', { name: 'AWC weather products' });
  await expect(tabs.getByRole('tab')).toHaveCount(6);
  // Enlarged text stays reachable in the same two rows without horizontal overflow.
  await page.addStyleTag({ content: '.awc-product-tabs > button { font-size: 18px; }' });
  const tab = page.getByRole('tab', { name: 'Advisories', exact: true });
  await tab.focus(); await tab.press('End');
  await expect(page.getByRole('tab', { name: 'Winds', exact: true })).toBeFocused();
  expect(await tabs.evaluate(e => e.scrollWidth <= e.clientWidth)).toBe(true);
  expect(await tabs.getByRole('tab').evaluateAll(elements => new Set(elements.map(e => Math.round(e.getBoundingClientRect().top))).size)).toBe(2);
  await page.getByRole('switch', { name: 'Show winds', exact: true }).click();
  await expect(page.locator('.awc-grid-status')).toContainText('Valid Sep 22 · 21:00Z');
  const altitude = page.getByRole('slider', { name: 'Wind altitude', exact: true });
  await expect(altitude).toHaveAttribute('aria-valuetext', '5,000 feet MSL');
  await request.post('/__test/awc-grids', { data: { failure: true } });
  await altitude.focus(); await altitude.press('ArrowRight');
  await expect(altitude).toHaveAttribute('aria-valuetext', '5,500 feet MSL');
  await expect(page.getByRole('button', { name: 'Retry forecasts', exact: true })).toBeVisible();
  await expect(page.locator('.awc-grid-status')).toContainText('Forecast unavailable');
  await request.post('/__test/awc-grids', { data: { failure: false } });
  await page.getByRole('button', { name: 'Retry forecasts', exact: true }).click();
  await expect(page.locator('.awc-grid-status')).toContainText('Valid Sep 22 · 21:00Z');
  await page.getByRole('tab', { name: 'Cloud', exact: true }).click();
  await page.getByRole('combobox', { name: 'Forecast overlay', exact: true }).selectOption('cloudCover');
  await expect(page.locator('.awc-grid-status')).toContainText('Valid Sep 22 · 21:00Z');
  await page.getByRole('button', { name: 'Next weather time' }).click();
  await expect(page.locator('.awc-grid-status')).toContainText('Valid Sep 22 · 22:00Z');
  await inspectWeather(page);
  const pointForecast = page.getByRole('article', { name: 'Forecast at selected point' });
  await expect(pointForecast).toHaveCount(1);
  await expect(pointForecast).toContainText('Temperature aloft');
  await expect(pointForecast.locator('dl > div')
    .filter({ has: page.getByText('Wind altitude', { exact: true }) }).locator('dd > span')).toHaveText('5,500 ft MSL');
  await expect(pointForecast).toContainText(/\d{3}°M \/ 288°T · 31\.6 kt/);
  await expect(pointForecast).toContainText('Cloud coverage');
  await expect(pointForecast.getByText('Valid', { exact: true })).toHaveCount(1);
  await expect(pointForecast.getByText('Model run', { exact: true })).toHaveCount(1);
  await page.getByRole('button', { name: 'Hide AWC Weather toolbox', exact: true }).click();
  await pointForecast.getByRole('button', { name: 'Change wind altitude', exact: true }).click();
  await expect(page.getByRole('tab', { name: 'Winds', exact: true })).toHaveAttribute('aria-selected', 'true');
  await expect(altitude).toBeFocused();
  await altitude.click({ trial: true });
  await expect(altitude).toHaveAttribute('aria-valuetext', '5,500 feet MSL');
  await expect(pointForecast).toBeVisible();
  await expect(pointForecast).toContainText('Cloud coverage');
  await expect(page.getByRole('slider', { name: 'Weather forecast time' })).toHaveAttribute('aria-valuetext', 'Sep 22 · 22:00Z');
  await page.getByLabel('Close weather details', { exact: true }).click();
  await page.getByRole('tab', { name: 'Winds', exact: true }).click();
  await expect(page.getByRole('switch', { name: 'Show winds', exact: true })).toHaveAttribute('aria-checked', 'true');
  await expect(page.getByRole('slider', { name: 'Weather forecast time' })).toHaveAttribute('aria-valuetext', 'Sep 22 · 22:00Z');
  await page.getByRole('switch', { name: 'Show temperature', exact: true }).click();
  await expect(page.locator('.awc-grid-status')).toContainText('Valid Sep 22 · 22:00Z');
  await page.screenshot({ path: testInfo.outputPath('winds-toolbox-phone.png') });
  await page.reload();
  await expect(page.locator('.app-shell')).toHaveAttribute('aria-busy', 'false');
  await page.getByRole('tab', { name: 'Winds', exact: true }).click();
  await expect(page.getByRole('switch', { name: 'Show winds', exact: true })).toHaveAttribute('aria-checked', 'true');
  await expect(page.getByRole('switch', { name: 'Show temperature', exact: true })).toHaveAttribute('aria-checked', 'true');
  await expect(altitude).toHaveAttribute('aria-valuetext', '5,500 feet MSL');
});

test.describe('wind magnetic reference', () => {
  test.use({ serviceWorkers: 'block' });
  test('inspection recovers magnetic / true directions on reconnect and reuses variation offline', async ({ page, request }) => {
    let unavailable = true, modelRequests = 0;
    // This case blocks the service worker to exercise reference-cache fallback;
    // chart archive rendering requires that worker and is outside this check.
    await page.addInitScript(() => localStorage.setItem('zlayers-map-preferences-v1', JSON.stringify({ chartBase: '', ownshipEnabled: false })));
    await page.route('**/nav/magnetic-model.json*', async route => {
      modelRequests++;
      if (unavailable) await route.fulfill({ status: 503, body: 'Temporarily unavailable' });
      else await route.continue();
    });
    await request.post('/__test/awc-grids', { data: { products: [gridFixture('winds')] } });
    await page.clock.install({ time: WEATHER_NOW });
    await page.goto('/');
    await expect(page.locator('.app-shell')).toHaveAttribute('aria-busy', 'false');
    await page.getByRole('button', { name: 'Show AWC Weather toolbox', exact: true }).click();
    await page.getByRole('switch', { name: 'Show AWC weather', exact: true }).click();
    for (const name of ['G-AIRMET', 'SIGMET', 'Convective SIGMET', 'CWA']) await page.getByRole('checkbox', { name, exact: true }).uncheck();
    await page.getByRole('tab', { name: 'Winds', exact: true }).click();
    await page.getByRole('switch', { name: 'Show winds', exact: true }).click();
    await expect(page.locator('.awc-grid-status')).toContainText('Valid Sep 22 · 21:00Z');
    expect(modelRequests, 'opening wind overlays alone does not acquire variation').toBe(0);
    await inspectWeather(page);
    const details = page.getByRole('article', { name: 'Forecast at selected point' });
    await expect.poll(() => modelRequests).toBe(1);
    await expect(details).toContainText('— / 292°T · 26.9 kt');
    await expect(details).toContainText('Magnetic variation unavailable');
    unavailable = false;
    await page.evaluate(() => window.dispatchEvent(new Event('online')));
    await expect(details).toContainText(/\d{3}°M \/ 292°T · 26\.9 kt/);
    await expect(details).not.toContainText('Magnetic variation unavailable');
    expect(modelRequests).toBe(2);
    // A fresh page must use the shared durable reference cache, not this hook's state.
    await page.reload();
    await expect(page.locator('.app-shell')).toHaveAttribute('aria-busy', 'false');
    await page.route('**/chart-data/**', route => route.abort());
    await inspectWeather(page);
    await expect(details).toContainText(/\d{3}°M \/ 292°T · 26\.9 kt/);
    expect(modelRequests).toBe(2);
  });
});

test('returning to a visited wind altitude reopens its converted frame with the network unavailable', async ({ page, request }) => {
  await request.post('/__test/awc-grids', { data: { products: [gridFixture('clouds'), gridFixture('winds')] } });
  await page.clock.install({ time: WEATHER_NOW });
  await page.goto('/test/browser/weather-grids.html');
  await page.evaluate(() => window.weatherGridFixture.controller.change({ awcGridMode: 'none', awcWindBarbs: true }));
  const level = () => page.evaluate(() => window.weatherGridFixture.controller.getSnapshot().windDisplay?.frame.altitudeFtMsl);
  await expect.poll(level).toBe(5000);
  await page.evaluate(() => window.weatherGridFixture.controller.change({ awcWindAltitude: 10000 }));
  await expect.poll(level).toBe(10000);
  await page.route('**/api/weather/grids/**', route => route.abort());
  await page.evaluate(() => {
    Object.defineProperty(navigator, 'onLine', { get: () => false }); window.dispatchEvent(new Event('offline'));
    window.weatherGridFixture.controller.change({ awcWindAltitude: 5000 });
  });
  await expect.poll(level).toBe(5000);
  expect(await page.evaluate(() => window.weatherGridFixture.controller.getSnapshot().wind.preparation)).toBeUndefined();
  expect(await page.evaluate(() => window.weatherGridFixture.errors)).toEqual([]);
});

test('a failed wind update clears preceding graphics while retaining the saved catalog for recovery', async ({ page, request }) => {
  const original = gridFixture('winds'), replacement = gridFixture('winds', 2);
  await request.post('/__test/awc-grids', { data: { products: [gridFixture('clouds'), original] } });
  await page.clock.install({ time: WEATHER_NOW });
  await page.goto('/test/browser/weather-grids.html');
  await page.evaluate(() => window.weatherGridFixture.controller.change({ awcGridMode: 'temperature', awcWindBarbs: true }));
  const shown = () => page.evaluate(() => {
    const s = window.weatherGridFixture.controller.getSnapshot();
    return { wind: s.windDisplay?.manifest.generation, shade: s.gridDisplay?.data.manifest.generation,
      catalog: s.wind.products.winds.manifest?.generation, error: s.wind.error };
  });
  await expect.poll(shown).toEqual({ wind: original.manifest.generation, shade: original.manifest.generation, catalog: original.manifest.generation });
  await request.post('/__test/awc-grids', { data: { products: [replacement], corrupt: true } });
  await page.clock.fastForward(300_001);
  await expect.poll(async () => (await shown()).error).toMatch(/checksum/);
  expect((await shown()).wind).toBeUndefined();
  expect((await shown()).shade).toBeUndefined();
  expect((await shown()).catalog).toBe(original.manifest.generation);
  await request.post('/__test/awc-grids', { data: { corrupt: false } });
  await page.evaluate(() => window.weatherGridFixture.controller.retryForecasts());
  await expect.poll(shown).toEqual({ wind: replacement.manifest.generation, shade: replacement.manifest.generation, catalog: replacement.manifest.generation });
});
