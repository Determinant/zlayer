import { test, expect, type Page } from '@playwright/test';
import { advisorySource, WEATHER_NOW } from '../fixtures/awc-advisories';

test.beforeEach(async ({ request }) => {
  await request.post('/__test/reset');
  await request.post('/__test/awc', { data: { gairmet: [0, 3, 6, 9, 12].map(hour => advisorySource('gairmet', hour)),
    sigmet: advisorySource('sigmet'), cwa: advisorySource('cwa') } });
});

async function enable(page: Page, prepared = true) {
  await page.clock.install({ time: WEATHER_NOW });
  await page.goto('/');
  await expect(page.locator('.app-shell')).toHaveAttribute('aria-busy', 'false', { timeout: 20_000 });
  await page.getByRole('button', { name: 'Show AWC Weather toolbox', exact: true }).click();
  await page.getByRole('switch', { name: 'Show AWC weather', exact: true }).click();
  for (const name of ['G-AIRMET', 'SIGMET', 'Convective SIGMET', 'CWA']) await page.getByRole('checkbox', { name, exact: true }).uncheck();
  await page.getByRole('tab', { name: 'Progs', exact: true }).click();
  await page.getByRole('switch', { name: 'Surface analysis / progs', exact: true }).click();
  if (prepared) {
    await expect(page.locator('.awc-progs-frame')).toContainText('Valid Sep 22 · 18:00Z');
    await expect(page.locator('.awc-progs-frame')).toContainText('Checked');
    await expect(page.locator('.awc-time-dates')).toContainText('Sep 29');
  }
}

test('NDFD shading renders beneath chart features, clears at gaps and recovers after source failure and style replacement', async ({ page }, testInfo) => {
  await page.clock.install({ time: WEATHER_NOW });
  await page.goto('/test/browser/weather-progs.html');
  await expect.poll(() => page.evaluate(() => window.progsMapAudit.state().coverageDisplay.validTime)).toBe(Date.parse('2026-09-22T18:00:00Z'));
  await expect.poll(() => page.evaluate(() => window.progsMapAudit.map.loaded())).toBe(true);
  const screenshot = await page.screenshot({ path: testInfo.outputPath('progs-with-coverage.png') });
  const greenPixels = (image: Buffer) => page.evaluate(async png => {
    const bitmap = await createImageBitmap(await (await fetch(`data:image/png;base64,${png}`)).blob());
    const canvas = document.createElement('canvas'); canvas.width = bitmap.width; canvas.height = bitmap.height;
    const ctx = canvas.getContext('2d')!; ctx.drawImage(bitmap, 0, 0); bitmap.close();
    const pixels = ctx.getImageData(0, 0, canvas.width, canvas.height).data;
    let count = 0;
    for (let i = 0; i < pixels.length; i += 4) if (Math.abs(pixels[i]! - 57) < 4 && Math.abs(pixels[i + 1]! - 171) < 4 && Math.abs(pixels[i + 2]! - 105) < 4) count++;
    return count;
  }, image.toString('base64'));
  expect(await greenPixels(screenshot)).toBeGreaterThan(1000);
  const order = await page.evaluate(() => window.progsMapAudit.map.getStyle().layers.map(layer => layer.id));
  expect(order.indexOf('weather-awc-progs-coverage-raster')).toBeLessThan(order.indexOf('weather-awc-progs-fronts'));
  await page.evaluate(() => window.progsMapAudit.select(window.progsMapAudit.state().coverage.snapshot!.frames.at(-1)!.validTime));
  await expect.poll(() => page.evaluate(() => window.progsMapAudit.state().coverageDisplay.validTime)).toBeUndefined();
  expect(await page.evaluate(() => !!window.progsMapAudit.map.getLayer('weather-awc-progs-coverage-raster'))).toBe(false);
  expect(await page.evaluate(() => window.progsMapAudit.features().length)).toBeGreaterThan(0);
  await page.evaluate(() => window.progsMapAudit.select(window.progsMapAudit.state().coverage.snapshot!.frames[1]!.validTime));
  await expect.poll(() => page.evaluate(() => window.progsMapAudit.state().coverageDisplay.validTime)).toBe(Date.parse('2026-09-23T00:00:00Z'));
  await page.evaluate(() => window.progsMapAudit.map.fire('error', { sourceId: 'weather-awc-progs-coverage', error: new Error('Coverage test failure') }));
  await expect.poll(() => page.evaluate(() => window.progsMapAudit.state().coverageDisplay.error)).toContain('Coverage test failure');
  expect(await page.evaluate(() => window.progsMapAudit.map.getLayoutProperty('weather-awc-progs-coverage-raster', 'visibility'))).toBe('none');
  await page.evaluate(() => window.progsMapAudit.retry());
  await expect.poll(() => page.evaluate(() => window.progsMapAudit.state().coverageDisplay.validTime)).toBe(Date.parse('2026-09-23T00:00:00Z'));
  const retry = await page.evaluate(() => window.progsMapAudit.state().progsRetry);
  await page.evaluate(() => window.progsMapAudit.map.fire('error', { sourceId: 'weather-awc-progs-coverage', error: new Error('Refresh recovery failure') }));
  await expect.poll(() => page.evaluate(() => window.progsMapAudit.state().coverageDisplay.error)).toContain('Refresh recovery failure');
  await page.clock.fastForward(5 * 60_000 + 1);
  await expect.poll(() => page.evaluate(() => window.progsMapAudit.state().coverageDisplay.validTime)).toBe(Date.parse('2026-09-23T00:00:00Z'));
  expect(await page.evaluate(() => window.progsMapAudit.state().progsRetry)).toBe(retry);
  for (const longitude of [238, -482, -122]) {
    await page.evaluate(longitude => window.progsMapAudit.map.jumpTo({ center: [longitude, 37.3] }), longitude);
    await expect.poll(() => page.evaluate(() => window.progsMapAudit.map.loaded())).toBe(true);
    expect(await page.evaluate(() => window.progsMapAudit.state().coverageDisplay.error)).toBeUndefined();
    expect(await greenPixels(await page.screenshot())).toBeGreaterThan(1000);
  }
  await page.evaluate(() => window.progsMapAudit.recover());
  await expect.poll(() => page.evaluate(() => window.progsMapAudit.state().coverageDisplay.validTime)).toBe(Date.parse('2026-09-23T00:00:00Z'));
  expect(await page.evaluate(() => window.progsMapAudit.errors)).toEqual(['Coverage test failure', 'Refresh recovery failure']);
});

