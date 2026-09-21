import { test, expect, type Page } from '@playwright/test';

test.beforeEach(async ({ request }) => { await request.post('/__test/reset'); });
test.afterEach(async ({ request }) => { await request.post('/__test/reset'); });

const release = '2222222222222222';
const releaseSelector = 'meta[name="zlayer-release"]';
const versionSelector = 'meta[name="zlayer-version"]';

async function nextVersion(page: Page): Promise<string> {
  const current = await page.locator(versionSelector).getAttribute('content');
  expect(current).toMatch(/^v0\.1\.0\+g[a-f0-9]{7}\.b[a-f0-9]{8}$/);
  return current!.replace(/\.b[a-f0-9]{8}$/, `.b${release.slice(0, 8)}`);
}

test('a prepared release prompts both windows, waits for a click, and reloads once offline with saved data', { tag: '@smoke' }, async ({ page, context, request }, testInfo) => {
  await page.goto('/');
  await page.waitForFunction(() => navigator.serviceWorker.controller?.state === 'activated');
  const originalRelease = await page.locator(releaseSelector).getAttribute('content');
  expect(originalRelease).toMatch(/^[a-f0-9]{16}$/);
  const originalVersion = await page.locator(versionSelector).getAttribute('content');
  const version = await nextVersion(page);
  expect(originalVersion).toMatch(new RegExp(`\\.b${originalRelease!.slice(0, 8)}$`));
  // The opaque release field remains compatible with older installed pages.
  const workerVersion = await page.evaluate(() => new Promise(resolve => {
    const channel = new MessageChannel();
    channel.port1.onmessage = event => { channel.port1.close(); resolve(event.data); };
    navigator.serviceWorker.controller!.postMessage({ type: 'app-release' }, [channel.port2]);
  }));
  expect(workerVersion).toEqual({ release: originalRelease, displayVersion: originalVersion });
  await expect(page.getByLabel('App update', { exact: true })).toHaveCount(0);
  const input = page.getByRole('textbox', { name: 'Add route waypoint' });
  await input.fill('KSBA KSMO ');
  await input.press('Enter');
  await expect(page.locator('[data-route-entry]')).toHaveCount(2);
  await page.getByLabel('Settings and offline downloads').click();
  await page.getByLabel('Find a state or territory').fill('California');
  await page.locator('.region-row').getByRole('button', { name: 'Download', exact: true }).click();
  await expect(page.locator('.download-card .offline-tag')).toHaveText('Saved');
  await expect(page.locator('.pwa-update-settings')).toContainText(`Current version: ${originalVersion}`);
  const other = await context.newPage();
  await other.goto('/');
  await other.waitForFunction(() => navigator.serviceWorker.controller?.state === 'activated');
  // Settings state is shared across windows; close it to expose the second prompt.
  await other.getByLabel('Close settings').click();
  let navigations = 0;
  page.on('framenavigated', frame => { if (frame === page.mainFrame()) navigations++; });

  await request.post('/__test/app-update');
  await page.getByRole('button', { name: 'Check for updates', exact: true }).click();
  await expect(page.locator('.pwa-update-settings')).toContainText(`Update available: ${version}`);
  await page.getByLabel('Close settings').click();
  const prompt = page.getByLabel('App update', { exact: true });
  await expect(prompt).toContainText(version);
  await expect(other.getByLabel('App update', { exact: true })).toContainText(version);
  expect(navigations).toBe(0);
  await expect(page.locator(releaseSelector)).toHaveAttribute('content', originalRelease!);
  await page.setViewportSize({ width: 390, height: 844 });
  const bounds = await prompt.boundingBox();
  expect(bounds!.x).toBeGreaterThanOrEqual(0);
  expect(bounds!.x + bounds!.width).toBeLessThanOrEqual(390);
  expect(bounds!.y + bounds!.height).toBeLessThanOrEqual(844);
  await page.screenshot({ path: testInfo.outputPath('update-prompt-mobile.png') });

  await prompt.getByRole('button', { name: 'Later', exact: true }).click();
  await expect(prompt).toHaveCount(0);
  await page.getByLabel('Settings and offline downloads').click();
  await expect(page.locator('.pwa-update-settings')).toContainText(version);
  await context.setOffline(true);
  await page.locator('.pwa-update-settings').getByRole('button', { name: 'Update now', exact: true }).click();
  await expect(page.locator(releaseSelector)).toHaveAttribute('content', release);
  await expect(page.locator(versionSelector)).toHaveAttribute('content', version);
  await expect(page.locator('[data-route-entry]')).toHaveCount(2);
  await expect(page.locator('.download-card .offline-tag')).toHaveText('Saved');
  await expect(prompt).toHaveCount(0);
  expect(navigations).toBe(1);
  await expect(other.locator(releaseSelector)).toHaveAttribute('content', originalRelease!);
  await expect(other.getByLabel('App update', { exact: true })).toBeVisible();
});

