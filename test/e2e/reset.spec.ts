import { test, expect, type Page, type Route } from '@playwright/test';

async function savedRegion(page: Page) {
  await page.goto('/');
  await page.getByLabel('Settings and offline downloads').click();
  await page.getByLabel('Find a state or territory').fill('California');
  await page.locator('.region-row').getByRole('button', { name: 'Download', exact: true }).click();
  await expect(page.locator('.download-card .offline-tag')).toHaveText('Saved');
}

test('full reset requires confirmation, stops other windows, clears app storage offline, and starts fresh', async ({ page, context }) => {
  await savedRegion(page);
  const advanced = page.locator('.reset-settings');
  await expect(advanced).not.toHaveAttribute('open', '');
  await advanced.getByText('Advanced', { exact: true }).click();
  const remove = advanced.getByRole('button', { name: 'Delete all local data', exact: true });
  await expect(remove).toBeDisabled();
  await advanced.getByLabel('Type DELETE to confirm').fill('DELETE');
  await page.getByLabel('Close settings').click();
  await page.getByLabel('Settings and offline downloads').click();
  await expect(advanced).not.toHaveAttribute('open', '');
  await advanced.getByText('Advanced', { exact: true }).click();
  await expect(remove).toBeDisabled();
  await page.getByLabel('Close settings').click();
  const route = page.getByRole('textbox', { name: 'Add route waypoint' });
  await route.fill('KSBA KSMO ');
  await route.press('Enter');
  await expect(page.locator('[data-route-entry]')).toHaveCount(2);
  await page.evaluate(async () => {
    localStorage.setItem('zlayers-map-view-v1', JSON.stringify({ version: 1, longitude: -119, latitude: 34, zoom: 8, bearing: 0, pitch: 0 }));
    localStorage.setItem('zlayers.metars.v1', '[]');
    localStorage.setItem('zlayers.tafs.v1', '[]');
    for (const key of ['plate-on-map', 'side-panel', 'identification-open', 'ahrs-mount']) {
      localStorage.setItem(`zlayer-ui:${key}`, JSON.stringify({ version: 1, value: null }));
    }
    sessionStorage.setItem('zlayer-test-session', 'saved');
    localStorage.setItem('unrelated-data', 'keep');
    await (await caches.open('zlayers-shell-old-release')).put('/old.js', new Response('old'));
    await (await caches.open('unrelated-cache')).put('/keep', new Response('keep'));
    const files = await navigator.storage.getDirectory();
    await (await files.getDirectoryHandle('zlayer-exports', { create: true })).getFileHandle('interrupted.gpx', { create: true });
    await files.getDirectoryHandle('unrelated-files', { create: true });
  });
  const other = await context.newPage();
  await other.goto('/');
  await expect(other.locator('[data-route-entry]')).toHaveCount(2);
  await other.evaluate(() => sessionStorage.setItem('zlayer-test-session', 'other'));
  await page.getByLabel('Settings and offline downloads').click();
  await advanced.getByText('Advanced', { exact: true }).click();
  await advanced.getByLabel('Type DELETE to confirm').fill('DELETE');
  const navigations = new Map<Page, number>([[page, 0], [other, 0]]);
  for (const window of navigations.keys()) window.on('request', request => {
    if (request.isNavigationRequest() && new URL(request.url()).searchParams.get('reset') === '1') {
      navigations.set(window, navigations.get(window)! + 1);
    }
  });
  await context.setOffline(true);
  await remove.click();
  for (const window of [page, other]) {
    await expect(window.getByRole('heading', { name: 'Local data cleared' })).toBeVisible({ timeout: 25_000 });
    expect(await window.evaluate(async () => {
      const files: string[] = [];
      for await (const name of (await navigator.storage.getDirectory()).keys()) files.push(name);
      return {
        local: Object.keys(localStorage), session: Object.keys(sessionStorage),
        caches: await caches.keys(), databases: (await indexedDB.databases()).map(db => db.name),
        registrations: (await navigator.serviceWorker.getRegistrations()).length, files,
      };
    })).toEqual({ local: ['unrelated-data'], session: [], caches: ['unrelated-cache'], databases: [], registrations: 0,
      files: ['unrelated-files'] });
    expect(navigations.get(window), 'each window must load its reset screen only once').toBe(1);
  }
  await context.setOffline(false);
  await page.getByRole('link', { name: 'Open ZLayer' }).click();
  await expect(page.getByRole('dialog', { name: 'Welcome to ZLayer', exact: true })).toBeVisible();
  await page.evaluate(() => document.fonts.ready);
  await page.getByRole('region', { name: 'Installation and safety notice' }).press('End');
  await page.getByRole('button', { name: 'I understand', exact: true }).click();
  await expect(page.getByLabel('Settings and offline downloads')).toBeVisible({ timeout: 20_000 });
  await expect(page.locator('[data-route-entry]')).toHaveCount(0);
  await page.getByLabel('Settings and offline downloads').click();
  await page.getByRole('button', { name: 'My downloads', exact: true }).click();
  await expect(page.getByText('No region downloads yet.', { exact: false })).toBeVisible();
  await page.waitForFunction(() => !!navigator.serviceWorker.controller);
  // A revived registration must reinstall its erased shell before promising offline use.
  await context.setOffline(true);
  await page.reload();
  await expect(page.getByLabel('Settings and offline downloads')).toBeVisible();
});