test('coverage switch and legend explain precipitation and fog independently of isobars', async ({ page }) => {
  await enable(page);
  const toggle = page.getByRole('switch', { name: 'Precipitation / weather', exact: true });
  await expect(toggle).toBeChecked();
  await expect(page.locator('.awc-coverage-status')).toContainText('Shown · valid Sep 22 · 18:00Z');
  await page.getByText('Weather coverage legend', { exact: true }).click();
  await expect(page.locator('.awc-coverage-legend')).toContainText('Rain');
  await expect(page.locator('.awc-coverage-legend')).toContainText('Snow');
  await expect(page.locator('.awc-coverage-legend')).toContainText('Fog');
  await expect(page.locator('.awc-coverage-legend')).toContainText('Chance: up to 50%');
  await toggle.click();
  await expect(page.locator('.awc-coverage-status')).toHaveCount(0);
  await expect(page.locator('.awc-progs-frame')).toContainText('Surface analysis');
  await page.reload();
  await page.getByRole('tab', { name: 'Progs', exact: true }).click();
  await expect(toggle).not.toBeChecked();
  await toggle.click();
  await expect(page.locator('.awc-coverage-status')).toContainText('Shown');
  await page.getByRole('slider', { name: 'Weather forecast time', exact: true }).press('End');
  await expect(page.locator('.awc-coverage-status')).toContainText('Weather coverage not published for this chart');
  await expect(page.locator('.awc-progs-frame')).toContainText('Valid Sep 29 · 12:00Z');
});