test('a failed install never offers a broken release and a later foreground check recovers', async ({ page, request }) => {
  await page.goto('/');
  await page.waitForFunction(() => navigator.serviceWorker.controller?.state === 'activated');
  const version = await nextVersion(page);
  const originalRelease = await page.locator(releaseSelector).getAttribute('content');
  await page.getByLabel('Settings and offline downloads').click();
  await request.post('/__test/fail-app-update');
  await page.getByRole('button', { name: 'Check for updates', exact: true }).click();
  await expect(page.locator('.pwa-update-settings [role="alert"]')).toContainText('could not be downloaded');
  await expect(page.getByLabel('App update', { exact: true })).toHaveCount(0);
  await expect(page.locator(releaseSelector)).toHaveAttribute('content', originalRelease!);
  await page.getByLabel('Close settings').click();

  await request.post('/__test/allow-app-update');
  // A connectivity event triggers the same check as returning to a foreground app.
  await page.evaluate(() => window.dispatchEvent(new Event('online')));
  const prompt = page.getByLabel('App update', { exact: true });
  await expect(prompt).toContainText(version);
  await prompt.getByRole('button', { name: 'Update now', exact: true }).click();
  await expect(page.locator(releaseSelector)).toHaveAttribute('content', release);
  await expect(prompt).toHaveCount(0);
});

test('an app launched offline discovers a release when connectivity returns', async ({ page, context, request }) => {
  await page.goto('/');
  await page.waitForFunction(() => navigator.serviceWorker.controller?.state === 'activated');
  const version = await nextVersion(page);
  // Chromium's page-level offline emulation can leave worker update fetches online.
  await request.post('/__test/disconnect');
  await context.setOffline(true);
  await page.reload();
  await page.getByLabel('Settings and offline downloads').click();
  await expect(page.locator('.pwa-update-settings')).toBeVisible();
  await expect(page.locator('.pwa-update-settings')).not.toContainText('You’re up to date.');
  await page.getByLabel('Close settings').click();
  await expect(page.getByLabel('App update', { exact: true })).toHaveCount(0);
  await request.post('/__test/reset');
  await request.post('/__test/app-update');
  await context.setOffline(false);
  await expect(page.getByLabel('App update', { exact: true })).toContainText(version);
});

test('closing and reopening can load a prepared release automatically without a prompt', async ({ page, context, request }) => {
  await page.goto('/');
  await page.waitForFunction(() => navigator.serviceWorker.controller?.state === 'activated');
  const version = await nextVersion(page);
  await page.getByLabel('Settings and offline downloads').click();
  await page.getByRole('button', { name: 'Check for updates', exact: true }).click();
  await expect(page.locator('.pwa-update-settings')).toContainText('You’re up to date.');
  await request.post('/__test/app-update');
  await page.getByRole('button', { name: 'Check for updates', exact: true }).click();
  await expect(page.locator('.pwa-update-settings')).toContainText(`Update available: ${version}`);
  await page.close();
  await context.setOffline(true);
  const reopened = await context.newPage();
  await reopened.goto('/');
  await expect(reopened.locator('.pwa-update-settings')).toContainText(`Current version: ${version}`);
  await expect(reopened.getByLabel('App update', { exact: true })).toHaveCount(0);
});

test('startup cache cleanup cannot discard a release being installed', async ({ page, context, request }) => {
  await page.goto('/');
  await page.waitForFunction(() => navigator.serviceWorker.controller?.state === 'activated');
  const version = await nextVersion(page);
  const active = context.serviceWorkers()[0]!;
  type CleanupProbe = { shellCleanupFinished: boolean };
  await active.evaluate(() => {
    const state = globalThis as unknown as CleanupProbe;
    state.shellCleanupFinished = false;
    const waitUntil = ExtendableEvent.prototype.waitUntil;
    ExtendableEvent.prototype.waitUntil = function (work) {
      if ((this as ExtendableMessageEvent).data?.type === 'active-shell') {
        return waitUntil.call(this, Promise.resolve(work).finally(() => { state.shellCleanupFinished = true; }));
      }
      return waitUntil.call(this, work);
    };
  });
  await page.getByLabel('Settings and offline downloads').click();
  await request.post('/__test/hold-app-update');
  await page.getByRole('button', { name: 'Check for updates', exact: true }).click();
  const nextCache = `zlayers-shell-${release}`;
  await expect.poll(() => page.evaluate(name => caches.has(name), nextCache)).toBe(true);
  await page.evaluate(() => navigator.serviceWorker.controller!.postMessage({
    type: 'active-shell', entry: (document.querySelector('script[type=module]') as HTMLScriptElement).src,
  }));
  await expect.poll(() => active.evaluate(() => (globalThis as unknown as CleanupProbe).shellCleanupFinished)).toBe(true);
  expect(await page.evaluate(name => caches.has(name), nextCache)).toBe(true);
  await request.post('/__test/allow-app-update');
  await expect(page.locator('.pwa-update-settings')).toContainText(`Update available: ${version}`);
  expect(await page.evaluate(async name => !!await (await caches.open(name)).match('/'), nextCache)).toBe(true);
  await context.setOffline(true);
  await page.locator('.pwa-update-settings').getByRole('button', { name: 'Update now', exact: true }).click();
  await expect(page.locator(releaseSelector)).toHaveAttribute('content', release);
});

