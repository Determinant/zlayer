import { test, expect, type Page } from '@playwright/test';
import type { ImageSource } from 'maplibre-gl';
import { gridFixture } from '../fixtures/awc-grids';
import { WEATHER_NOW, advisorySource } from '../fixtures/awc-advisories';
import { formatTimestamp } from '../../src/core/format/time';
import { inspectWeather, openWeatherMenu, weatherMapPoint } from './weather-inspection';
import { gridValueLabel } from '../../src/layers/weather-awc/grids/presentation';
import { RAW_WEATHER_REQUESTS } from './weather-requests';

test.beforeEach(async ({ request, context }) => {
  await request.post('/__test/reset');
  await context.route(RAW_WEATHER_REQUESTS, route => route.abort());
  await request.post('/__test/awc-grids', { data: { products: [gridFixture('clouds'), gridFixture('icing')] } });
  await request.post('/__test/awc', { data: { gairmet: [0, 3, 6, 9, 12].map(hour => advisorySource('gairmet', hour)),
    sigmet: advisorySource('sigmet'), cwa: advisorySource('cwa') } });
});
async function selectTab(page: Page, name: 'Cloud' | 'Icing' | 'Advisories') {
  await page.getByRole('tab', { name, exact: true }).click();
}
async function enable(page: Page, mode = 'cloudCover', waitForDisplay = true) {
  await page.clock.install({ time: WEATHER_NOW });
  await page.goto('/');
  await expect(page.locator('.app-shell')).toHaveAttribute('aria-busy', 'false');
  await page.getByRole('button', { name: 'Show AWC Weather toolbox', exact: true }).click();
  await page.getByRole('switch', { name: 'Show AWC weather', exact: true }).click();
  for (const name of ['G-AIRMET', 'SIGMET', 'Convective SIGMET', 'CWA']) await page.getByRole('checkbox', { name, exact: true }).uncheck();
  await selectTab(page, mode.startsWith('cloud') ? 'Cloud' : 'Icing');
  await page.getByRole('combobox', { name: 'Forecast overlay', exact: true }).selectOption(mode);
  if (waitForDisplay) await expect(page.locator('.awc-grid-status')).toContainText('Valid Sep 22 · 21:00Z', { timeout: 30_000 });
}
async function inspect(page: Page) {
  // Field switches and WebGL restoration finish drawing after the data arrives.
  // An unfinished time selection has no numeric inspection.
  await expect(page.locator('.awc-grid-status')).toContainText('Valid ');
  await inspectWeather(page);
  return page.getByRole('article', { name: 'Forecast at selected point' });
}

for (const touch of [false, true]) test.describe(touch ? 'touch inspection' : 'mouse inspection', () => {
  test.use({ hasTouch: touch });
  test('weather inspection works with an open or stowed toolbox through an explicit context-menu action', async ({ page }) => {
    await enable(page);
    const details = page.getByRole('region', { name: 'Weather advisory details' });
    const point = await weatherMapPoint(page);
    if (touch) await page.touchscreen.tap(point.x, point.y);
    else await page.mouse.click(point.x, point.y);
    await expect(details).toHaveCount(0);
    let menu = await openWeatherMenu(page, touch);
    await expect(details).toHaveCount(0); // Opening/releasing the long press does not select an action.
    await expect(menu.getByRole('menuitem')).toHaveCount(2); // Weather and the coordinate waypoint.
    await menu.getByRole('menuitem', { name: 'Inspect weather', exact: true }).click();
    await expect(details).toBeVisible();
    await page.getByRole('button', { name: 'Hide Weather advisory details', exact: true }).click();
    await expect(details).toBeHidden();
    await page.clock.fastForward(15_000);
    await expect(details).toBeHidden();
    menu = await openWeatherMenu(page, touch);
    await menu.getByRole('menuitem', { name: 'Inspect weather', exact: true }).click();
    await expect(details).toBeVisible();
    await page.getByLabel('Close weather details', { exact: true }).click();
    await expect(details).toHaveCount(0);
    await page.getByRole('button', { name: 'Hide AWC Weather toolbox', exact: true }).click();
    menu = await openWeatherMenu(page, touch);
    await expect(details).toHaveCount(0);
    await menu.getByRole('menuitem', { name: 'Inspect weather', exact: true }).click();
    await expect(details).toBeVisible();
    await expect(page.getByRole('button', { name: 'Show AWC Weather toolbox', exact: true })).toBeVisible();
    await page.getByLabel('Close weather details', { exact: true }).click();
    await page.getByRole('button', { name: 'Show AWC Weather toolbox', exact: true }).click();
    await page.getByRole('switch', { name: 'Show AWC weather', exact: true }).click();
    await page.mouse.click(point.x, point.y, { button: 'right' });
    await expect(page.getByRole('menuitem', { name: 'Inspect weather', exact: true })).toHaveCount(0);
  });
});

