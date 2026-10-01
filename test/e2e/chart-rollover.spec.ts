import { test, expect, type Page } from '@playwright/test';
import type { CatalogResponse } from '@zlayer/contracts';

test.beforeEach(async ({ page, request }) => {
  // These tests replay later editions independently of the machine's clock.
  await page.clock.setFixedTime(new Date('2026-10-29T12:00:00Z'));
  await request.post('/__test/reset');
});
test.afterEach(async ({ request }) => { await request.post('/__test/reset'); });
const row = (page: Page, date: string) => page.locator(`.region-row[data-region-id="us-CA"][data-revision="${date}"]`);

async function catalog(page: Page, date: string) {
  return page.evaluate(date => new Promise<CatalogResponse | undefined>((resolve, reject) => {
    const open = indexedDB.open('zlayer-offline', 1);
    // Observation must not create an empty database before the app initializes it.
    open.onupgradeneeded = () => { open.transaction!.abort(); resolve(undefined); };
    open.onerror = () => reject(open.error);
    open.onsuccess = () => {
      const db = open.result;
      const read = db.transaction('records').objectStore('records').get(`catalog:/chart-data:${date}`);
      read.onerror = () => { db.close(); reject(read.error); };
      read.onsuccess = () => { db.close(); resolve(read.result as CatalogResponse | undefined); };
    };
  }), date);
}

async function offlineSettings(page: Page) {
  const dialog = page.getByRole('dialog', { name: 'Settings', exact: true });
  if (!await dialog.isVisible()) await page.getByLabel('Settings and offline downloads').click();
  await page.getByRole('tab', { name: 'Offline', exact: true }).click();
  await page.getByLabel('Find a state or territory').fill('California');
}

async function approach(page: Page, name: string) {
  await page.getByLabel('Search FAA navigation data').fill('KSBA');
  await page.locator('.search-results button').filter({ hasText: 'KSBA' }).click();
  await page.getByRole('tab', { name: 'Plates', exact: true }).click();
  await page.getByRole('button', { name: new RegExp(name) }).click();
  await expect(page.locator('.procedure-page-stage canvas')).toBeVisible();
  await page.getByLabel('Close plate').click();
}

test('fresh change-notice install saves old raster/base books and new notice, then opens offline', async ({ page, request, context }) => {
  await request.post('/__test/chart-rollover', { data: { edition: 'notice' } });
  await page.goto('/');
  await expect(page.getByLabel('Settings and offline downloads')).toBeEnabled();
  await expect.poll(async () => (await catalog(page, '2026-10-01'))?.charts[0]?.revision).toBe('2026-09-03');
  const current = (await catalog(page, '2026-10-01'))!;
  expect(current.navigation.every(layer => layer.url.includes('/2026-10-01/nav/'))).toBe(true);
  expect(current.procedures?.effectiveDate).toBe('2026-10-01');
  await expect(page.getByRole('button', { name: 'Dismiss FAA data cycle', exact: true })).toHaveCount(0);
  await page.getByLabel('Settings and offline downloads').click();
  await expect(page.getByRole('tabpanel', { name: 'General' })).toContainText(/Raster charts use the Sep 3(?:, 2026)? edition, still effective for this cycle/);
  await offlineSettings(page);
  await row(page, '2026-10-01').getByRole('button', { name: 'Download', exact: true }).click();
  await expect(row(page, '2026-10-01').locator('.offline-tag')).toHaveText('Saved');
  await page.getByLabel('Close settings').click();
  await context.setOffline(true);
  await page.reload();
  await expect(page.getByLabel('Settings and offline downloads')).toBeEnabled();
  await approach(page, 'NOTICE APPROACH');
  await approach(page, 'TEST APPROACH');
});

test('failed notice save preserves September; retry and a standalone next full edition advance safely', async ({ page, request, context }) => {
  await page.goto('/');
  await offlineSettings(page);
  await row(page, '2026-09-03').getByRole('button', { name: 'Download', exact: true }).click();
  await expect(row(page, '2026-09-03').locator('.offline-tag')).toHaveText('Saved');
  await request.post('/__test/chart-rollover', { data: { edition: 'notice', missingNotice: true } });
  await page.reload();
  await expect.poll(async () => (await catalog(page, '2026-10-01'))?.revision).toBe('2026-10-01');
  await offlineSettings(page);
  await row(page, '2026-09-03').getByRole('button', { name: 'Update to latest', exact: true }).click();
  await expect(row(page, '2026-10-01').locator('.offline-tag')).toHaveText('Needs attention');
  await expect(row(page, '2026-10-01')).toContainText('Saved cycle Sep 3 stays selected');
  await page.getByLabel('Close settings').click();
  await context.setOffline(true);
  await page.reload();
  await approach(page, 'TEST APPROACH');
  await context.setOffline(false);
  await request.post('/__test/chart-rollover', { data: { edition: 'notice' } });
  await offlineSettings(page);
  // Incomplete transfers restore as paused after restarting the app.
  await expect(row(page, '2026-10-01').locator('.offline-tag')).toHaveText('Paused');
  await row(page, '2026-10-01').getByRole('button', { name: 'Resume', exact: true }).click();
  await expect(row(page, '2026-10-01').locator('.offline-tag')).toHaveText('Saved');
  await expect(row(page, '2026-09-03')).toHaveCount(0);
  await page.getByLabel('Close settings').click();
  await approach(page, 'NOTICE APPROACH');
  await request.post('/__test/chart-rollover', { data: { edition: 'full', onlyLatest: true } });
  await page.reload();
  await expect.poll(async () => (await catalog(page, '2026-10-29'))?.charts[0]?.revision).toBe('2026-10-29');
  // Browsing advances, but the verified October region keeps its own sources.
  await approach(page, 'NOTICE APPROACH');
  await offlineSettings(page);
  await row(page, '2026-10-01').getByRole('button', { name: 'Update to latest', exact: true }).click();
  await expect(row(page, '2026-10-29').locator('.offline-tag')).toHaveText('Saved');
  await page.getByLabel('Close settings').click();
  await context.setOffline(true);
  await page.reload();
  await approach(page, 'TEST APPROACH');
  await expect(page.getByRole('button', { name: /NOTICE APPROACH/ })).toHaveCount(0);
});

test('fresh install can save a standalone full edition after older server files are removed', async ({ page, request, context }) => {
  await request.post('/__test/chart-rollover', { data: { edition: 'full', onlyLatest: true } });
  await page.goto('/');
  await offlineSettings(page);
  await expect.poll(async () => (await catalog(page, '2026-10-29'))?.charts[0]?.revision).toBe('2026-10-29');
  await row(page, '2026-10-29').getByRole('button', { name: 'Download', exact: true }).click();
  await expect(row(page, '2026-10-29').locator('.offline-tag')).toHaveText('Saved');
  await page.getByLabel('Close settings').click();
  await context.setOffline(true);
  await page.reload();
  await approach(page, 'TEST APPROACH');
});
