import { test, expect, type Page } from '@playwright/test';
import { readFile } from 'node:fs/promises';
import { mockGps, countWatches } from './ownship-fixture';

async function open(page: Page) {
  await mockGps(page);
  await page.addInitScript(() => {
    localStorage.setItem('zlayers-map-preferences-v1', JSON.stringify({ chartBase: '', ownshipEnabled: false }));
    Object.defineProperty(DeviceMotionEvent, 'requestPermission', { configurable: true, value: async () => 'granted' });
    window.addEventListener('test-recording-sensors', () => {
      setInterval(() => window.dispatchEvent(new DeviceMotionEvent('devicemotion', {
        rotationRate: { alpha: 0, beta: 0, gamma: 0 },
        accelerationIncludingGravity: { x: 0, y: 9.80665, z: 0 }, interval: 20,
      })), 20);
      setInterval(() => window.dispatchEvent(new CustomEvent('test-gps-position', {
        detail: { speed: 50, altitude: 3048, altitudeAccuracy: 5 },
      })), 1000);
    });
  });
  await page.goto('/');
  await page.waitForFunction(() => !!navigator.serviceWorker.controller);
  await page.getByRole('button', { name: 'Hide terrain toolbox', exact: true }).click();
  await page.getByRole('button', { name: 'Show AHRS toolbox', exact: true }).click();
  await page.getByRole('button', { name: 'AHRS recorder', exact: true }).click();
  const menu = page.getByRole('region', { name: 'AHRS recordings', exact: true });
  await menu.getByRole('button', { name: 'Start recording', exact: true }).click();
  await expect(menu.getByRole('button', { name: 'Stop recording', exact: true })).toBeEnabled();
  await page.keyboard.press('Escape');
  await expect(menu).toHaveCount(0);
  await expect(page.getByRole('alertdialog')).toHaveCount(0);
  expect(await countWatches(page)).toBe(0);
  await page.getByRole('button', { name: 'Calibrate', exact: true }).click();
  await page.evaluate(() => window.dispatchEvent(new Event('test-recording-sensors')));
}

async function download(page: Page) {
  const result = page.waitForEvent('download');
  await page.getByRole('region', { name: 'AHRS recordings', exact: true })
    .getByRole('button', { name: 'Debug log', exact: true }).first().click();
  const file = await result;
  expect(file.suggestedFilename()).toMatch(/^zlayer-ahrs-.*\.jsonl$/);
  expect(await file.failure()).toBeNull();
  const lines = (await readFile((await file.path())!, 'utf8')).trim().split('\n').map(line => JSON.parse(line));
  expect(lines.map(line => line.sequence)).toEqual(lines.map((_, index) => index));
  expect(lines[0].data.format).toBe('zlayer-ahrs');
  return lines;
}

async function recordingKeys(page: Page) {
  return page.evaluate(() => new Promise<string[]>((resolve, reject) => {
    const opening = indexedDB.open('zlayer-offline', 1);
    opening.onerror = () => reject(opening.error);
    opening.onsuccess = () => {
      const db = opening.result, transaction = db.transaction('records');
      const request = transaction.objectStore('records').getAllKeys();
      transaction.oncomplete = () => db.close();
      transaction.onabort = () => { db.close(); reject(transaction.error); };
      request.onerror = () => reject(request.error);
      request.onsuccess = () => resolve(request.result.filter((key): key is string =>
        typeof key === 'string' && (key.startsWith('ahrs-recording:') || key.startsWith('ahrs-samples:'))));
    };
  }));
}