test('forecast dropdowns preserve open inspection and respect stowed or closed details', async ({ page, request }) => {
  await enable(page);
  const forecast = await inspect(page);
  const details = page.getByRole('region', { name: 'Weather advisory details' });
  const coordinates = await forecast.locator('.awc-advisory-hazard').textContent();
  const overlay = page.getByRole('combobox', { name: 'Forecast overlay', exact: true });
  for (const mode of ['cloudBase', 'cloudTop', 'cloudCover']) {
    await overlay.selectOption(mode);
    await expect(details).toBeVisible();
    await expect(forecast).toContainText('75%');
    await expect(forecast.locator('.awc-advisory-hazard')).toHaveText(coordinates!);
  }

  await request.post('/__test/awc-grids', { data: { holdFrame: 'runs/icing-synthetic-1/f1-8000.zwg.gz' } });
  await selectTab(page, 'Icing');
  try {
    await overlay.selectOption('icingProbability');
    await expect(page.locator('.awc-grid-status')).toContainText('Loading forecast');
    await expect(details).toBeVisible();
    await expect(details).toContainText('Forecast unavailable for this selection.');
    await expect(forecast).toHaveCount(0);
  } finally { await request.post('/__test/awc-grids', { data: { releaseFrame: true } }); }
  await expect(forecast).toContainText('71%');
  for (const mode of ['icingSeverity', 'sldPotential', 'freezingLowest', 'freezingHighest']) {
    await overlay.selectOption(mode);
    await expect(details).toBeVisible();
    await expect(forecast).toContainText(mode.startsWith('freezing') ? '12,000 ft MSL' : 'Moderate');
    await expect(forecast.locator('.awc-advisory-hazard')).toHaveText(coordinates!);
  }

  await page.getByRole('button', { name: 'Hide Weather advisory details', exact: true }).click();
  await expect(details).toBeHidden();
  await overlay.selectOption('icingProbability');
  await expect(page.locator('.awc-grid-status')).toContainText('Valid ');
  await expect(details).toBeHidden();
  await page.getByRole('button', { name: 'Show Weather advisory details', exact: true }).click();
  await expect(details).toBeVisible();
  await expect(forecast).toContainText('71%');
  await expect(forecast.locator('.awc-advisory-hazard')).toHaveText(coordinates!);

  await page.getByLabel('Close weather details', { exact: true }).click();
  await expect(details).toHaveCount(0);
  await selectTab(page, 'Cloud');
  await overlay.selectOption('cloudCover');
  await expect(page.locator('.awc-grid-status')).toContainText('Valid ');
  await expect(details).toHaveCount(0);
  await inspect(page);
  await page.getByRole('switch', { name: 'Show AWC weather', exact: true }).click();
  await expect(details).toHaveCount(0);
});

test('one timeline preserves time across tabs and retains a pinned selection when the new field lacks coverage', async ({ page, request }, testInfo) => {
  const icing = gridFixture('icing');
  icing.manifest.frames = icing.manifest.frames.filter(frame => frame.validTime !== WEATHER_NOW + 3600000 || frame.altitudeFtMsl !== 8000);
  await request.post('/__test/awc-grids', { data: { products: [icing] } });
  await enable(page);
  await selectTab(page, 'Advisories');
  await page.getByRole('checkbox', { name: 'G-AIRMET', exact: true }).check();
  await expect(page.locator('.awc-timeline .awc-time-mark').last()).toHaveAttribute('title', 'Sep 23 · 09:00Z');
  const timeline = page.getByRole('region', { name: 'Weather timeline' });
  const slider = page.getByRole('slider', { name: 'Weather forecast time' });
  const tabs = page.getByRole('tablist', { name: 'AWC weather products' });
  const timeBox = (await timeline.boundingBox())!, tabsBox = (await tabs.boundingBox())!;
  expect(timeBox.y + timeBox.height).toBeLessThanOrEqual(tabsBox.y);
  await slider.focus(); await slider.press('Home'); await slider.press('ArrowRight');
  const selected = 'Sep 22 · 22:00Z';
  await expect(slider).toHaveAttribute('aria-valuetext', selected);
  const stops = await timeline.locator('.awc-time-mark').evaluateAll(elements => elements.map(element => element.getAttribute('title')));
  const unchanged = async (sameStops = true) => {
    await expect(page.getByRole('region', { name: 'Weather timeline' })).toHaveCount(1);
    await expect(slider).toHaveAttribute('aria-valuetext', selected);
    if (sameStops) expect(await timeline.locator('.awc-time-mark').evaluateAll(elements => elements.map(element => element.getAttribute('title')))).toEqual(stops);
  };
  const overlay = page.getByRole('combobox', { name: 'Forecast overlay', exact: true });
  for (const tab of ['Cloud', 'Icing', 'Advisories', 'Icing'] as const) {
    await selectTab(page, tab); await unchanged();
  }
  await overlay.selectOption('icingSeverity');
  await expect(page.locator('.awc-grid-status')).toContainText('No forecast available for this time / altitude');
  await unchanged(false);
  await expect(timeline.locator(`.awc-time-mark[title="${selected}"]`)).toHaveCount(0);
  await page.getByRole('slider', { name: 'Icing altitude', exact: true }).press('End');
  await expect(page.locator('.awc-grid-status')).toContainText(`Valid ${selected}`);
  await unchanged();
  await overlay.selectOption('none'); await unchanged(false);
  await expect(timeline.locator(`.awc-time-mark[title="${selected}"]`)).toHaveCount(0);
  await selectTab(page, 'Cloud');
  await overlay.selectOption('cloudTop');
  await expect(page.locator('.awc-grid-status')).toContainText(`Valid ${selected}`);
  await unchanged();
  await page.locator('.map-edge-awc .edge-panel-body').evaluate(element => { element.scrollTop = 0; });
  await page.screenshot({ animations: 'disabled', path: testInfo.outputPath('shared-weather-timeline.png') });
  await slider.press('End');
  await expect(slider).toHaveAttribute('aria-valuetext', 'Sep 23 · 09:00Z');
  await expect(page.locator('.awc-grid-status')).toContainText('No forecast available for this time / altitude');
  await selectTab(page, 'Advisories');
  await expect(page.getByRole('tabpanel', { name: 'Advisories', exact: true }).locator('.awc-frame-time')).toHaveText('G-AIRMET: Sep 23 · 09:00Z');
  await page.setViewportSize({ width: 320, height: 568 });
  await page.locator('.map-edge-awc .edge-panel-body').evaluate(element => { element.scrollTop = 0; });
  await expect(timeline).toBeInViewport(); await expect(tabs).toBeInViewport();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await page.screenshot({ animations: 'disabled', path: testInfo.outputPath('shared-weather-timeline-phone.png') });
});

