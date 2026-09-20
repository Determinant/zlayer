import { expect, test, type Page } from '@playwright/test';

type DownloadWindow = Window & typeof globalThis & {
  regionDownloadFixture: { blocked: boolean; fail: boolean; finished: boolean; release: () => void };
  finalCheckFixture: { blocked: boolean; missing: boolean; release: () => void; restore: () => void };
};

test.beforeEach(async ({ request }) => { await request.post('/__test/reset'); });

async function holdBook(page: Page) {
  await page.addInitScript(() => {
    const fixture: DownloadWindow['regionDownloadFixture'] = (window as DownloadWindow).regionDownloadFixture = {
      blocked: false, fail: false, finished: false, release: () => {},
    };
    const fetch = window.fetch;
    window.fetch = async (...args) => {
      const response = await fetch(...args);
      if (!new URL(response.url).pathname.endsWith('/book.pdf')) return response;
      if (!fixture.finished) {
        fixture.blocked = true;
        await new Promise<void>(resolve => { fixture.release = () => { fixture.finished = true; resolve(); }; });
      }
      if (fixture.fail) void response.body?.cancel();
      return fixture.fail ? new Response('Temporarily unavailable', { status: 503 }) : response;
    };
  });
}

async function holdFinalCheck(page: Page, stage: 'files' | 'data') {
  await page.addInitScript(stage => {
    const match = Cache.prototype.match, put = Cache.prototype.put;
    const pending: Array<() => void> = [];
    let bookSaved = false;
    const path = (request: RequestInfo | URL) => new URL(request instanceof Request ? request.url : String(request), location.href).pathname;
    const fixture: DownloadWindow['finalCheckFixture'] = (window as DownloadWindow).finalCheckFixture = {
      blocked: false, missing: false,
      restore: () => { Cache.prototype.match = match; Cache.prototype.put = put; },
      release: () => { fixture.restore(); pending.forEach(resolve => resolve()); },
    };
    Cache.prototype.put = async function (...args: Parameters<Cache['put']>) {
      await put.apply(this, args);
      if (path(args[0]).endsWith('/book.pdf')) bookSaved = true;
    };
    Cache.prototype.match = async function (...args: Parameters<Cache['match']>) {
      if (bookSaved && (stage === 'files' ? path(args[0]).endsWith('.mbtiles') : path(args[0]).endsWith('/nav/airports.geojson'))) {
        fixture.blocked = true;
        await new Promise<void>(resolve => pending.push(resolve));
        if (fixture.missing) return undefined;
      }
      return match.apply(this, args);
    };
  }, stage);
}

const california = (page: Page, revision = '2026-09-03') =>
  page.locator(`.region-row[data-region-id="us-CA"][data-revision="${revision}"]`);

async function openSettings(page: Page) {
  await page.goto('/');
  await page.getByLabel('Settings and offline downloads').click();
  await expect(california(page).getByRole('button', { name: 'Download', exact: true })).toBeEnabled();
}

for (const [width, height] of [[320, 568], [393, 852], [1280, 900]] as const) {
  test(`download progress and saved controls stay in the selected row at ${width}×${height}`, async ({ page }, testInfo) => {
    await page.setViewportSize({ width, height });
    await holdBook(page);
    await openSettings(page);
    const row = california(page);
    const order = await page.locator('.region-row h4').allTextContents();
    await row.evaluate(element => element.scrollIntoView({ block: 'center' }));
    const element = (await row.elementHandle())!;
    const before = (await row.boundingBox())!;
    await row.getByRole('button', { name: 'Download', exact: true }).click();
    await page.waitForFunction(() => (window as DownloadWindow).regionDownloadFixture.blocked);
    await expect(row.locator('.offline-tag')).toHaveText('Downloading');
    await expect(row.locator('.offline-tag')).toBeInViewport();
    await expect(row.getByRole('button', { name: 'Pause', exact: true })).toBeInViewport();
    await expect(row.getByRole('progressbar')).toBeVisible();
    expect(await element.evaluate(node => node.isConnected)).toBe(true);
    expect(Math.abs((await row.boundingBox())!.y - before.y)).toBeLessThanOrEqual(2);
    expect(await page.locator('.region-row h4').allTextContents()).toEqual(order);
    await expect(page.getByRole('heading', { name: 'Your downloads', exact: true })).toHaveCount(0);
    await page.screenshot({ path: testInfo.outputPath('downloading-in-place.png') });

    await page.evaluate(() => (window as DownloadWindow).regionDownloadFixture.release());
    await expect(row.locator('.offline-tag')).toHaveText('Saved');
    await expect(row.getByRole('progressbar')).toHaveCount(0);
    await expect(row.getByRole('button', { name: 'Verify / update', exact: true })).toBeEnabled();
    await expect(row.getByRole('button', { name: 'Remove', exact: true })).toBeEnabled();
    expect(await element.evaluate(node => node.isConnected)).toBe(true);
    expect(await page.locator('.region-row h4').allTextContents()).toEqual(order);
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    await page.screenshot({ path: testInfo.outputPath('saved-in-place.png') });
  });
}

