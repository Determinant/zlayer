import { test, expect, type Page, type Locator } from '@playwright/test';
import { mockGps, countWatches } from './ownship-fixture';

test.use({ hasTouch: true });

async function openAhrs(page: Page) {
  await mockGps(page);
  await page.addInitScript(() => {
    localStorage.setItem('zlayers-map-preferences-v1', JSON.stringify({ chartBase: '', ownshipEnabled: false }));
    Object.defineProperty(DeviceMotionEvent, 'requestPermission', { configurable: true, value: async () => 'granted' });
    window.addEventListener('test-ahrs-sensors', () => {
      setInterval(() => window.dispatchEvent(new DeviceMotionEvent('devicemotion', {
        rotationRate: { alpha: 0, beta: 0, gamma: 0 },
        accelerationIncludingGravity: { x: 0, y: 9.80665, z: 0 }, interval: 20,
      })), 20);
      setInterval(() => window.dispatchEvent(new CustomEvent('test-gps-position', {
        detail: { speed: 50, altitude: 3048, altitudeAccuracy: 5 },
      })), 1000);
    });
  });
  await page.goto('/');
  // At 320 × 568 the initially open terrain panel covers the other tool tabs.
  await page.getByRole('button', { name: 'Hide terrain toolbox', exact: true }).click();
  await page.getByRole('button', { name: 'Show AHRS toolbox', exact: true }).click();
  return page.getByRole('region', { name: 'AHRS toolbox', exact: true });
}

async function insideViewport(locator: Locator, page: Page) {
  const box = (await locator.boundingBox())!, viewport = page.viewportSize()!;
  expect(box.x).toBeGreaterThanOrEqual(0);
  expect(box.y).toBeGreaterThanOrEqual(0);
  expect(box.x + box.width).toBeLessThanOrEqual(viewport.width + 1);
  expect(box.y + box.height).toBeLessThanOrEqual(viewport.height + 1);
}

async function insideContent(locator: Locator, dialog: Locator) {
  const box = (await locator.boundingBox())!, content = (await dialog.locator('.ahrs-content').boundingBox())!;
  expect(box.y).toBeGreaterThanOrEqual(content.y);
  expect(box.y + box.height).toBeLessThanOrEqual(content.y + content.height + 1);
}

for (const viewport of [
  { width: 320, height: 568 }, { width: 393, height: 852 },
  { width: 507, height: 1112 }, // Narrow tablet window / Split View.
  { width: 600, height: 960 },
  { width: 744, height: 1133 }, // iPad mini, including its taller portrait ratio.
  { width: 768, height: 1024 }, // Earlier mini / 4:3 iPads.
  { width: 820, height: 1180 }, { width: 834, height: 1194 },
  { width: 1024, height: 1366 }, { width: 1280, height: 900 },
]) {
  test(`AHRS full screen fits and rotates without restarting the demo at ${viewport.width}px`, async ({ page }, testInfo) => {
    await page.clock.install();
    await page.setViewportSize(viewport);
    const errors: string[] = [];
    page.on('pageerror', error => errors.push(error.message));
    const tool = await openAhrs(page);
    await page.screenshot({ path: testInfo.outputPath('top-bezel.png'), animations: 'disabled' });
    await page.clock.pauseAt(new Date(Date.now() + 1000));
    await tool.getByRole('button', { name: 'Test', exact: true }).click();
    await page.clock.runFor(4500);
    const demo = tool.getByRole('region', { name: 'Instrument test', exact: true });
    const instrument = await demo.locator('.ahrs-instrument').elementHandle();
    await expect(demo.getByRole('img', { name: /^GPS vertical speed:/ })).toHaveAttribute('aria-label', 'GPS vertical speed: 400 feet per minute');
    const enter = tool.getByRole('button', { name: 'Enter full screen', exact: true });
    const bezel = (await tool.locator('.ahrs-heading').boundingBox())!;
    const compactButton = (await enter.boundingBox())!;
    const actions = (await tool.locator('.ahrs-heading-actions').boundingBox())!;
    const record = tool.getByRole('button', { name: 'AHRS recorder', exact: true });
    expect((await record.boundingBox())!.width).toBe(compactButton.width);
    expect(Math.abs(actions.x + actions.width / 2 - bezel.x - bezel.width / 2)).toBeLessThan(1);
    expect(compactButton.height).toBeLessThanOrEqual(28);
    await enter.click();
    const dialog = page.getByRole('dialog', { name: 'AHRS full screen', exact: true });
    const exit = dialog.getByRole('button', { name: 'Exit full screen', exact: true });
    await expect(exit).toHaveAttribute('aria-pressed', 'true');
    for (const [orientation, size] of [['initial', viewport], ['rotated', { width: viewport.height, height: viewport.width }]] as const) {
      await page.setViewportSize(size);
      expect(await dialog.boundingBox()).toEqual({ x: 0, y: 0, ...size });
      const button = (await exit.boundingBox())!;
      expect(button.width).toBeGreaterThanOrEqual(44);
      expect(button.height).toBeGreaterThanOrEqual(44);
      const group = (await tool.locator('.ahrs-heading-actions').boundingBox())!;
      expect((await record.boundingBox())!.width).toBe(button.width);
      expect(Math.abs(group.x + group.width / 2 - size.width / 2)).toBeLessThan(1);
      await insideViewport(exit, page);
      await insideViewport(demo.locator('.ahrs-instrument'), page);
      await insideViewport(demo.locator('.ahrs-hsi-dial'), page);
      if (Math.min(size.width, size.height) >= 600) {
        await insideContent(demo.locator('.ahrs-instrument'), dialog);
        await insideContent(demo.locator('.ahrs-hsi'), dialog);
        const attitude = (await demo.locator('.ahrs-instrument').boundingBox())!;
        const hsi = (await demo.locator('.ahrs-hsi').boundingBox())!;
        if (size.width <= size.height) {
          expect(hsi.y).toBeGreaterThanOrEqual(attitude.y + attitude.height);
          const dial = (await demo.locator('.ahrs-hsi-dial').boundingBox())!;
          const readings = (await demo.locator('.ahrs-hsi-readings').boundingBox())!;
          expect(readings.x).toBeGreaterThanOrEqual(dial.x + dial.width);
        } else expect(hsi.x).toBeGreaterThanOrEqual(attitude.x + attitude.width);
      }
      expect(await dialog.locator('.ahrs-content').evaluate(node => node.scrollWidth <= node.clientWidth)).toBe(true);
      await page.screenshot({ path: testInfo.outputPath(`full-screen-${orientation}.png`) });
    }
    expect(await demo.locator('.ahrs-instrument').evaluate((node, previous) => node === previous, instrument)).toBe(true);
    await exit.click();
    await expect(dialog).toHaveCount(0);
    await expect(enter).toBeFocused();
    await expect(demo.getByRole('img', { name: /^GPS vertical speed:/ })).toHaveAttribute('aria-label', 'GPS vertical speed: 400 feet per minute');
    expect(await countWatches(page)).toBe(0);
    expect(errors).toEqual([]);
  });
}