test('combined timeline keeps each layer on its own frame at irregular advisory boundaries', async ({ page, request }, testInfo) => {
  const cwa = advisorySource('cwa');
  cwa.features[0]!.properties.validTimeFrom = new Date(WEATHER_NOW + 17 * 60_000).toISOString();
  cwa.features[0]!.properties.validTimeTo = new Date(WEATHER_NOW + 42 * 60_000).toISOString();
  await request.post('/__test/awc', { data: { cwa, sigmet: advisorySource('sigmet'),
    gairmet: [0, 3, 6, 9, 12].map(hour => advisorySource('gairmet', hour)) } });
  await enable(page);
  await selectTab(page, 'Advisories');
  for (const name of ['G-AIRMET', 'CWA']) await page.getByRole('checkbox', { name, exact: true }).check();
  const marks = () => page.locator('.awc-timeline .awc-time-mark').evaluateAll(elements => elements.map(e => e.getAttribute('title')));
  await expect.poll(marks).toContain('Sep 22 · 21:17Z');
  await expect.poll(marks).toContain('Sep 22 · 21:42Z');
  const mark = (title: string) => page.locator(`.awc-timeline .awc-time-mark[title="${title}"]`);
  const products = (title: string) => mark(title).locator('[data-time-product]').evaluateAll(elements => elements.map(e => e.getAttribute('data-time-product')));
  expect(await products('Sep 22 · 21:17Z')).toEqual(['cwa']);
  expect(await products('Sep 22 · 22:00Z')).toEqual(['clouds']);
  expect(await products('Sep 23 · 00:00Z')).toEqual(['gairmet', 'clouds']);
  // Every tick is an actual data boundary. No evenly sampled filler times.
  const catalog = await page.evaluate(() => JSON.parse(localStorage.getItem('zlayer-plugin:weather-awc:grid-clouds')!).manifest);
  const expected = [...new Set<number>([
    ...catalog.frames.map((frame: { validTime: number }) => frame.validTime),
    ...[0, 3, 6, 9, 12].map(hour => WEATHER_NOW + hour * 3600000),
    WEATHER_NOW + 17 * 60_000, WEATHER_NOW + 42 * 60_000,
  ])].filter(time => time > WEATHER_NOW).sort((a, b) => a - b);
  expect(await marks()).toEqual(['Now', ...expected.map(time => formatTimestamp(time))]);
  const left = (title: string) => mark(title).evaluate(element => Number.parseFloat((element as HTMLElement).style.left));
  expect((await left('Sep 22 · 21:17Z')) / (await left('Sep 22 · 22:00Z'))).toBeCloseTo(17 / 60);
  const colors = await mark('Sep 23 · 00:00Z').locator('[data-time-product]').evaluateAll(elements => elements.map(e => getComputedStyle(e).backgroundColor));
  expect(new Set(colors).size).toBe(2);
  await selectTab(page, 'Cloud');
  await expect(page.locator('.awc-grid-status')).toContainText('Forecasts saved', { timeout: 30_000 });
  const acquired = await (await request.get('/__test/awc-counts')).json();
  const slider = page.getByRole('slider', { name: 'Weather forecast time' });
  for (const [minute, visible] of [[17, true], [42, false]] as const) {
    await page.getByRole('button', { name: 'Next weather time' }).click();
    await expect(slider).toHaveAttribute('aria-valuetext', `Sep 22 · 21:${minute}Z`);
    await expect(page.locator('.awc-grid-status')).toContainText('Valid Sep 22 · 21:00Z');
    const point = await inspect(page);
    await expect(point).toContainText('Sep 22 · 21:00Z');
    await expect(page.getByRole('article', { name: 'CWA 101', exact: true })).toHaveCount(visible ? 1 : 0);
    await expect(page.getByRole('article', { name: 'G-AIRMET ICE-0', exact: true })).toContainText('Snapshot Sep 22 · 21:00Z');
    await page.getByLabel('Close weather details').click();
    const after = await (await request.get('/__test/awc-counts')).json();
    expect(after.gridFiles).toBe(acquired.gridFiles);
    expect(after.nativeFiles).toBe(acquired.nativeFiles);
  }
  await page.getByRole('button', { name: 'Next weather time' }).click();
  await expect(slider).toHaveAttribute('aria-valuetext', 'Sep 22 · 22:00Z');
  await expect(page.locator('.awc-grid-status')).toContainText('Valid Sep 22 · 22:00Z');
  await selectTab(page, 'Advisories');
  await expect(page.locator('.awc-toolbox .awc-frame-time').first()).toHaveText('G-AIRMET: Sep 22 · 21:00Z');
  await page.setViewportSize({ width: 320, height: 568 });
  const labels = await page.locator('.awc-timeline .awc-time-mark > span').evaluateAll(elements => elements.map(element => {
    const box = element.getBoundingClientRect(); return { left: box.left, right: box.right };
  }));
  for (let i = 1; i < labels.length; i++) expect(labels[i]!.left).toBeGreaterThan(labels[i - 1]!.right);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await page.screenshot({ animations: 'disabled', path: testInfo.outputPath('combined-timeline-phone.png') });
});

