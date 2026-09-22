import { test, expect, type Page } from '@playwright/test';
import { expectCycle, selectCycle } from './settings';

test.beforeEach(async ({ page }) => {
  await page.clock.setFixedTime(new Date('2026-09-19T12:00:00Z'));
});

async function setRoute(page: Page) {
  const input = page.getByRole('textbox', { name: 'Add route waypoint' });
  await input.fill('KSBA KSMO ');
  await input.press('Enter');
  await expect(page.locator('[data-route-entry]')).toHaveCount(2);
}

test('cycle discovery works with directory listing forbidden', async ({ page, context }) => {
  const requests: string[] = [];
  await context.route('**/chart-data/', route => route.fulfill({ status: 403, body: 'Forbidden' }));
  page.on('request', request => requests.push(new URL(request.url()).pathname));
  await page.goto('/');
  await page.getByLabel('Settings and offline downloads').click();
  await expect(page.getByLabel('FAA data cycle').locator('option')).toHaveText([
    'Default · Latest', 'FAA Sep 3', 'FAA Aug 6',
  ]);
  await expect(page.getByText(/Cycle list unavailable online/)).toHaveCount(0);
  expect(requests).toContain('/chart-data/cycles.json');
  expect(requests).not.toContain('/chart-data/');
});

test('dismissed fetch warnings stay dismissed across map tiles and chart failures', async ({ page, context }) => {
  await context.route('**/basemap.png', route => route.abort('internetdisconnected'));
  await page.goto('/');
  const dismiss = page.getByRole('button', { name: 'Dismiss warning' });
  await expect(dismiss).toBeVisible();
  await dismiss.click();
  const failedTile = page.waitForEvent('requestfailed', request => request.url().endsWith('/basemap.png'));
  await page.getByRole('button', { name: 'Zoom in', exact: true }).click();
  await failedTile;
  await page.evaluate(() => {
    for (const url of ['unsaved-a.mbtiles', 'unsaved-b.mbtiles']) {
      navigator.serviceWorker.dispatchEvent(new MessageEvent('message', { data: {
        type: 'chart-archive-error', url, message: 'Failed to fetch',
      } }));
    }
  });
  await expect(dismiss).toHaveCount(0);
  await context.setOffline(true);
  await expect(page.locator('.offline-banner')).toBeVisible();
  await expect(dismiss).toHaveCount(0);
});