test('surface maps render all symbol families from prepared snapshots and recover their selected forecast', async ({ page }, testInfo) => {
  const raw: string[] = [];
  page.on('request', request => { if (/wpc\.ncep\.noaa\.gov|aviationweather\.gov/.test(request.url())) raw.push(request.url()); });
  await page.clock.install({ time: WEATHER_NOW });
  await page.goto('/test/browser/weather-progs.html');
  await page.evaluate(() => window.progsMapAudit.change({ awcProgsCoverage: false }));
  await expect.poll(() => page.evaluate(() => [...new Set(window.progsMapAudit.features().map(f => f.kind))].sort()))
    .toEqual(['COLD', 'DRYLINE', 'HIGH', 'HURRICANE', 'ISOBAR', 'LABEL', 'LOW', 'OCFNT', 'SQUALL', 'STNRY', 'TROF', 'TROPICAL_STORM', 'WARM']);
  await expect.poll(() => page.evaluate(() => window.progsMapAudit.map.loaded())).toBe(true);
  const screenshot = await page.screenshot({ path: testInfo.outputPath('surface-analysis.png') });
  const sides = await page.evaluate(async png => {
    const map = window.progsMapAudit.map;
    const bitmap = await createImageBitmap(await (await fetch(`data:image/png;base64,${png}`)).blob());
    const canvas = document.createElement('canvas'); canvas.width = bitmap.width; canvas.height = bitmap.height;
    const ctx = canvas.getContext('2d')!; ctx.drawImage(bitmap, 0, 0); bitmap.close();
    const scale = canvas.width / innerWidth, from = map.project([-123.9, 35.5]), to = map.project([-122.1, 35.5]);
    const result = { coldLeft: 0, coldRight: 0, warmLeft: 0, warmRight: 0, isobarPixels: 0 };
    // This stationary boundary runs west → east. Its cold symbols belong north
    // (left of source order), warm symbols south; ignore the central stroke.
    for (let x = Math.ceil(from.x * scale); x < to.x * scale; x++) for (const side of [-1, 1]) for (let dy = 3 * scale; dy <= 7 * scale; dy++) {
      const [r, g, b] = ctx.getImageData(x, Math.round(from.y * scale + side * dy), 1, 1).data;
      if (r! < 60 && g! < 130 && b! > 130) result[side < 0 ? 'coldLeft' : 'coldRight']++;
      if (r! > 130 && g! < 70 && b! < 110) result[side < 0 ? 'warmLeft' : 'warmRight']++;
    }
    const contourStart = map.project([-124.2, 36.2]), contourEnd = map.project([-122.8, 36.2]);
    for (let x = Math.ceil(contourStart.x * scale); x < contourEnd.x * scale; x++) for (let dy = -2 * scale; dy <= 2 * scale; dy++) {
      const [r, g, b] = ctx.getImageData(x, Math.round(contourStart.y * scale + dy), 1, 1).data;
      // Thin contours blend with the background differently in WebKit and Chromium.
      if (r! >= 90 && r! <= 175 && Math.abs(r! - g!) < 5 && Math.abs(g! - b!) < 5) result.isobarPixels++;
    }
    return result;
  }, screenshot.toString('base64'));
  expect(await page.evaluate(() => window.progsMapAudit.features().some(f => f.kind === 'LABEL' && f.text === 'RIDGE'))).toBe(true);
  expect(sides.coldLeft).toBeGreaterThan(10); expect(sides.warmRight).toBeGreaterThan(10);
  expect(sides.isobarPixels).toBeGreaterThan(80);
  expect(sides.coldRight).toBe(0); expect(sides.warmLeft).toBe(0);
  expect(await page.evaluate(() => window.progsMapAudit.errors)).toEqual([]);
  await page.evaluate(() => window.progsMapAudit.change({ awcSigmet: true, awcGairmet: true }));
  await expect.poll(() => page.evaluate(() => !!window.progsMapAudit.state().products.sigmet.snapshot && !!window.progsMapAudit.state().products.gairmet.snapshot)).toBe(true);
  await page.evaluate(time => window.progsMapAudit.select(time), WEATHER_NOW + 2 * 3600_000);
  expect(await page.evaluate(() => window.progsMapAudit.state().selectedTime)).toBe(WEATHER_NOW + 2 * 3600_000);
  await expect.poll(() => page.evaluate(() => window.progsMapAudit.features().some(f => f.kind === 'LABEL' && f.text === '1024'))).toBe(true);
  await page.evaluate(time => window.progsMapAudit.select(time), WEATHER_NOW + 3 * 3600_000);
  await expect.poll(() => page.evaluate(() => window.progsMapAudit.features().some(f => f.kind === 'LABEL' && f.text === '1025'))).toBe(true);
  await page.evaluate(time => window.progsMapAudit.select(time), WEATHER_NOW + 6 * 3600_000);
  expect(await page.evaluate(() => window.progsMapAudit.state().selectedTime)).toBe(WEATHER_NOW + 6 * 3600_000);
  await expect.poll(() => page.evaluate(() => window.progsMapAudit.features().some(f => f.kind === 'LABEL' && f.text === '1025'))).toBe(true);
  await page.evaluate(time => window.progsMapAudit.select(time), WEATHER_NOW + 9 * 3600_000);
  await expect.poll(() => page.evaluate(() => window.progsMapAudit.features().some(f => f.kind === 'LABEL' && f.text === '1026'))).toBe(true);
  const beforeToggle = await page.evaluate(() => window.progsMapAudit.state().progs.forecast.snapshot!.sourceHash);
  await page.evaluate(() => window.progsMapAudit.change({ awcProgsIsobars: false }));
  await expect.poll(() => page.evaluate(() => window.progsMapAudit.features().some(f => f.kind === 'ISOBAR'))).toBe(false);
  await expect.poll(() => page.evaluate(() => window.progsMapAudit.features().some(f => f.pressureLabel))).toBe(false);
  await expect.poll(() => page.evaluate(() => window.progsMapAudit.features().some(f => f.kind === 'LABEL' && f.text === 'RIDGE'))).toBe(true);
  await expect.poll(() => page.evaluate(() => window.progsMapAudit.features().some(f => f.kind === 'HIGH') && window.progsMapAudit.features().some(f => f.kind === 'COLD'))).toBe(true);
  expect(await page.evaluate(() => window.progsMapAudit.state().progs.forecast.snapshot!.sourceHash)).toBe(beforeToggle);
  await page.evaluate(() => window.progsMapAudit.recover());
  await expect.poll(() => page.evaluate(() => window.progsMapAudit.features().some(f => f.kind === 'HIGH'))).toBe(true);
  expect(await page.evaluate(() => window.progsMapAudit.features().some(f => f.kind === 'ISOBAR'))).toBe(false);
  expect(await page.evaluate(() => window.progsMapAudit.features().some(f => f.pressureLabel))).toBe(false);
  await page.evaluate(() => window.progsMapAudit.change({ awcProgsIsobars: true }));
  await expect.poll(() => page.evaluate(() => window.progsMapAudit.features().some(f => f.kind === 'ISOBAR'))).toBe(true);
  await expect.poll(() => page.evaluate(() => window.progsMapAudit.features().some(f => f.kind === 'LABEL' && f.text === '1016'))).toBe(true);
  await expect.poll(() => page.evaluate(() => window.progsMapAudit.features().some(f => f.kind === 'LABEL' && f.text === '1026'))).toBe(true);
  expect(await page.evaluate(() => window.progsMapAudit.state().selectedTime)).toBe(WEATHER_NOW + 9 * 3600_000);
  await page.evaluate(() => window.progsMapAudit.change({ awcProgs: false }));
  await expect.poll(() => page.evaluate(() => window.progsMapAudit.features().length)).toBe(0);
  await page.evaluate(() => window.progsMapAudit.change({ awcProgs: true }));
  await expect.poll(() => page.evaluate(() => window.progsMapAudit.features().some(f => f.kind === 'LABEL' && f.text === '1026'))).toBe(true);
  expect(raw).toEqual([]);
  expect(await page.evaluate(() => window.progsMapAudit.errors)).toEqual([]);
});