test('full toolbox steps only displayed forecasts through their entire horizon with advisories enabled', async ({ page, request }) => {
  test.setTimeout(120_000);
  await page.clock.install({ time: WEATHER_NOW + 40 * 60_000 });
  await page.goto('/');
  await expect(page.locator('.app-shell')).toHaveAttribute('aria-busy', 'false');
  await page.getByRole('button', { name: 'Show AWC Weather toolbox', exact: true }).click();
  await page.getByRole('switch', { name: 'Show AWC weather', exact: true }).click();
  const timeline = page.getByRole('region', { name: 'Weather timeline' });
  const slider = page.getByRole('slider', { name: 'Weather forecast time' });
  const next = page.getByRole('button', { name: 'Next weather time' });
  const marks = () => timeline.locator('.awc-time-mark').evaluateAll(elements => elements.map(element => element.getAttribute('title')));
  const advisoryTimes = [2, 3, 6, 9, 12].map(hour => WEATHER_NOW + hour * 3600000);
  // The actual app used to insert inactive clouds/icing hours here, making Next
  // change the heading while leaving every advisory on the same snapshot.
  await expect.poll(marks).toEqual(['Now', ...advisoryTimes.map(time => formatTimestamp(time))]);
  await next.click();
  await expect(slider).toHaveAttribute('aria-valuetext', formatTimestamp(advisoryTimes[0]!));
  await expect(page.locator('.awc-toolbox .awc-frame-time').first()).toContainText(formatTimestamp(WEATHER_NOW));
  for (const [tab, mode, product] of [['Cloud', 'cloudCover', 'clouds'], ['Icing', 'icingSeverity', 'icing']] as const) {
    await page.getByRole('button', { name: 'Now', exact: true }).click();
    await selectTab(page, tab);
    await page.getByRole('combobox', { name: 'Forecast overlay', exact: true }).selectOption(mode);
    if (product === 'icing') {
      const sldOverlay = page.getByRole('switch', { name: 'SLD potential overlay', exact: true });
      await expect(sldOverlay).toBeChecked();
      await sldOverlay.click();
      await expect(sldOverlay).not.toBeChecked();
    }
    await expect.poll(() => page.evaluate(product =>
      !!localStorage.getItem(`zlayer-plugin:weather-awc:grid-${product}`), product)).toBe(true);
    const catalog = await page.evaluate(product => JSON.parse(localStorage.getItem(`zlayer-plugin:weather-awc:grid-${product}`)!).manifest as {
      encoding?: string; runTime: number; frames: { validTime: number; altitudeFtMsl: number | null }[];
    }, product);
    const available = catalog.frames.filter(frame => product === 'clouds' || frame.altitudeFtMsl === 8000).map(frame => frame.validTime);
    const times = [...new Set([...available.filter(time => time > WEATHER_NOW), ...advisoryTimes])].sort((a, b) => a - b);
    await expect.poll(marks).toEqual(['Now', ...times.map(time => formatTimestamp(time))]);
    const status = page.locator('.awc-grid-status');
    await expect(status).toContainText(`Valid ${formatTimestamp(WEATHER_NOW)}`, { timeout: 30_000 });
    const map = (await page.locator('.maplibregl-canvas').boundingBox())!;
    const crop = () => page.screenshot({ clip: { x: map.x + map.width / 2 - 20, y: map.y + map.height / 2 - 20, width: 40, height: 40 } });
    let previousPixels = await crop();
    for (const time of times) {
      await next.click();
      await expect(slider).toHaveAttribute('aria-valuetext', formatTimestamp(time));
      if (!available.includes(time)) {
        await expect(status).toContainText('No forecast available for this time / altitude');
        continue;
      }
      await expect(status).toContainText(`Valid ${formatTimestamp(time)}`);
      await expect(status).not.toContainText('Loading');
      const details = await inspect(page);
      await expect(details.locator('dl > div').filter({ has: page.getByText('Valid', { exact: true }) }).locator('dd')).toHaveText(formatTimestamp(time));
      if (catalog.encoding === 'grib2') {
        const phase = ((time - catalog.runTime) / 3600000 - 1) % 5;
        const value = (product === 'clouds' ? [75, 0, 25, 50, 10] : [3, 0, 4, 1, 2])[phase]!;
        const label = product === 'clouds' ? 'Cloud coverage' : 'Icing severity';
        await expect(details.locator('dl > div').filter({ has: page.getByText(label, { exact: true }) }).locator('dd')).toHaveText(gridValueLabel(mode, value));
        await expect.poll(async () => (await crop()).equals(previousPixels), { message: `rendered ${mode} must change at ${formatTimestamp(time)}` }).toBe(false);
        previousPixels = await crop();
      }
      await page.getByLabel('Close weather details').click();
    }
    await expect(next).toBeDisabled();
    const acquired = await (await request.get('/__test/awc-counts')).json();
    // Walk back through warmed middle frames using the same shared UI.
    for (const time of times.slice(-4, -1).reverse()) {
      await page.getByRole('button', { name: 'Previous weather time' }).click();
      await expect(slider).toHaveAttribute('aria-valuetext', formatTimestamp(time));
      if (available.includes(time)) await expect(status).toContainText(`Valid ${formatTimestamp(time)}`);
    }
    const after = await (await request.get('/__test/awc-counts')).json();
    expect(after.nativeFiles).toBe(acquired.nativeFiles);
    expect(after.gridFiles).toBe(acquired.gridFiles);
  }
});

