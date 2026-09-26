import { expect, test, type Page } from '@playwright/test';
import { MercatorCoordinate } from 'maplibre-gl';
import { countWatches, mockGps, sendFix } from './ownship-fixture';

const camera = (page: Page) => page.evaluate(() => JSON.parse(localStorage.getItem('zlayers-map-view-v1')!) as {
  center: [number, number]; zoom: number; bearing: number;
});
const bearing = (page: Page) => camera(page).then(view => (view.bearing + 360) % 360);
async function expectCenter(page: Page, longitude: number, latitude = 37) {
  await expect.poll(async () => (await camera(page)).center[0]).toBeCloseTo(longitude, 6);
  await expect.poll(async () => (await camera(page)).center[1]).toBeCloseTo(latitude, 6);
}

async function expectRouteFits(page: Page, coordinates: [number, number][], expectedBearing: number) {
  const canvas = (await page.locator('.maplibregl-canvas').boundingBox())!;
  await expect.poll(async () => {
    const view = await camera(page);
    if (Math.abs(view.bearing - expectedBearing) > 0.01) return false;
    // Project the persisted, unpitched camera so the check includes the rotation
    // after fitBounds completes, without exposing production map internals.
    const center = MercatorCoordinate.fromLngLat(view.center);
    const scale = 512 * 2 ** view.zoom;
    const radians = view.bearing * Math.PI / 180;
    return coordinates.every(coordinate => {
      const point = MercatorCoordinate.fromLngLat(coordinate);
      const dx = (point.x - center.x) * scale, dy = (point.y - center.y) * scale;
      const x = canvas.width / 2 + dx * Math.cos(radians) + dy * Math.sin(radians);
      const y = canvas.height / 2 - dx * Math.sin(radians) + dy * Math.cos(radians);
      return x >= 71 && x <= canvas.width - 71 && y >= 71 && y <= canvas.height - 71;
    });
  }, { message: 'Both route endpoints retain the 72px fit padding at the final bearing' }).toBe(true);
}

test.beforeEach(async ({ page }) => {
  await mockGps(page);
  await page.addInitScript(() => {
    if (!localStorage.getItem('zlayers-map-preferences-v1')) localStorage.setItem('zlayers-map-preferences-v1',
      JSON.stringify({ version: 2, chartBase: '', ownshipEnabled: true }));
  });
  await page.goto('/');
  await expect(page.getByRole('group', { name: 'Map navigation', exact: true })).toBeVisible();
  await expect.poll(() => countWatches(page)).toBe(1);
});

test('zoom and orientation align to the left of Layers on desktop and touch screens', async ({ page }, testInfo) => {
  for (const [width, height] of [[1440, 900], [320, 568], [568, 320]] as const) {
    await page.setViewportSize({ width, height });
    const layers = page.getByRole('button', { name: 'Open map layers', exact: true });
    const layerBox = (await layers.boundingBox())!;
    const controls = page.getByRole('group', { name: 'Map navigation', exact: true });
    const boxes = await controls.getByRole('button').evaluateAll(buttons => buttons.map(button => {
      const { x, y, width, height } = button.getBoundingClientRect();
      return { x, y, width, height };
    }));
    expect(boxes).toHaveLength(3);
    for (const [index, box] of boxes.entries()) {
      expect(box.width).toBeGreaterThanOrEqual(44);
      expect(box.height).toBe(44);
      expect(box.y).toBe(layerBox.y);
      expect(box.x).toBeGreaterThanOrEqual(0);
      if (index > 0) expect(box.x).toBe(boxes[index - 1]!.x + boxes[index - 1]!.width);
    }
    expect(layerBox.x - (boxes[2]!.x + boxes[2]!.width)).toBe(9);
    await expect(page.locator('.maplibregl-ctrl-compass')).toHaveCount(0);
    await page.screenshot({ path: testInfo.outputPath(`map-navigation-${width}.png`) });
    await layers.click();
    const menu = page.getByRole('dialog', { name: 'Map layers', exact: true });
    await expect(menu).toBeVisible();
    expect((await menu.boundingBox())!.y).toBeGreaterThanOrEqual(layerBox.y + layerBox.height);
    await controls.getByRole('button', { name: 'Track up', exact: true }).click({ trial: true });
    await page.getByRole('button', { name: 'Close map layers', exact: true }).click();
  }
});