test('surface charts still warming at startup retry automatically and share analysis/forecast intervals with advisory ticks', async ({ page, request }) => {
  // Fail at the origin so the test follows the normal service-worker path in
  // both browsers, including the distinction between an error and no coverage.
  await request.post('/__test/progs', { data: { failure: true } });
  await enable(page, false);
  await expect(page.getByRole('button', { name: 'Retry surface weather', exact: true })).toBeVisible();
  await expect(page.locator('.awc-progs-frame')).toContainText('Surface weather unavailable');
  for (const product of ['analysis', 'forecast']) await expect(page.locator(`[data-product="progs-${product}"]`)).toContainText('Refresh failed');
  expect((await (await request.get('/__test/awc-counts')).json()).progs).toBe(2);
  await request.post('/__test/progs', { data: { failure: false } });
  await page.clock.fastForward(31_000);
  await expect(page.locator('.awc-time-dates')).toContainText('Sep 29');
  await expect(page.locator('.awc-progs-frame')).toContainText('Valid Sep 22 · 18:00Z');
  await expect(page.getByRole('button', { name: 'Retry surface weather', exact: true })).toHaveCount(0);
  expect((await (await request.get('/__test/awc-counts')).json()).progs).toBe(4);
  await page.getByRole('tab', { name: 'Advisories', exact: true }).click();
  await page.getByRole('checkbox', { name: 'SIGMET', exact: true }).check();
  await page.getByRole('checkbox', { name: 'G-AIRMET', exact: true }).check();
  await expect(page.locator('.awc-time-marks [data-time-product="sigmet"]')).not.toHaveCount(0);
  await expect(page.locator('.awc-time-marks [data-time-product="gairmet"]')).not.toHaveCount(0);
  await page.getByRole('tab', { name: 'Progs', exact: true }).click();
  const next = page.getByRole('button', { name: 'Next weather time', exact: true });
  await next.click();
  await expect(page.getByRole('slider', { name: 'Weather forecast time', exact: true })).toHaveAttribute('aria-valuetext', 'Sep 22 · 23:00Z');
  await expect(page.locator('.awc-progs-frame')).toContainText('Surface analysis');
  await expect(page.locator('.awc-progs-frame')).toContainText('Valid Sep 22 · 18:00Z');
  await expect(page.locator('.awc-progs-frame')).toContainText('Next chart Sep 23 · 00:00Z');
  await next.click();
  await expect(page.locator('.awc-progs-frame')).toContainText('Surface forecast');
  await expect(page.locator('.awc-progs-frame')).toContainText('Valid Sep 23 · 00:00Z');
  await next.click();
  await expect(page.getByRole('slider', { name: 'Weather forecast time', exact: true })).toHaveAttribute('aria-valuetext', 'Sep 23 · 03:00Z');
  await expect(page.locator('.awc-progs-frame')).toContainText('Valid Sep 23 · 00:00Z');
  await expect(page.locator('.awc-progs-frame')).toContainText('Next chart Sep 23 · 06:00Z');
  await next.click();
  await expect(page.locator('.awc-progs-frame')).toContainText('Valid Sep 23 · 06:00Z');
  await page.getByRole('button', { name: 'Now', exact: true }).click();
  await expect(page.locator('.awc-progs-frame')).toContainText('Surface analysis');
  await expect(page.locator('.awc-progs-frame')).toContainText('Valid Sep 22 · 18:00Z');
});

