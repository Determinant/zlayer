import { test, expect } from '@playwright/test';
import { WEATHER_NOW } from '../fixtures/awc-advisories';

test.beforeEach(async ({ request, page }) => { await request.post('/__test/reset'); await page.clock.install({ time: WEATHER_NOW }); });

test('prepared composite and terminal contours render together, survive style recovery and clear for forecast time', async ({ page }, testInfo) => {
  const raw: string[] = [];
  page.on('request', r => { if (/noaa-mrms-pds|tgftp.nws.noaa.gov/.test(r.url())) raw.push(r.url()); });
  await page.goto('/test/browser/weather-progs.html');
  await expect.poll(() => page.evaluate(() => window.progsMapAudit.map.loaded())).toBe(true);
  await page.evaluate(() => { window.progsMapAudit.change({ awcRadar: true, awcProgs: false }); window.progsMapAudit.map.setZoom(7.5); });
  await expect.poll(() => page.evaluate(() => window.progsMapAudit.state().radarDisplay.sites)).toEqual(['CONUS', 'TOKC']);
  await expect.poll(() => page.evaluate(() => window.progsMapAudit.map.queryRenderedFeatures(undefined, { layers: window.progsMapAudit.map.getStyle().layers.filter(layer => layer.id.startsWith('weather-awc-radar-fill')).map(layer => layer.id) }).some(f => f.properties.dbz === 55))).toBe(true);
  await page.screenshot({ path: testInfo.outputPath('combined-radar.png') });
  const past = await page.evaluate(() => window.progsMapAudit.state().radar.snapshot!.history!.find(f => f.site === 'CONUS')!.observedAt);
  await page.evaluate(time => window.progsMapAudit.select(time), past);
  await expect.poll(() => page.evaluate(() => window.progsMapAudit.state().radarDisplay.sites)).toEqual(['CONUS', 'TOKC']);
  await expect.poll(() => page.evaluate(() => {
    const data = window.progsMapAudit.map.getSource('weather-awc-radar')!.serialize().data as { features: { geometry: { coordinates: number[][][][] } }[] };
    return data.features[0]?.geometry.coordinates[0]?.[0]?.[0]?.[0];
  })).toBeCloseTo(-122.3 + 92 / 300, 5);
  await page.evaluate(() => window.progsMapAudit.recover());
  await expect.poll(() => page.evaluate(() => window.progsMapAudit.state().radarDisplay.sites)).toEqual(['CONUS', 'TOKC']);
  expect(await page.evaluate(() => window.progsMapAudit.state().selectedTime)).toBe(past);
  await page.evaluate(() => window.progsMapAudit.change({ awcProgs: true }));
  await expect.poll(() => page.evaluate(() => window.progsMapAudit.state().progs.forecast.snapshot?.frames.length ?? 0)).toBeGreaterThan(0);
  await page.evaluate(() => window.progsMapAudit.select(window.progsMapAudit.state().progs.forecast.snapshot!.frames.at(-1)!.validTime));
  await expect.poll(() => page.evaluate(() => window.progsMapAudit.state().radarDisplay.sites)).toEqual([]);
  await expect.poll(() => page.evaluate(() => window.progsMapAudit.map.queryRenderedFeatures(undefined, { layers: window.progsMapAudit.map.getStyle().layers.filter(layer => layer.id.startsWith('weather-awc-radar-fill')).map(layer => layer.id) }).length)).toBe(0);
  await page.evaluate(() => window.progsMapAudit.select(null));
  await expect.poll(() => page.evaluate(() => window.progsMapAudit.state().radarDisplay.sites)).toEqual(['CONUS', 'TOKC']);
  await page.clock.fastForward(16 * 60_000);
  await expect.poll(() => page.evaluate(() => window.progsMapAudit.state().radarDisplay.sites)).toEqual([]);
  expect(raw).toEqual([]); expect(await page.evaluate(() => window.progsMapAudit.errors)).toEqual([]);
});