test('forecast pixels remain visible through zoom, pan and resize without fetching another forecast', async ({ page, request }) => {
  await page.clock.install({ time: WEATHER_NOW });
  await page.goto('/test/browser/weather-grids.html');
  await expect.poll(() => page.evaluate(() => {
    const pixel = window.weatherGridFixture?.pixel(); return pixel ? pixel[2]! - pixel[0]! : 0;
  })).toBeGreaterThan(40);
  await page.waitForFunction(() => {
    const p = window.weatherGridFixture.controller.getSnapshot().grid.preparation; return p && p.ready === p.total;
  });
  const requests = (await (await request.get('/__test/awc-counts')).json()).grids;
  await page.evaluate(() => { window.weatherGridFixture.recording = true; });
  const coordinates = () => page.evaluate(() => JSON.stringify((window.weatherGridFixture.map.getSource('weather-awc-grid') as ImageSource).coordinates));
  for (const move of ['in', 'out', 'pan', 'resize'] as const) {
    const previous = await coordinates();
    if (move === 'resize') await page.setViewportSize({ width: 960, height: 640 });
    else await page.evaluate(move => new Promise<void>(resolve => {
      const { map } = window.weatherGridFixture;
      map.once('moveend', () => resolve());
      if (move === 'pan') map.panBy([40, 15], { duration: 180 });
      else map.easeTo({ zoom: map.getZoom() + (move === 'in' ? 1 : -1), duration: 180 });
    }), move);
    expect(await coordinates()).toBe(previous); // Full-domain unhatched imagery needs no camera redraw.
    await page.evaluate(() => new Promise<void>(resolve => {
      const { map } = window.weatherGridFixture; map.once('render', () => resolve()); map.triggerRepaint();
    }));
  }
  const result = await page.evaluate(() => {
    const fixture = window.weatherGridFixture; fixture.recording = false;
    return { samples: fixture.samples, errors: fixture.errors };
  });
  expect(result.samples.length).toBeGreaterThan(8);
  expect(result.samples.every(pixel => pixel[2]! - pixel[0]! > 40)).toBe(true);
  expect(result.errors).toEqual([]);
  expect((await (await request.get('/__test/awc-counts')).json()).grids).toBe(requests);
});

test('time changes clear the preceding forecast while a newer request replaces a delayed one', async ({ page, request }) => {
  await page.clock.install({ time: WEATHER_NOW });
  await page.goto('/test/browser/weather-grids.html');
  const displayedTime = () => page.evaluate(() => window.weatherGridFixture.controller.getSnapshot().gridDisplay?.data.frame.validTime);
  await expect.poll(displayedTime).toBe(WEATHER_NOW);
  await page.waitForFunction(() => {
    const p = window.weatherGridFixture.controller.getSnapshot().grid.preparation;
    return p && p.total > 0 && p.ready === p.total;
  });
  // Release the decoded neighborhood before evicting a saved frame.
  await page.evaluate(() => window.weatherGridFixture.controller.change({ awcEnabled: false }));
  // Simulate eviction of a prepared frame, then delay its reacquisition.
  await page.evaluate(async () => {
    const cache = await caches.open('zlayers-plugin-files-v1:weather-awc:grids');
    for (const key of await cache.keys()) if (key.url.includes('f2-all')) await cache.delete(key);
  });
  await request.post('/__test/awc-grids', { data: { holdFrame: 'runs/clouds-synthetic-1/f2-all.zwg.gz' } });
  await page.evaluate(() => {
    Object.defineProperty(navigator, 'onLine', { configurable: true, get: () => false });
    window.weatherGridFixture.controller.change({ awcEnabled: true });
  });
  await expect.poll(displayedTime).toBe(WEATHER_NOW);
  const requests = (await (await request.get('/__test/awc-counts')).json()).gridFiles;
  try {
    await page.evaluate(time => {
      Object.defineProperty(navigator, 'onLine', { configurable: true, get: () => true });
      const fixture = window.weatherGridFixture; fixture.recording = true; fixture.controller.selectTime(time);
    }, WEATHER_NOW + 3600000);
    await expect.poll(() => page.evaluate(() => window.weatherGridFixture.controller.getSnapshot().grid.loading)).toBe(true);
    await expect.poll(async () => (await (await request.get('/__test/awc-counts')).json()).gridFiles).toBe(requests + 1);
    expect(await displayedTime()).toBeUndefined();
    expect(await page.evaluate(() => window.weatherGridFixture.map.getLayoutProperty('weather-awc-grid-raster', 'visibility'))).toBe('none');
    await page.evaluate(() => new Promise<void>(resolve => {
      const { map } = window.weatherGridFixture; map.once('render', () => resolve()); map.triggerRepaint();
    }));
    await page.evaluate(time => window.weatherGridFixture.controller.selectTime(time), WEATHER_NOW + 10800000);
    await expect.poll(displayedTime).toBe(WEATHER_NOW + 10800000);
  } finally { await request.post('/__test/awc-grids', { data: { releaseFrame: true } }); }
  await page.evaluate(() => new Promise<void>(resolve => {
    const { map } = window.weatherGridFixture; map.once('render', () => resolve()); map.triggerRepaint();
  }));
  const result = await page.evaluate(() => {
    const fixture = window.weatherGridFixture; fixture.recording = false;
    return { samples: fixture.samples, errors: fixture.errors, time: fixture.controller.getSnapshot().gridDisplay?.data.frame.validTime };
  });
  expect(result.samples.length).toBeGreaterThan(0);
  expect(result.samples.some(pixel => Math.abs(pixel[2]! - pixel[0]!) < 5)).toBe(true);
  expect(result.time).toBe(WEATHER_NOW + 10800000);
  expect(result.errors).toEqual([]);
});