test('the seven-day timeline keeps hourly spacing, pans independently and follows forecast navigation', async ({ page }) => {
  await enable(page);
  const rail = page.locator('.awc-time-scroll'), slider = page.getByRole('slider', { name: 'Weather forecast time' });
  const next = page.getByRole('button', { name: 'Next weather time', exact: true });
  const previous = page.getByRole('button', { name: 'Previous weather time', exact: true });
  const now = page.getByRole('button', { name: 'Now', exact: true });
  const thumbIsVisible = async () => expect.poll(() => slider.evaluate(input => {
    const range = input as HTMLInputElement, box = range.getBoundingClientRect(), view = range.closest('.awc-time-scroll')!.getBoundingClientRect();
    const x = box.x + 8 + (Number(range.value) - Number(range.min)) / (Number(range.max) - Number(range.min)) * (box.width - 16);
    return x >= view.left + 8 && x <= view.right - 8;
  })).toBe(true);
  expect(await rail.evaluate(e => e.scrollWidth > e.clientWidth * 5)).toBe(true);
  const hours = page.locator('.awc-time-hour');
  expect((await hours.nth(1).boundingBox())!.x - (await hours.first().boundingBox())!.x).toBeCloseTo(11, 1);
  const selection = (await slider.getAttribute('aria-valuetext'))!, controls = (await next.boundingBox())!;
  const view = (await rail.boundingBox())!;
  await page.mouse.move(view.x + view.width - 15, view.y + 10);
  await page.mouse.down(); await page.mouse.move(view.x + 15, view.y + 10, { steps: 8 }); await page.mouse.up();
  const panned = await rail.evaluate(e => e.scrollLeft);
  expect(panned).toBeGreaterThan(150);
  await expect(slider).toHaveAttribute('aria-valuetext', selection);
  await page.clock.fastForward(5 * 60_000 + 1000);
  // WebKit can round scroll anchoring by one pixel as the live Now thumb moves.
  expect(Math.abs(await rail.evaluate(e => e.scrollLeft) - panned)).toBeLessThanOrEqual(1);
  await now.click(); await thumbIsVisible();
  expect(await rail.evaluate(e => e.scrollLeft)).toBe(0);
  // The handle still scrubs native frames, independently of dragging the scale.
  const track = (await slider.boundingBox())!;
  const handle = track.x + 8 + (Number(await slider.inputValue()) - Number(await slider.getAttribute('min'))) /
    (Number(await slider.getAttribute('max')) - Number(await slider.getAttribute('min'))) * (track.width - 16);
  await page.mouse.move(handle, track.y + 12); await page.mouse.down();
  await page.mouse.move(handle + 3 * 11, track.y + 12, { steps: 6 }); await page.mouse.up();
  await expect(slider).toHaveAttribute('aria-valuetext', 'Sep 23 · 00:00Z');
  for (let i = 0; i < 9; i++) { await next.click(); await thumbIsVisible(); }
  await expect(next).toBeDisabled();
  expect(await rail.evaluate(e => e.scrollWidth - e.clientWidth - e.scrollLeft)).toBeLessThanOrEqual(1);
  await expect(slider).toHaveAttribute('aria-valuetext', 'Sep 29 · 12:00Z');
  await previous.click(); await thumbIsVisible();
  await expect(slider).toHaveAttribute('aria-valuetext', 'Sep 28 · 12:00Z');
  expect((await next.boundingBox())!.y).toBe(controls.y);
  await slider.press('Home'); await thumbIsVisible();
  await expect(now).toHaveAttribute('aria-pressed', 'true');
  await slider.press('End'); await thumbIsVisible();
  await expect(next).toBeDisabled();
  await now.click(); await thumbIsVisible();
});