test('a deployment with mismatched page and worker releases is never offered as ready', async ({ page, request }) => {
  await page.goto('/');
  await page.waitForFunction(() => navigator.serviceWorker.controller?.state === 'activated');
  const version = await nextVersion(page);
  const originalRelease = await page.locator(releaseSelector).getAttribute('content');
  await page.getByLabel('Settings and offline downloads').click();
  await request.post('/__test/mismatched-app-update');
  await page.getByRole('button', { name: 'Check for updates', exact: true }).click();
  await expect(page.locator('.pwa-update-settings [role="alert"]')).toContainText('could not be downloaded');
  await expect(page.getByLabel('App update', { exact: true })).toHaveCount(0);
  await page.reload();
  await expect(page.locator(releaseSelector)).toHaveAttribute('content', originalRelease!);
  await request.post('/__test/allow-app-update');
  await page.getByRole('button', { name: 'Check for updates', exact: true }).click();
  await expect(page.locator('.pwa-update-settings')).toContainText(`Update available: ${version}`);
});

test('shell recovery rejects mismatched cached and downloaded pages on every retry', async ({ page, context, request }) => {
  await page.goto('/');
  await page.waitForFunction(() => navigator.serviceWorker.controller?.state === 'activated');
  const originalRelease = await page.locator(releaseSelector).getAttribute('content');
  const cacheName = `zlayers-shell-${originalRelease}`;
  // Finish startup's update check before changing the served page underneath this worker.
  await page.getByLabel('Settings and offline downloads').click();
  await page.getByRole('button', { name: 'Check for updates', exact: true }).click();
  await expect(page.locator('.pwa-update-settings')).toContainText('You’re up to date.');

  const prepare = () => page.evaluate(() => new Promise<{ ok?: boolean; error?: string }>(resolve => {
    const channel = new MessageChannel();
    channel.port1.onmessage = event => { channel.port1.close(); resolve(event.data); };
    navigator.serviceWorker.controller!.postMessage({ type: 'prepare-pwa' }, [channel.port2]);
  }));
  expect(await prepare()).toEqual({ ok: true });
  await request.post('/__test/app-update');
  // Simulate a rejected page left behind by an earlier recovery attempt.
  await page.evaluate(async ({ cacheName, release }) => {
    const cache = await caches.open(cacheName);
    await cache.put('/', new Response(`<meta name="zlayer-release" content="${release}" />`));
  }, { cacheName, release });
  for (let attempt = 0; attempt < 2; attempt++) {
    expect(await prepare()).toEqual({ error: 'Offline worker could not prepare storage' });
    expect(await page.evaluate(async name => !!await (await caches.open(name)).match('/'), cacheName)).toBe(false);
  }

  // Fetching online HTML alone must not make an incomplete shell look ready.
  const onlineHtml = await page.evaluate(async () => (await fetch('/')).text());
  expect(onlineHtml).toContain(`<meta name="zlayer-release" content="${release}"`);
  expect(await page.evaluate(async name => !!await (await caches.open(name)).match('/'), cacheName)).toBe(false);
  expect(await prepare()).toEqual({ error: 'Offline worker could not prepare storage' });

  await request.post('/__test/reset');
  expect(await prepare()).toEqual({ ok: true });
  const cachedHtml = await page.evaluate(async name => (await (await caches.open(name)).match('/'))?.text(), cacheName);
  expect(cachedHtml).toContain(`<meta name="zlayer-release" content="${originalRelease}"`);
  await request.post('/__test/disconnect');
  await context.setOffline(true);
  await page.reload();
  await expect(page.locator(releaseSelector)).toHaveAttribute('content', originalRelease!);
  await expect(page.locator('.pwa-update-settings')).toBeVisible();
});