test('cloud/freezing values share numeric inspection, real forecast stops and core details; icing switches native levels', async ({ page, request }, testInfo) => {
  const errors: string[] = []; page.on('pageerror', error => errors.push(error.message));
  await enable(page);
  await page.evaluate(async () => {
    const cache = await caches.open('zlayers-plugin-files-v1:weather-awc:grids');
    for (const key of await cache.keys()) if (key.url.includes('f4-all')) await cache.delete(key);
  });
  await request.post('/__test/awc-grids', { data: { holdFrame: 'runs/clouds-synthetic-1/f4-all.zwg.gz' } });
  let details = await inspect(page);
  await expect(details).toContainText('75%');
  await expect(details).toContainText('2,100 ft MSL');
  await expect(details).toContainText('18,000 ft MSL');
  await expect(details).toContainText('9,000 ft MSL');
  await expect(details).toContainText('12,000 ft MSL');
  await page.getByLabel('Close weather details').click();
  const overlay = page.getByRole('combobox', { name: 'Forecast overlay', exact: true });
  await overlay.selectOption('cloudBase');
  await expect(page.getByLabel('Cloud bases legend')).toBeVisible();
  await expect(page.locator('.awc-grid-controls:visible')).toContainText('not a ceiling');
  await expect(page.locator('.awc-grid-status')).toContainText('Valid Sep 22 · 21:00Z');
  const slider = page.getByRole('slider', { name: 'Weather forecast time' });
  try {
    await slider.focus(); await slider.press('End');
    await expect(page.locator('.awc-grid-status')).toContainText('Loading forecast…');
    await expect(page.locator('.awc-grid-status')).not.toContainText('Showing');
    await expect(page.locator('.awc-time-controls + .awc-time-status')).toHaveText('Loading forecast…');
    await page.screenshot({ animations: 'disabled', path: testInfo.outputPath('forecast-time-loading.png') });
    const point = await weatherMapPoint(page);
    await page.mouse.click(point.x, point.y, { button: 'right' });
    await expect(page.getByRole('menuitem', { name: 'Inspect weather', exact: true })).toHaveCount(0);
    await page.keyboard.press('Escape');
  } finally { await request.post('/__test/awc-grids', { data: { releaseFrame: true } }); }
  await expect(slider).toHaveValue(String(WEATHER_NOW + 3 * 3600000));
  await expect(slider).toHaveAttribute('aria-valuetext', 'Sep 23 · 00:00Z');
  await expect(page.locator('.awc-grid-status')).toContainText('Valid Sep 23 · 00:00Z');
  await expect(page.locator('.awc-time-heading')).not.toContainText('Loading');
  details = await inspect(page); await expect(details).toContainText('2,400 ft MSL');
  await page.getByLabel('Close weather details').click();
  await page.getByRole('button', { name: 'Now', exact: true }).click();
  await selectTab(page, 'Icing');
  await expect(page.getByText('Cloud bases is active. Choosing a forecast here replaces it.', { exact: true })).toBeVisible();
  await overlay.selectOption('icingSeverity');
  await expect(page.locator('.awc-grid-status')).toContainText('IFI run');
  details = await inspect(page);
  await expect(details).toContainText('8,000 ft MSL');
  await expect(details).toContainText('71%');
  await expect(details).toContainText('Moderate');
  await expect(details).toContainText('0.25');
  await page.getByRole('button', { name: 'Hide AWC Weather toolbox', exact: true }).click();
  await details.getByRole('button', { name: 'Change icing altitude', exact: true }).click();
  await expect(page.getByRole('tab', { name: 'Icing', exact: true })).toHaveAttribute('aria-selected', 'true');
  const altitude = page.getByRole('slider', { name: 'Icing altitude', exact: true });
  await expect(altitude).toBeFocused();
  await expect(altitude).toHaveAttribute('aria-valuetext', '8,000 feet MSL');
  await expect(details).toBeVisible();
  await expect(details).toContainText('Moderate');
  await expect(slider).toHaveAttribute('aria-valuetext', 'Now · Sep 22 · 21:00Z');
  await page.getByLabel('Close weather details').click();
  await expect(page.locator('.awc-altitude-marks .awc-time-mark')).toHaveText(['500', '8k', '12k']);
  await altitude.press('Home');
  await expect(altitude).toHaveAttribute('aria-valuetext', '500 feet MSL');
  await altitude.press('ArrowRight');
  await expect(altitude).toHaveAttribute('aria-valuetext', '8,000 feet MSL');
  await altitude.scrollIntoViewIfNeeded();
  const track = (await altitude.boundingBox())!;
  await page.mouse.click(track.x + 8 + (track.width - 16) * 0.2, track.y + track.height / 2);
  await expect(altitude).toHaveAttribute('aria-valuetext', '500 feet MSL');
  details = await inspect(page);
  await expect(details.getByText('Below model terrain', { exact: true })).toHaveCount(3);
  await page.getByLabel('Close weather details').click();
  await altitude.press('End');
  await expect(altitude).toHaveAttribute('aria-valuetext', '12,000 feet MSL');
  await overlay.selectOption('sldPotential');
  await expect(page.locator('.awc-grid-controls:visible')).toContainText('not a probability');
  details = await inspect(page); await expect(details).toContainText('50%');
  await page.screenshot({ animations: 'disabled', path: testInfo.outputPath('icing-numeric-details.png') });
  await page.getByLabel('Close weather details').click();
  await overlay.selectOption('freezingHighest');
  await expect(page.locator('.awc-time-legend')).toHaveText('Freezing');
  await expect(altitude).toHaveCount(0);
  await expect(page.locator('.awc-grid-status')).toContainText('HRRR run');
  details = await inspect(page); await expect(details).toContainText('12,000 ft MSL');
  expect(errors).toEqual([]);
});