test('Progs keeps shared time and displayed overlays across tabs, stowing, refresh failures and offline reopening', async ({ page, request }) => {
  await enable(page);
  await expect(page.locator('.awc-coverage-status')).toContainText('Shown');
  await page.waitForFunction(() => !!localStorage.getItem('zlayer-plugin:weather-awc:progs-coverage'));
  const isobars = page.getByRole('switch', { name: 'Isobars', exact: true });
  await expect(isobars).toBeChecked();
  const readsBeforeToggle = (await (await request.get('/__test/awc-counts')).json()).progs;
  await isobars.click(); await expect(isobars).not.toBeChecked();
  expect((await (await request.get('/__test/awc-counts')).json()).progs).toBe(readsBeforeToggle);
  await page.getByRole('button', { name: 'Next weather time', exact: true }).click();
  await expect(page.locator('.awc-progs-frame')).toContainText('Surface forecast');
  await expect(page.locator('.awc-progs-frame')).toContainText('Valid Sep 23 · 00:00Z');
  const time = await page.getByRole('slider', { name: 'Weather forecast time', exact: true }).inputValue();
  await page.getByRole('tab', { name: 'Cloud', exact: true }).click();
  await expect(page.getByRole('tab', { name: 'Progs', exact: true })).toHaveAttribute('data-active', 'true');
  await expect(page.getByRole('slider', { name: 'Weather forecast time', exact: true })).toHaveValue(time);
  await page.getByRole('button', { name: 'Hide AWC Weather toolbox', exact: true }).click();
  await page.getByRole('button', { name: 'Show AWC Weather toolbox', exact: true }).click();
  await page.getByRole('tab', { name: 'Progs', exact: true }).click();
  await expect(page.locator('.awc-progs-frame')).toContainText('Valid Sep 23 · 00:00Z');
  await expect(isobars).not.toBeChecked();
  const stored = await page.evaluate(() => localStorage.getItem('zlayer-plugin:weather-awc:progs-forecast'));
  expect(stored).toBeTruthy();
  await page.waitForFunction(() => !!navigator.serviceWorker.controller);
  await request.post('/__test/progs', { data: { failure: true } });
  await page.clock.fastForward(5 * 60_000 + 1000);
  await page.locator('.awc-progs-controls .awc-source-status > summary').click();
  await expect(page.locator('[data-product="progs-forecast"]')).toContainText('Refresh failed');
  expect(await page.evaluate(() => localStorage.getItem('zlayer-plugin:weather-awc:progs-forecast'))).toBe(stored);
  await page.getByRole('switch', { name: 'Surface analysis / progs', exact: true }).click();
  const reads = (await (await request.get('/__test/awc-counts')).json()).progs;
  await page.clock.fastForward(6 * 60_000);
  expect((await (await request.get('/__test/awc-counts')).json()).progs).toBe(reads);
  await page.getByRole('switch', { name: 'Surface analysis / progs', exact: true }).click();
  // WebKit's offline emulation also rejects service-worker responses. Cut the
  // actual origin, as in workspace-restore, and expose the disconnected state.
  await page.addInitScript(() => Object.defineProperty(navigator, 'onLine', { get: () => false }));
  await request.post('/__test/disconnect');
  await expect(request.get('/')).rejects.toThrow();
  await page.reload();
  await expect(page.locator('.app-shell')).toHaveAttribute('aria-busy', 'false', { timeout: 20_000 });
  await page.getByRole('tab', { name: 'Progs', exact: true }).click();
  await expect(page.getByRole('switch', { name: 'Surface analysis / progs', exact: true })).toBeChecked();
  await expect(isobars).not.toBeChecked();
  await expect(page.locator('.awc-progs-frame')).toContainText('Cached / unverified');
  await expect(page.locator('.awc-coverage-status')).toContainText('Shown');
  await expect(page.locator('.awc-coverage-status')).toContainText('Cached / unverified');
});

