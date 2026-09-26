import { test, expect, type Page } from '@playwright/test';
import type { CatalogResponse } from '@zlayer/contracts';

test.beforeEach(async ({ page }) => {
  await page.clock.setFixedTime(new Date('2026-09-23T08:00:00Z'));
});
test.afterEach(async ({ request }) => { await request.post('/__test/reset'); });

async function browsingCatalog(page: Page) {
  return page.evaluate(() => new Promise<CatalogResponse | undefined>((resolve, reject) => {
    const open = indexedDB.open('zlayer-offline', 1);
    open.onerror = () => reject(open.error);
    open.onsuccess = () => {
      const db = open.result;
      const read = db.transaction('records').objectStore('records').get('catalog:/chart-data:2026-09-03');
      read.onerror = () => { db.close(); reject(read.error); };
      read.onsuccess = () => { db.close(); resolve(read.result as CatalogResponse | undefined); };
    };
  }));
}

async function removeBrowsingMetadata(page: Page, removeCatalogs: boolean) {
  // The installed worker serves the app shell for every navigation, including
  // /icon.svg. Bypass it only while leaving the app, so refreshes cannot recreate
  // browsing metadata during cleanup. Restore interception before testing recovery.
  const session = await page.context().newCDPSession(page);
  try {
    await session.send('Network.enable');
    await session.send('Network.setBypassServiceWorker', { bypass: true });
    await page.goto('/icon.svg');
  } finally {
    await session.send('Network.setBypassServiceWorker', { bypass: false });
    await session.detach();
  }
  expect(await page.evaluate(() => document.contentType)).toBe('image/svg+xml');
  await page.evaluate(async removeCatalogs => {
    const cache = await caches.open('zlayers-data-v6');
    for (const key of await cache.keys()) {
      if (/\/mbtiles\/(?:packages\/)?(?:chart-)?manifest\.json$/.test(new URL(key.url).pathname)) await cache.delete(key);
    }
    if (!removeCatalogs) return;
    await new Promise<void>((resolve, reject) => {
      const open = indexedDB.open('zlayer-offline', 1);
      open.onerror = () => reject(open.error);
      open.onsuccess = () => {
        const db = open.result, transaction = db.transaction('records', 'readwrite');
        const cursor = transaction.objectStore('records').openCursor();
        cursor.onsuccess = () => {
          const item = cursor.result;
          if (!item) return;
          if (/^catalog(?:-cycles)?:/.test(String(item.key))) item.delete();
          item.continue();
        };
        transaction.oncomplete = () => { db.close(); resolve(); };
        transaction.onabort = () => { db.close(); reject(transaction.error); };
      };
    });
  }, removeCatalogs);
}

test('a new chart family leaves supported charts available on a clean launch and offline restart', async ({ page, request, context }) => {
  await request.post('/__test/add-chart-family');
  const archives: string[] = [];
  page.on('request', event => { if (event.url().includes('.mbtiles')) archives.push(event.url()); });
  await page.goto('/');
  await expect(page.getByLabel('Settings and offline downloads')).toBeEnabled();
  await expect.poll(async () => (await browsingCatalog(page))?.charts.length ?? 0).toBeGreaterThan(0);
  await expect.poll(() => archives.length).toBeGreaterThan(0);
  const saved = (await browsingCatalog(page))!;
  expect(saved.charts.map(chart => chart.kind)).not.toContain('ifr-high');
  expect(saved.chartPackages!.archives.map(archive => archive.kind)).not.toContain('ifr-high');
  await context.setOffline(true);
  await page.reload();
  await expect(page.getByLabel('Settings and offline downloads')).toBeEnabled();
  await expect(page.getByRole('heading', { name: 'Chart feed unavailable' })).toHaveCount(0);
  expect((await browsingCatalog(page))?.charts).toEqual(saved.charts);
  expect(archives.some(url => url.includes('ifr-high'))).toBe(false);
});

test('a broken live manifest uses the saved browsing catalog with a nonblocking refresh notice', async ({ page, request }) => {
  await page.goto('/');
  await expect(page.getByLabel('Settings and offline downloads')).toBeEnabled();
  await expect.poll(async () => (await browsingCatalog(page))?.charts.length ?? 0).toBeGreaterThan(0);
  const saved = (await browsingCatalog(page))!;
  await removeBrowsingMetadata(page, false);
  await request.post('/__test/invalid-chart-feed');
  await page.goto('/');
  await expect(page.locator('.feed-status').filter({ hasText: 'Chart refresh failed; using saved FAA Sep 3 charts.' })).toBeVisible();
  await expect(page.getByLabel('Settings and offline downloads')).toBeEnabled();
  await expect(page.getByRole('heading', { name: 'Chart feed unavailable' })).toHaveCount(0);
  expect((await browsingCatalog(page))?.chartPackages).toEqual(saved.chartPackages);
  await page.getByLabel('Settings and offline downloads').click();
  await expect(page.getByRole('heading', { name: 'Settings', exact: true })).toBeVisible();
});

for (const offline of [true, false]) {
  test(`saved regions open without browsing metadata when ${offline ? 'offline' : 'the live chart feed is invalid'}`, async ({ page, context, request }) => {
    await page.goto('/');
    await page.getByLabel('Settings and offline downloads').click();
    await page.getByLabel('Find a state or territory').fill('California');
    await page.locator('.region-row').getByRole('button', { name: 'Download', exact: true }).click();
    await expect(page.locator('.download-card .offline-tag')).toHaveText('Saved');
    await page.getByLabel('Close settings').click();
    // Invalidate discovery before removing saved metadata, so a finishing
    // download refresh cannot repopulate it from a still-valid live manifest.
    if (!offline) await request.post('/__test/invalid-chart-feed');
    await removeBrowsingMetadata(page, true);
    expect(await browsingCatalog(page)).toBeUndefined();
    if (offline) await context.setOffline(true);
    await page.goto('/');
    await expect(page.getByLabel('Settings and offline downloads')).toBeEnabled();
    await expect(page.locator('.saved-editions')).toContainText('Sep 3');
    await expect(page.locator('.feed-status').filter({ hasText: 'Using saved FAA cycle Sep 3.' })).toBeVisible();
    await expect(page.getByRole('heading', { name: 'Chart feed unavailable' })).toHaveCount(0);
    await page.getByLabel('Search FAA navigation data').fill('KSBA');
    await page.locator('.search-results button').filter({ hasText: 'KSBA' }).click();
    await page.getByRole('tab', { name: 'Plates', exact: true }).click();
    await page.getByRole('button', { name: /TEST APPROACH/ }).click();
    await expect(page.locator('.procedure-page-stage canvas')).toBeVisible();
    await page.getByLabel('Close plate').click();
    await page.getByLabel('Settings and offline downloads').click();
    await expect(page.locator('#cycle-description')).toContainText('Browsing FAA Sep 3');
    await expect(page.locator('.download-card .offline-tag')).toHaveText('Saved');
    await context.setOffline(false);
    await request.post('/__test/reset');
    await page.reload();
    await expect(page.getByLabel('Settings and offline downloads')).toBeEnabled();
    await expect.poll(async () => (await browsingCatalog(page))?.charts.length ?? 0).toBeGreaterThan(0);
    await expect(page.getByText('Chart feed refresh failed; saved regions remain available.', { exact: false })).toHaveCount(0);
  });
}