test('terminal radar follows the visible world copy without reloading the scans', async ({ page }) => {
  const files: string[] = [];
  page.on('request', request => { if (/\/radar\/(CONUS|T\w{3})\//.test(request.url())) files.push(request.url()); });
  await page.goto('/test/browser/weather-progs.html');
  await expect.poll(() => page.evaluate(() => window.progsMapAudit.map.loaded())).toBe(true);
  await page.evaluate(() => {
    window.progsMapAudit.change({ awcRadar: true, awcProgs: false });
    window.progsMapAudit.map.jumpTo({ center: [-122, 37.3], zoom: 7.5 });
  });
  await expect.poll(() => page.evaluate(() => window.progsMapAudit.state().radarDisplay.sites)).toEqual(['CONUS', 'TOKC']);
  const loaded = [...files];
  for (const longitude of [238, -482, -122]) {
    await page.evaluate(longitude => window.progsMapAudit.map.jumpTo({ center: [longitude, 37.3] }), longitude);
    await expect.poll(() => page.evaluate(() => window.progsMapAudit.state().radarDisplay.sites)).toEqual(['CONUS', 'TOKC']);
    await expect.poll(() => page.evaluate(() => window.progsMapAudit.map.queryRenderedFeatures(undefined, {
      layers: window.progsMapAudit.map.getStyle().layers.filter(layer => layer.id.startsWith('weather-awc-radar-fill')).map(layer => layer.id),
    }).some(feature => feature.properties.dbz === 55))).toBe(true);
  }
  expect(files).toEqual(loaded);
  expect(await page.evaluate(() => window.progsMapAudit.errors)).toEqual([]);
});

for (const size of [{ width: 393, height: 852 }, { width: 320, height: 568 }, { width: 852, height: 393 }]) {
  test(`six slim tabs and radar controls fit ${size.width}×${size.height}`, async ({ page }, testInfo) => {
    await page.setViewportSize(size); await page.goto('/');
    await expect(page.locator('.app-shell')).toHaveAttribute('aria-busy', 'false');
    await page.getByRole('button', { name: 'Show AWC Weather toolbox', exact: true }).click();
    await page.getByRole('switch', { name: 'Show AWC weather', exact: true }).click();
    const tabs = page.getByRole('tablist', { name: 'AWC weather products' });
    await expect(tabs.getByRole('tab')).toHaveText(['Advis.', 'Progs', 'Radar', 'Cloud', 'Icing', 'Winds']);
    const boxes = await tabs.getByRole('tab').evaluateAll(elements => elements.map(e => { const b = e.getBoundingClientRect(); return { x: b.x, y: b.y, height: b.height }; }));
    expect(boxes[0]!.y).toBe(boxes[2]!.y); expect(boxes[3]!.y).toBe(boxes[5]!.y); expect(boxes[3]!.y).toBeGreaterThan(boxes[0]!.y);
    expect(boxes.every(b => b.height === 32)).toBe(true);
    await page.getByRole('tab', { name: 'Radar', exact: true }).click();
    await page.getByRole('switch', { name: 'Radar mosaic', exact: true }).click();
    await expect(page.locator('.awc-radar-controls')).toContainText('Composite Sep 22');
    await expect(page.getByRole('tab', { name: 'Radar', exact: true })).toHaveAttribute('data-active', 'true');
    expect(await tabs.evaluate(e => e.scrollWidth <= e.clientWidth)).toBe(true);
    const radarText = await page.locator('.awc-radar-frame').evaluate(e => ({
      font: getComputedStyle(e).font, small: getComputedStyle(e.querySelector('small')!).font,
    }));
    await page.getByRole('tab', { name: 'Progs', exact: true }).click();
    await page.getByRole('switch', { name: 'Surface analysis / progs', exact: true }).click();
    await expect(page.locator('.awc-progs-frame')).toContainText('Valid Sep 22');
    expect(await page.locator('.awc-progs-frame').evaluate(e => ({
      font: getComputedStyle(e).font, small: getComputedStyle(e.querySelector('small')!).font,
    }))).toEqual(radarText);
    await page.getByRole('tab', { name: 'Radar', exact: true }).click();
    const slider = page.getByRole('slider', { name: 'Weather forecast time' });
    const previous = page.getByRole('button', { name: 'Previous weather time', exact: true });
    const next = page.getByRole('button', { name: 'Next weather time', exact: true });
    await previous.click();
    await expect(page.locator('.awc-radar-frame strong')).toHaveText('Radar history');
    await expect(slider).toHaveAttribute('aria-valuetext', 'Sep 22 · 20:58Z');
    await previous.click(); await expect(slider).toHaveAttribute('aria-valuetext', 'Sep 22 · 20:46Z');
    await next.click(); await next.click();
    await expect(page.getByRole('button', { name: 'Now', exact: true })).toHaveAttribute('aria-pressed', 'true');
    await slider.press('Home'); await expect(slider).toHaveAttribute('aria-valuetext', 'Sep 22 · 19:26Z');
    await expect(previous).toBeDisabled();
    await expect.poll(() => slider.evaluate(input => {
      const range = input as HTMLInputElement, box = range.getBoundingClientRect(), view = range.closest('.awc-time-scroll')!.getBoundingClientRect();
      const x = box.x + 8 + Number(range.value) / Number(range.max) * (box.width - 16);
      return x >= view.left + 8 && x <= view.right - 8;
    })).toBe(true);
    await page.screenshot({ path: testInfo.outputPath('radar-history-phone.png') });
    await page.getByRole('button', { name: 'Now', exact: true }).click();
    await next.click(); await expect(page.locator('.awc-radar-frame')).toContainText('No radar forecast');
    await page.getByRole('button', { name: 'Now', exact: true }).click();
    await page.screenshot({ path: testInfo.outputPath('radar-phone.png') });
  });
}

test('radar reopens from whole-file storage offline and expires without a refreshed observation', async ({ page, request }) => {
  await page.goto('/');
  await expect(page.locator('.app-shell')).toHaveAttribute('aria-busy', 'false');
  await page.getByRole('button', { name: 'Show AWC Weather toolbox', exact: true }).click();
  await page.getByRole('switch', { name: 'Show AWC weather', exact: true }).click();
  await page.getByRole('tab', { name: 'Radar', exact: true }).click();
  await page.getByRole('switch', { name: 'Radar mosaic', exact: true }).click();
  const frame = page.locator('.awc-radar-frame');
  await expect(frame).toContainText('Shown: CONUS');
  const saved = await page.evaluate(() => localStorage.getItem('zlayer-plugin:weather-awc:radar'));
  expect(saved).toBeTruthy();
  // Display readiness precedes optional publication. Wait for the national file
  // before discarding the page, its clients and all decoded geometry.
  await expect.poll(() => page.evaluate(async () => (await (await caches.open('zlayers-plugin-files-v1:weather-awc:radar')).keys())
    .some(key => key.url.includes('/CONUS/')))).toBe(true);
  await page.waitForFunction(() => !!navigator.serviceWorker.controller);
  await page.addInitScript(() => Object.defineProperty(navigator, 'onLine', { get: () => false }));
  await request.post('/__test/disconnect');
  await expect(request.get('/')).rejects.toThrow();
  await page.reload();
  await expect(page.locator('.app-shell')).toHaveAttribute('aria-busy', 'false');
  await page.getByRole('tab', { name: 'Radar', exact: true }).click();
  await expect(page.getByRole('switch', { name: 'Radar mosaic', exact: true })).toBeChecked();
  await expect(frame).toContainText('Shown: CONUS');
  expect(await page.evaluate(() => localStorage.getItem('zlayer-plugin:weather-awc:radar'))).toBe(saved);
  await page.clock.fastForward(16 * 60_000);
  await expect(frame).toContainText('No current national radar');
  await expect(frame).not.toContainText('Shown:');
});