test('a second window waits for the revived worker to rebuild its shell before downloading', async ({ page, context }) => {
  await savedRegion(page);
  const other = await context.newPage();
  await other.goto('/');
  await expect(other.getByLabel('Settings and offline downloads')).toBeVisible();
  await page.locator('.reset-settings summary').click();
  await page.getByLabel('Type DELETE to confirm').fill('DELETE');
  await page.getByRole('button', { name: 'Delete all local data', exact: true }).click();
  for (const window of [page, other]) {
    await expect(window.getByRole('heading', { name: 'Local data cleared' })).toBeVisible();
  }
  const worker = context.serviceWorkers()[0]!;
  type ShellGate = { releaseShell: () => void; shellBuilds: number; preparations: number };
  await worker.evaluate(() => {
    const state = globalThis as unknown as ShellGate;
    state.shellBuilds = 0;
    state.preparations = 0;
    addEventListener('message', event => {
      if ((event as MessageEvent).data?.type === 'prepare-pwa') state.preparations++;
    });
    const held = new Promise<void>(resolve => { state.releaseShell = resolve; });
    const addAll = Cache.prototype.addAll;
    Cache.prototype.addAll = async function (requests) {
      state.shellBuilds++;
      await held;
      return addAll.call(this, requests);
    };
  });
  try {
    await page.getByRole('link', { name: 'Open ZLayer' }).click();
    await expect(page.getByRole('dialog', { name: 'Welcome to ZLayer', exact: true })).toBeVisible();
    await page.evaluate(() => document.fonts.ready);
    await page.getByRole('region', { name: 'Installation and safety notice' }).press('End');
    await page.getByRole('button', { name: 'I understand', exact: true }).click();
    await expect.poll(() => worker.evaluate(() => (globalThis as unknown as ShellGate).shellBuilds)).toBe(1);
    await other.getByRole('link', { name: 'Open ZLayer' }).click();
    expect(await other.evaluate(() => !!navigator.serviceWorker.controller)).toBe(true);
    await expect.poll(() => worker.evaluate(() => (globalThis as unknown as ShellGate).preparations)).toBe(2);
    await expect(other.getByRole('dialog', { name: 'ZLayer', exact: true })).toBeVisible();
    // Downloads stays unavailable until shell preparation completes.
    await expect(other.getByLabel('Settings and offline downloads')).toHaveCount(0);
    expect(await worker.evaluate(() => (globalThis as unknown as ShellGate).shellBuilds)).toBe(1);
  } finally {
    await worker.evaluate(() => (globalThis as unknown as ShellGate).releaseShell());
  }
  await other.getByLabel('Settings and offline downloads').click();
  await other.getByLabel('Find a state or territory').fill('California');
  await other.locator('.region-row').getByRole('button', { name: 'Download', exact: true }).click();
  await expect(other.locator('.download-card .offline-tag')).toHaveText('Saved');
  await context.setOffline(true);
  await other.reload();
  await expect(other.getByLabel('Settings and offline downloads')).toBeVisible();
  await expect(other.locator('.download-card .offline-tag')).toHaveText('Saved');
});