test('full screen preserves calibration and HSI selection, traps focus, and Escape exits before stowing', async ({ page }) => {
  await page.clock.install();
  await page.setViewportSize({ width: 768, height: 1024 });
  const tool = await openAhrs(page);
  await page.getByRole('textbox', { name: 'Add route waypoint', exact: true }).fill('370000N1230000W 370000N1210000W 380000N1210000W');
  await page.getByRole('textbox', { name: 'Add route waypoint', exact: true }).press('Enter');
  const leg = tool.getByRole('combobox', { name: 'HSI route leg', exact: true });
  await leg.selectOption({ index: 2 });
  const selection = await leg.inputValue();
  await tool.getByRole('button', { name: 'Calibrate', exact: true }).click();
  await page.evaluate(() => window.dispatchEvent(new Event('test-ahrs-sensors')));
  await page.clock.runFor(5000);
  const instrument = await tool.locator('.ahrs-instrument').elementHandle();
  const enter = tool.getByRole('button', { name: 'Enter full screen', exact: true });
  await enter.click();
  const dialog = page.getByRole('dialog', { name: 'AHRS full screen', exact: true });
  await expect(dialog).toBeVisible();
  expect(await countWatches(page)).toBe(1);
  await page.clock.runFor(7000);
  await expect(tool.getByRole('button', { name: 'Recalibrate', exact: true })).toBeVisible();
  await insideContent(tool.locator('.ahrs-display:not([hidden]) .ahrs-hsi'), dialog);
  await expect(leg).toHaveValue(selection);
  expect(await tool.locator('.ahrs-instrument').evaluate((node, previous) => node === previous, instrument)).toBe(true);
  const background = page.getByLabel('Search FAA navigation data');
  await background.evaluate(node => node.focus());
  await expect(background).not.toBeFocused();
  for (let i = 0; i < 8; i++) {
    await page.keyboard.press('Tab');
    expect(await dialog.evaluate(node => document.activeElement === document.body || node.contains(document.activeElement))).toBe(true);
  }
  await page.keyboard.press('Escape');
  await expect(dialog).toHaveCount(0);
  await expect(page.getByRole('alertdialog', { name: 'Stow AHRS?', exact: true })).toHaveCount(0);
  await expect(enter).toBeFocused();
  await expect(leg).toHaveValue(selection);
  expect(await countWatches(page)).toBe(1);
  await page.keyboard.press('Escape');
  await expect(page.getByRole('alertdialog', { name: 'Stow AHRS?', exact: true })).toBeVisible();
});

test('AHRS full-screen preference restores on reload and an explicit exit persists', async ({ page }) => {
  const tool = await openAhrs(page);
  await tool.getByRole('button', { name: 'Enter full screen', exact: true }).click();
  await page.reload();
  await expect(page.getByRole('dialog', { name: 'AHRS full screen', exact: true })).toBeVisible();
  await page.getByRole('button', { name: 'Exit full screen', exact: true }).click();
  await page.reload();
  await expect(page.getByRole('dialog', { name: 'AHRS full screen', exact: true })).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Enter full screen', exact: true })).toBeVisible();
});
