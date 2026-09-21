import { test, expect, type Page } from '@playwright/test';
import { mockGps, sendFix, countWatches, stats } from './ownship-fixture';

test.use({ hasTouch: true });

// Native permission/provider integration stays in this suite. Graphics tests use
// deterministic fixes: Playwright 1.63 Linux WebKit's geolocation override emits
// a timestamp 1000× too large, which the application's freshness checks reject.
test('browser geolocation permission and real watch deliver a fix with unknown velocity', async ({ page, context }) => {
  await context.grantPermissions(['geolocation']);
  await context.setGeolocation({ latitude: 37, longitude: -122, accuracy: 8 });
  await page.goto('/test/browser/ownship.html');
  await expect(page.locator('body')).toHaveAttribute('data-ready', 'true');
  await page.getByRole('switch', { name: 'GPS aircraft' }).click();
  await expect(page.getByLabel('GPS aircraft status')).toContainText('Track unavailable');
  await expect.poll(async () => (await stats(page)).rendered).toContain('ownship-position');
  expect((await stats(page)).rendered).not.toContain('ownship-trace');
  await expect(page.getByTestId('errors')).toBeEmpty();
});

async function openFixture(page: Page) {
  await mockGps(page);
  await page.goto('/test/browser/ownship.html');
  await expect(page.locator('body')).toHaveAttribute('data-ready', 'true');
  await page.getByRole('switch', { name: 'GPS aircraft' }).click();
  await expect.poll(() => countWatches(page)).toBe(1);
}

test('a replacement map centers on a fresh fix; remounting the same map preserves panning', async ({ page }) => {
  await openFixture(page);
  await sendFix(page, { longitude: -119, latitude: 34 });
  await expect.poll(async () => (await stats(page)).center[0]).toBeCloseTo(-119);
  await page.getByRole('button', { name: 'Pan away' }).click();
  await page.getByRole('button', { name: 'Remount', exact: true }).click();
  await sendFix(page, { longitude: -119, latitude: 34 });
  expect((await stats(page)).center[0]).toBeCloseTo(-121.5);
  await page.getByRole('button', { name: 'Replace map' }).click();
  await expect(page.locator('body')).toHaveAttribute('data-ready', 'true');
  await expect.poll(async () => (await stats(page)).center[0]).toBeCloseTo(-122);
  await expect.poll(() => countWatches(page)).toBe(1);
  await sendFix(page, { longitude: -119, latitude: 34 });
  await expect.poll(async () => (await stats(page)).center[0]).toBeCloseTo(-119);
  await expect(page.getByTestId('errors')).toBeEmpty();
});

for (const [longitude, heading] of [[179.99, 90], [-179.99, 270]] as const) {
  test(`dateline crossing at ${longitude} renders the short projection and the nearest world copy`, async ({ page }) => {
    await openFixture(page);
    await page.evaluate(lng => window.ownshipFixture.camera({ center: [lng, 60] }), longitude + 360);
    await sendFix(page, { longitude, latitude: 60, heading, speed: 100 });
    await expect.poll(async () => (await stats(page)).moving).toBe(false);
    await expect.poll(async () => (await stats(page)).rendered).toContain('ownship-trace');
    const rendered = await stats(page);
    // MapLibre wraps longitude on moveend. Verify that the animation stayed
    // nearby instead of panning across a world, independent of final wrapping.
    const relative = (lng: number) => ((lng - longitude + 540) % 360) - 180;
    expect(relative(rendered.center[0])).toBeCloseTo(0);
    expect(rendered.movement.every(lng => Math.abs(relative(lng)) < 1)).toBe(true);
    const line = (rendered.geometry as GeoJSON.FeatureCollection).features
      .find(feature => feature.properties?.kind === 'projection')!.geometry as GeoJSON.LineString;
    expect(Math.abs(line.coordinates.at(-1)![0]! - longitude)).toBeLessThan(1);
    expect(rendered.rendered).toContain('ownship-aircraft');
    await expect(page.getByTestId('errors')).toBeEmpty();
  });
}

test('low accuracy, stopped and unknown velocity fixes remove the aircraft and vector appropriately', async ({ page }) => {
  await openFixture(page);
  await sendFix(page);
  await expect.poll(async () => (await stats(page)).rendered).toContain('ownship-aircraft');
  for (const coords of [{ accuracy: 1500 }, { speed: 0 }, { heading: null, speed: null }]) {
    await sendFix(page, coords);
    await expect.poll(async () => (await stats(page)).rendered).toContain('ownship-position');
    await expect.poll(async () => (await stats(page)).rendered).not.toContain('ownship-aircraft');
    await expect.poll(async () => (await stats(page)).rendered).not.toContain('ownship-trace');
  }
  await sendFix(page, { heading: 359, speed: 80 });
  await page.evaluate(() => window.ownshipFixture.camera({ bearing: -45, pitch: 50 }));
  await expect.poll(async () => (await stats(page)).rendered).toContain('ownship-aircraft');
  await expect(page.getByLabel('GPS aircraft status')).toContainText('359°T');
  await expect(page.getByTestId('errors')).toBeEmpty();
});