test('background preparation shows progress while selected frames and source updates remain usable', async ({ page, request }, testInfo) => {
  await request.post('/__test/awc-grids', { data: { holdFrame: 'runs/clouds-synthetic-1/f4-all.zwg.gz' } });
  await enable(page, 'cloudCover', false);
  const progress = page.getByRole('progressbar', { name: 'Forecast preparation' });
  try {
    await expect(progress).toHaveAttribute('value', '2');
    await expect(progress).toHaveAttribute('max', '3');
    await expect(page.locator('.awc-grid-status')).toContainText('Saving forecasts');
    await expect(page.locator('.awc-grid-status')).toContainText('Valid Sep 22 · 21:00Z');
    await page.screenshot({ path: testInfo.outputPath('forecast-initial-preparation.png') });
  } finally { await request.post('/__test/awc-grids', { data: { releaseFrame: true } }); }
  await expect(progress).toHaveCount(0);
  await expect(page.locator('.awc-grid-status')).toContainText('Valid Sep 22 · 21:00Z');
  let details = await inspect(page); await expect(details).toContainText('75%');
  await page.getByLabel('Close weather details').click();
  await request.post('/__test/awc-grids', { data: { products: [gridFixture('clouds', 2)], holdFrame: 'runs/clouds-synthetic-2/f4-all.zwg.gz' } });
  await page.clock.fastForward(5 * 60_000 + 1000);
  try {
    await expect(progress).toHaveAttribute('value', '2');
    await expect(page.locator('.awc-grid-status')).toContainText('Valid Sep 22 · 21:00Z');
    expect(await page.evaluate(() => JSON.parse(localStorage.getItem('zlayer-plugin:weather-awc:grid-clouds')!).manifest.generation)).toBe('clouds-synthetic-2');
    details = await inspect(page); await expect(details).toContainText('76%');
    await page.getByLabel('Close weather details').click();
    await page.screenshot({ path: testInfo.outputPath('forecast-update-preparation.png') });
  } finally { await request.post('/__test/awc-grids', { data: { releaseFrame: true } }); }
  await expect(progress).toHaveCount(0);
  details = await inspect(page); await expect(details).toContainText('76%');
  expect(await page.evaluate(() => JSON.parse(localStorage.getItem('zlayer-plugin:weather-awc:grid-clouds')!).manifest.generation)).toBe('clouds-synthetic-2');
});

test('prepared cloud/icing timelines survive refresh and reopen offline', async ({ page, request }) => {
  await enable(page);
  await expect(page.locator('.awc-grid-status')).toContainText('Forecasts saved');
  const slider = page.getByRole('slider', { name: 'Weather forecast time' });
  await slider.press('ArrowRight');
  await expect(page.locator('.awc-grid-status')).toContainText('Valid Sep 22 · 22:00Z');
  await slider.press('End');
  await expect(page.locator('.awc-grid-status')).toContainText('Valid Sep 23 · 00:00Z');
  await selectTab(page, 'Icing');
  await page.getByRole('combobox', { name: 'Forecast overlay', exact: true }).selectOption('icingSeverity');
  await expect(page.locator('.awc-grid-status')).toContainText('Valid Sep 23 · 00:00Z');
  await expect(page.locator('.awc-grid-status')).toContainText('Forecasts saved');
  const altitude = page.getByRole('slider', { name: 'Icing altitude', exact: true });
  await altitude.press('End');
  await expect(page.locator('.awc-grid-status')).toContainText('Valid Sep 23 · 00:00Z');
  await expect(page.locator('.awc-grid-status')).toContainText('Forecasts saved');
  await altitude.press('Home');
  await expect(page.locator('.awc-grid-status')).toContainText('Valid Sep 23 · 00:00Z');
  await expect(page.locator('.awc-grid-status')).toContainText('Forecasts saved');
  await expect.poll(() => page.evaluate(async () => (await (await caches.open('zlayers-plugin-files-v1:weather-awc:grids')).keys()).length)).toBe(12);
  const before = await (await request.get('/__test/awc-counts')).json();
  await selectTab(page, 'Cloud');
  await page.getByRole('combobox', { name: 'Forecast overlay', exact: true }).selectOption('cloudCover');
  await expect(page.locator('.awc-grid-status')).toContainText('Valid Sep 23 · 00:00Z');
  await page.clock.fastForward(5 * 60_000 + 1000);
  await expect.poll(async () => (await (await request.get('/__test/awc-counts')).json()).grids).toBeGreaterThanOrEqual(before.grids + 2);
  expect((await (await request.get('/__test/awc-counts')).json()).gridFiles).toBe(before.gridFiles);
  await page.waitForFunction(() => !!navigator.serviceWorker.controller);
  // WebKit's offline emulation also rejects service-worker responses. Disconnect
  // the actual origin, as in the workspace offline-restoration regressions.
  await request.post('/__test/disconnect');
  await page.addInitScript(() => Object.defineProperty(navigator, 'onLine', { get: () => false }));
  await page.evaluate(() => {
    Object.defineProperty(navigator, 'onLine', { get: () => false });
    window.dispatchEvent(new Event('offline'));
  });
  await slider.press('Home');
  await expect(page.locator('.awc-grid-status')).toContainText('Valid Sep 22 · 21:00Z');
  await page.reload();
  await expect(page.locator('.app-shell')).toHaveAttribute('aria-busy', 'false');
  const open = page.getByRole('button', { name: 'Show AWC Weather toolbox', exact: true });
  if (await open.isVisible()) await open.click();
  await selectTab(page, 'Cloud');
  await expect(page.locator('.awc-grid-status')).toContainText('Valid Sep 22 · 21:00Z');
  await expect(page.locator('.awc-grid-status')).toContainText('Offline · cached');
  expect((await (await request.get('/__test/awc-counts')).json()).gridFiles).toBe(before.gridFiles);
});