test('track up centers each fresh fix, preserves zoom, and stops following in north up', async ({ page }) => {
  const toggle = page.getByRole('button', { name: 'Track up', exact: true });
  await page.clock.install();
  await expect(toggle).toHaveAttribute('aria-pressed', 'false');
  await sendFix(page);
  await expect.poll(async () => (await camera(page)).zoom).toBe(9);
  await toggle.click();
  await expect(toggle).toHaveAttribute('aria-pressed', 'true');
  await expect.poll(() => bearing(page)).toBeCloseTo(90);
  await page.getByRole('button', { name: 'Zoom in', exact: true }).click();
  await expect.poll(async () => (await camera(page)).zoom).toBe(10);

  const canvas = (await page.locator('.maplibregl-canvas').boundingBox())!;
  await page.mouse.move(canvas.x + canvas.width / 2, canvas.y + canvas.height / 2);
  await page.mouse.down();
  await page.mouse.move(canvas.x + canvas.width / 2 + 100, canvas.y + canvas.height / 2 + 50, { steps: 10 });
  await page.mouse.up();
  // Wait for pan inertia before comparing the camera against later GPS fixes.
  await expect.poll(async () => (await camera(page)).center[0]).not.toBeCloseTo(-122);
  await page.getByRole('button', { name: 'Zoom out', exact: true }).click();
  await expect.poll(async () => (await camera(page)).zoom).toBe(9);
  const panned = await camera(page);
  for (const heading of [350, 10]) {
    await sendFix(page, { heading, longitude: -121.9, latitude: 37.1 });
    await expect.poll(() => bearing(page)).toBeCloseTo(heading);
    await expectCenter(page, -121.9, 37.1);
    expect((await camera(page)).zoom).toBe(panned.zoom);
  }
  // Position following must also work when the ground track has not changed.
  await sendFix(page, { heading: 10, longitude: -121.8, latitude: 37.2 });
  await expectCenter(page, -121.8, 37.2);
  expect((await camera(page)).zoom).toBe(panned.zoom);

  // A stationary position is usable even though it has no ground track.
  await sendFix(page, { heading: null, speed: 0, longitude: -121.7 });
  await expect(toggle).toHaveAttribute('aria-description', /Waiting for GPS track/);
  await expectCenter(page, -121.7);
  expect(await bearing(page)).toBeCloseTo(10);
  const held = await camera(page);
  await sendFix(page, { heading: 80, accuracy: 500 });
  await expect(toggle).toHaveAttribute('aria-description', /Waiting for GPS track/);
  expect(await camera(page)).toEqual(held);
  await sendFix(page, { heading: 120 });
  await expect.poll(() => bearing(page)).toBeCloseTo(120);
  await page.clock.fastForward(10_001);
  await expect(toggle).toHaveAttribute('aria-description', /Waiting for GPS track/);
  expect(await bearing(page)).toBeCloseTo(120);
  await expectCenter(page, -122);
  await sendFix(page, { heading: 180, longitude: -121.6 });
  await expect.poll(() => bearing(page)).toBeCloseTo(180);
  await expectCenter(page, -121.6);
  await expect(toggle).not.toHaveClass(/is-waiting/);
  expect(await countWatches(page)).toBe(1);

  await toggle.focus();
  await toggle.press('Enter');
  await expect(toggle).toHaveAttribute('aria-pressed', 'false');
  await expect.poll(() => bearing(page)).toBeCloseTo(0);
  await sendFix(page, { heading: 270, longitude: -121.5 });
  expect(await bearing(page)).toBeCloseTo(0);
  await expectCenter(page, -121.6);
  await toggle.click();
  await expectCenter(page, -121.5);
  await expect.poll(() => bearing(page)).toBeCloseTo(270);
});