test('hiding pauses location and clears geometry; resuming starts one fresh watch', async ({ page }) => {
  await openFixture(page);
  await sendFix(page);
  await expect.poll(async () => (await stats(page)).rendered).toContain('ownship-aircraft');
  await page.evaluate(() => {
    Object.defineProperty(document, 'hidden', { configurable: true, value: true });
    document.dispatchEvent(new Event('visibilitychange'));
  });
  await expect.poll(() => countWatches(page)).toBe(0);
  await expect(page.getByLabel('GPS aircraft status')).toContainText('paused');
  expect(((await stats(page)).geometry as GeoJSON.FeatureCollection).features).toEqual([]);
  await page.evaluate(() => {
    Object.defineProperty(document, 'hidden', { configurable: true, value: false });
    document.dispatchEvent(new Event('visibilitychange'));
  });
  await expect.poll(() => countWatches(page)).toBe(1);
  await expect(page.getByLabel('GPS aircraft status')).toContainText('Waiting');
  await sendFix(page);
  await expect.poll(async () => (await stats(page)).rendered).toContain('ownship-aircraft');
  await expect(page.getByTestId('errors')).toBeEmpty();
});

test('native browser geolocation supplies track and speed and observes revoked permission', async ({ page, context }) => {
  await context.grantPermissions(['geolocation']);
  const session = await context.newCDPSession(page);
  await session.send('Emulation.setGeolocationOverride', { latitude: 37, longitude: -122, accuracy: 8, heading: 270, speed: 50 });
  await page.goto('/test/browser/ownship.html');
  await expect(page.locator('body')).toHaveAttribute('data-ready', 'true');
  await page.getByRole('switch', { name: 'GPS aircraft' }).click();
  await expect(page.getByLabel('GPS aircraft status')).toContainText('270°T · 97 kt');
  await expect.poll(async () => (await stats(page)).rendered).toContain('ownship-aircraft');
  const { targetInfo } = await session.send('Target.getTargetInfo');
  if (!targetInfo.browserContextId) throw new Error('Missing isolated test browser context');
  await session.send('Browser.setPermission', {
    permission: { name: 'geolocation' }, setting: 'denied', origin: new URL(page.url()).origin,
    browserContextId: targetInfo.browserContextId,
  });
  expect(await page.evaluate(async () => (await navigator.permissions.query({ name: 'geolocation' })).state)).toBe('denied');
  await session.send('Emulation.setGeolocationOverride', { latitude: 37, longitude: -122.001, accuracy: 8, heading: 270, speed: 50 });
  await expect(page.getByLabel('GPS aircraft status')).toContainText('Location denied', { timeout: 20_000 });
  expect(((await stats(page)).geometry as GeoJSON.FeatureCollection).features).toEqual([]);
  await expect(page.getByTestId('errors')).toBeEmpty();
  await session.detach();
});

test('GPS layer and map label font load on a cold offline PWA page', async ({ page, context }) => {
  await mockGps(page);
  await page.addInitScript(() => localStorage.setItem('zlayers-map-preferences-v1',
    JSON.stringify({ version: 2, chartBase: '', ownshipEnabled: true })));
  await page.goto('/');
  await page.waitForFunction(() => !!navigator.serviceWorker.controller);
  await expect.poll(() => countWatches(page)).toBe(1);
  await sendFix(page);
  await expect(page.getByLabel('GPS aircraft status')).toContainText('120 kt');
  await context.setOffline(true);
  const cold = await context.newPage();
  await mockGps(cold);
  await page.close();
  await cold.goto('/');
  await expect.poll(() => countWatches(cold)).toBe(1);
  await sendFix(cold, { heading: 180, speed: 90 });
  await expect(cold.getByLabel('GPS aircraft status')).toContainText('180°T · 175 kt');
  expect(await cold.evaluate(async () => (await fetch('/fonts/Noto%20Sans%20Bold/0-255.pbf')).ok)).toBe(true);
  await expect(cold.locator('.maplibregl-ctrl-zoom-in')).toBeVisible();
});

for (const [width, height] of [[320, 568], [568, 320]] as const) {
  test(`GPS status and recovery controls fit at ${width}×${height}`, async ({ page }) => {
    await page.setViewportSize({ width, height });
    await mockGps(page);
    await page.addInitScript(() => localStorage.setItem('zlayers-map-preferences-v1',
      JSON.stringify({ version: 2, chartBase: '', ownshipEnabled: true })));
    await page.goto('/');
    await expect.poll(() => countWatches(page)).toBe(1);
    await sendFix(page);
    const map = (await page.getByLabel('Aviation chart map').boundingBox())!;
    await page.getByRole('button', { name: 'Hide terrain toolbox', exact: true }).tap();
    await page.getByRole('button', { name: 'Show GPS status', exact: true }).tap();
    const toggle = page.getByRole('switch', { name: 'GPS aircraft' });
    await expect(toggle).toHaveAttribute('aria-checked', 'true');
    const toggleBox = (await toggle.boundingBox())!;
    expect(toggleBox.height).toBeGreaterThanOrEqual(44);
    expect(toggleBox.width).toBeGreaterThanOrEqual(44);
    await toggle.click({ trial: true });
    for (const label of ['Center aircraft', 'Retry GPS']) {
      if (label === 'Retry GPS') await page.evaluate(() => window.dispatchEvent(new CustomEvent('test-gps-error', { detail: 1 })));
      const button = page.getByRole('button', { name: label, exact: true });
      await expect(button).toBeVisible();
      const box = (await button.boundingBox())!;
      expect(box.height).toBeGreaterThanOrEqual(44);
      expect(box.y + box.height).toBeLessThanOrEqual(map.y + map.height);
      expect(box.x + box.width).toBeLessThanOrEqual(width);
      await button.click({ trial: true });
    }
  });
}
