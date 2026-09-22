import { test, expect, type Page } from '@playwright/test';
import { selectCycle } from './settings';
import type { DownloadPlan } from '../../src/offline/downloads';

test.beforeEach(async ({ page }) => {
  await page.clock.setFixedTime(new Date('2026-09-19T12:00:00Z'));
});
async function saveRegion(page: Page, region = 'California', revision = '2026-09-03') {
  await page.goto('/');
  await selectCycle(page, revision);
  await page.getByLabel('Settings and offline downloads').click();
  await page.getByLabel('Find a state or territory').fill(region);
  await page.locator('.region-row').getByRole('button', { name: 'Download', exact: true }).click();
  await expect(page.locator('.download-card .offline-tag')).toHaveText('Saved');
  await page.getByLabel('Close settings').click();
}

async function openAirportPlates(page: Page) {
  await page.getByLabel('Search FAA navigation data').fill('KSBA');
  await page.locator('.search-results button').filter({ hasText: 'KSBA' }).click();
  await page.getByRole('button', { name: 'Plates', exact: true }).click();
}

test('saved navigation rejects replacement content after eviction despite identical cycle and counts', async ({ page, request }) => {
  await saveRegion(page);
  await request.post('/__test/replace-navigation');
  try {
    await page.evaluate(async () => {
      const cache = await caches.open('zlayers-data-v6');
      for (const key of await cache.keys()) if (key.url.includes('/nav/airports.geojson')) await cache.delete(key);
    });
    await page.reload();
    await expect(page.locator('.feed-status').filter({ hasText: /California.*airports unavailable/ })).toBeVisible();
    await page.getByLabel('Search FAA navigation data').fill('KSBA');
    await expect(page.locator('.search-results button').filter({ hasText: 'KSBA' })).toHaveCount(0);
    const savedUrl = await page.evaluate(() => new Promise<string>((resolve, reject) => {
      const open = indexedDB.open('zlayer-offline', 1);
      open.onerror = () => reject(open.error);
      open.onsuccess = () => {
        const db = open.result;
        const read = db.transaction('records').objectStore('records').getAll(IDBKeyRange.bound('region:', 'region:\uffff'));
        read.onsuccess = () => { db.close(); resolve((read.result as DownloadPlan[])[0]!.references.find(r => r.id === 'airports')!.url); };
      };
    }));
    expect(await page.evaluate(async url => !!await (await caches.open('zlayers-data-v6')).match(url), savedUrl)).toBe(false);
  } finally { await request.post('/__test/reset'); }
});

