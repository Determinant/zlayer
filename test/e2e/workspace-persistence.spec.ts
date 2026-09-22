import { expect, test, type Page } from '@playwright/test';
import { mockGps, sendFix, countWatches } from './ownship-fixture';

test.afterEach(async ({ request }) => { await request.post('/__test/reset'); });

const camera = (page: Page) => page.evaluate(() => JSON.parse(localStorage.getItem('zlayers-map-view-v1')!));

function twoPagePdf() {
  const objects = [
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Kids [3 0 R 4 0 R] /Count 2 >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 200 200] /Resources << >> >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 200 300] /Resources << >> >>',
  ];
  let body = '%PDF-1.7\n';
  const offsets = [0];
  for (const [index, object] of objects.entries()) {
    offsets.push(Buffer.byteLength(body));
    body += `${index + 1} 0 obj\n${object}\nendobj\n`;
  }
  const xref = Buffer.byteLength(body);
  body += `xref\n0 ${offsets.length}\n0000000000 65535 f \n`;
  for (const offset of offsets.slice(1)) body += `${String(offset).padStart(10, '0')} 00000 n \n`;
  return Buffer.from(body + `trailer\n<< /Size ${offsets.length} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`);
}
async function mapReady(page: Page) {
  await expect(page.locator('.app-shell')).toHaveAttribute('aria-busy', 'false');
  await expect(page.locator('.maplibregl-ctrl-zoom-in')).toBeVisible();
}
async function pan(page: Page) {
  const box = (await page.locator('.maplibregl-canvas').boundingBox())!;
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  await page.mouse.down();
  await page.mouse.move(box.x + box.width / 2 + 180, box.y + box.height / 2 + 100, { steps: 12 });
  await page.mouse.up();
}

test('camera survives refresh with GPS enabled, including a refresh during zoom', async ({ page }) => {
  await mockGps(page);
  await page.addInitScript(() => {
    if (!localStorage.getItem('zlayers-map-preferences-v1')) localStorage.setItem('zlayers-map-preferences-v1',
      JSON.stringify({ version: 2, chartBase: '', ownshipEnabled: true }));
  });
  await page.goto('/');
  await mapReady(page);
  await expect.poll(() => countWatches(page)).toBe(1);
  await sendFix(page);
  await page.waitForTimeout(650);
  await pan(page);
  await page.getByRole('button', { name: 'Zoom out', exact: true }).click();
  await page.waitForTimeout(650);
  const saved = await camera(page);
  await page.reload();
  await mapReady(page);
  await expect.poll(() => countWatches(page)).toBe(1);
  await sendFix(page, { longitude: -119, latitude: 35 });
  await page.waitForTimeout(650);
  expect(await camera(page)).toEqual(saved);

  // Start a camera animation and reload before moveend. pagehide must flush it.
  await page.locator('.maplibregl-ctrl-zoom-in').evaluate((button: HTMLButtonElement) => button.click());
  await page.waitForTimeout(100);
  await page.reload();
  await mapReady(page);
  const interrupted = await camera(page);
  expect(interrupted.zoom).toBeGreaterThan(saved.zoom);
  expect(interrupted.zoom).toBeLessThan(saved.zoom + 1);
  await page.reload();
  await mapReady(page);
  expect(await camera(page)).toEqual(interrupted);
});

