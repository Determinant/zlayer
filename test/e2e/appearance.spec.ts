import { test, expect } from '@playwright/test';

test.beforeEach(async ({ request }) => { await request.post('/__test/reset'); });

test('appearance switches immediately, preserves the map and restores across reloads and windows', async ({ page, context }, testInfo) => {
  await page.goto('/');
  await page.getByLabel('Settings and offline downloads').click();
  const dark = page.getByRole('radio', { name: 'Dark', exact: true });
  const light = page.getByRole('radio', { name: 'Light', exact: true });
  await expect(dark).toBeChecked();
  const canvas = await page.locator('.maplibregl-canvas').elementHandle();
  const before = await page.locator('.settings-dialog').evaluate(element => {
    const style = getComputedStyle(element);
    return { background: style.backgroundColor, color: style.color };
  });
  // These are the pre-theme dialog's actual dark colors.
  expect(before).toEqual({ background: 'rgb(9, 23, 37)', color: 'rgb(220, 236, 245)' });
  await light.check();
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'light');
  expect(await canvas!.evaluate(element => element.isConnected)).toBe(true);
  await expect(page.locator('.ui-input').first()).toHaveCSS('color-scheme', 'light');
  await page.screenshot({ path: testInfo.outputPath('settings-light.png') });
  await page.reload();
  await expect(light).toBeChecked();
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'light');
  await expect(page.locator('.app-shell')).not.toHaveAttribute('inert', { timeout: 30_000 });
  const other = await context.newPage();
  await other.goto('/');
  await expect(other.locator('html')).toHaveAttribute('data-theme', 'light');
  // Native radios support arrow-key selection without moving focus elsewhere.
  await page.bringToFront();
  await light.focus();
  await expect(light).toBeFocused();
  await page.keyboard.press('ArrowRight');
  await expect(dark).toBeChecked();
  await expect(other.locator('html')).toHaveAttribute('data-theme', 'dark');
  await expect(page.locator('.settings-dialog')).toHaveCSS('background-color', before.background);
  await expect(page.locator('.settings-dialog')).toHaveCSS('color', before.color);
  await page.screenshot({ path: testInfo.outputPath('settings-dark.png') });
  await other.close();
  await light.check();
  await page.getByLabel('Close settings').click();
  await page.getByLabel('Search FAA navigation data').fill('KSBA');
  await page.locator('.search-results button').filter({ hasText: 'KSBA' }).click();
  await expect(page.locator('.feature-card')).toBeVisible();
  await page.screenshot({ path: testInfo.outputPath('airport-light.png') });
});

test('appearance is usable on a narrow screen even when preference storage is denied', async ({ page }, testInfo) => {
  await page.setViewportSize({ width: 320, height: 568 });
  await page.addInitScript(() => {
    const setItem = Storage.prototype.setItem;
    Storage.prototype.setItem = function(key, value) {
      if (key === 'zlayer-ui:appearance') throw new DOMException('Storage denied', 'SecurityError');
      setItem.call(this, key, value);
    };
  });
  await page.goto('/');
  await page.getByLabel('Settings and offline downloads').click();
  await page.getByRole('radio', { name: 'Light', exact: true }).check();
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'light');
  for (const label of await page.locator('.appearance-options label').all()) {
    const bounds = (await label.boundingBox())!;
    expect(bounds.height).toBeGreaterThanOrEqual(44);
    expect(bounds.x).toBeGreaterThanOrEqual(0);
    expect(bounds.x + bounds.width).toBeLessThanOrEqual(320);
    await expect(label).toHaveCSS('font-size', '15px');
    await expect(label).toHaveCSS('text-transform', 'none');
  }
  await page.screenshot({ path: testInfo.outputPath('settings-light-phone.png') });
  await page.reload();
  await expect(page.getByRole('radio', { name: 'Dark', exact: true })).toBeChecked();
});