test('failed deletion keeps reset pending and can be retried without reopening the workspace', async ({ page }) => {
  await savedRegion(page);
  await page.addInitScript(() => {
    if (new URL(location.href).searchParams.get('reset') !== '1') return;
    const remove = CacheStorage.prototype.delete;
    let failed = false;
    CacheStorage.prototype.delete = async function (name) {
      if (!failed && name === 'zlayers-chart-archives-v3') {
        failed = true;
        throw new Error('Simulated storage failure');
      }
      return remove.call(this, name);
    };
  });
  await page.locator('.reset-settings summary').click();
  await page.getByLabel('Type DELETE to confirm').fill('DELETE');
  await page.getByRole('button', { name: 'Delete all local data', exact: true }).click();
  await expect(page.getByRole('alert')).toHaveText('Simulated storage failure');
  expect(await page.evaluate(() => localStorage.getItem('zlayer-reset-pending'))).toBe('1');
  expect(await page.evaluate(async () => (await caches.keys()).some(name => name.startsWith('zlayers-shell-')))).toBe(true);
  await page.getByRole('button', { name: 'Retry reset' }).click();
  await expect(page.getByRole('heading', { name: 'Local data cleared' })).toBeVisible();
  expect(await page.evaluate(async () => ({ keys: Object.keys(localStorage), caches: await caches.keys() })))
    .toEqual({ keys: [], caches: [] });
});

