import { test, expect, type Locator, type Page } from '@playwright/test';
import { mockGps, sendFix, countWatches } from './ownship-fixture';

async function openMap(page: Page) {
  await mockGps(page);
  await page.addInitScript(() => localStorage.setItem('zlayers-map-preferences-v1',
    JSON.stringify({ chartBase: '' })));
  await page.goto('/');
  await expect.poll(() => countWatches(page)).toBe(1);
  await sendFix(page);
  const route = page.getByRole('textbox', { name: 'Add route waypoint', exact: true });
  await route.fill('KSBA KSMO');
  await route.press('Enter');
  // Terrain starts open for a fresh user; stow it before exercising the toggles.
  const terrain = page.getByRole('button', { name: 'Hide terrain toolbox', exact: true });
  await expect(terrain).toBeVisible();
  await terrain.click();
}

async function insideMap(page: Page, locator: Locator) {
  await expect.poll(async () => {
    const map = (await page.getByLabel('Aviation chart map').boundingBox())!;
    const box = (await locator.boundingBox())!;
    return box.x >= map.x - 1 && box.y >= map.y - 1 && box.x + box.width <= map.x + map.width + 1 &&
      box.y + box.height <= map.y + map.height + 1;
  }).toBe(true);
}

test.describe('touch map overlays', () => {
  test.use({ hasTouch: true });
  for (const [width, height] of [[320, 568], [393, 852], [568, 320], [744, 1133], [832, 906], [1440, 900]] as const) {
    test(`compact panels slide away without disabling layers at ${width}×${height}`, async ({ page }, testInfo) => {
      await page.setViewportSize({ width, height });
      await openMap(page);
      const contents = page.locator('.map-edge-content');
      await expect(page.locator('.map-edge-content:not([inert])')).toHaveCount(0);
      for (const name of ['chart status', 'GPS status', 'AHRS toolbox', 'terrain toolbox']) {
        const handle = page.getByRole('button', { name: `Show ${name}`, exact: true });
        const box = (await handle.boundingBox())!;
        expect(box.width).toBeGreaterThanOrEqual(44);
        expect(box.height).toBeGreaterThanOrEqual(44);
        await insideMap(page, handle);
        await handle.tap();
        const expanded = page.locator('.map-edge-tool.is-open');
        await insideMap(page, expanded);
        await expect(page.locator('.map-edge-content:not([inert])')).toHaveCount(1);
        if (name === 'chart status') expect((await page.locator('.map-badge').boundingBox())!.height).toBeLessThan(33);
        if (name === 'GPS status') {
          const center = page.getByRole('button', { name: 'Center aircraft', exact: true });
          await center.scrollIntoViewIfNeeded();
          await insideMap(page, center);
          await center.tap();
          await expect(page.getByLabel('GPS aircraft status')).toContainText('120 kt');
        }
        if (name === 'AHRS toolbox') {
          const confirm = page.getByRole('button', { name: 'Calibrate', exact: true });
          await confirm.scrollIntoViewIfNeeded();
          await insideMap(page, confirm);
          await page.screenshot({ path: testInfo.outputPath('compact-ahrs.png') });
        }
        if (name === 'terrain toolbox') {
          await page.getByRole('tab', { name: 'Clearance', exact: true }).tap();
          const altitude = page.getByRole('spinbutton', { name: 'Selected altitude' });
          await altitude.fill('6500');
          await altitude.press('Enter');
          await insideMap(page, altitude);
          await page.screenshot({ path: testInfo.outputPath('compact-terrain.png') });
        }
        // A tap pins the panel through map interaction and focus changes.
        const map = (await page.getByLabel('Aviation chart map').boundingBox())!;
        await page.touchscreen.tap(map.x + map.width - 20, map.y + 75);
        const toggle = page.getByRole('button', { name: `Hide ${name}`, exact: true });
        await expect(toggle).toHaveAttribute('aria-expanded', 'true');
        await toggle.tap();
        if (name === 'AHRS toolbox') await page.getByRole('alertdialog', { name: 'Stow AHRS?', exact: true })
          .getByRole('button', { name: 'Stop', exact: true }).tap();
        await expect(page.getByRole('button', { name: `Show ${name}`, exact: true })).toHaveAttribute('aria-expanded', 'false');
        await expect(page.locator('.map-edge-content:not([inert])')).toHaveCount(0);
      }
      await expect(contents).toHaveCount(4);
      expect(await countWatches(page)).toBe(1);
      await page.getByRole('button', { name: 'Show terrain toolbox', exact: true }).tap();
      await expect(page.getByRole('spinbutton', { name: 'Selected altitude' })).toHaveValue('6500');
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    });
  }
});

test('hover does not change panel state; tabs alone toggle panels', async ({ page }) => {
  await openMap(page);
  const chart = page.locator('.map-edge-charts .map-edge-handle');
  const gps = page.locator('.map-edge-gps .map-edge-handle');
  await chart.hover();
  await expect(chart).toHaveAttribute('aria-expanded', 'false');
  await chart.click();
  await expect(chart).toHaveAttribute('aria-expanded', 'true');
  await page.mouse.move(700, 400);
  await page.mouse.click(700, 400);
  await gps.hover();
  await page.waitForTimeout(550); // Exceed both the preview and auto-hide delays.
  await expect(chart).toHaveAttribute('aria-expanded', 'true');
  await expect(gps).toHaveAttribute('aria-expanded', 'false');
  await gps.click();
  await expect(chart).toHaveAttribute('aria-expanded', 'false');
  await expect(gps).toHaveAttribute('aria-expanded', 'true');
  await gps.click();
  await expect(gps).toHaveAttribute('aria-expanded', 'false');
});

test('tab toggles persist through pointer movement, and Escape returns to the handle', async ({ page }) => {
  await openMap(page);
  const chart = page.locator('.map-edge-charts .map-edge-handle');
  await chart.hover();
  await expect(chart).toHaveAttribute('aria-expanded', 'false');
  await chart.click();
  await page.mouse.move(700, 400);
  await expect(chart).toHaveAttribute('aria-expanded', 'true');
  const terrain = page.locator('.map-edge-terrain .map-edge-handle');
  await terrain.focus();
  await page.keyboard.press('Enter');
  await page.keyboard.press('Tab');
  await expect(page.getByRole('tab', { name: 'Elevation', exact: true })).toBeFocused();
  await page.keyboard.press('ArrowRight');
  const altitude = page.getByRole('spinbutton', { name: 'Selected altitude' });
  await altitude.fill('7200');
  await page.mouse.move(100, 700);
  await page.mouse.move(700, 400);
  await expect(terrain).toHaveAttribute('aria-expanded', 'true');
  await altitude.press('Enter');
  await altitude.press('Escape');
  await expect(terrain).toHaveAttribute('aria-expanded', 'false');
  await expect(terrain).toBeFocused();
  await page.keyboard.press('Enter');
  await expect(altitude).toHaveValue('7200');
  await altitude.fill('8400');
  await altitude.press('Escape');
  await expect(terrain).toBeFocused();
  await page.keyboard.press('Enter');
  await expect(altitude).toHaveValue('7200');
  // Removing the route removes the Terrain tab entirely.
  await page.getByRole('button', { name: 'Route actions', exact: true }).click();
  await page.getByRole('menuitem', { name: 'Clear route', exact: true }).click();
  await expect(terrain).toHaveCount(0);
  await chart.hover();
  await expect(chart).toHaveAttribute('aria-expanded', 'false');
});
