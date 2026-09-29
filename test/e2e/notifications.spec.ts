import { test, expect } from '@playwright/test';

test('offline bubbles dismiss by keyboard, stay available in Settings, and return on recurrence', async ({ page, context }) => {
  await page.goto('/');
  await expect(page.locator('.app-shell')).toHaveAttribute('aria-busy', 'false');
  await context.setOffline(true);
  const bubble = page.getByRole('button', { name: 'Dismiss Offline', exact: true });
  await expect(bubble).toBeVisible();
  await expect(bubble).toHaveAccessibleDescription(/Saved content remains available\..*weather may be stale/);
  await bubble.focus();
  await page.keyboard.press('Enter');
  await expect(bubble).toHaveCount(0);
  await page.getByLabel('Settings and offline downloads').click();
  await page.getByRole('tab', { name: 'Notifications', exact: true }).click();
  const panel = page.getByRole('tabpanel', { name: 'Notifications', exact: true });
  await expect(panel.getByRole('heading', { name: 'Offline', exact: true })).toBeVisible();
  await expect(panel).toContainText('weather may be stale');
  await page.getByLabel('Close settings').click();
  await expect(bubble).toHaveCount(0);
  await context.setOffline(false);
  await page.getByLabel('Settings and offline downloads').click();
  await expect(panel.getByRole('heading', { name: 'Offline', exact: true })).toHaveCount(0);
  await page.getByLabel('Close settings').click();
  await context.setOffline(true);
  await expect(bubble).toBeVisible();
});

test.describe('touch notifications', () => {
  test.use({ viewport: { width: 320, height: 568 }, hasTouch: true });
  test('tap the bubble body and review notices in the narrow Settings tab rail', async ({ page, context }) => {
    await page.goto('/');
    await expect(page.locator('.app-shell')).toHaveAttribute('aria-busy', 'false');
    await context.setOffline(true);
    const bubble = page.getByRole('button', { name: 'Dismiss Offline', exact: true });
    await expect(bubble).toBeVisible();
    await bubble.screenshot({ path: test.info().outputPath('offline-bubble-phone.png') });
    await bubble.getByText('Saved content remains available.', { exact: false }).tap();
    await expect(bubble).toHaveCount(0);
    await page.getByLabel('Settings and offline downloads').tap();
    await page.getByRole('tab', { name: 'Notifications', exact: true }).tap();
    const panel = page.getByRole('tabpanel', { name: 'Notifications', exact: true });
    await expect(panel.getByRole('heading', { name: 'Offline', exact: true })).toBeVisible();
    expect(await panel.evaluate(element => element.scrollWidth <= element.clientWidth)).toBe(true);
    await page.screenshot({ path: test.info().outputPath('notifications-phone.png') });
  });
});

test('dismissed resource failures retain details and changed failures surface again', async ({ page }) => {
  await page.goto('/');
  await expect(page.locator('.app-shell')).toHaveAttribute('aria-busy', 'false');
  await page.waitForFunction(() => !!navigator.serviceWorker.controller);
  const fail = (message: string) => page.evaluate(message => {
    navigator.serviceWorker.dispatchEvent(new MessageEvent('message', { data: {
      type: 'chart-archive-error', url: '/broken.mbtiles', message, code: 'invalid-data',
    } }));
  }, message);
  await fail('Chart archive SHA-256 mismatch');
  const bubble = page.getByRole('button', { name: 'Dismiss Chart unavailable', exact: true });
  await expect(bubble).toHaveAccessibleDescription(/Chart archive SHA-256 mismatch/);
  await bubble.click();
  await fail('Chart archive SHA-256 mismatch');
  await expect(bubble).toHaveCount(0);
  await page.getByLabel('Settings and offline downloads').click();
  await page.getByRole('tab', { name: 'Notifications', exact: true }).click();
  await expect(page.getByRole('tabpanel', { name: 'Notifications', exact: true })).toContainText('Chart archive SHA-256 mismatch');
  await page.getByLabel('Close settings').click();
  await fail('Chart archive has invalid metadata');
  await expect(bubble).toBeVisible();
  await expect(bubble).toContainText('invalid metadata');
  await expect(bubble).toHaveAccessibleDescription(/Chart archive has invalid metadata/);
});