test('full reset finishes when private browsing makes OPFS unavailable', async ({ page }) => {
  await page.addInitScript(() => {
    StorageManager.prototype.getDirectory = async () => {
      throw new DOMException('OPFS unavailable in private browsing', 'UnknownError');
    };
  });
  await page.goto('/');
  await page.getByLabel('Settings and offline downloads').click();
  await page.evaluate(() => new Promise<void>((resolve, reject) => {
    localStorage.setItem('zlayer-test-preference', 'saved');
    const opening = indexedDB.open('zlayer-offline', 1);
    opening.onupgradeneeded = () => opening.result.createObjectStore('records');
    opening.onerror = () => reject(opening.error);
    opening.onsuccess = () => {
      const db = opening.result, transaction = db.transaction('records', 'readwrite');
      transaction.objectStore('records').put({ saved: true }, 'zlayer-test-record');
      transaction.oncomplete = () => { db.close(); resolve(); };
      transaction.onabort = () => { db.close(); reject(transaction.error); };
    };
  }));
  await page.locator('.reset-settings summary').click();
  await page.getByLabel('Type DELETE to confirm').fill('DELETE');
  await page.getByRole('button', { name: 'Delete all local data', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Local data cleared' })).toBeVisible();
  expect(await page.evaluate(async () => ({
    pending: localStorage.getItem('zlayer-reset-pending'), preference: localStorage.getItem('zlayer-test-preference'),
    caches: await caches.keys(), databases: await indexedDB.databases(),
  }))).toEqual({ pending: null, preference: null, caches: [], databases: [] });
});

test('reset still coordinates windows when service workers are unavailable', async ({ page, context }) => {
  await context.addInitScript(() => { Reflect.deleteProperty(Navigator.prototype, 'serviceWorker'); });
  await page.goto('/');
  const other = await context.newPage();
  await other.goto('/');
  for (const window of [page, other]) {
    await expect(window.getByLabel('Settings and offline downloads')).toBeVisible();
    await window.evaluate(() => sessionStorage.setItem('zlayer-test-session', 'saved'));
  }
  // Unload the old workspace, but hold the new tab's boot code until its peer
  // has cleared the shared reset marker. Its own session data must still clear.
  const entry = await other.locator('script[type="module"][src]').getAttribute('src');
  let hold!: (route: Route) => void;
  const boot = new Promise<Route>(resolve => { hold = resolve; });
  await other.route(new URL(entry!, other.url()).href, hold);
  await page.getByLabel('Settings and offline downloads').click();
  await page.locator('.reset-settings summary').click();
  await page.getByLabel('Type DELETE to confirm').fill('DELETE');
  await page.getByRole('button', { name: 'Delete all local data', exact: true }).click();
  const held = await boot;
  try { await expect(page.getByRole('heading', { name: 'Local data cleared' })).toBeVisible(); }
  finally { await held.continue(); }
  for (const window of [page, other]) {
    await expect(window.getByRole('heading', { name: 'Local data cleared' })).toBeVisible();
    expect(await window.evaluate(() => ({ local: Object.keys(localStorage), session: Object.keys(sessionStorage) })))
      .toEqual({ local: [], session: [] });
  }
});

test('opening the reset URL without confirmation leaves saved data alone', async ({ page }) => {
  await savedRegion(page);
  await page.goto('/?reset=1');
  await expect(page.getByRole('heading', { name: 'No reset requested' })).toBeVisible();
  expect(await page.evaluate(async () => (await indexedDB.databases()).some(db => db.name === 'zlayer-offline'))).toBe(true);
  await page.getByRole('link', { name: 'Open ZLayer' }).click();
  await expect(page.locator('.download-card .offline-tag')).toHaveText('Saved');
});

test('unsupported window coordination cannot leave the workspace stuck in reset mode', async ({ page }) => {
  await page.addInitScript(() => Object.defineProperty(navigator, 'locks', { value: undefined }));
  await page.goto('/');
  await page.getByLabel('Settings and offline downloads').click();
  await page.locator('.reset-settings summary').click();
  await page.getByLabel('Type DELETE to confirm').fill('DELETE');
  await page.getByRole('button', { name: 'Delete all local data', exact: true }).click();
  await expect(page.locator('.reset-settings').getByRole('alert')).toContainText('Update your browser');
  expect(await page.evaluate(() => localStorage.getItem('zlayer-reset-pending'))).toBeNull();
  await page.getByLabel('Close settings').click();
  await expect(page.getByRole('textbox', { name: 'Add route waypoint' })).toBeVisible();
});

test('Resume retains the saved plan when a newer same-cycle supplement is published', async ({ page, request }) => {
  await request.post('/__test/reset');
  try {
    await savedRegion(page);
    // Simulate termination after all bytes arrived but before activation committed.
    await page.evaluate(async () => {
      const db = await new Promise<IDBDatabase>((resolve, reject) => {
        const opening = indexedDB.open('zlayer-offline', 1);
        opening.onsuccess = () => resolve(opening.result); opening.onerror = () => reject(opening.error);
      });
      try {
        await new Promise<void>((resolve, reject) => {
          const transaction = db.transaction('records', 'readwrite');
          const cursor = transaction.objectStore('records').openCursor();
          cursor.onsuccess = () => {
            const row = cursor.result;
            if (!row) return;
            if (String(row.key).startsWith('region:')) {
              const plan = row.value;
              delete plan.completedAt;
              row.update(plan);
            }
            row.continue();
          };
          transaction.oncomplete = () => resolve(); transaction.onabort = () => reject(transaction.error);
        });
      } finally { db.close(); }
    });
    await request.post('/__test/update-supplement'); // The replacement book intentionally fails to download.
    await page.reload();
    await page.waitForFunction(async () => {
      const saved = await (await caches.open('zlayers-data-v6')).match('/chart-data/2026-09-03/cs/catalog.json');
      return saved && (await saved.json()).generatedAt === '2026-09-17T00:00:00Z';
    });
    await expect(page.locator('.region-row').getByRole('button', { name: 'Verify / update' })).toBeEnabled();
    await page.locator('.download-card').getByRole('button', { name: 'Resume', exact: true }).click();
    await expect(page.locator('.download-card .offline-tag')).toHaveText('Saved');
    // Updating remains an explicit, separate action that selects the new book.
    await page.locator('.download-card').getByRole('button', { name: 'Verify / update' }).click();
    await expect(page.locator('.download-card .offline-tag')).toHaveText('Needs attention', { timeout: 15_000 });
  } finally { await request.post('/__test/reset'); }
});