test('saved recordings can be deleted individually offline while active capture stays protected', async ({ page, context }) => {
  await page.clock.install();
  await open(page);
  await page.clock.runFor(3000);
  await context.setOffline(true);
  await page.getByRole('button', { name: 'Recording · open recorder', exact: true }).click();
  const menu = page.getByRole('region', { name: 'AHRS recordings', exact: true });
  await expect(menu.getByRole('button', { name: 'Delete', exact: true })).toBeDisabled();
  await menu.getByRole('button', { name: 'Stop recording', exact: true }).click();
  await expect(menu.getByRole('button', { name: 'Start recording', exact: true })).toBeEnabled();
  const oldKeys = await recordingKeys(page);
  expect(oldKeys.some(key => key.startsWith('ahrs-samples:'))).toBe(true);
  const confirmation = page.getByRole('alertdialog', { name: 'Delete recording?', exact: true });
  await menu.getByRole('button', { name: 'Delete', exact: true }).click();
  await expect(confirmation).toBeVisible();
  await expect(confirmation.getByRole('button', { name: 'Cancel', exact: true })).toBeFocused();
  await confirmation.getByRole('button', { name: 'Cancel', exact: true }).click();
  await expect(confirmation).toHaveCount(0);
  await expect(menu.getByRole('button', { name: 'Delete', exact: true })).toBeFocused();
  expect(await recordingKeys(page)).toEqual(oldKeys);
  await menu.getByRole('button', { name: 'Delete', exact: true }).click();
  await page.keyboard.press('Escape');
  await expect(confirmation).toHaveCount(0);
  await expect(menu.getByRole('button', { name: 'Delete', exact: true })).toBeFocused();
  await expect(page.getByRole('alertdialog', { name: 'Stow AHRS?', exact: true })).toHaveCount(0);
  expect(await recordingKeys(page)).toEqual(oldKeys);

  await menu.getByRole('button', { name: 'Start recording', exact: true }).click();
  await expect(menu.locator('li')).toHaveCount(2);
  await expect(menu.locator('li').first().getByRole('button', { name: 'Delete', exact: true })).toBeDisabled();
  await menu.locator('li').last().getByRole('button', { name: 'Delete', exact: true }).click();
  await confirmation.getByRole('button', { name: 'Delete', exact: true }).click();
  await expect(confirmation).toHaveCount(0);
  await expect(menu.locator('li')).toHaveCount(1);
  await expect(page.getByRole('button', { name: 'Recording · open recorder', exact: true })).toBeFocused();
  await expect(menu.getByRole('button', { name: 'Stop recording', exact: true })).toBeEnabled();
  expect(await countWatches(page)).toBe(1);
  const remaining = await recordingKeys(page);
  expect(remaining.length).toBeGreaterThan(0);
  expect(remaining.some(key => oldKeys.includes(key))).toBe(false);
  await menu.getByRole('button', { name: 'Stop recording', exact: true }).click();
  await expect(menu.getByRole('button', { name: 'Start recording', exact: true })).toBeEnabled();
  await page.reload();
  await page.getByRole('button', { name: 'AHRS recorder', exact: true }).click();
  await expect(menu.locator('li')).toHaveCount(1);
  expect((await recordingKeys(page)).some(key => oldKeys.includes(key))).toBe(false);
});