test('panel visibility, toolboxes, settings and recommendations survive refresh and explicit close', async ({ page }) => {
  await page.goto('/');
  await mapReady(page);
  await page.getByRole('button', { name: 'Show chart status', exact: true }).click();
  await page.getByRole('button', { name: 'Open map layers', exact: true }).click();
  await page.reload();
  await expect(page.getByRole('dialog', { name: 'Map layers', exact: true })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Hide chart status', exact: true })).toBeVisible();
  await page.getByRole('button', { name: 'Close map layers', exact: true }).click();
  await page.getByRole('button', { name: 'Hide chart status', exact: true }).click();
  await page.getByLabel('Settings and offline downloads').click();
  await page.getByLabel('Find a state or territory').fill('California');
  await page.reload();
  await expect(page.getByRole('dialog', { name: 'Settings', exact: true })).toBeVisible();
  await expect(page.getByLabel('Find a state or territory')).toHaveValue('California');
  await page.getByRole('button', { name: 'About ZLayer', exact: true }).click();
  await page.reload();
  await expect(page.getByRole('dialog', { name: 'About ZLayer', exact: true })).toBeVisible();
  await page.getByLabel('Close about dialog').click();
  await page.getByLabel('Close settings').click();
  await page.getByRole('textbox', { name: 'Add route waypoint' }).fill('KSBA KSMO ');
  await page.getByRole('textbox', { name: 'Add route waypoint' }).press('Enter');
  await page.getByRole('button', { name: 'Advise', exact: true }).click();
  await expect(page.locator('[data-route-category="frequency"] li').first()).toBeVisible();
  await page.getByLabel('Aircraft', { exact: true }).selectOption('Piston');
  await pan(page);
  await page.waitForTimeout(650);
  const saved = await camera(page);
  await page.reload();
  await expect(page.locator('[data-route-category="frequency"] li').first()).toBeVisible();
  await expect(page.getByLabel('Aircraft', { exact: true })).toHaveValue('Piston');
  await page.waitForTimeout(650);
  expect(await camera(page)).toEqual(saved);
  await page.getByLabel('Close recommendations').click();
  await page.reload();
  await mapReady(page);
  await expect(page.getByRole('dialog')).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Show chart status', exact: true })).toBeVisible();
});

test('airport, plate, page, zoom, fullscreen and scroll restore together, including offline', async ({ page, request }) => {
  const errors: string[] = [];
  page.on('pageerror', error => errors.push(error.message));
  await page.goto('/');
  await page.getByLabel('Search FAA navigation data').fill('KSBA');
  await page.locator('.search-results button').filter({ hasText: 'KSBA' }).click();
  await page.getByRole('button', { name: 'Plates', exact: true }).click();
  await page.getByRole('button', { name: /TEST APPROACH/ }).click();
  await expect(page.getByText('Available offline', { exact: true })).toBeVisible();
  await expect(page.locator('.procedure-page-stage')).toHaveAttribute('aria-busy', 'false');
  await page.getByRole('button', { name: 'Enter full screen' }).click();
  const dialog = page.locator('.procedure-window');
  for (let i = 0; i < 4; i++) await dialog.getByRole('button', { name: 'Zoom in', exact: true }).click();
  await expect(page.locator('.procedure-page-stage')).toHaveAttribute('aria-busy', 'false');
  await page.locator('.procedure-page-stage').evaluate(stage => {
    stage.scrollTop = 120; stage.scrollLeft = 60;
    // Exit before the browser dispatches its next scroll event or the debounce.
    window.dispatchEvent(new PageTransitionEvent('pagehide'));
  });
  expect(await page.evaluate(() => Object.entries(localStorage).filter(([key]) => key.endsWith(':scroll'))
    .map(([, value]) => JSON.parse(value).value))).toEqual([{ left: 60, top: 120 }]);
  await expect.poll(() => page.locator('.procedure-page-stage').evaluate(stage => stage.scrollTop)).toBe(120);
  const zoom = await page.locator('.procedure-zoom-controls').textContent();
  const pageText = await page.locator('.procedure-page-controls').textContent();
  await page.waitForFunction(() => !!navigator.serviceWorker.controller);
  // WebKit's offline emulation rejects service-worker responses as well.
  await page.addInitScript(() => Object.defineProperty(navigator, 'onLine', { get: () => false }));
  await request.post('/__test/disconnect');
  await page.reload();
  await expect(page.locator('.procedure-page-stage')).toHaveAttribute('aria-busy', 'false');
  await expect(page.getByRole('button', { name: 'Exit full screen' })).toBeVisible();
  await expect(page.locator('.procedure-zoom-controls')).toHaveText(zoom!);
  await expect(page.locator('.procedure-page-controls')).toHaveText(pageText!);
  await expect.poll(() => page.locator('.procedure-page-stage').evaluate(stage => stage.scrollTop)).toBe(120);
  await page.getByLabel('Close plate', { exact: true }).click();
  await expect(page.locator('.procedure-window')).toHaveCount(0);
  await page.getByRole('button', { name: 'Show KSBA details', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Plates', exact: true })).toHaveClass('is-active');
  await expect(page.locator('.feature-card h2')).toHaveText('KSBA');
  await page.reload();
  await mapReady(page);
  await expect(page.locator('.procedure-window')).toHaveCount(0);
  await expect(page.locator('.feature-card h2')).toHaveText('KSBA');
  await page.getByLabel('Close detail').click();
  await page.reload();
  await mapReady(page);
  await expect(page.locator('.feature-card')).toHaveCount(0);
  expect(errors).toEqual([]);
});

test('a visited PDF page survives refresh, and corrupt presentation records do not block startup', async ({ page }) => {
  // Page routing cannot intercept requests already handled by a service worker.
  await page.addInitScript(() => { Reflect.deleteProperty(Navigator.prototype, 'serviceWorker'); });
  await page.route('**/two-page.pdf', route => route.fulfill({ contentType: 'application/pdf', body: twoPagePdf() }));
  await page.addInitScript(() => {
    if (localStorage.getItem('test-seeded')) return;
    localStorage.setItem('test-seeded', 'true');
    localStorage.setItem('zlayer-ui:layers-open', '{broken');
    localStorage.setItem('zlayer-ui:selected-feature', JSON.stringify({ version: 1, value: { type: 'Feature' } }));
    localStorage.setItem('zlayer-plugin:plates:plate-selection', JSON.stringify({ version: 1, value: {
      airport: { id: 'KSBA' }, procedure: { id: 'two-page', name: 'Two-page test plate' },
      cycle: '2026-09-03', effectiveDate: '2026-09-03', expirationDate: '2026-10-01',
      document: { url: `${location.origin}/two-page.pdf`, nativeUrl: `${location.origin}/two-page.pdf`,
        pageIndex: 0, source: 'faa-individual' },
    } }));
  });
  await page.goto('/');
  await expect(page.locator('.procedure-page-stage')).toHaveAttribute('aria-busy', 'false');
  await page.getByLabel('Next PDF page').click();
  await expect(page.locator('.procedure-page-controls')).toContainText('Page 2 / 2');
  await expect(page.locator('.procedure-page-stage')).toHaveAttribute('aria-busy', 'false');
  await page.reload();
  await expect(page.locator('.procedure-page-stage')).toHaveAttribute('aria-busy', 'false');
  await expect(page.locator('.procedure-page-controls')).toContainText('Page 2 / 2');
  await expect(page.getByLabel('PDF page 2', { exact: true })).toBeVisible();
  await page.getByLabel('Close plate', { exact: true }).click();
  await expect(page.locator('.procedure-window')).toHaveCount(0);
  await expect(page.locator('.feature-card')).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Open map layers', exact: true })).toBeVisible();
});
