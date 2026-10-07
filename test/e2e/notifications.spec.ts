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

test.describe('basemap recovery', () => {
  test.use({ serviceWorkers: 'block' });
  test('a recovered tile removes its dismissed warning from Notifications without reloading', async ({ page }) => {
    await page.addInitScript(() => localStorage.setItem('zlayers-map-preferences-v1', JSON.stringify({
      chartBase: '', ownshipEnabled: false, metarEnabled: false, terrainEnabled: false, obstructionsEnabled: false,
    })));
    let fail = true;
    await page.route('**/basemap.png', async route => {
      if (fail) await route.abort('failed');
      else await route.continue();
    });
    await page.goto('/');
    await expect(page.locator('.app-shell')).toHaveAttribute('aria-busy', 'false');
    const bubble = page.getByRole('button', { name: 'Dismiss Map layer unavailable', exact: true });
    await expect(bubble).toContainText('zlayer-basemap');
    await bubble.click();
    await page.getByLabel('Settings and offline downloads').click();
    await page.getByRole('tab', { name: 'Notifications', exact: true }).click();
    const panel = page.getByRole('tabpanel', { name: 'Notifications', exact: true });
    await expect(panel).toContainText('zlayer-basemap');
    await page.getByLabel('Close settings').click();

    // Leave and revisit the failed tile so MapLibre requests it again.
    fail = false;
    const zoom = () => page.evaluate(() => JSON.parse(localStorage.getItem('zlayers-map-view-v1')!).zoom as number);
    const initialZoom = await zoom();
    await page.getByRole('button', { name: 'Zoom in', exact: true }).click();
    await expect.poll(zoom).toBe(initialZoom + 1);
    await page.getByRole('button', { name: 'Zoom out', exact: true }).click();
    await expect.poll(zoom).toBe(initialZoom);
    await page.getByLabel('Settings and offline downloads').click();
    await expect(panel.getByRole('heading', { name: 'Map layer unavailable', exact: true })).toHaveCount(0);
    await expect(bubble).toHaveCount(0);
  });
});

test('verified VFR and IFR archive recovery clears only its own pending request notice', async ({ page, request }) => {
  try {
    await request.post('/__test/add-ifr-charts');
    const root = '/chart-data/2026-09-03/mbtiles';
    const manifest = await (await request.get(`${root}/manifest.json`)).json();
    const urls: string[] = ['vfr-sectional', 'ifr-low', 'ifr-high'].map(kind => {
      const archive = manifest.archives.find((archive: { kind: string }) => archive.kind === kind);
      return `${root}/${archive.file}?sha256=${archive.sha256}&bytes=${archive.byteLength}`;
    });
    await page.addInitScript(() => localStorage.setItem('zlayers-map-preferences-v1', JSON.stringify({
      chartBase: '', ownshipEnabled: false, metarEnabled: false, terrainEnabled: false, obstructionsEnabled: false,
    })));
    await page.goto('/');
    await expect(page.locator('.app-shell')).toHaveAttribute('aria-busy', 'false');
    await page.waitForFunction(() => !!navigator.serviceWorker.controller);
    await page.getByLabel('Settings and offline downloads').click();
    await page.getByRole('tab', { name: 'Notifications', exact: true }).click();
    const panel = page.getByRole('tabpanel', { name: 'Notifications', exact: true });
    const notice = panel.getByRole('heading', { name: 'Chart unavailable', exact: true });
    const read = (url: string) => page.evaluate(async url => {
      const response = await fetch(url);
      await response.arrayBuffer();
      return response.status;
    }, url);
    // A real server outage leaves navigator.onLine true and exercises the worker's
    // failure messages, verified whole-file reads and recovery messages end to end.
    await request.post('/__test/disconnect');
    for (const url of urls) expect(await read(url)).toBe(503);
    await expect(notice).toBeVisible();
    await request.post('/__test/reset');
    await request.post('/__test/add-ifr-charts');
    for (const url of urls.slice(0, -1)) {
      expect(await read(url)).toBe(200);
      await expect(notice).toBeVisible();
    }
    expect(await read(urls.at(-1)!)).toBe(200);
    await expect(notice).toHaveCount(0);
  } finally { await request.post('/__test/reset'); }
});