test('AHRS recorder captures live inputs, fits beside full screen, and downloads after an offline reload', async ({ page, context }, testInfo) => {
  await page.clock.install();
  await page.setViewportSize({ width: 320, height: 568 });
  await open(page);
  await context.setOffline(true);
  await page.clock.runFor(12_000);
  await expect(page.getByRole('button', { name: 'Recalibrate', exact: true })).toBeVisible();
  const record = page.getByRole('button', { name: 'Recording · open recorder', exact: true });
  const expand = page.getByRole('button', { name: 'Enter full screen', exact: true });
  const recordBox = (await record.boundingBox())!, expandBox = (await expand.boundingBox())!;
  expect(recordBox.width).toBe(expandBox.width);
  const heading = (await page.locator('.ahrs-heading').boundingBox())!;
  expect(Math.abs((recordBox.x + expandBox.x + expandBox.width) / 2 - heading.x - heading.width / 2)).toBeLessThan(1);
  expect(recordBox.x + recordBox.width).toBeLessThanOrEqual(expandBox.x);
  expect(Math.abs(recordBox.y - expandBox.y)).toBeLessThan(2);
  await expand.click();
  expect((await record.boundingBox())!.width).toBe((await page.getByRole('button', { name: 'Exit full screen', exact: true }).boundingBox())!.width);
  await record.click();
  const menu = page.getByRole('region', { name: 'AHRS recordings', exact: true });
  const box = (await menu.boundingBox())!;
  expect(box.x).toBeGreaterThanOrEqual(0);
  expect(box.x + box.width).toBeLessThanOrEqual(320);
  expect(box.y + box.height).toBeLessThanOrEqual(568);
  await page.screenshot({ path: testInfo.outputPath('recorder-mobile.png') });
  await page.keyboard.press('Escape');
  await expect(page.getByRole('dialog', { name: 'AHRS full screen', exact: true })).toBeVisible();
  await record.click();
  await menu.getByRole('button', { name: 'Stop recording', exact: true }).click();
  await expect(menu.getByRole('button', { name: 'Start recording', exact: true })).toBeEnabled();
  expect(await countWatches(page)).toBe(1); // Stopping recording leaves the estimator running.
  await menu.getByRole('button', { name: 'Delete', exact: true }).click();
  const confirmation = page.getByRole('alertdialog', { name: 'Delete recording?', exact: true });
  await expect(confirmation).toBeVisible();
  const confirmationBox = (await confirmation.boundingBox())!;
  expect(confirmationBox.x).toBeGreaterThanOrEqual(0);
  expect(confirmationBox.x + confirmationBox.width).toBeLessThanOrEqual(320);
  expect(confirmationBox.y).toBeGreaterThanOrEqual(0);
  expect(confirmationBox.y + confirmationBox.height).toBeLessThanOrEqual(568);
  await page.screenshot({ path: testInfo.outputPath('recorder-delete-mobile.png') });
  await page.keyboard.press('Escape');
  await expect(confirmation).toHaveCount(0);
  await expect(page.getByRole('dialog', { name: 'AHRS full screen', exact: true })).toBeVisible();
  await expect(menu.getByRole('button', { name: 'Delete', exact: true })).toBeFocused();
  await page.reload();
  await page.getByRole('button', { name: 'AHRS recorder', exact: true }).click();
  await expect(menu.getByRole('button', { name: 'Download GPX', exact: true })).toHaveCount(1);
  const gpxDownload = page.waitForEvent('download');
  await menu.getByRole('button', { name: 'Download GPX', exact: true }).click();
  const gpx = await gpxDownload;
  expect(gpx.suggestedFilename()).toMatch(/^zlayer-ahrs-.*\.gpx$/);
  expect(await gpx.failure()).toBeNull();
  await gpx.saveAs(testInfo.outputPath('recording.gpx'));
  const xml = await readFile((await gpx.path())!, 'utf8');
  const track = await page.evaluate(xml => {
    const doc = new DOMParser().parseFromString(xml, 'application/xml');
    const points = [...doc.getElementsByTagNameNS('http://www.topografix.com/GPX/1/1', 'trkpt')];
    const states = [...doc.getElementsByTagNameNS('urn:zlayer:ahrs:1', 'state')];
    return { errors: doc.getElementsByTagName('parsererror').length,
      points: points.map(point => ({ latitude: point.getAttribute('lat'), longitude: point.getAttribute('lon'),
        time: point.getElementsByTagName('time')[0]?.textContent, altitude: point.getElementsByTagName('ele')[0]?.textContent })),
      states: states.map(state => ({ time: state.getAttribute('time'), phase: state.getAttribute('phase'),
        roll: state.getAttribute('roll'), quaternion: state.getAttribute('quaternion'), headingStatus: state.getAttribute('headingStatus') })),
      complete: doc.getElementsByTagNameNS('urn:zlayer:ahrs:1', 'recording')[0]?.getAttribute('complete') };
  }, xml);
  expect(track.errors).toBe(0);
  expect(track.points.length).toBeGreaterThanOrEqual(12);
  expect(track.points.every(point => point.latitude === '37' && point.longitude === '-122' &&
    point.altitude === '3048' && Number.isFinite(Date.parse(point.time!)))).toBe(true);
  expect(new Set(track.points.map(point => point.time)).size).toBe(track.points.length);
  expect(track.states.length).toBeGreaterThan(track.points.length * 5);
  expect(track.states.some(state => state.phase === 'ready' && state.roll !== null && state.quaternion !== null)).toBe(true);
  expect(track.complete).toBe('true');
  // The worker wrote an OPFS file, rather than collecting the entire export in the page.
  expect(await page.evaluate(async () => {
    const directory = await (await navigator.storage.getDirectory()).getDirectoryHandle('zlayer-exports');
    for await (const [name] of directory.entries()) if (name.endsWith('.gpx')) return true;
    return false;
  })).toBe(true);
  const lines = await download(page);
  for (const type of ['calibrate', 'alignment', 'imu', 'gps', 'state', 'covariance', 'end'])
    expect(lines.some(line => line.type === type), type).toBe(true);
  expect(lines.filter(line => line.type === 'imu').length).toBeGreaterThanOrEqual(590);
  const imu = lines.find(line => line.type === 'imu').data;
  expect(imu.raw.acceleration).toEqual([0, 9.80665, 0]);
  expect(imu.sample.specificForce).toEqual([0, 0, -9.80665]);
  expect(lines.some(line => line.type === 'gps' && line.data.fix?.coordinates?.[0] === -122)).toBe(true);
  expect(lines.some(line => line.type === 'state' && line.data.attitude?.attitudeStd?.[2] === 'Infinity')).toBe(true);
  expect(lines.at(-1).type).toBe('end');
  expect(await countWatches(page)).toBe(0);
});

