import { expect, test, type Page } from '@playwright/test';
import { openSidePanel } from './side-panel-fixture';
import { expectMapPlate, hideMapPlate } from './plate-map-fixture';

test.afterEach(async ({ request }) => { await request.post('/__test/reset'); });

const camera = (page: Page) => page.evaluate(() => JSON.parse(localStorage.getItem('zlayers-map-view-v1')!));
async function ready(page: Page) {
  await expect(page.locator('.app-shell')).toHaveAttribute('aria-busy', 'false', { timeout: 15_000 });
}
async function airport(page: Page) {
  await page.getByLabel('Search FAA navigation data').fill('KSBA');
  await page.locator('.search-results button').filter({ hasText: 'KSBA' }).click();
}
async function seedPlate(page: Page, slot: 'plate-selection' | 'plate-on-map', url = '/georeferenced-book.pdf') {
  await page.addInitScript(({ slot, url }) => {
    if (localStorage.getItem('restore-test-seeded')) return;
    localStorage.setItem('restore-test-seeded', 'true');
    // Keep the fixture plate in view so its context menu can remove it after restoration.
    localStorage.setItem('zlayers-map-view-v1', JSON.stringify({ version: 1, center: [-119.85, 34.45], zoom: 10 }));
    localStorage.setItem('zlayer-ui:edge-tool', JSON.stringify({ version: 1, value: null }));
    localStorage.setItem('zlayers-map-preferences-v1', JSON.stringify({ version: 2, chartBase: '', ownshipEnabled: false,
      metarEnabled: false, terrainEnabled: false, obstructionsEnabled: false }));
    localStorage.setItem(`zlayer-ui:${slot}`, JSON.stringify({ version: 1, value: {
      airport: { id: 'KSBA' }, procedure: { id: 'geo', name: 'Georeferenced approach', kind: 'approach' },
      cycle: '2609', effectiveDate: '2026-09-03', expirationDate: '2026-10-01',
      document: { url: new URL(url, location.href).href, nativeUrl: new URL(url, location.href).href,
        pageIndex: 0, source: 'faa-individual' },
    } }));
  }, { slot, url });
}

test('stowed details retain identification, and the chosen right panel survives alongside a plate', async ({ page }) => {
  await page.goto('/');
  await airport(page);
  await page.getByRole('button', { name: 'Identify KSBA with nearby navaids' }).click();
  await expect(page.locator('.nearby-navaids')).toContainText('CMA');
  await page.getByRole('button', { name: 'Hide KSBA details', exact: true }).click();
  await page.reload();
  await ready(page);
  await expect(page.locator('.feature-card')).toBeHidden();
  await expect(page.getByRole('button', { name: 'Show KSBA details', exact: true })).toBeVisible();
  await openSidePanel(page, 'details');
  await expect(page.getByRole('button', { name: 'Identify KSBA with nearby navaids' })).toHaveAttribute('aria-pressed', 'true');
  await expect(page.locator('.nearby-navaids')).toContainText('CMA');
  await page.getByRole('tab', { name: 'Plates', exact: true }).click();
  await page.getByRole('button', { name: /TEST APPROACH/ }).click();
  await expect(page.locator('.procedure-page-stage')).toHaveAttribute('aria-busy', 'false');
  await openSidePanel(page, 'details');
  await page.reload();
  await ready(page);
  await expect(page.locator('.feature-card')).toBeVisible();
  await expect(page.locator('.procedure-window')).toBeHidden();
  await page.getByRole('button', { name: 'Hide KSBA details', exact: true }).click();
  await page.reload();
  await ready(page);
  await expect(page.locator('.side-panels .edge-panel.is-open')).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Show KSBA plate', exact: true })).toBeVisible();
  await openSidePanel(page, 'plate');
  await expect(page.locator('.procedure-page-stage')).toHaveAttribute('aria-busy', 'false');
});

test('AHRS remembers mount preference while requiring a new calibration', async ({ page }) => {
  await page.goto('/');
  await page.getByRole('button', { name: 'Show AHRS toolbox', exact: true }).click();
  await page.getByRole('combobox', { name: 'Device mount', exact: true }).selectOption('flat');
  await page.reload();
  await ready(page);
  await expect(page.getByRole('combobox', { name: 'Device mount', exact: true })).toHaveValue('flat');
  await expect(page.getByRole('button', { name: 'Calibrate', exact: true })).toBeEnabled();
});