for (const [width, height] of [[393, 852], [320, 568], [852, 393]] as const) {
  test.describe(`surface controls on phone ${width}×${height}`, () => {
    test.use({ viewport: { width, height }, isMobile: true, hasTouch: true, deviceScaleFactor: 2 });
    if (width === 393) test('touch can pan the hourly scale without moving the selected weather time', async ({ page, browserName }) => {
      test.skip(browserName !== 'chromium', 'Playwright exposes native touch dragging through Chromium CDP');
      await enable(page);
      const rail = page.locator('.awc-time-scroll'), slider = page.getByRole('slider', { name: 'Weather forecast time' });
      const box = (await rail.boundingBox())!, before = (await slider.getAttribute('aria-valuetext'))!;
      const touch = await page.context().newCDPSession(page);
      const drag = async (x: number, y: number, distance: number) => {
        await touch.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x, y }] });
        for (let i = 1; i <= 10; i++) await touch.send('Input.dispatchTouchEvent', {
          type: 'touchMove', touchPoints: [{ x: x + distance * i / 10, y }],
        });
        // End a deliberate drag with the finger stationary, rather than a fling
        // whose follow-up tap Chromium consumes to stop the gesture.
        await page.waitForTimeout(250);
        await touch.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
      };
      await drag(box.x + box.width - 15, box.y + 10, -180);
      expect(await rail.evaluate(e => e.scrollLeft)).toBeGreaterThan(150);
      await expect(slider).toHaveAttribute('aria-valuetext', before);
      await page.getByRole('button', { name: 'Now', exact: true }).tap();
      await expect.poll(() => rail.evaluate(e => e.scrollLeft)).toBe(0);
      const track = (await slider.boundingBox())!;
      await drag(track.x + 8, track.y + 12, 3 * 11);
      await expect(slider).toHaveAttribute('aria-valuetext', 'Sep 23 · 00:00Z');
      const selected = await slider.inputValue();
      await drag(box.x + box.width - 15, track.y + 12, -180);
      expect(await rail.evaluate(e => e.scrollLeft)).toBeGreaterThan(150);
      await expect(slider).toHaveValue(selected);
      await page.getByRole('button', { name: 'Now', exact: true }).tap();
      await expect.poll(() => rail.evaluate(e => e.scrollLeft)).toBe(0);
      await touch.detach();
    });
    test('two product rows, timeline and source status stay inside the map and remain reachable', async ({ page }, testInfo) => {
      await enable(page);
      await page.getByRole('button', { name: 'Next weather time', exact: true }).click();
      await expect(page.locator('.awc-progs-frame')).toContainText('Valid Sep 23 · 00:00Z');
      const tabs = page.getByRole('tablist', { name: 'AWC weather products' });
      expect(await tabs.getByRole('tab').evaluateAll(elements => new Set(elements.map(e => Math.round(e.getBoundingClientRect().top))).size)).toBe(2);
      for (const tab of await tabs.getByRole('tab').all()) {
        await tab.scrollIntoViewIfNeeded(); await expect(tab).toBeInViewport();
        expect((await tab.boundingBox())!.height).toBe(32);
      }
      const body = page.locator('.map-edge-awc .edge-panel-body'), map = (await page.getByLabel('Aviation chart map').boundingBox())!;
      expect((await page.getByRole('button', { name: 'Next weather time', exact: true }).boundingBox())!.height).toBe(32);
      const isobars = page.getByRole('switch', { name: 'Isobars', exact: true });
      await isobars.scrollIntoViewIfNeeded();
      expect((await isobars.boundingBox())!.height).toBe(32);
      const box = (await body.boundingBox())!;
      expect(box.y).toBeGreaterThanOrEqual(map.y);
      expect(box.y + box.height).toBeLessThanOrEqual(map.y + map.height);
      expect(box.width + box.x).toBeLessThanOrEqual(map.width + map.x);
      expect(await body.evaluate(e => e.scrollWidth <= e.clientWidth)).toBe(true);
      await page.locator('.awc-progs-controls .awc-source-status > summary').click();
      await page.getByRole('link', { name: 'NOAA / Weather Prediction Center' }).scrollIntoViewIfNeeded();
      await expect(page.getByRole('link', { name: 'NOAA / Weather Prediction Center' })).toBeInViewport();
      await page.locator('.awc-progs-controls .awc-source-status > summary').click();
      await body.evaluate(e => { e.scrollTop = 0; });
      await page.locator('.awc-tab-content:not([hidden])').evaluate(e => { e.scrollTop = 0; });
      const screenshot = await page.screenshot({ path: testInfo.outputPath('progs-phone.png'), animations: 'disabled' });
      const thumb = await page.evaluate(async png => {
        const slider = document.querySelector<HTMLInputElement>('.awc-time-slider')!, box = slider.getBoundingClientRect();
        const padding = parseFloat(getComputedStyle(slider).paddingBottom);
        const x = box.x + 8 + (Number(slider.value) - Number(slider.min)) / (Number(slider.max) - Number(slider.min)) * (box.width - 16);
        const y = box.y + (box.height - padding) / 2;
        const tick = document.querySelector('.awc-time-mark[data-selected] > i')!.getBoundingClientRect();
        const bitmap = await createImageBitmap(await (await fetch(`data:image/png;base64,${png}`)).blob());
        const canvas = document.createElement('canvas'); canvas.width = bitmap.width; canvas.height = bitmap.height;
        const ctx = canvas.getContext('2d')!; ctx.drawImage(bitmap, 0, 0); bitmap.close();
        const scale = canvas.width / innerWidth, pixels = [];
        // These interior thumb pixels overlap the colored selected tick below
        // the track; the tick must not paint over the circular handle.
        for (const dx of [-1, 0, 1]) for (const dy of [5, 6]) {
          pixels.push([...ctx.getImageData(Math.round((x + dx) * scale), Math.round((y + dy) * scale), 1, 1).data].slice(0, 3));
        }
        return { overlap: tick.top < y + 5 && tick.bottom > y + 6, pixels };
      }, screenshot.toString('base64'));
      expect(thumb.overlap).toBe(true);
      expect(thumb.pixels).toEqual(Array.from({ length: 6 }, () => [133, 230, 219]));
      await page.addStyleTag({ content: '.awc-product-tabs > button { font-size:18px; letter-spacing:.12em; line-height:1.5; }' });
      expect(await tabs.evaluate(e => e.scrollWidth <= e.clientWidth)).toBe(true);
    });
  });
}