test('an interrupted recording retains a valid downloadable prefix offline', async ({ page, context }) => {
  await page.clock.install();
  await open(page);
  await page.clock.runFor(4000);
  await page.getByRole('button', { name: 'Recording · open recorder', exact: true }).click();
  await expect(page.locator('.ahrs-recorder-menu small')).not.toContainText('0:00');
  await context.setOffline(true);
  await page.reload();
  await page.getByRole('button', { name: 'AHRS recorder', exact: true }).click();
  await expect(page.locator('.ahrs-recorder-menu small')).toContainText('Partial');
  const lines = await download(page);
  expect(lines.some(line => line.type === 'imu')).toBe(true);
  expect(lines.some(line => line.type === 'end')).toBe(false);
  const exported = page.waitForEvent('download');
  await page.getByRole('button', { name: 'Download GPX', exact: true }).click();
  const gpx = await exported;
  const xml = await readFile((await gpx.path())!, 'utf8');
  expect(xml).toContain('complete="false"');
  expect(xml.trim()).toMatch(/<\/gpx>$/);
  await page.getByRole('region', { name: 'AHRS recordings', exact: true }).getByRole('button', { name: 'Delete', exact: true }).click();
  await page.getByRole('alertdialog', { name: 'Delete recording?', exact: true }).getByRole('button', { name: 'Delete', exact: true }).click();
  await expect(page.getByText('No recordings yet.', { exact: true })).toBeVisible();
  expect(await recordingKeys(page)).toEqual([]);
});

test('a recording without GPS reports a GPX error and keeps its debug log available', async ({ page }) => {
  await mockGps(page);
  await page.goto('/');
  await page.waitForFunction(() => !!navigator.serviceWorker.controller);
  await page.getByRole('button', { name: 'Show AHRS toolbox', exact: true }).click();
  await page.getByRole('button', { name: 'AHRS recorder', exact: true }).click();
  const menu = page.getByRole('region', { name: 'AHRS recordings', exact: true });
  await menu.getByRole('button', { name: 'Start recording', exact: true }).click();
  await menu.getByRole('button', { name: 'Stop recording', exact: true }).click();
  await expect(menu.getByRole('button', { name: 'Start recording', exact: true })).toBeEnabled();
  await menu.getByRole('button', { name: 'Download GPX', exact: true }).click();
  await expect(menu.getByRole('alert')).toHaveText('No GPS positions were saved. Download the debug log instead.');
  expect(await page.evaluate(async () => {
    const directory = await (await navigator.storage.getDirectory()).getDirectoryHandle('zlayer-exports');
    let count = 0;
    for await (const _ of directory.keys()) count++;
    return count;
  })).toBe(0);
  expect((await download(page)).at(-1).type).toBe('end');
});