test('pause, resume and removal remain available in the original region row', async ({ page }) => {
  await holdBook(page);
  await openSettings(page);
  const row = california(page);
  await row.getByRole('button', { name: 'Download', exact: true }).click();
  await page.waitForFunction(() => (window as DownloadWindow).regionDownloadFixture.blocked);
  await row.getByRole('button', { name: 'Pause', exact: true }).click();
  await expect(row.locator('.offline-tag')).toHaveText('Pausing');
  await page.evaluate(() => (window as DownloadWindow).regionDownloadFixture.release());
  await expect(row.locator('.offline-tag')).toHaveText('Paused');
  await page.getByLabel('Close settings').click();
  await page.getByLabel('Settings and offline downloads').click();
  await row.getByRole('button', { name: 'Resume', exact: true }).click();
  await expect(row.locator('.offline-tag')).toHaveText('Saved');
  page.once('dialog', dialog => void dialog.dismiss());
  await row.getByRole('button', { name: 'Remove', exact: true }).click();
  await expect(row.locator('.offline-tag')).toHaveText('Saved');
  page.once('dialog', dialog => void dialog.accept());
  await row.getByRole('button', { name: 'Remove', exact: true }).click();
  await expect(row.getByRole('button', { name: 'Download', exact: true })).toBeEnabled();
  await expect(row.locator('.offline-tag')).toHaveCount(0);
});

test('download failures show an inline retry and recover without a separate saved section', async ({ page }) => {
  await holdBook(page);
  await openSettings(page);
  const row = california(page);
  await row.getByRole('button', { name: 'Download', exact: true }).click();
  await page.waitForFunction(() => (window as DownloadWindow).regionDownloadFixture.blocked);
  await page.evaluate(() => {
    const fixture = (window as DownloadWindow).regionDownloadFixture;
    fixture.fail = true;
    fixture.release();
  });
  await expect(row.locator('.offline-tag')).toHaveText('Needs attention', { timeout: 15_000 });
  await expect(row.getByRole('alert')).toBeVisible();
  await page.evaluate(() => { (window as DownloadWindow).regionDownloadFixture.fail = false; });
  await row.getByRole('button', { name: 'Retry', exact: true }).click();
  await expect(row.locator('.offline-tag')).toHaveText('Saved');
  await expect(row.getByRole('alert')).toHaveCount(0);
});

for (const fault of ['network', 'stream', 'http'] as const) {
  test(`a temporary ${fault} failure finishes the first region download automatically`, async ({ page }) => {
    await page.addInitScript(fault => {
      const fetch = window.fetch;
      let failed = false;
      window.fetch = async (...args) => {
        const response = await fetch(...args);
        if (failed || !new URL(response.url).pathname.endsWith('/book.pdf')) return response;
        failed = true;
        void response.body?.cancel();
        if (fault === 'network') throw new TypeError('Failed to fetch');
        if (fault === 'http') return new Response('Temporarily unavailable', { status: 503 });
        return new Response(new ReadableStream({ start(controller) {
          controller.enqueue(new TextEncoder().encode('%PDF-1.7\n'));
          controller.error(new TypeError('Failed to fetch'));
        } }), { headers: response.headers });
      };
    }, fault);
    await openSettings(page);
    const row = california(page);
    await row.getByRole('button', { name: 'Download', exact: true }).click();
    await expect(row.locator('.offline-tag')).toHaveText('Saved', { timeout: 15_000 });
    await expect(row.getByRole('alert')).toHaveCount(0);
    await expect(row.getByRole('button', { name: 'Remove', exact: true })).toBeEnabled();
  });
}