test('two browser windows share one missing-frame download through the core cache', async ({ page, context, request }) => {
  await page.clock.install({ time: WEATHER_NOW });
  // Stall the final frame: one admitted job intentionally cannot prepare later
  // frames past a stalled earlier frame, even if controllers have queued them.
  await request.post('/__test/awc-grids', { data: { holdFrame: 'runs/clouds-synthetic-1/f4-all.zwg.gz' } });
  await page.goto('/test/browser/weather-grids.html');
  const displayed = (target: Page) => target.evaluate(() => window.weatherGridFixture.controller.getSnapshot().gridDisplay?.data.frame.validTime);
  await expect.poll(() => page.evaluate(() => window.weatherGridFixture.controller.getSnapshot().grid.preparation?.ready)).toBe(2);
  expect(await displayed(page)).toBe(WEATHER_NOW);
  const other = await context.newPage();
  await other.clock.install({ time: WEATHER_NOW });
  await other.goto('/test/browser/weather-grids.html');
  await expect.poll(() => other.evaluate(() => window.weatherGridFixture.controller.getSnapshot().grid.preparation?.ready)).toBe(2);
  expect(await displayed(other)).toBe(WEATHER_NOW);
  await expect.poll(async () => (await (await request.get('/__test/awc-counts')).json()).gridFiles).toBe(3);
  try {
    await page.evaluate(time => window.weatherGridFixture.controller.selectTime(time), WEATHER_NOW + 3 * 3600000);
    expect((await (await request.get('/__test/awc-counts')).json()).gridFiles).toBe(3);
    await other.evaluate(time => window.weatherGridFixture.controller.selectTime(time), WEATHER_NOW + 3 * 3600000);
    await expect.poll(() => other.evaluate(() => window.weatherGridFixture.controller.getSnapshot().grid.loading)).toBe(true);
  } finally { await request.post('/__test/awc-grids', { data: { releaseFrame: true } }); }
  await expect.poll(() => displayed(page)).toBe(WEATHER_NOW + 3 * 3600000);
  await expect.poll(() => displayed(other)).toBe(WEATHER_NOW + 3 * 3600000);
  for (const target of [page, other]) await target.waitForFunction(() => {
    const p = window.weatherGridFixture.controller.getSnapshot().grid.preparation; return p && p.ready === p.total;
  });
  expect((await (await request.get('/__test/awc-counts')).json()).gridFiles).toBe(3);
});

test('offline uses only saved identity, corrupt bytes do not render, reconnect repairs the forecast', async ({ page, request, context }) => {
  await enable(page, 'icingProbability');
  const altitude = page.getByRole('slider', { name: 'Icing altitude', exact: true });
  await inspect(page); await page.getByLabel('Close weather details').click();
  await expect.poll(() => page.evaluate(async () => (await (await caches.open('zlayers-plugin-files-v1:weather-awc:grids')).keys()).length)).toBeGreaterThan(0);
  await context.setOffline(true);
  await altitude.press('End');
  await expect(page.locator('.awc-grid-status')).toContainText('not saved for offline');
  await altitude.press('ArrowLeft');
  await expect(page.locator('.awc-grid-status')).toContainText('Valid');
  await request.post('/__test/awc-grids', { data: { corrupt: true } });
  await context.setOffline(false);
  await altitude.press('End');
  await expect(page.locator('.awc-grid-status')).toContainText('checksum mismatch');
  await request.post('/__test/awc-grids', { data: {} });
  await altitude.press('ArrowLeft');
  await altitude.press('End');
  await expect(page.locator('.awc-grid-status')).toContainText('Valid');
  const details = await inspect(page); await expect(details).toContainText('50%');
  await request.post('/__test/awc-grids', { data: { failure: true } });
  await page.clock.fastForward(5 * 60_000 + 1000);
  await expect(page.locator('.awc-grid-status')).toContainText('503');
  await expect(details).toContainText('Cached / outdated');
  await expect(details).toContainText('50%');
});

test('grid controls fit a phone, retain pinned time through WebGL recovery and release requests when off', async ({ page, request }, testInfo) => {
  await request.post('/__test/awc-grids', { data: { products: [gridFixture('clouds'),
    gridFixture('icing', 1, WEATHER_NOW, Array.from({ length: 60 }, (_, i) => (i + 1) * 500))] } });
  await page.setViewportSize({ width: 390, height: 844 });
  await enable(page, 'icingSeverity');
  const altitude = page.getByRole('slider', { name: 'Icing altitude', exact: true });
  await expect(page.locator('.awc-altitude-marks .awc-time-mark')).toHaveCount(60);
  await altitude.press('ArrowRight');
  await expect(altitude).toHaveAttribute('aria-valuetext', '8,500 feet MSL');
  const labels = await page.locator('.awc-altitude-marks .awc-time-mark > span').evaluateAll(elements => elements.map(element => {
    const box = element.getBoundingClientRect(); return { left: box.left, right: box.right };
  }));
  for (let i = 1; i < labels.length; i++) expect(labels[i]!.left).toBeGreaterThan(labels[i - 1]!.right);
  expect((await altitude.boundingBox())!.height).toBeGreaterThanOrEqual(44);
  await page.screenshot({ animations: 'disabled', path: testInfo.outputPath('icing-altitude-phone.png') });
  const slider = page.getByRole('slider', { name: 'Weather forecast time' });
  await slider.focus(); await slider.press('End');
  await expect(page.locator('.awc-grid-status')).toContainText('Valid Sep 23 · 00:00Z');
  await page.getByRole('button', { name: 'Hide AWC Weather toolbox', exact: true }).click();
  await inspect(page);
  await page.screenshot({ animations: 'disabled', path: testInfo.outputPath('icing-phone.png') });
  await page.getByLabel('Close weather details').click();
  await page.locator('.maplibregl-canvas').evaluate(element => new Promise<void>(resolve => {
    const extension = (element as HTMLCanvasElement).getContext('webgl2')!.getExtension('WEBGL_lose_context')!;
    element.addEventListener('webglcontextrestored', () => resolve(), { once: true });
    extension.loseContext(); setTimeout(() => extension.restoreContext(), 200);
  }));
  const details = await inspect(page); await expect(details).toContainText('Sep 23 · 00:00Z');
  await page.getByLabel('Close weather details').click();
  await expect(slider).toHaveValue(String(WEATHER_NOW + 3 * 3600000));
  await expect(altitude).toHaveAttribute('aria-valuetext', '8,500 feet MSL');
  await expect(page.getByRole('tab', { name: 'Icing', exact: true })).toHaveAttribute('aria-selected', 'true');
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await page.getByRole('switch', { name: 'Show AWC weather', exact: true }).click();
  const count = (await (await request.get('/__test/awc-counts')).json()).grids;
  await page.clock.fastForward(10 * 60_000);
  expect((await (await request.get('/__test/awc-counts')).json()).grids).toBe(count);
});
