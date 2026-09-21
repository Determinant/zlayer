import { test as base, expect, type Page } from '@playwright/test';
import { readFile } from 'node:fs/promises';

const test = base.extend({
  context: async ({ context, browserName, playwright, baseURL }, use, testInfo) => {
    if (browserName !== 'webkit') { await use(context); return; }
    // WebKit's ephemeral contexts cannot persist recording Blobs in IndexedDB.
    // Use real file storage, then inject the unavailable-OPFS export condition.
    const persistent = await playwright.webkit.launchPersistentContext(testInfo.outputPath('profile'), {
      baseURL: baseURL!, serviceWorkers: 'block',
    });
    await persistent.addInitScript(() => localStorage.setItem('zlayer-ui:welcome-acknowledged', JSON.stringify({ version: 1, value: true })));
    try { await use(persistent); } finally { await persistent.close(); }
  },
});

// Allow worker response injection and exercise the app without a service worker.
test.use({ serviceWorkers: 'block' });
const MiB = 1024 * 1024;

async function seed(page: Page, sizes: number[]) {
  await page.goto('/');
  await expect(page.getByRole('button', { name: 'Show AHRS toolbox', exact: true })).toBeVisible();
  const recordings = await page.evaluate(async sizes => {
    const db = await new Promise<IDBDatabase>((resolve, reject) => {
      const request = indexedDB.open('zlayer-offline', 1);
      request.onupgradeneeded = () => request.result.createObjectStore('records');
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
    const recordings = [], origin = Date.now();
    for (const [index, size] of sizes.entries()) {
      const id = `storage-test-${index}`, startedAt = origin - index * 1000;
      const lines: string[] = [];
      let bytes = 0;
      const add = (type: string, data: unknown) => {
        const line = JSON.stringify({ sequence: lines.length, time: lines.length * .02, type, data }) + '\n';
        lines.push(line); bytes += line.length;
      };
      add('header', { format: 'zlayer-ahrs', version: 1, context: { timeOrigin: startedAt } });
      add('gps', { state: 'tracking', fix: { timestamp: startedAt, coordinates: [-122, 37] } });
      while (bytes < size) add('imu', { sample: { gyro: [0, 0, 0], specificForce: [0, 0, -9.80665] }, applied: true });
      add('end', { reason: 'Stopped by user' });
      const blob = new Blob(lines), chunks = Math.ceil(blob.size / (128 * 1024));
      const data = new Uint8Array(await blob.arrayBuffer());
      await new Promise<void>((resolve, reject) => {
        const transaction = db.transaction('records', 'readwrite'), store = transaction.objectStore('records');
        store.put({ version: 1, id, startedAt, updatedAt: startedAt, chunks, events: lines.length, bytes: blob.size,
          status: 'complete' }, `ahrs-recording:${id}`);
        // Store independent Blobs, matching the recorder's committed chunks.
        for (let i = 0; i < chunks; i++) store.put(new Blob([data.slice(i * 128 * 1024, (i + 1) * 128 * 1024)]), `ahrs-samples:${id}:${i}`);
        transaction.oncomplete = () => resolve();
        transaction.onabort = () => reject(transaction.error);
      });
      recordings.push({ id, bytes: blob.size, events: lines.length });
    }
    db.close();
    return recordings;
  }, sizes);
  await page.getByRole('button', { name: 'Show AHRS toolbox', exact: true }).click();
  await page.getByRole('button', { name: 'AHRS recorder', exact: true }).click();
  await expect(page.locator('.ahrs-recorder-menu li')).toHaveCount(sizes.length);
  return recordings;
}

async function save(page: Page, index: number, format: 'Download GPX' | 'Debug log') {
  const downloaded = page.waitForEvent('download');
  await page.locator('.ahrs-recorder-menu li').nth(index).getByRole('button', { name: format, exact: true }).click();
  const file = await downloaded;
  expect(await file.failure()).toBeNull();
  return readFile((await file.path())!);
}

test('private-storage fallback reuses repeated downloads and releases earlier memory before a different export', async ({ page, context }) => {
  await page.clock.install();
  let workers = 0;
  await context.route('**/assets/recording-export.worker-*.js', async route => {
    workers++;
    const response = await route.fetch();
    await route.fulfill({ response, body: `StorageManager.prototype.getDirectory = async () => {
      throw new DOMException('OPFS unavailable in private browsing', 'UnknownError');
    };\n${await response.text()}` });
  });
  await page.addInitScript(() => {
    const live = new Map<string, number>();
    const update = () => {
      document.documentElement.dataset.exportBytes = String([...live.values()].reduce((a, b) => a + b, 0));
      document.documentElement.dataset.exportUrls = String(live.size);
    };
    const create = URL.createObjectURL.bind(URL), revoke = URL.revokeObjectURL.bind(URL);
    URL.createObjectURL = blob => {
      const url = create(blob);
      if (blob instanceof Blob && ['application/x-ndjson', 'application/gpx+xml'].includes(blob.type)) {
        live.set(url, blob.size); update();
      }
      return url;
    };
    URL.revokeObjectURL = url => { live.delete(url); update(); revoke(url); };
  });
  const recordings = await seed(page, [6 * MiB, 6 * MiB]);
  const first = await save(page, 0, 'Debug log');
  expect(first.length).toBe(recordings[0]!.bytes);
  const lines = first.toString().trim().split('\n').map(line => JSON.parse(line));
  expect(lines.map(line => line.sequence)).toEqual(lines.map((_, index) => index));
  expect(lines.at(-1).type).toBe('end');
  // Stress retained payloads without Chromium's native rapid-download limiter.
  await page.evaluate(() => {
    const click = HTMLAnchorElement.prototype.click;
    HTMLAnchorElement.prototype.click = () => {};
    window.addEventListener('restore-test-downloads', () => { HTMLAnchorElement.prototype.click = click; }, { once: true });
  });
  for (let i = 0; i < 12; i++) await page.locator('.ahrs-recorder-menu li').first().getByRole('button', { name: 'Debug log', exact: true }).click();
  await page.evaluate(() => window.dispatchEvent(new Event('restore-test-downloads')));
  expect(workers).toBe(1);
  await expect(page.locator('html')).toHaveAttribute('data-export-urls', '1');
  for (const index of [1, 0, 1]) {
    expect((await save(page, index, 'Debug log')).length).toBe(recordings[index]!.bytes);
    await expect(page.locator('html')).toHaveAttribute('data-export-urls', '1');
    await expect(page.locator('html')).toHaveAttribute('data-export-bytes', String(recordings[index]!.bytes));
  }
  expect((await save(page, 0, 'Download GPX')).toString()).toContain('complete="true"');
  await expect(page.locator('html')).toHaveAttribute('data-export-urls', '1');
  await page.clock.runFor(300_001);
  await expect(page.locator('html')).toHaveAttribute('data-export-urls', '0');
});

test('full origin storage still exports saved GPX and debug data within the fallback limit', async ({ page, context, browserName }) => {
  test.skip(browserName !== 'chromium', 'Quota override uses Chromium CDP.');
  const recordings = await seed(page, [2 * MiB, 9 * MiB]);
  const session = await context.newCDPSession(page);
  const { origin, usage } = await page.evaluate(async () => ({ origin: location.origin, usage: (await navigator.storage.estimate()).usage }));
  expect(usage).toBeDefined();
  await session.send('Storage.overrideQuotaForOrigin', { origin, quotaSize: usage! });
  try {
    const xml = (await save(page, 0, 'Download GPX')).toString();
    expect(xml).toContain('<trkpt lat="37" lon="-122">');
    expect(xml).toContain('complete="true"');
    const log = await save(page, 0, 'Debug log');
    expect(log.length).toBe(recordings[0]!.bytes);
    const lines = log.toString().trim().split('\n').map(line => JSON.parse(line));
    expect(lines.length).toBe(recordings[0]!.events);
    expect(lines.map(line => line.sequence)).toEqual(lines.map((_, i) => i));
    expect(lines.at(-1).type).toBe('end');
    await page.locator('.ahrs-recorder-menu li').nth(1).getByRole('button', { name: 'Debug log', exact: true }).click();
    await expect(page.getByRole('region', { name: 'AHRS recordings', exact: true }).getByRole('alert')).toContainText('8 MiB memory limit');
    // Failed large downloads preserve the recording and permit a smaller GPX recovery.
    expect((await save(page, 1, 'Download GPX')).toString()).toContain('complete="true"');
    await expect(page.locator('.ahrs-recorder-menu li')).toHaveCount(2);
  } finally {
    await session.send('Storage.overrideQuotaForOrigin', { origin });
    await session.detach();
  }
});