test('a file removal error leaves settings usable and removal can be retried', async ({ page }) => {
  const errors: string[] = [];
  page.on('pageerror', error => errors.push(error.message));
  await openSettings(page);
  const row = california(page);
  await row.getByRole('button', { name: 'Download', exact: true }).click();
  await expect(row.locator('.offline-tag')).toHaveText('Saved');
  await page.evaluate(() => {
    const remove = Cache.prototype.delete;
    Cache.prototype.delete = async function () {
      Cache.prototype.delete = remove;
      throw new DOMException('The requested file could not be read', 'NotReadableError');
    };
  });
  page.once('dialog', dialog => void dialog.accept());
  await row.getByRole('button', { name: 'Remove', exact: true }).click();
  await expect(row.getByRole('alert')).toContainText('The requested file could not be read');
  await expect(row.getByRole('button', { name: 'Remove', exact: true })).toBeEnabled();
  await page.getByLabel('Close settings').click();
  await page.getByLabel('Settings and offline downloads').click();
  page.once('dialog', dialog => void dialog.accept());
  await row.getByRole('button', { name: 'Remove', exact: true }).click();
  await expect(row.getByRole('button', { name: 'Download', exact: true })).toBeEnabled();
  await expect(row.getByRole('alert')).toHaveCount(0);
  expect(errors).toEqual([]);
});

test('my downloads includes saved editions from other cycles and restores its filter', async ({ page }) => {
  await openSettings(page);
  const current = california(page);
  await current.getByRole('button', { name: 'Download', exact: true }).click();
  await expect(current.locator('.offline-tag')).toHaveText('Saved');
  await page.getByLabel('FAA data cycle').selectOption('2026-08-06');
  const older = california(page, '2026-08-06');
  await older.getByRole('button', { name: 'Download', exact: true }).click();
  await expect(older.locator('.offline-tag')).toHaveText('Saved');
  await page.getByRole('button', { name: 'My downloads', exact: true }).click();
  await expect(page.locator('.region-row')).toHaveCount(2);
  await expect(current.locator('.offline-tag')).toHaveText('Saved');
  await page.reload();
  await expect(page.getByRole('button', { name: 'My downloads', exact: true })).toHaveAttribute('aria-pressed', 'true');
  await expect(page.locator('.region-row')).toHaveCount(2);
  await page.getByLabel('Find a state or territory').fill('Nevada');
  await expect(page.getByText('No regions match your search.', { exact: true })).toBeVisible();
  await page.getByLabel('Find a state or territory').fill('');
  await page.getByRole('button', { name: 'All regions', exact: true }).click();
  await expect(page.locator('.region-row').filter({ has: page.getByRole('button', { name: 'Download', exact: true }) }).first()).toBeVisible();
});

test('unknown FAA plate sizes use a minimum estimate without permanent pending labels', async ({ page }) => {
  await page.addInitScript(() => {
    const fetch = window.fetch;
    window.fetch = async (...args) => {
      const response = await fetch(...args);
      if (!new URL(response.url).pathname.endsWith('/tpp/catalog.json')) return response;
      const catalog = await response.json();
      catalog.airports[0].procedures[0].volumeTarget = null;
      catalog.volumes[0].resolvedTargetCount = 0;
      return new Response(JSON.stringify(catalog), { headers: { 'Content-Type': 'application/json' } });
    };
  });
  await openSettings(page);
  const row = california(page);
  await expect(row).toContainText('At least ');
  await expect(page.getByRole('dialog', { name: 'Settings', exact: true })).not.toContainText('size pending');
  await expect(row).not.toContainText('FAA PDF');
});

