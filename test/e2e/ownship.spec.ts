import { test, expect } from '@playwright/test';
import { mockGps, sendFix, countWatches, stats } from './ownship-fixture';

test.use({ hasTouch: true });

test('aircraft and 1 min vector render through MapLibre, stay aligned on rotation, expire and remount', { tag: '@smoke' }, async ({ page }, testInfo) => {
  await page.clock.install();
  const errors: string[] = [];
  page.on('pageerror', error => errors.push(error.message));
  await mockGps(page);
  await page.goto('/test/browser/ownship.html');
  await expect(page.locator('body')).toHaveAttribute('data-ready', 'true');
  await expect.poll(() => countWatches(page)).toBe(0);
  await page.getByRole('switch', { name: 'GPS aircraft' }).click();
  await expect.poll(() => countWatches(page)).toBe(1);
  await sendFix(page);
  await expect(page.getByLabel('GPS aircraft status')).toContainText('090°T · 120 kt · ±5 m');
  await expect.poll(async () => (await stats(page)).rendered).toContain('ownship-aircraft');
  await expect.poll(async () => (await stats(page)).rendered).toContain('ownship-trace');
  await expect(page.getByTestId('errors')).toBeEmpty();
  const nosePixels = () => page.locator('.maplibregl-canvas').evaluate(element => {
    const canvas = element as HTMLCanvasElement, gl = canvas.getContext('webgl2')!;
    const ratio = canvas.width / canvas.clientWidth;
    return [[14, 0], [0, -14]].map(([dx, dy]) => {
      const pixel = new Uint8Array(4);
      gl.readPixels(Math.floor(canvas.width / 2 + dx! * ratio),
        Math.floor(canvas.height / 2 - dy! * ratio) - 1, 1, 1, gl.RGBA, gl.UNSIGNED_BYTE, pixel);
      return pixel[2]! - pixel[0]! > 100; // Blue aircraft nose, not the neutral background.
    });
  });
  await expect.poll(nosePixels).toEqual([true, false]);
  await page.screenshot({ path: testInfo.outputPath('gps-east.png') });
  await page.getByRole('button', { name: 'Rotate map' }).click();
  await expect.poll(async () => (await stats(page)).bearing).toBe(90);
  const rotated = await stats(page);
  expect(rotated.alignment).toBe('map');
  expect(rotated.rotation).toEqual(['get', 'track']);
  await expect.poll(nosePixels).toEqual([false, true]);
  await page.screenshot({ path: testInfo.outputPath('gps-rotated.png') });
  await page.getByRole('button', { name: 'Pan away' }).click();
  await sendFix(page, { longitude: -122.001 });
  expect((await stats(page)).center[0]).toBeCloseTo(-121.5);
  await page.getByRole('button', { name: 'Center aircraft' }).click();
  await expect.poll(async () => (await stats(page)).center[0]).toBeCloseTo(-122.001);
  await sendFix(page);
  await page.clock.fastForward(10_001);
  await expect(page.getByLabel('GPS aircraft status')).toContainText('GPS fix stale');
  await expect.poll(async () => (await stats(page)).rendered).not.toContain('ownship-aircraft');
  await expect.poll(async () => (await stats(page)).rendered).toContain('ownship-position');
  const stale = (await stats(page)).geometry as GeoJSON.FeatureCollection;
  expect(stale.features.some(feature => feature.properties?.kind === 'projection')).toBe(false);
  await page.getByRole('button', { name: 'Remount' }).click();
  await expect.poll(() => countWatches(page)).toBe(1);
  await sendFix(page, { heading: 0 });
  await expect(page.getByLabel('GPS aircraft status')).toContainText('000°T');
  await expect.poll(async () => (await stats(page)).rendered).toContain('ownship-aircraft');
  await page.getByRole('switch', { name: 'GPS aircraft' }).click();
  await expect.poll(() => countWatches(page)).toBe(0);
  await expect.poll(async () => ((await stats(page)).geometry as GeoJSON.FeatureCollection).features.length).toBe(0);
  await expect(page.getByTestId('errors')).toBeEmpty();
  expect(errors).toEqual([]);
});