test('terrain remembers the last clearance altitude while elevation coloring is selected', async ({ page }) => {
  await page.goto('/');
  await page.getByRole('button', { name: 'Show terrain toolbox', exact: true }).click();
  await page.getByRole('tab', { name: 'Clearance', exact: true }).click();
  const altitude = page.getByRole('spinbutton', { name: 'Selected altitude', exact: true });
  await altitude.fill('6500');
  await altitude.press('Enter');
  await page.getByRole('tab', { name: 'Elevation', exact: true }).click();
  await page.reload();
  await ready(page);
  await expect(page.getByRole('tab', { name: 'Elevation', exact: true })).toHaveAttribute('aria-selected', 'true');
  await page.getByRole('tab', { name: 'Clearance', exact: true }).click();
  await expect(altitude).toHaveValue('6500');
  await altitude.fill('0');
  await altitude.press('Enter');
  await page.getByRole('tab', { name: 'Elevation', exact: true }).click();
  await page.reload();
  await ready(page);
  await page.getByRole('tab', { name: 'Clearance', exact: true }).click();
  await expect(altitude).toHaveValue('0');
});

test('an on-map approach restores offline without refitting the camera or closing saved airport details', async ({ page, request }) => {
  await seedPlate(page, 'plate-selection');
  await page.goto('/');
  await page.getByRole('button', { name: 'Show on map', exact: true }).click();
  await expectMapPlate(page, 'Georeferenced approach');
  await airport(page); // Explicitly move away from the original fit and leave a panel open.
  await page.getByRole('button', { name: 'Zoom out', exact: true }).click();
  await page.waitForTimeout(700);
  const saved = await camera(page);
  await page.waitForFunction(() => !!navigator.serviceWorker.controller);
  // Disconnect the actual origin; WebKit offline emulation also rejects SW responses.
  await page.addInitScript(() => Object.defineProperty(navigator, 'onLine', { get: () => false }));
  await request.post('/__test/disconnect');
  await page.reload();
  await ready(page);
  await expectMapPlate(page, 'Georeferenced approach');
  await expect(page.locator('.feature-card')).toBeVisible();
  await expect(page.locator('.feature-card h2')).toHaveText('KSBA');
  await expect(page.locator('.procedure-window')).toHaveCount(0);
  expect(await camera(page)).toEqual(saved);
  await hideMapPlate(page);
  await page.reload();
  await ready(page);
  await expectMapPlate(page, null);
  await expect(page.locator('.feature-card')).toBeVisible();
  expect(await camera(page)).toEqual(saved);
});

test('startup waits for the restored map plate and preserves a separately restored reader', async ({ page }) => {
  await page.addInitScript(() => { Reflect.deleteProperty(Navigator.prototype, 'serviceWorker'); });
  await seedPlate(page, 'plate-on-map');
  let release!: () => void;
  const held = new Promise<void>(resolve => { release = resolve; });
  let requested = false;
  await page.route('**/assets/restore-map-image-*.js', async route => {
    requested = true; await held; await route.continue();
  });
  await page.goto('/');
  await expect.poll(() => requested).toBe(true);
  await expect(page.getByLabel('IAP on map', { exact: true })).toHaveAttribute('aria-busy', 'true');
  await page.waitForTimeout(1100);
  await expect(page.locator('.startup-screen')).toBeVisible();
  release();
  await ready(page);
  await airport(page);
  await page.getByRole('tab', { name: 'Plates', exact: true }).click();
  await page.getByRole('button', { name: /TEST APPROACH/ }).click();
  await expect(page.locator('.procedure-page-stage')).toHaveAttribute('aria-busy', 'false');
  await page.reload();
  await ready(page);
  await expectMapPlate(page, 'Georeferenced approach');
  await expect(page.locator('.procedure-window')).toBeVisible();
  await expect(page.locator('.procedure-window h2')).toHaveText('TEST APPROACH');
});

test('unavailable saved map plate offers retry and explicit removal without blocking startup', async ({ page, request }, testInfo) => {
  await page.setViewportSize({ width: 393, height: 852 });
  await page.addInitScript(() => { Reflect.deleteProperty(Navigator.prototype, 'serviceWorker'); });
  await seedPlate(page, 'plate-on-map', '/missing-approach.pdf');
  const bytes = await (await request.get('/georeferenced-book.pdf')).body();
  let available = false;
  await page.route('**/missing-approach.pdf', route => available
    ? route.fulfill({ contentType: 'application/pdf', body: bytes }) : route.fulfill({ status: 503 }));
  await page.goto('/');
  await ready(page);
  const plate = page.getByLabel('IAP on map', { exact: true });
  await expect(plate.getByRole('alert')).toContainText('IAP could not be restored');
  const bounds = (await plate.boundingBox())!;
  expect(bounds.height).toBeLessThan(200);
  expect(bounds.x).toBeGreaterThanOrEqual(0);
  expect(bounds.x + bounds.width).toBeLessThanOrEqual(393);
  await page.screenshot({ path: testInfo.outputPath('plate-restore-error-mobile.png') });
  expect(await page.evaluate(() => JSON.parse(localStorage.getItem('zlayer-plugin:plates:plate-on-map')!).value.procedure.id)).toBe('geo');
  available = true;
  await page.getByRole('button', { name: 'Retry IAP', exact: true }).click();
  await expectMapPlate(page, 'Georeferenced approach');
  await hideMapPlate(page);
  await page.reload();
  await ready(page);
  await expectMapPlate(page, null);
});