test('cancelling an export terminates its worker and leaves the recording downloadable', async ({ page }) => {
  await page.clock.install();
  await open(page);
  await page.clock.runFor(3000);
  await page.getByRole('button', { name: 'Recording · open recorder', exact: true }).click();
  const menu = page.getByRole('region', { name: 'AHRS recordings', exact: true });
  await menu.getByRole('button', { name: 'Stop recording', exact: true }).click();
  await expect(menu.getByRole('button', { name: 'Start recording', exact: true })).toBeEnabled();
  await page.evaluate(() => {
    const Original = Worker;
    window.Worker = class extends Original {
      constructor(url: string | URL, options?: WorkerOptions) {
        super(url, options);
        if (!String(url).includes('recording-export')) return;
        // Hold the RPC so cancellation happens before an export finishes.
        this.postMessage = () => {};
        const terminate = this.terminate.bind(this);
        this.terminate = () => {
          terminate(); window.Worker = Original;
          document.documentElement.dataset.exportTerminated = 'true';
        };
      }
    };
  });
  await menu.getByRole('button', { name: 'Download GPX', exact: true }).click();
  await expect(menu.getByRole('button', { name: 'Preparing…', exact: true })).toBeDisabled();
  await menu.getByRole('button', { name: 'Cancel download', exact: true }).click();
  await expect(page.locator('html')).toHaveAttribute('data-export-terminated', 'true');
  await expect(menu.getByRole('button', { name: 'Download GPX', exact: true })).toBeEnabled();
  await expect(menu.getByRole('alert')).toHaveCount(0);
  expect((await download(page)).at(-1).type).toBe('end');
});

test('a failed recording deletion rolls back metadata and chunks and remains downloadable', async ({ page }) => {
  await page.clock.install();
  await open(page);
  await page.clock.runFor(3000);
  await page.getByRole('button', { name: 'Recording · open recorder', exact: true }).click();
  const menu = page.getByRole('region', { name: 'AHRS recordings', exact: true });
  await menu.getByRole('button', { name: 'Stop recording', exact: true }).click();
  await expect(menu.getByRole('button', { name: 'Start recording', exact: true })).toBeEnabled();
  const before = await recordingKeys(page);
  await page.evaluate(() => {
    const remove = IDBObjectStore.prototype.delete;
    IDBObjectStore.prototype.delete = function (key: IDBValidKey | IDBKeyRange) {
      if (key instanceof IDBKeyRange && String(key.lower).startsWith('ahrs-samples:')) throw new Error('Deletion failed');
      return remove.call(this, key);
    };
  });
  await menu.getByRole('button', { name: 'Delete', exact: true }).click();
  await page.getByRole('alertdialog', { name: 'Delete recording?', exact: true }).getByRole('button', { name: 'Delete', exact: true }).click();
  await expect(menu.getByRole('alert')).toContainText('Deletion failed');
  expect(await recordingKeys(page)).toEqual(before);
  expect((await download(page)).at(-1).type).toBe('end');
});

test('a failed chunk rolls back its metadata and leaves saved data downloadable', async ({ page }) => {
  await page.clock.install();
  await open(page);
  await page.clock.runFor(3000);
  await page.evaluate(() => {
    const put = IDBObjectStore.prototype.put;
    IDBObjectStore.prototype.put = function (value: unknown, key?: IDBValidKey) {
      if (String(key).startsWith('ahrs-samples:')) throw new DOMException('Storage full', 'QuotaExceededError');
      return put.call(this, value, key);
    };
  });
  await page.clock.runFor(2000);
  await page.getByRole('button', { name: 'Recorder needs attention', exact: true }).click();
  await expect(page.getByRole('region', { name: 'AHRS recordings', exact: true }).getByRole('alert')).toContainText('Storage full');
  expect(await countWatches(page)).toBe(1);
  await page.reload();
  await page.getByRole('button', { name: 'AHRS recorder', exact: true }).click();
  const lines = await download(page);
  expect(lines.some(line => line.type === 'imu')).toBe(true);
  expect(lines.some(line => line.type === 'end')).toBe(false);
});