test('an open airport keeps its edition and plate targets when a newer saved region activates', async ({ page }) => {
  await saveRegion(page, 'California', '2026-08-06');
  await openAirportPlates(page);
  await expect(page.locator('.feature-edition')).toHaveText('FAA Aug 6');
  await page.getByRole('button', { name: 'Info', exact: true }).click();
  await selectCycle(page, '2026-09-03');
  await page.getByLabel('Settings and offline downloads').click();
  await page.getByLabel('Find a state or territory').fill('California');
  await page.locator('.region-row').getByRole('button', { name: 'Download', exact: true }).click();
  await expect(page.locator('.download-card .offline-tag')).toHaveText(['Saved', 'Saved']);
  await page.getByLabel('Close settings').click();
  await expect(page.locator('.saved-editions')).toContainText('Sep 3');
  // Wait for the new navigation to load, not merely for download completion.
  await page.getByLabel('Search FAA navigation data').fill('KSBA');
  await expect(page.locator('.search-results button').filter({ hasText: 'KSBA' })).toBeVisible();
  await expect(page.locator('.feature-edition')).toHaveText('FAA Aug 6');
  await page.getByLabel('Search FAA navigation data').fill('');
  await page.getByRole('button', { name: 'Plates', exact: true }).click();
  await page.getByRole('button', { name: /TEST APPROACH/ }).click();
  await expect(page.getByText('Open original ↗')).toHaveAttribute('href', /\/2026-08-06\//);
  await page.getByLabel('Close plate').click();
  await page.getByRole('button', { name: 'Show KSBA details', exact: true }).click();
  await page.locator('.procedure-group button').filter({ hasText: 'Chart Supplement' }).click();
  await expect(page.getByText('Open original ↗')).toHaveAttribute('href', /\/2026-08-06\//);
  await page.getByLabel('Close plate').click();
  await page.getByRole('button', { name: 'Show KSBA details', exact: true }).click();
  await page.getByLabel('Close detail').click();
  await openAirportPlates(page);
  await expect(page.locator('.feature-edition')).toHaveText('FAA Sep 3');
  await page.getByRole('button', { name: /TEST APPROACH/ }).click();
  await expect(page.getByText('Open original ↗')).toHaveAttribute('href', /\/2026-09-03\//);
});

async function addUnreadableSelection(page: Page, legacy: boolean) {
  return page.evaluate(legacy => new Promise<string>((resolve, reject) => {
    const open = indexedDB.open('zlayer-offline', 1);
    open.onerror = () => reject(open.error);
    open.onsuccess = () => {
      const db = open.result, transaction = db.transaction('records', 'readwrite');
      const records = transaction.objectStore('records');
      const selections = records.getAll(IDBKeyRange.bound('region:', 'region:\uffff'));
      let sharedUrl = '';
      transaction.oncomplete = () => { db.close(); resolve(sharedUrl); };
      transaction.onabort = () => { db.close(); reject(transaction.error); };
      selections.onsuccess = () => {
        const plan = (selections.result as DownloadPlan[])[0]!;
        sharedUrl = plan.files[0]!.url;
        if (!legacy) { records.put({ id: 'unreadable', files: plan.files }, 'region:unreadable'); return; }
        const snapshot = records.get(`bundle-snapshot:${plan.snapshotId}`);
        snapshot.onsuccess = () => {
          const { snapshotId: _snapshot, completedAt: _activation, previous: _previous, ...fields } = plan;
          records.put({ ...fields, id: 'legacy-fault', regionId: 'us-NV', title: 'Legacy Nevada', catalog: snapshot.result,
            files: plan.files.map(file => ({ ...file, url: `${file.url}&legacy-cache-fault=1` })) }, 'region:legacy-fault');
        };
      };
    };
  }), legacy);
}

test('cold startup preserves a committed edition when a legacy selection has a cache-read failure', async ({ page, context }) => {
  await saveRegion(page, 'California', '2026-08-06');
  await selectCycle(page, 'latest');
  await addUnreadableSelection(page, true);
  const cold = await context.newPage();
  await cold.addInitScript(() => {
    const match = Cache.prototype.match;
    Cache.prototype.match = function (request, options) {
      const url = request instanceof Request ? request.url : String(request);
      if (url.includes('legacy-cache-fault')) return Promise.reject(new Error('Injected legacy storage failure'));
      return match.call(this, request, options);
    };
  });
  await page.close();
  await cold.goto('/');
  await expect(cold.locator('.feed-status').filter({ hasText: 'Legacy Nevada' })).toContainText('Injected legacy storage failure');
  await openAirportPlates(cold);
  await expect(cold.locator('.feature-edition')).toHaveText('FAA Aug 6');
  await cold.getByRole('button', { name: /TEST APPROACH/ }).click();
  await expect(cold.getByText('Open original ↗')).toHaveAttribute('href', /\/2026-08-06\//);
});

test('an airport outside saved coverage opens plates from its actual fallback navigation edition', async ({ page, request }) => {
  await saveRegion(page, 'Nevada', '2026-08-06');
  await selectCycle(page, 'latest');
  await request.post('/__test/fail-browsing-airports');
  try {
    await page.evaluate(async () => {
      const cache = await caches.open('zlayers-data-v6');
      for (const key of await cache.keys()) if (key.url.includes('/2026-09-03/nav/airports.geojson')) await cache.delete(key);
    });
    await page.reload();
    await openAirportPlates(page);
    await expect(page.locator('.feature-edition')).toHaveText('FAA Aug 6');
    await page.getByRole('button', { name: /TEST APPROACH/ }).click();
    await expect(page.getByText('Open original ↗')).toHaveAttribute('href', /\/2026-08-06\//);
  } finally { await request.post('/__test/reset'); }
});

test('saved TPP metadata rejects changed PDF identities even when dates, counts and timestamp are reused', async ({ page, request }) => {
  await saveRegion(page);
  await request.post('/__test/replace-tpp-metadata');
  try {
    await page.evaluate(async () => {
      const cache = await caches.open('zlayers-data-v6');
      for (const key of await cache.keys()) if (key.url.includes('/tpp/catalog.json')) await cache.delete(key);
    });
    await page.reload();
    await openAirportPlates(page);
    await expect(page.locator('.procedure-state.is-error')).toContainText('invalid document');
    await expect(page.getByRole('button', { name: /TEST APPROACH/ })).toHaveCount(0);
  } finally { await request.post('/__test/reset'); }
  await page.reload();
  await openAirportPlates(page);
  await expect(page.getByRole('button', { name: /TEST APPROACH/ })).toBeVisible();
});

test('removing a region preserves files and the selection when another stored record is unreadable', async ({ page }) => {
  await saveRegion(page);
  const sharedUrl = await addUnreadableSelection(page, false);
  await page.getByLabel('Settings and offline downloads').click();
  await expect(page.locator('.download-card .offline-tag')).toHaveText('Saved');
  await page.locator('.download-card').getByRole('button', { name: 'Remove', exact: true }).click();
  await page.getByRole('alertdialog').getByRole('button', { name: 'Remove', exact: true }).click();
  await expect(page.locator('.settings-error')).toContainText('could not be read');
  await expect(page.locator('.download-card')).toHaveCount(1);
  expect(await page.evaluate(async url => !!await (await caches.open('zlayers-chart-archives-v3')).match(url), sharedUrl)).toBe(true);
});