test('saved region, route draft, first-use PDF viewer and glyphs work after a cold offline page', { tag: '@smoke' }, async ({ page, context }) => {
  const errors: string[] = [];
  context.on('page', opened => opened.on('pageerror', error => errors.push(error.message)));
  page.on('pageerror', error => errors.push(error.message));
  await page.goto('/');
  await expectCycle(page, 'latest');
  await page.waitForFunction(() => !!navigator.serviceWorker.controller);
  await setRoute(page);
  await page.getByRole('button', { name: 'Advise', exact: true }).click();
  await expect(page.locator('[data-route-category="frequency"] li').first()).toBeVisible();
  await expect(page.locator('[data-route-category="tec"] li').first()).toBeVisible();
  await page.locator('.route-recommend-close').click();
  await page.getByLabel('Settings and offline downloads').click();
  await page.getByLabel('Find a state or territory').fill('California');
  await page.locator('.region-row').getByRole('button', { name: 'Download', exact: true }).click();
  await expect(page.locator('.download-card .offline-tag')).toHaveText('Saved');
  await page.evaluate(async () => {
    await (await caches.open('zlayers-procedures-v1')).put('/unused.pdf', new Response('unused'));
  });
  await page.getByText('Temporary files and storage limits', { exact: true }).click();
  await page.getByRole('button', { name: 'Remove temporary charts and plates' }).click();
  await page.getByRole('alertdialog').getByRole('button', { name: 'Remove', exact: true }).click();
  await expect.poll(() => page.evaluate(async () => !!await (await caches.open('zlayers-procedures-v1')).match('/unused.pdf'))).toBe(false);
  await page.getByLabel('Close settings').click();
  const glyph = '/fonts/Noto%20Sans%20Bold/0-255.pbf';
  expect(await page.evaluate(async url => {
    const name = (await caches.keys()).find(key => key.startsWith('zlayers-shell-'))!;
    return !!await (await caches.open(name)).match(url);
  }, glyph)).toBe(true);

  await context.setOffline(true);
  const cold = await context.newPage();
  // Chromium can block a new page's network while leaving navigator.onLine true.
  // Exercise a known-offline launch; the test above covers unreliable detection.
  await cold.addInitScript(() => Object.defineProperty(navigator, 'onLine', { get: () => false }));
  await page.close();
  await cold.goto('/');
  await expect(cold.locator('.offline-banner')).toBeVisible();
  await expect(cold.locator('[data-route-entry]')).toHaveCount(2);
  await expect(cold.locator('[data-route-entry]').first()).toContainText('KSBA');
  expect(await cold.evaluate(async url => (await fetch(url)).ok, glyph)).toBe(true);
  await cold.getByRole('button', { name: 'Advise', exact: true }).click();
  await expect(cold.locator('[data-route-category="frequency"] li').first()).toBeVisible();
  await cold.locator('.route-recommend-close').click();
  await cold.getByLabel('Search FAA navigation data').fill('KSBA');
  await cold.locator('.search-results button').filter({ hasText: 'KSBA' }).click();
  await cold.getByRole('tab', { name: 'Plates', exact: true }).click();
  await cold.getByRole('button', { name: /TEST APPROACH/ }).click();
  await expect(cold.getByText('Available offline', { exact: true })).toBeVisible();
  await expect(cold.locator('.procedure-page-loading')).toHaveCount(0);
  expect(await cold.locator('.procedure-page-stage canvas').evaluate(element => {
    const canvas = element as HTMLCanvasElement;
    const pixel = canvas.getContext('2d')!.getImageData(canvas.width / 2, canvas.height / 2, 1, 1).data;
    return canvas.width > 0 && pixel[2]! > pixel[0]! * 2;
  })).toBe(true);
  await cold.getByLabel('Close plate').click();
  // Closing finishes after the slide and restores focus to the airport tab.
  // Wait for that handoff before opening a menu that dismisses on blur.
  await expect(cold.getByRole('button', { name: 'Show KSBA details', exact: true })).toBeFocused();
  await cold.getByRole('button', { name: 'Route actions', exact: true }).click();
  await cold.getByRole('menuitem', { name: 'Clear Route', exact: true }).click();
  await cold.reload();
  await expect(cold.locator('[data-route-entry]')).toHaveCount(0);
  await expect(cold.getByRole('button', { name: 'Dismiss warning' })).toHaveCount(0);
  await cold.setViewportSize({ width: 390, height: 844 });
  expect(await cold.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  expect(errors).toEqual([]);
});

test('published dates load on selection and two editions of a region stay isolated offline and on removal', async ({ page, context }) => {
  const requests: string[] = [];
  page.on('request', request => requests.push(request.url()));
  await page.goto('/');
  const menu = page.getByLabel('FAA data cycle');
  await expectCycle(page, 'latest');
  await expect(menu.locator('option')).toHaveText(['Default · Latest', 'FAA Sep 3', 'FAA Aug 6']);
  expect(requests.some(url => url.includes('/2026-07-09/'))).toBe(false);
  expect(requests.some(url => url.includes('/2026-08-06/'))).toBe(false);
  await setRoute(page);
  const saveCalifornia = async (revision: string) => {
    await page.getByLabel('Settings and offline downloads').click();
    await page.getByLabel('Find a state or territory').fill('California');
    await expect(page.locator('.region-cycle'))
      .toContainText(revision === '2026-09-03' ? 'Sep 3' : 'Aug 6');
    await page.locator('.region-row').getByRole('button', { name: 'Download', exact: true }).click();
    const card = page.locator('.download-card').filter({ hasText: `Cycle ${revision === '2026-09-03' ? 'Sep 3' : 'Aug 6'}` });
    await expect(card.locator('.offline-tag')).toHaveText('Saved');
    await page.getByLabel('Close settings').click();
  };
  await saveCalifornia('2026-09-03');
  await selectCycle(page, '2026-08-06');
  await saveCalifornia('2026-08-06');
  await page.reload();
  await expectCycle(page, '2026-08-06');
  await expect(page.locator('.feed-status').filter({ hasText: /Using FAA cycle Aug 6/ })).toBeVisible();
  await page.getByRole('button', { name: 'Advise', exact: true }).click();
  await expect(page.locator('[data-route-category="frequency"] li').first()).toBeVisible();
  await page.locator('.route-recommend-close').click();
  await context.setOffline(true);
  await page.reload();
  await expectCycle(page, '2026-08-06');
  await expect(page.locator('[data-route-entry]')).toHaveCount(2);
  await page.getByLabel('Settings and offline downloads').click();
  const old = page.locator('.download-card').filter({ hasText: 'Cycle Aug 6' });
  const current = page.locator('.download-card').filter({ hasText: 'Cycle Sep 3' });
  await expect(old.locator('.offline-tag')).toHaveText('Saved');
  await expect(current.locator('.offline-tag')).toHaveText('Saved');
  // Verify the other date while viewing the older map: it must keep its own plan.
  await current.getByRole('button', { name: 'Verify / update' }).click();
  await expect(current.locator('.offline-tag')).toHaveText('Saved');
  await page.getByLabel('Close settings').click();
  await selectCycle(page, 'latest');
  await page.getByLabel('Settings and offline downloads').click();
  await old.getByRole('button', { name: 'Remove', exact: true }).click();
  const confirmation = page.getByRole('alertdialog', { name: /Remove California.*cycle Aug 6/ });
  await confirmation.getByRole('button', { name: 'Remove', exact: true }).click();
  await expect(old).toHaveCount(0);
  await expect(current.locator('.offline-tag')).toHaveText('Saved');
  const keys = await page.evaluate(async () => {
    const names = ['zlayers-chart-archives-v3', 'zlayers-procedures-v1'];
    return Promise.all(names.map(async name => (await (await caches.open(name)).keys()).map(key => key.url)));
  });
  for (const urls of keys) {
    expect(urls.some(url => url.includes('/2026-09-03/'))).toBe(true);
    expect(urls.some(url => url.includes('/2026-08-06/'))).toBe(false);
  }
  await page.getByLabel('Close settings').click();
  await page.reload();
  await expectCycle(page, 'latest');
  await page.getByLabel('Search FAA navigation data').fill('KSBA');
  await page.locator('.search-results button').filter({ hasText: 'KSBA' }).click();
  await page.getByRole('tab', { name: 'Plates', exact: true }).click();
  await page.getByRole('button', { name: /TEST APPROACH/ }).click();
  await expect(page.getByText('Available offline', { exact: true })).toBeVisible();
});

test('an older saved region overrides latest browsing online and after an offline restart', async ({ page, context }) => {
  await page.goto('/');
  const menu = page.getByLabel('FAA data cycle');
  await selectCycle(page, '2026-08-06');
  await page.getByLabel('Settings and offline downloads').click();
  await page.getByLabel('Find a state or territory').fill('California');
  await page.locator('.region-row').getByRole('button', { name: 'Download', exact: true }).click();
  await expect(page.locator('.download-card .offline-tag')).toHaveText('Saved');
  await page.getByLabel('Close settings').click();
  await selectCycle(page, 'latest');
  await expect(menu.locator('option:checked')).toHaveText('Default · Latest');

  const checkSavedAirport = async () => {
    await expect(page.locator('.saved-editions')).toContainText('Aug 6');
    await page.getByLabel('Search FAA navigation data').fill('KSBA');
    await page.locator('.search-results button').filter({ hasText: 'KSBA' }).click();
    await expect(page.locator('.feature-edition')).toHaveText('FAA Aug 6');
    await page.getByRole('tab', { name: 'Plates', exact: true }).click();
    await page.getByRole('button', { name: /TEST APPROACH/ }).click();
    await expect(page.getByText('Open original ↗')).toHaveAttribute('href', /\/2026-08-06\//);
    await expect(page.getByText('Available offline', { exact: true })).toBeVisible();
    await page.getByLabel('Close plate').click();
  };
  await checkSavedAirport();
  await context.setOffline(true);
  await page.reload();
  await expectCycle(page, 'latest');
  await checkSavedAirport();

  await context.setOffline(false);
  await page.getByLabel('Settings and offline downloads').click();
  await page.locator('.download-card').getByRole('button', { name: 'Remove', exact: true }).click();
  await page.getByRole('alertdialog').getByRole('button', { name: 'Remove', exact: true }).click();
  await expect(page.locator('.download-card')).toHaveCount(0);
  await page.getByLabel('Close settings').click();
  await expect(page.locator('.saved-editions')).toHaveCount(0);
  await page.getByRole('button', { name: 'Show KSBA details', exact: true }).click();
  await expect(page.locator('.feature-edition')).toHaveText('FAA Aug 6');
  await page.getByLabel('Close detail').click();
  await page.getByLabel('Search FAA navigation data').fill('KSBA');
  await page.locator('.search-results button').filter({ hasText: 'KSBA' }).click();
  await expect(page.locator('.feature-edition')).toHaveText('FAA Sep 3');
});

test('saved badge follows the map view and never treats automatic cache as an explicit download', async ({ page }) => {
  await page.goto('/');
  await page.waitForFunction(async () => (await (await caches.open('zlayers-chart-archives-v3')).keys()).length > 0);
  await expect(page.locator('.saved-editions')).toHaveCount(0);
  await page.getByLabel('Settings and offline downloads').click();
  await page.getByLabel('Find a state or territory').fill('California');
  await page.locator('.region-row').getByRole('button', { name: 'Download', exact: true }).click();
  await expect(page.locator('.download-card .offline-tag')).toHaveText('Saved');
  await page.getByLabel('Close settings').click();
  await expect(page.locator('.saved-editions')).toHaveText('California · Saved · Sep 3');
  await expect(page.locator('.saved-editions')).toHaveAttribute('title', /California/);

  const zoomOut = page.getByRole('button', { name: 'Zoom out', exact: true });
  await expect.poll(async () => {
    // Check and click in one browser task: the final camera frame can disable
    // the control between a Node-side isDisabled() check and Playwright's click.
    await zoomOut.evaluate((button: HTMLButtonElement) => {
      if (!button.disabled && button.getAttribute('aria-disabled') !== 'true') button.click();
    });
    return zoomOut.isDisabled();
  }, { intervals: [500], timeout: 10_000 }).toBe(true);
  const map = await page.locator('.maplibregl-canvas').boundingBox();
  const x = map!.x + map!.width * 0.75, y = map!.y + map!.height * 0.6;
  // At zoom 3, a 500px westward drag moves the center from California to the East Coast.
  await page.mouse.move(x, y);
  await page.mouse.down();
  await page.mouse.move(x - 500, y, { steps: 20 });
  await page.waitForTimeout(200); // Release without inertial panning.
  await page.mouse.up();
  for (let i = 0; i < 3; i++) {
    await page.getByRole('button', { name: 'Zoom in', exact: true }).click();
    await page.waitForTimeout(350);
  }
  await expect(page.locator('.saved-editions')).toHaveCount(0);

  await page.getByLabel('Search FAA navigation data').fill('KSBA');
  await page.locator('.search-results button').filter({ hasText: 'KSBA' }).click();
  await expect(page.locator('.saved-editions')).toHaveText('California · Saved · Sep 3');
});

test('cleanup keeps all releases while another app window is open', async ({ page, context }) => {
  await page.goto('/');
  await page.waitForFunction(() => !!navigator.serviceWorker.controller);
  await page.evaluate(async () => {
    const cache = await caches.open('zlayers-shell-obsolete');
    await cache.put('/', new Response('<script src="/assets/obsolete.js"></script>'));
  });
  const second = await context.newPage();
  await second.goto('/');
  await second.waitForFunction(() => !!navigator.serviceWorker.controller);
  const report = () => page.evaluate(() => navigator.serviceWorker.controller!.postMessage({
    type: 'active-shell', entry: (document.querySelector('script[type=module]') as HTMLScriptElement).src,
  }));
  await report();
  expect(await page.evaluate(() => caches.has('zlayers-shell-obsolete'))).toBe(true);
  await second.close();
  await report();
  await expect.poll(() => page.evaluate(() => caches.has('zlayers-shell-obsolete'))).toBe(false);
});

test('legacy browsing sheets and saved regional packages both render after restart', async ({ page, request }) => {
  await request.post('/__test/legacy-latest-charts');
  try {
    await page.goto('/');
    await selectCycle(page, '2026-08-06');
    await page.getByLabel('Settings and offline downloads').click();
    await page.getByLabel('Find a state or territory').fill('California');
    await page.locator('.region-row').getByRole('button', { name: 'Download', exact: true }).click();
    await expect(page.locator('.download-card .offline-tag')).toHaveText('Saved');
    await page.getByLabel('Close settings').click();
    await selectCycle(page, 'latest');
    const archives: string[] = [];
    page.on('request', event => { if (event.url().includes('.mbtiles?')) archives.push(event.url()); });
    await page.reload();
    await expect(page.locator('.saved-editions')).toContainText('Aug 6');
    await expect.poll(() => archives.some(url => url.includes('/2026-08-06/mbtiles/vfr-sectional'))).toBe(true);
    await expect.poll(() => archives.some(url => url.includes('/2026-09-03/mbtiles/chart.mbtiles'))).toBe(true);
    await expect(page.getByRole('button', { name: 'Dismiss warning' })).toHaveCount(0);
  } finally { await request.post('/__test/reset'); }
});

test('an unavailable cycle keeps the saved workspace and its controls accessible', async ({ page, context }) => {
  await page.goto('/');
  await expectCycle(page, 'latest');
  await setRoute(page);
  await context.setOffline(true);
  await page.getByLabel('Settings and offline downloads').click();
  await page.getByLabel('FAA data cycle').selectOption('2026-08-06');
  await expect(page.locator('.settings-cycle-notice')).toContainText('FAA cycle Aug 6 unavailable');
  await expect(page.getByRole('heading', { name: 'Chart feed unavailable' })).toHaveCount(0);
  await expect(page.getByLabel('FAA data cycle')).toHaveValue('latest');
  await expect(page.locator('[data-route-entry]')).toHaveCount(2);
  await expect(page.getByRole('heading', { name: 'Settings', exact: true })).toBeVisible();
  await page.getByLabel('FAA data cycle').selectOption('2026-09-03');
  await expect(page.getByLabel('FAA data cycle')).toHaveValue('2026-09-03');
  await expect(page.getByText(/FAA cycle Aug 6 unavailable/)).toHaveCount(0);
  await page.getByLabel('Close settings').click();
});

test('a chart retained by the worker can repair missing storage while offline', async ({ page, context }) => {
  await page.goto('/');
  await page.getByLabel('Settings and offline downloads').click();
  await page.getByLabel('Find a state or territory').fill('California');
  await page.locator('.region-row').getByRole('button', { name: 'Download', exact: true }).click();
  await expect(page.locator('.download-card .offline-tag')).toHaveText('Saved');
  const url = await page.evaluate(async () => {
    const cache = await caches.open('zlayers-chart-archives-v3');
    const [key] = await cache.keys();
    await fetch(key!.url, { method: 'HEAD' });
    await cache.delete(key!);
    return key!.url;
  });
  await context.setOffline(true);
  await page.getByRole('button', { name: 'Check saved files', exact: true }).click();
  await expect(page.locator('.download-card .offline-tag')).toHaveText('Paused');
  await page.locator('.download-card').getByRole('button', { name: 'Resume', exact: true }).click();
  await expect(page.locator('.download-card .offline-tag')).toHaveText('Saved');
  expect(await page.evaluate(async url => !!await (await caches.open('zlayers-chart-archives-v3')).match(url), url)).toBe(true);
});

test('downloads reopen IndexedDB after the browser force-closes its connection', async ({ page, context }) => {
  await page.goto('/');
  await page.getByLabel('Settings and offline downloads').click();
  await page.getByLabel('Find a state or territory').fill('California');
  await page.locator('.region-row').getByRole('button', { name: 'Download', exact: true }).click();
  await expect(page.locator('.download-card .offline-tag')).toHaveText('Saved');
  const cdp = await context.newCDPSession(page);
  await cdp.send('Storage.clearDataForOrigin', { origin: new URL(page.url()).origin, storageTypes: 'indexeddb' });
  await page.getByRole('button', { name: 'Check saved files', exact: true }).click();
  await expect(page.locator('.download-card')).toHaveCount(0);
  await expect(page.locator('.settings-error')).toHaveCount(0);
  await page.locator('.region-row').getByRole('button', { name: 'Download', exact: true }).click();
  await expect(page.locator('.download-card .offline-tag')).toHaveText('Saved');
});

test('a stalled verification can pause, reopen settings, and resume before the old check returns', async ({ page }) => {
  await page.goto('/');
  await page.getByLabel('Settings and offline downloads').click();
  await page.getByLabel('Find a state or territory').fill('California');
  await page.locator('.region-row').getByRole('button', { name: 'Download', exact: true }).click();
  const card = page.locator('.download-card');
  await expect(card.locator('.offline-tag')).toHaveText('Saved');
  await page.evaluate(() => {
    const match = Cache.prototype.match;
    const pending: Array<() => void> = [];
    Cache.prototype.match = async function (...args: Parameters<Cache['match']>) {
      const request = args[0];
      if (String(request instanceof Request ? request.url : request).includes('.mbtiles')) {
        await new Promise<void>(resolve => pending.push(resolve));
      }
      return match.apply(this, args);
    };
    Object.assign(window, { downloadCheckAudit: {
      pending, restore: () => { Cache.prototype.match = match; },
      release: () => { for (const resolve of pending) resolve(); },
    } });
  });
  await card.getByRole('button', { name: 'Verify / update' }).click();
  await page.waitForFunction(() => (window as unknown as { downloadCheckAudit: { pending: unknown[] } }).downloadCheckAudit.pending.length > 0);
  await expect(card.locator('.offline-tag')).toHaveText('Checking files');
  await card.getByRole('button', { name: 'Pause', exact: true }).click();
  await expect(card.locator('.offline-tag')).toHaveText('Paused');
  await page.evaluate(() => (window as unknown as { downloadCheckAudit: { restore: () => void } }).downloadCheckAudit.restore());
  await page.getByLabel('Close settings').click();
  await page.getByLabel('Settings and offline downloads').click();
  await card.getByRole('button', { name: 'Resume', exact: true }).click();
  await expect(card.locator('.offline-tag')).toHaveText('Saved');
  await page.evaluate(async () => {
    (window as unknown as { downloadCheckAudit: { release: () => void } }).downloadCheckAudit.release();
    await new Promise(resolve => setTimeout(resolve, 100));
  });
  await expect(card.locator('.offline-tag')).toHaveText('Saved');
  await expect(page.locator('.settings-error')).toHaveCount(0);
});

test('same-cycle supplement refresh and failed updates preserve saved page targets across restarts', async ({ page, context, request }) => {
  await request.post('/__test/reset');
  try {
    await page.goto('/');
    await page.getByLabel('Settings and offline downloads').click();
    await page.getByLabel('Find a state or territory').fill('California');
    await page.locator('.region-row').getByRole('button', { name: 'Download', exact: true }).click();
    await expect(page.locator('.download-card .offline-tag')).toHaveText('Saved');
    // Existing installed releases have URL-only supplement references. Exercise migration.
    await page.evaluate(async () => {
      const db = await new Promise<IDBDatabase>((resolve, reject) => {
        const opening = indexedDB.open('zlayer-offline', 1);
        opening.onsuccess = () => resolve(opening.result); opening.onerror = () => reject(opening.error);
      });
      try {
        await new Promise<void>((resolve, reject) => {
          const tx = db.transaction('records', 'readwrite');
          const cursor = tx.objectStore('records').openCursor();
          cursor.onsuccess = () => {
            const row = cursor.result;
            if (!row) return;
            if (String(row.key).startsWith('region:')) {
              const plan = row.value;
              for (const reference of plan.references) delete reference.snapshot;
              row.update(plan);
            }
            row.continue();
          };
          tx.oncomplete = () => resolve(); tx.onabort = () => reject(tx.error);
        });
      } finally { db.close(); }
    });
    await request.post('/__test/update-supplement');
    await page.reload();
    await expect(page.getByRole('dialog', { name: 'Settings', exact: true })).toBeVisible();
    await page.waitForFunction(async () => {
      const saved = await (await caches.open('zlayers-data-v6')).match('/chart-data/2026-09-03/cs/catalog.json');
      return saved && (await saved.json()).generatedAt === '2026-09-17T00:00:00Z';
    });
    await page.getByRole('button', { name: 'Check saved files', exact: true }).click();
    await expect(page.locator('.download-card .offline-tag')).toHaveText('Saved');
    await page.locator('.download-card').getByRole('button', { name: 'Verify / update' }).click();
    await expect(page.locator('.download-card .offline-tag')).toHaveText('Needs attention', { timeout: 15_000 });
    await page.getByText('Temporary files and storage limits', { exact: true }).click();
    await page.getByRole('button', { name: 'Remove temporary charts and plates' }).click();
    await page.getByRole('alertdialog').getByRole('button', { name: 'Remove', exact: true }).click();
    await expect(page.getByRole('button', { name: 'Check saved files', exact: true })).toBeEnabled();
    await context.setOffline(true);
    await page.reload();
    const openSupplement = async () => {
      await page.getByLabel('Close settings').click();
      await page.getByLabel('Search FAA navigation data').fill('KSBA');
      await page.locator('.search-results button').filter({ hasText: 'KSBA' }).click();
      await page.getByRole('tab', { name: 'Plates', exact: true }).click();
      await page.locator('.procedure-group button').filter({ hasText: 'Chart Supplement' }).click();
      await expect(page.getByText('Available offline', { exact: true })).toBeVisible();
      await expect(page.locator('.procedure-page-loading')).toHaveCount(0);
    };
    await openSupplement();
    await expect(page.getByText('Open original ↗')).toHaveAttribute('href', /\/book\.pdf\?/);
    await page.getByLabel('Close plate').click();
    await context.setOffline(false);
    await request.post('/__test/allow-updated-book');
    await page.reload();
    await page.getByLabel('Settings and offline downloads').click();
    await page.locator('.download-card').getByRole('button', { name: 'Resume', exact: true }).click();
    await expect(page.locator('.download-card .offline-tag')).toHaveText('Saved');
    await context.setOffline(true);
    await page.reload();
    await openSupplement();
    await expect(page.getByText('Open original ↗')).toHaveAttribute('href', /\/updated-book\.pdf\?/);
  } finally { await request.post('/__test/reset'); }
});

test('state boundary clipping renders matching editions and leaves a missing regional chart transparent', async ({ page }) => {
  await page.goto('/');
  const pixels = (missing: boolean) => page.evaluate(async missing => {
    const modulePath = '/regional-test.js';
    await import(modulePath);
    return (globalThis as unknown as { regionalTestPixels: (value: boolean) => Promise<unknown> }).regionalTestPixels(missing);
  }, missing);
  expect(await pixels(false)).toEqual({ truckee: [0, 0, 255, 255], reno: [0, 255, 0, 255], incomplete: 0 });
  expect(await pixels(true)).toEqual({ truckee: [0, 0, 255, 255], reno: [0, 0, 0, 0], incomplete: 1 });
});

test('a lost regional airport export preserves healthy search and recovers on reconnect without changing edition', async ({ page, request, context }) => {
  const save = async (region: string, revision: string) => {
    await selectCycle(page, revision);
    await page.getByLabel('Settings and offline downloads').click();
    await page.getByLabel('Find a state or territory').fill(region);
    await page.locator('.region-row').getByRole('button', { name: 'Download', exact: true }).click();
    await expect(page.locator('.download-card').filter({ hasText: region }).locator('.offline-tag')).toHaveText('Saved');
    await page.getByLabel('Close settings').click();
  };
  await page.goto('/');
  await save('California', '2026-09-03');
  await save('Nevada', '2026-08-06');
  await selectCycle(page, 'latest');
  await page.getByLabel('Search FAA navigation data').fill('KRNO');
  await page.locator('.search-results button').filter({ hasText: 'KRNO' }).click();
  await expect(page.locator('.feature-edition')).toHaveText('FAA Aug 6');
  await expect(page.locator('.saved-editions')).toContainText('Nevada · Saved · Aug 6');
  try {
    await request.post('/__test/fail-nevada-airports');
    await page.evaluate(async () => {
      const cache = await caches.open('zlayers-data-v6');
      for (const key of await cache.keys()) if (key.url.includes('/2026-08-06/nav/airports.geojson')) await cache.delete(key);
    });
    await page.reload(); // Drop successful in-memory source reads to simulate a cold launch after eviction.
    const search = page.getByLabel('Search FAA navigation data');
    await search.fill('KSBA');
    await expect(page.locator('.search-results button').filter({ hasText: 'KSBA' })).toBeVisible();
    await expect(page.locator('.search-warning')).toContainText('Nevada · Aug 6: airports unavailable');
    await search.fill('KRNO');
    await expect(page.locator('.search-warning')).toBeVisible();
    await expect(page.locator('.search-results button')).toHaveCount(0);
    await request.post('/__test/allow-nevada-airports');
    await context.setOffline(true);
    await expect(page.locator('.offline-banner')).toBeVisible();
    await context.setOffline(false);
    await expect(page.locator('.search-results button').filter({ hasText: 'KRNO' })).toBeVisible();
    await expect(page.locator('.search-warning')).toHaveCount(0);
    await page.locator('.search-results button').filter({ hasText: 'KRNO' }).click();
    await expect(page.locator('.feature-edition')).toHaveText('FAA Aug 6');
  } finally { await request.post('/__test/reset'); }
});