test('GPS loss cancels a follow animation and holds the camera until a fresh fix', async ({ page }) => {
  const toggle = page.getByRole('button', { name: 'Track up', exact: true });
  await page.clock.install();
  await sendFix(page);
  await expect.poll(async () => (await camera(page)).zoom).toBe(9);
  await toggle.click();
  await expect.poll(() => bearing(page)).toBeCloseTo(90);
  const held = await camera(page);
  // Deliver an acquisition error before the new follow animation can render.
  await page.evaluate(() => {
    window.dispatchEvent(new CustomEvent('test-gps-position', { detail: { longitude: -121.9, heading: 120 } }));
    window.dispatchEvent(new CustomEvent('test-gps-error', { detail: 2 }));
  });
  await expect(toggle).toHaveAttribute('aria-description', /Waiting for GPS track/);
  await page.clock.runFor(500);
  expect(await camera(page)).toEqual(held);
  await sendFix(page, { longitude: -121.8, heading: 180 });
  await expectCenter(page, -121.8);
  await expect.poll(() => bearing(page)).toBeCloseTo(180);

  const canvas = (await page.locator('.maplibregl-canvas').boundingBox())!;
  const drag = async () => {
    await page.mouse.move(canvas.x + canvas.width / 2, canvas.y + canvas.height / 2);
    await page.mouse.down();
    await page.mouse.move(canvas.x + canvas.width / 2 + 100, canvas.y + canvas.height / 2 + 50, { steps: 10 });
  };
  await drag();
  await sendFix(page, { longitude: -121.7, heading: 180 });
  await page.mouse.up();
  await expectCenter(page, -121.7);

  // A queued fix must be discarded if GPS is lost before the gesture ends.
  await drag();
  await page.evaluate(() => {
    window.dispatchEvent(new CustomEvent('test-gps-position', { detail: { longitude: -121.6, heading: 120 } }));
    window.dispatchEvent(new CustomEvent('test-gps-error', { detail: 2 }));
  });
  await page.mouse.up();
  await page.clock.runFor(1000);
  expect((await camera(page)).center[0]).not.toBeCloseTo(-121.6);
  expect(await bearing(page)).toBeCloseTo(180);
});

test('orientation persists and can be toggled while GPS is unavailable or off', async ({ page }) => {
  const toggle = page.getByRole('button', { name: 'Track up', exact: true });
  const initial = await camera(page);
  await toggle.click();
  await expect(toggle).toHaveAttribute('aria-description', /Waiting for GPS track/);
  expect(await camera(page)).toEqual(initial);
  await sendFix(page, { heading: 45 });
  await expect.poll(() => bearing(page)).toBeCloseTo(45);
  await page.reload();
  await expect(toggle).toHaveAttribute('aria-pressed', 'true');
  await expect(toggle).toHaveAttribute('aria-description', /Waiting for GPS track/);
  expect(await bearing(page)).toBeCloseTo(45);
  await expect.poll(() => countWatches(page)).toBe(1);
  const restored = await camera(page);
  await sendFix(page, { heading: 60, longitude: -121.9 });
  await expect.poll(() => bearing(page)).toBeCloseTo(60);
  await expectCenter(page, -121.9);
  expect((await camera(page)).zoom).toBe(restored.zoom);
  const beforeOff = await camera(page);
  await page.getByRole('button', { name: 'Show GPS status', exact: true }).click();
  await page.getByRole('switch', { name: 'GPS aircraft', exact: true }).click();
  await expect.poll(() => countWatches(page)).toBe(0);
  await expect(toggle).toHaveAttribute('aria-description', /Waiting for GPS track/);
  expect(await camera(page)).toEqual(beforeOff);
  await toggle.click();
  await expect.poll(() => bearing(page)).toBeCloseTo(0);
  await page.reload();
  await expect(toggle).toHaveAttribute('aria-pressed', 'false');
  expect(await countWatches(page)).toBe(0);
});

for (const { name, viewport, route, coordinates } of [
  { name: 'landscape', viewport: { width: 1200, height: 600 },
    route: '370000N1220000W 370000N1180000W', coordinates: [[-122, 37], [-118, 37]] },
  { name: 'portrait', viewport: { width: 600, height: 1200 },
    route: '350000N1220000W 390000N1220000W', coordinates: [[-122, 35], [-122, 39]] },
] satisfies { name: string; viewport: { width: number; height: number }; route: string; coordinates: [number, number][] }[]) {
  test(`route fitting respects live, held and changing orientation (${name})`, async ({ page }) => {
    await page.setViewportSize(viewport);
    await sendFix(page);
    const input = page.getByRole('textbox', { name: 'Add route waypoint', exact: true });
    await input.fill(route);
    await input.press('Enter');
    const fit = page.getByRole('button', { name: 'Fit route on map', exact: true });
    await fit.click();
    await expectRouteFits(page, coordinates, 0);

    const toggle = page.getByRole('button', { name: 'Track up', exact: true });
    const toggleAndFit = () => toggle.evaluate((button: HTMLButtonElement) => {
      button.click();
      // Fit in the same turn, before the orientation animation can finish.
      document.querySelector<HTMLButtonElement>('[aria-label="Fit route on map"]')!.click();
    });
    await toggleAndFit();
    await expectRouteFits(page, coordinates, 90);

    await sendFix(page, { heading: null, speed: 0 });
    await expect(toggle).toHaveAttribute('aria-description', /Waiting for GPS track/);
    await fit.click();
    await expectRouteFits(page, coordinates, 90);

    await toggleAndFit();
    await expectRouteFits(page, coordinates, 0);
  });
}