for (const stage of ['files', 'data'] as const) {
  test(`the final ${stage} check explains offline availability before showing Saved`, async ({ page }, testInfo) => {
    await page.setViewportSize({ width: 393, height: 852 });
    await holdFinalCheck(page, stage);
    await openSettings(page);
    const row = california(page);
    await row.getByRole('button', { name: 'Download', exact: true }).click();
    await page.waitForFunction(() => (window as DownloadWindow).finalCheckFixture.blocked);
    await expect(row.locator('.offline-tag')).toHaveText('Final check');
    await expect(row.locator('.region-progress')).toContainText(stage === 'files'
      ? 'Download finished. Checking offline availability:'
      : 'Files checked. Confirming offline data and finishing the save…');
    await expect(row.getByRole('button', { name: 'Pause', exact: true })).toBeEnabled();
    if (stage === 'data') await expect(row.getByRole('progressbar')).not.toHaveAttribute('value');
    await row.evaluate(element => element.scrollIntoView({ block: 'center' }));
    await page.screenshot({ path: testInfo.outputPath('final-check.png') });
    await page.evaluate(() => (window as DownloadWindow).finalCheckFixture.release());
    await expect(row.locator('.offline-tag')).toHaveText('Saved');
    await expect(row.getByRole('progressbar')).toHaveCount(0);
  });
}

test('pausing the final check leaves saved files available to resume without waiting for the old check', async ({ page }) => {
  await holdFinalCheck(page, 'data');
  await openSettings(page);
  const row = california(page);
  await row.getByRole('button', { name: 'Download', exact: true }).click();
  await page.waitForFunction(() => (window as DownloadWindow).finalCheckFixture.blocked);
  await row.getByRole('button', { name: 'Pause', exact: true }).click();
  await expect(row.locator('.offline-tag')).toHaveText('Paused');
  await expect(row).toContainText('Files saved. Resume to finish the offline check.');
  await page.evaluate(() => (window as DownloadWindow).finalCheckFixture.restore());
  await row.getByRole('button', { name: 'Resume', exact: true }).click();
  await expect(row.locator('.offline-tag')).toHaveText('Saved');
  await page.evaluate(() => (window as DownloadWindow).finalCheckFixture.release());
  await expect(row.locator('.offline-tag')).toHaveText('Saved');
});

test('missing offline data during the final check shows an actionable retry instead of Paused', async ({ page }) => {
  await holdFinalCheck(page, 'data');
  await openSettings(page);
  const row = california(page);
  await row.getByRole('button', { name: 'Download', exact: true }).click();
  await page.waitForFunction(() => (window as DownloadWindow).finalCheckFixture.blocked);
  await page.evaluate(() => {
    const fixture = (window as DownloadWindow).finalCheckFixture;
    fixture.missing = true;
    fixture.release();
  });
  await expect(row.locator('.offline-tag')).toHaveText('Needs attention');
  await expect(row.getByRole('alert')).toContainText('Required offline data could not be confirmed. Retry to finish saving this region.');
  await row.getByRole('button', { name: 'Retry', exact: true }).click();
  await expect(row.locator('.offline-tag')).toHaveText('Saved');
});

test('temporary cleanup can be cancelled or retried after a storage error without losing saved regions', async ({ page }) => {
  await openSettings(page);
  const row = california(page);
  await row.getByRole('button', { name: 'Download', exact: true }).click();
  await expect(row.locator('.offline-tag')).toHaveText('Saved');
  await page.getByText('Temporary files and storage limits', { exact: true }).click();
  const clean = page.getByRole('button', { name: 'Remove temporary charts and plates', exact: true });
  const check = page.getByRole('button', { name: 'Check saved files', exact: true });

  page.once('dialog', dialog => void dialog.dismiss());
  await clean.click();
  await expect(row.locator('.offline-tag')).toHaveText('Saved');

  await page.evaluate(() => {
    const keys = Cache.prototype.keys;
    Cache.prototype.keys = async function () {
      Cache.prototype.keys = keys;
      throw new Error('Temporary cleanup unavailable');
    };
  });
  page.once('dialog', dialog => void dialog.accept());
  await clean.click();
  await expect(page.getByRole('alert').filter({ hasText: 'Temporary cleanup unavailable' })).toBeVisible();
  await expect(clean).toBeEnabled();
  await expect(check).toBeEnabled();
  await expect(row.locator('.offline-tag')).toHaveText('Saved');

  page.once('dialog', dialog => void dialog.accept());
  await clean.click();
  await expect(check).toBeEnabled();
  await check.click();
  await expect(check).toBeEnabled();
  await expect(row.locator('.offline-tag')).toHaveText('Saved');
  await expect(page.locator('.settings-error')).toHaveCount(0);
});