for (const rate of [-1, 1]) {
  test(`the blue track vector curves ${rate < 0 ? 'left' : 'right'} while ownship stays at the current fix`, async ({ page }, testInfo) => {
    await page.clock.install();
    await mockGps(page);
    await page.goto('/test/browser/ownship.html');
    await expect(page.locator('body')).toHaveAttribute('data-ready', 'true');
    await page.clock.pauseAt(await page.evaluate(() => Date.now()) + 1000);
    await page.getByRole('switch', { name: 'GPS aircraft' }).click();
    await sendFix(page, { heading: 90 - 2 * rate });
    for (const second of [1, 2]) {
      await page.clock.runFor(1000);
      await sendFix(page, { heading: 90 + (second - 2) * rate });
    }
    await page.clock.resume();
    await expect.poll(async () => (await stats(page)).turnRate).toBeCloseTo(rate, 8);
    await expect.poll(async () => (await stats(page)).rendered).toContain('ownship-trace');
    const geometry = (await stats(page)).geometry as GeoJSON.FeatureCollection;
    const aircraft = geometry.features.find(feature => feature.properties?.kind === 'aircraft')!;
    const trace = geometry.features.find(feature => feature.properties?.kind === 'projection')!.geometry as GeoJSON.LineString;
    expect(aircraft.geometry).toEqual({ type: 'Point', coordinates: [-122, 37] });
    expect(aircraft.properties?.track).toBe(90);
    expect(trace.coordinates[0]).toEqual([-122, 37]);
    expect(trace.coordinates.at(-1)![0]).toBeGreaterThan(-122);
    expect(Math.sign(trace.coordinates.at(-1)![1]! - 37)).toBe(-rate);
    expect(geometry.features.filter(feature => feature.geometry.type === 'Point')).toHaveLength(1);
    // Sample the real WebGL output along the outer half of the arc. A dashed
    // line or a straight vector cannot fill this continuous curve in blue.
    await expect.poll(() => page.evaluate(coordinates => {
      const canvas = document.querySelector<HTMLCanvasElement>('.maplibregl-canvas')!;
      const gl = canvas.getContext('webgl2')!, ratio = canvas.width / canvas.clientWidth;
      return coordinates.every(coordinate => {
        const { x, y } = window.ownshipFixture.project(coordinate as [number, number]);
        const pixel = new Uint8Array(4);
        gl.readPixels(Math.floor(x * ratio), canvas.height - Math.floor(y * ratio) - 1, 1, 1, gl.RGBA, gl.UNSIGNED_BYTE, pixel);
        return pixel[2]! - pixel[0]! > 100;
      });
    }, trace.coordinates.slice(Math.ceil(trace.coordinates.length / 2), -1))).toBe(true);
    await page.screenshot({ path: testInfo.outputPath(`gps-turn-${rate < 0 ? 'left' : 'right'}.png`) });
    await expect(page.getByTestId('errors')).toBeEmpty();
  });
}

test('GPS starts enabled and its toolbox toggle persists through denial, offline updates and reloads on a phone', async ({ page }, testInfo) => {
  await page.setViewportSize({ width: 393, height: 852 });
  await mockGps(page);
  await page.addInitScript(() => {
    // This scenario uses the base map so chart-cache setup does not obscure GPS.
    if (!localStorage.getItem('zlayers-map-preferences-v1')) {
      localStorage.setItem('zlayers-map-preferences-v1', JSON.stringify({ version: 2, chartBase: '' }));
    }
  });
  await page.goto('/');
  await expect(page.locator('.maplibregl-ctrl-zoom-in')).toBeVisible();
  await page.getByRole('button', { name: 'Open map layers', exact: true }).click();
  await expect(page.getByRole('dialog', { name: 'Map layers' }).getByRole('switch', { name: 'GPS aircraft' })).toHaveCount(0);
  await page.getByRole('button', { name: 'Close map layers', exact: true }).click();
  await page.getByRole('button', { name: 'Show GPS status', exact: true }).click();
  const toggle = page.getByRole('switch', { name: 'GPS aircraft' });
  await expect(toggle).toHaveAttribute('aria-checked', 'true');
  await expect.poll(() => countWatches(page)).toBe(1);
  await toggle.scrollIntoViewIfNeeded();
  expect((await toggle.boundingBox())!.height).toBeGreaterThanOrEqual(44);
  await page.screenshot({ path: testInfo.outputPath('gps-toolbox-phone.png') });
  await page.evaluate(() => window.dispatchEvent(new CustomEvent('test-gps-error', { detail: 1 })));
  await expect(page.getByLabel('GPS aircraft status')).toContainText('Location denied');
  await expect.poll(() => countWatches(page)).toBe(0);
  await page.getByRole('button', { name: 'Retry GPS' }).click();
  await expect.poll(() => countWatches(page)).toBe(1);
  await sendFix(page, { longitude: -119.84, latitude: 34.42 });
  await expect(page.getByLabel('GPS aircraft status')).toContainText('120 kt');
  const center = page.getByRole('button', { name: 'Center aircraft' });
  expect((await center.boundingBox())!.height).toBeGreaterThanOrEqual(44);
  // MapLibre's initial 500 ms camera animation is independent of CSS animations.
  await page.waitForTimeout(600);
  await page.screenshot({ path: testInfo.outputPath('gps-phone.png') });
  await page.context().setOffline(true);
  await sendFix(page, { longitude: -119.838, latitude: 34.42, heading: 95, speed: 80 });
  await expect(page.getByLabel('GPS aircraft status')).toContainText('095°T · 156 kt');
  await page.context().setOffline(false);
  await page.reload();
  await expect.poll(() => countWatches(page)).toBe(1);
  await expect(toggle).toHaveAttribute('aria-checked', 'true');
  await toggle.click();
  await expect.poll(() => countWatches(page)).toBe(0);
  await expect(toggle).toHaveAttribute('aria-checked', 'false');
  await expect(page.getByLabel('GPS aircraft status')).toBeVisible();
  await expect(page.getByRole('button', { name: 'Center aircraft', exact: true })).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Retry GPS', exact: true })).toHaveCount(0);
  await page.reload();
  await expect(page.locator('.maplibregl-ctrl-zoom-in')).toBeVisible();
  await expect.poll(() => countWatches(page)).toBe(0);
  await expect(toggle).toHaveAttribute('aria-checked', 'false');
  await page.getByRole('button', { name: 'Hide GPS status', exact: true }).click();
  await page.getByRole('button', { name: 'Show GPS status', exact: true }).click();
  await toggle.click();
  await expect.poll(() => countWatches(page)).toBe(1);
  await sendFix(page);
  await expect(page.getByLabel('GPS aircraft status')).toContainText('120 kt');
});
