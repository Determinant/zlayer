import { test, expect } from '@playwright/test';

test.beforeEach(async ({ request }) => { await request.post('/__test/reset'); });

test('route discovery clears and restores terrain demand without unloading terrain', async ({ page }) => {
  const errors: string[] = [];
  page.on('pageerror', error => errors.push(error.message));
  await page.addInitScript(() => {
    localStorage.setItem('zlayers-map-preferences-v1', JSON.stringify({ version: 2, chartBase: '', ownshipEnabled: false }));
  });
  await page.goto('/');
  const route = page.getByRole('textbox', { name: 'Add route waypoint', exact: true });
  await route.fill('KSBA KSMO'); await route.press('Enter');
  await expect(page.locator('.route-token')).toHaveCount(2);
  await page.getByRole('button', { name: 'Fit route on map', exact: true }).click();
  const terrain = page.getByLabel('Route terrain elevation');
  await expect(terrain).toContainText('4 NM core / 8 NM fade', { timeout: 30_000 });
  for (let cycle = 0; cycle < 2; cycle++) {
    await page.getByLabel('Settings and offline downloads').click();
    await page.getByRole('tab', { name: 'Plugins', exact: true }).click();
    const routes = page.locator('.plugin-row[data-plugin="routes"]');
    await routes.getByRole('switch', { checked: true }).click();
    await expect(page.locator('.plugin-row[data-plugin="terrain"]').getByRole('switch')).toHaveAttribute('aria-checked', 'true');
    await page.getByLabel('Close settings').click();
    await expect(terrain).toContainText('Add a route or select Viewport');
    await page.getByLabel('Settings and offline downloads').click();
    await page.getByRole('tab', { name: 'Plugins', exact: true }).click();
    await routes.getByRole('switch', { checked: false }).click();
    await page.getByLabel('Close settings').click();
    await expect(terrain).toContainText('4 NM core / 8 NM fade', { timeout: 30_000 });
    await expect(page.locator('.route-token')).toHaveCount(2);
  }
  await expect(page.locator('.map-runtime-error')).toHaveCount(0);
  expect(errors).toEqual([]);
});
