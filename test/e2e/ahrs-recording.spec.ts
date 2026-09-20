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
    .getByRole('button', { name: 'Download', exact: true }).first().click();
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
  page.once('dialog', dialog => dialog.dismiss());
  await menu.getByRole('button', { name: 'Delete', exact: true }).click();
  expect(await recordingKeys(page)).toEqual(oldKeys);

  await menu.getByRole('button', { name: 'Start recording', exact: true }).click();
  await expect(menu.locator('li')).toHaveCount(2);
  await expect(menu.locator('li').first().getByRole('button', { name: 'Delete', exact: true })).toBeDisabled();
  page.once('dialog', dialog => dialog.accept());
  await menu.locator('li').last().getByRole('button', { name: 'Delete', exact: true }).click();
  await expect(menu.locator('li')).toHaveCount(1);
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
  await page.reload();
  await page.getByRole('button', { name: 'AHRS recorder', exact: true }).click();
  await expect(menu.getByRole('button', { name: 'Download', exact: true })).toHaveCount(1);
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
  page.once('dialog', dialog => dialog.accept());
  await page.getByRole('region', { name: 'AHRS recordings', exact: true }).getByRole('button', { name: 'Delete', exact: true }).click();
  await expect(page.getByText('No recordings yet.', { exact: true })).toBeVisible();
  expect(await recordingKeys(page)).toEqual([]);
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
  page.once('dialog', dialog => dialog.accept());
  await menu.getByRole('button', { name: 'Delete', exact: true }).click();
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
